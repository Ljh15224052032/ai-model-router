// 决策编排：classifier → rule-engine → (judge+tier) → fallback（方案文档第 5 节 + M8 档位映射 + P2 成本降级）
import { extractFeatures } from './classifier.ts';
import { matchFirst } from './rule-engine.ts';
import { judge } from './judge.ts';
import { applyContext } from './context.ts';
import { resolveTierModel, resolveTiers } from './tiers.ts';
import { isCooled } from './health.ts';
import { getModelCost } from '../db/models.ts';
import { getPolicy, getDefaultPolicy } from '../db/policies.ts';
import { getSetting } from '../db/settings.ts';
import { maybeExplore } from '../self/explore.ts';
import type { Action, ContextPolicy, Feature, Policy, RouteDecision } from '../types.ts';

export interface DecisionContext {
  requestModel: string;
  messages: Array<{ role: string; content: unknown }>;
  tools?: unknown[];
  stream?: boolean; // P2：成本降级仅对非流式生效
  dryRun?: boolean; // test-route：裁判不落正式日志
}

export interface DecisionOutcome {
  decision: RouteDecision;
  features: Feature;
  contextAction: 'none' | 'tools' | 'truncate' | 'summarize';
  messages: Array<{ role: string; content: unknown }>;
}

function actionOf(a: ActionLike): ContextPolicy {
  return a.context ?? { strategy: 'none' };
}
type ActionLike = { context?: ContextPolicy };

interface CandidatePlan {
  finalModel: string;
  candidates: string[]; // 首选 + onError + escalate（冷却已过滤后缀链，首选保留）
  costDegraded: boolean; // P2：估算成本超预算沿 costDegrade 链降级
}

// 候选链：首选 + onError（同档替代）+ escalate（升级）；去重；后缀链过滤冷却中的模型（首选不受冷却改道）
// P2 成本降级（仅非流式）：首选估算成本（输入 token × 输入单价）超 maxCostUsd 时，沿 costDegrade 链换预算内模型；
// 链上都不满足预算则取估算成本最低者；未配 maxCostUsd / costDegrade 或流式请求不做成本降级
function buildCandidates(action: Action, preferred: string, opts: { features: Feature; stream: boolean }): CandidatePlan {
  let finalModel = preferred;
  let costDegraded = false;
  if (!opts.stream && action.maxCostUsd && action.maxCostUsd > 0 && Array.isArray(action.costDegrade) && action.costDegrade.length) {
    const budget = action.maxCostUsd;
    const est = (m: string) => (opts.features.inputTokens * getModelCost(m).inputPrice) / 1_000_000;
    if (est(preferred) > budget) {
      const chain = action.costDegrade as string[];
      const under = chain.filter((m) => est(m) <= budget);
      // 预算内第一个（链按用户意图排序）；全超预算则取估算成本最低者兜底
      const picked = under.length ? under[0] : chain.reduce((a, b) => (est(b) < est(a) ? b : a));
      if (picked && picked !== preferred) {
        finalModel = picked;
        costDegraded = true;
      }
    }
  }
  const chain = [finalModel, ...(action.onError ?? []), ...(action.escalate ?? [])];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const m of chain) {
    if (!m || seen.has(m)) continue;
    seen.add(m);
    if (out.length === 0 || !isCooled(m)) out.push(m); // 首选不过滤，后缀冷却跳过
  }
  return { finalModel, candidates: out, costDegraded };
}

export async function decide(req: DecisionContext): Promise<DecisionOutcome> {
  const features = extractFeatures({ messages: req.messages, tools: req.tools, model: req.requestModel });
  const rm = req.requestModel;

  // passthrough: 真实模型名原样透传
  if (rm && !rm.startsWith('auto')) {
    return {
      decision: {
        finalModel: rm,
        candidates: [rm],
        source: 'passthrough',
        policyId: null,
        ruleId: null,
        judgeResult: null,
        context: { strategy: 'none' },
      },
      features,
      contextAction: 'none',
      messages: req.messages,
    };
  }

  // auto[:方案名]
  let policy: Policy;
  let policyId: string | null;
  if (!rm || rm === 'auto') {
    // 优先 settings.default_policy（设置页可改，保存即生效）；未配置/不存在/停用则回落默认方案
    const name = getSetting('default_policy');
    const named = name ? getPolicy(name) : undefined;
    const def = named && named.enabled ? named : getDefaultPolicy();
    if (!def) throw new Error('无可用默认路由方案');
    policy = def;
    policyId = def.id;
  } else if (rm.startsWith('auto:')) {
    const name = rm.slice(5);
    const p = getPolicy(name);
    if (!p || !p.enabled) throw new Error(`未知或未启用的路由方案: ${name}`);
    policy = p;
    policyId = p.id;
  } else {
    throw new Error(`非法 model 参数: ${rm}`);
  }

  // 1) 规则命中
  const hit = matchFirst(policy.rules, features);
  if (hit) {
    const act = hit.rule.then;
    const ctx = actionOf(act);
    const { messages, action } = await applyContext(req.messages, ctx, { log: !req.dryRun });
    const plan = buildCandidates(act, act.model, { features, stream: req.stream ?? false });
    return {
      decision: {
        finalModel: plan.finalModel,
        candidates: plan.candidates,
        source: 'rule',
        policyId,
        ruleId: hit.rule.id,
        judgeResult: null,
        reasonNote: act.reasonNote,
        context: ctx,
        costDegraded: plan.costDegraded,
      },
      features,
      contextAction: action,
      messages,
    };
  }

  // 2) LLM 裁判分类（M4/M8）：规则未命中，便宜模型判 taskType+complexity；失败不阻断
  let jr: Awaited<ReturnType<typeof judge>> = null;
  try {
    jr = await judge(features, policyId, req.messages, { log: !req.dryRun });
  } catch {
    jr = null; // judge 内部已兜底，此处双保险
  }
  if (jr) {
    // 档位映射（M8）：taskType×complexity → 模型；找不到则走 fallback 链
    const tierModel = resolveTierModel(resolveTiers(policy), jr.taskType, jr.complexity);
    if (tierModel) {
      const fb = policy.fallback;
      const ctx = actionOf(fb);
      // tier 首选 + fallback 的 onError/escalate 作为后续链（档位表本身不含链）
      const { messages, action } = await applyContext(req.messages, ctx, { log: !req.dryRun });
      const plan = buildCandidates(fb, tierModel, { features, stream: req.stream ?? false });
      // L2 在线探索：MVP/I，追加进 tier 决策（不改变候选链）；dryRun(调试) 不探索
      const exp = req.dryRun ? { model: plan.finalModel, exploredFrom: null } : maybeExplore(plan.finalModel);
      return {
        decision: {
          finalModel: exp.model,
          candidates: plan.candidates,
          source: 'tier',
          policyId,
          ruleId: null,
          judgeResult: jr,
          tier: { taskType: jr.taskType, complexity: jr.complexity },
          reasonNote: fb.reasonNote,
          context: ctx,
          costDegraded: plan.costDegraded,
          exploreFrom: exp.exploredFrom,
        },
        features,
        contextAction: action,
        messages,
      };
    }
    // 档位表无匹配 → 继续走 fallback（判定结果保留在日志）
  }

  // 3) 兜底
  const fb = policy.fallback;
  const ctx = actionOf(fb);
  const { messages, action } = await applyContext(req.messages, ctx, { log: !req.dryRun });
  const plan = buildCandidates(fb, fb.model, { features, stream: req.stream ?? false });
  return {
    decision: {
      finalModel: plan.finalModel,
      candidates: plan.candidates,
      source: 'fallback',
      policyId,
      ruleId: null,
      judgeResult: jr,
      reasonNote: fb.reasonNote,
      context: ctx,
      costDegraded: plan.costDegraded,
    },
    features,
    contextAction: action,
    messages,
  };
}