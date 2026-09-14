// M9.1 编排模式：规划-执行分离（串行最小闭环）
// 哲学：贵模型出思想（1 次规划 + 1 次合成），便宜模型出工时（子任务逐个执行，每个子任务独立走直路由基建）
// fail-open 原则（RouteLLM/Switchyard 共性）：规划/合成任一环节失败，降级为普通直路由，绝不因编排故障阻断请求
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { config } from '../config.ts';
import { getSetting } from '../db/settings.ts';
import { getModelCost, listModels } from '../db/models.ts';
import { callNewApi, type Usage } from '../upstream/newapi-client.ts';
import { decide } from './dispatcher.ts';
import { recordFail, recordSuccess } from './health.ts';
import { insertLog, estimateCost } from '../stats/logger.ts';

export interface OrchTask {
  id: string;
  goal: string;
  depends_on: string[];
  complexity: 'low' | 'mid' | 'high';
  acceptance?: string;
}

export interface OrchPlan {
  tasks: OrchTask[];
  synthesis: string; // 合成要求（怎么把子任务结果拼成最终答案）
}

export interface WorkerOutcome {
  id: string;
  goal: string;
  model: string;
  summary: string;
  costUsd: number;
  latencyMs: number;
  status: 'success' | 'fail' | 'skipped';
}

export interface OrchResult {
  status: 'DONE' | 'DEGRADED' | 'DIRECT';
  orchId: string;
  plan: OrchPlan | null;
  plannerModel: string;
  workers: WorkerOutcome[];
  final: string;
  totalCostUsd: number;
  usage: { promptTokens: number; completionTokens: number };
}

// SSE 过程事件（M9.2：客户端可见编排进度）
export type OrchEvent =
  | { type: 'plan'; tasks: number; plannerModel: string }
  | { type: 'worker_start'; id: string }
  | { type: 'worker_done'; id: string; model: string; status: WorkerOutcome['status']; latencyMs: number }
  | { type: 'synthesis_start' }
  | { type: 'status'; status: OrchResult['status']; totalCostUsd: number };

type Msg = { role: string; content: unknown };

const textOf = (c: unknown): string => {
  if (typeof c === 'string') return c;
  if (Array.isArray(c)) {
    return c.map((x) => (typeof x === 'object' && x && typeof (x as { text?: unknown }).text === 'string' ? (x as { text: string }).text : '')).join(' ');
  }
  return '';
};

// 一次非流式调用并解析 OpenAI 响应；返回 null = 失败（含 >=400）
async function callOnce(model: string, messages: Msg[], token: string): Promise<{ content: string; usage: Usage | null } | null> {
  try {
    const res = await callNewApi('/v1/chat/completions', { model, messages, stream: false }, { token, stream: false });
    const raw = await new Response(res.bodyStream).text();
    if (res.status >= 400) {
      recordFail(model);
      return null;
    }
    recordSuccess(model);
    const parsed = JSON.parse(raw) as {
      choices?: Array<{ message?: { content?: string } }>;
      usage?: { prompt_tokens?: number; completion_tokens?: number; prompt_tokens_details?: { cached_tokens?: number } };
    };
    const content = parsed.choices?.[0]?.message?.content ?? '';
    const usage: Usage | null = parsed.usage
      ? {
          promptTokens: parsed.usage.prompt_tokens ?? 0,
          completionTokens: parsed.usage.completion_tokens ?? 0,
          cachedTokens: parsed.usage.prompt_tokens_details?.cached_tokens ?? 0,
        }
      : null;
    return { content, usage };
  } catch {
    return null;
  }
}

// 编排子调用统一落库（routeSource=orchestrate，共享 orch_id）
function orchLog(orchId: string, role: 'planner' | 'worker' | 'synthesis', model: string, latencyMs: number, usage: Usage | null, status: 'success' | 'fail', policyId: string | null, error?: string) {
  const m = listModels().find((x) => x.model === model);
  const { inputPrice, outputPrice } = getModelCost(model);
  insertLog({
    client: 'router-orchestrate',
    requestedModel: 'auto@orchestrate',
    policyId,
    ruleId: null,
    routeSource: 'orchestrate',
    judgeResultJson: null,
    finalModel: model,
    provider: m?.provider ?? null,
    contextAction: 'none',
    usage,
    costUsd: estimateCost(usage, inputPrice, outputPrice),
    latencyMs,
    status,
    error,
    orchId,
    orchRole: role,
  });
}

// ---------- 规划调用（1 次，旗舰模型）----------
async function planTasks(orchId: string, plannerModel: string, maxTasks: number, messages: Msg[], token: string, start: () => number): Promise<{ plan: OrchPlan; usage: Usage | null; costUsd: number } | null> {
  const last = [...messages].reverse().find((m) => m.role === 'user');
  const userText = textOf(last?.content).slice(0, 6000) || '(无用户消息)';
  const sys = `你是路由编排器的规划器。请把用户的复杂请求拆解为 1-${maxTasks} 个可独立执行的子任务。
输出严格 JSON，不要输出任何额外文字、不要用 markdown 代码块包裹。JSON 格式：
{"tasks":[{"id":"t1","goal":"<一句话子任务目标，必须自包含可独立执行>","depends_on":[],"complexity":"low|mid|high","acceptance":"<一句话验收标准>"}],"synthesis":"<如何把各子任务结果合成为最终答案的要求>"}
要求：
- 子任务边界清晰、无循环依赖；独立的信息收集/格式化类标 low，推理/综合类标 high
- 如果该请求不需要拆解，输出单个子任务（goal 即原请求的直接回答要求）
- 子任务总数不超过 ${maxTasks}`;

  const res = await callOnce(plannerModel, [
    { role: 'system', content: sys },
    { role: 'user', content: `【用户请求】\n${userText}` },
  ], token);
  if (!res) {
    orchLog(orchId, 'planner', plannerModel, start(), null, 'fail', null, 'planner_call_failed');
    return null;
  }
  const block = res.content.match(/\{[\s\S]*\}/);
  if (!block) {
    orchLog(orchId, 'planner', plannerModel, start(), res.usage, 'fail', null, 'planner_invalid_json');
    return null;
  }
  try {
    const o = JSON.parse(block[0]) as { tasks?: OrchTask[]; synthesis?: string };
    if (!Array.isArray(o.tasks) || o.tasks.length === 0 || o.tasks.length > maxTasks) throw new Error('tasks 数量非法');
    const ids = new Set<string>();
    for (const t of o.tasks) {
      if (!t?.id || !t?.goal) throw new Error('task 缺 id/goal');
      ids.add(t.id);
    }
    // depends_on 校验：未知依赖清空，断环
    for (const t of o.tasks) {
      t.depends_on = Array.isArray(t.depends_on) ? t.depends_on.filter((d) => ids.has(d) && d !== t.id) : [];
      t.complexity = ['low', 'mid', 'high'].includes(String(t.complexity)) ? (t.complexity as OrchTask['complexity']) : 'mid';
    }
    const plan: OrchPlan = { tasks: o.tasks, synthesis: String(o.synthesis ?? '把各子任务结果整合为连贯的最终答案') };
    const costUsd = estimateCost(res.usage, getModelCost(plannerModel).inputPrice, getModelCost(plannerModel).outputPrice);
    orchLog(orchId, 'planner', plannerModel, start(), res.usage, 'success', null);
    return { plan, usage: res.usage, costUsd };
  } catch {
    orchLog(orchId, 'planner', plannerModel, start(), res.usage, 'fail', null, 'planner_schema_invalid');
    return null;
  }
}

// ---------- DAG 拓扑排序（M9.1 串行：依赖先行；有环则按原序兜底） ----------
function topoSort(tasks: OrchTask[]): OrchTask[] {
  const done = new Set<string>();
  const out: OrchTask[] = [];
  let pending = [...tasks];
  for (let guard = 0; pending.length && guard < tasks.length + 1; guard++) {
    const ready = pending.filter((t) => t.depends_on.every((d) => done.has(d)));
    if (!ready.length) { out.push(...pending); break; } // 剩余有环，原序兜底
    out.push(...ready);
    ready.forEach((t) => done.add(t.id));
    pending = pending.filter((t) => !done.has(t.id));
  }
  return out;
}

// ---------- M9.1 编排主流程 ----------
export async function orchestrate(opts: {
  baseModel: string; // '@orchestrate' 已剥离：'auto' 或 'auto:方案名'
  messages: Msg[];
  token: string;
  onEvent?: (e: OrchEvent) => void;
}): Promise<OrchResult> {
  const { baseModel, messages, token, onEvent } = opts;
  const orchId = `orch-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
  const plannerModel = getSetting('orchestrate_planner_model') || 'k3';
  const maxTasks = Math.max(1, Math.min(8, Number(getSetting('orchestrate_max_tasks')) || 8));
  const t0 = process.hrtime();
  const start = () => Math.round(process.hrtime(t0)[0] * 1000 + process.hrtime(t0)[1] / 1e6);
  let totalUsage = { promptTokens: 0, completionTokens: 0 };
  let totalCost = 0;
  const bump = (u: Usage | null, cost = 0) => { if (u) { totalUsage.promptTokens += u.promptTokens; totalUsage.completionTokens += u.completionTokens; } totalCost += cost; };

  // ① 规划；失败 → fail-open 直路由
  const planRes = await planTasks(orchId, plannerModel, maxTasks, messages, token, start);
  if (!planRes) {
    const direct = await directRoute(orchId, baseModel, messages, token);
    return { status: 'DIRECT', orchId, plan: null, plannerModel, workers: [], final: direct.content, totalCostUsd: direct.costUsd, usage: totalUsage };
  }
  const plan = planRes.plan;
  bump(planRes.usage, planRes.costUsd);
  onEvent?.({ type: 'plan', tasks: plan.tasks.length, plannerModel });

  // ② DAG 并发执行（M9.2）：拓扑序就绪即启动，并发 ≤4；预算护栏 + 失败级联取消
  const lastUser = [...messages].reverse().find((m) => m.role === 'user');
  const origText = textOf(lastUser?.content).slice(0, 3000);
  const concurrency = Math.max(1, Math.min(4, Number(getSetting('orchestrate_concurrency')) || 4));
  const budgetUsd = Number(getSetting('orchestrate_budget_usd')) || 0; // 0 = 不限

  const runWorker = async (task: OrchTask, outcomes: Map<string, WorkerOutcome>): Promise<WorkerOutcome> => {
    const depCtx = task.depends_on
      .map((d) => `【子任务 ${d} 结果】\n${(outcomes.get(d)?.summary ?? '').slice(0, 1600)}`)
      .join('\n\n');
    const user = `你是编排器中的执行者，负责完成一个子任务。直接输出结果正文（不要客套、不要复述任务），简洁、结构化、控制在 800 字以内。

【子任务目标】
${task.goal}

【验收标准】
${task.acceptance ?? '合理完整即可'}

【原始请求摘录】
${origText}${depCtx ? `\n\n${depCtx}` : ''}`;

    const tW = process.hrtime();
    const elapsedW = () => Math.round(process.hrtime(tW)[0] * 1000 + process.hrtime(tW)[1] / 1e6);

    // 子任务独立走直路由（规则/裁判/档位/冷却/重试链全套生效）
    onEvent?.({ type: 'worker_start', id: task.id });
    try {
      const { decision, messages: routedMessages } = await decide({ requestModel: baseModel, messages: [{ role: 'user', content: user }] });
      for (const m of decision.candidates) {
        const r = await callOnce(m, routedMessages, token);
        if (!r) {
          orchLog(orchId, 'worker', m, elapsedW(), null, 'fail', decision.policyId, `worker_upstream_fail_${m}`);
          continue;
        }
        const cost = estimateCost(r.usage, getModelCost(m).inputPrice, getModelCost(m).outputPrice);
        bump(r.usage, cost);
        orchLog(orchId, 'worker', m, elapsedW(), r.usage, 'success', decision.policyId);
        onEvent?.({ type: 'worker_done', id: task.id, model: m, status: 'success', latencyMs: elapsedW() });
        return { id: task.id, goal: task.goal, model: m, summary: r.content.slice(0, 2000), costUsd: cost, latencyMs: elapsedW(), status: 'success' };
      }
    } catch { /* decide 抛错按失败子任务处理 */ }
    onEvent?.({ type: 'worker_done', id: task.id, model: '-', status: 'fail', latencyMs: elapsedW() });
    return { id: task.id, goal: task.goal, model: '-', summary: '', costUsd: 0, latencyMs: elapsedW(), status: 'fail' };
  };

  // 调度循环：依赖全部成功才启动；有依赖失败/跳过则级联取消；超预算取消未启动任务
  const ordered = topoSort(plan.tasks);
  const outcomes = new Map<string, WorkerOutcome>();
  const queue = [...ordered];
  const inflight = new Map<Promise<void>, string>();
  let budgetCut = false;
  while (queue.length || inflight.size) {
    if (budgetUsd > 0 && totalCost >= budgetUsd) {
      // 预算护栏：未启动的全部取消（在跑的不中断，钱已花）
      budgetCut = true;
      for (const t of queue.splice(0)) {
        outcomes.set(t.id, { id: t.id, goal: t.goal, model: '-', summary: '', costUsd: 0, latencyMs: 0, status: 'skipped' });
      }
    }
    for (let i = 0; i < queue.length && inflight.size < concurrency; ) {
      const t = queue[i];
      const depStates = t.depends_on.map((d) => outcomes.get(d)?.status ?? 'pending');
      if (depStates.some((s) => s === 'fail' || s === 'skipped')) {
        queue.splice(i, 1); // 级联取消
        outcomes.set(t.id, { id: t.id, goal: t.goal, model: '-', summary: '', costUsd: 0, latencyMs: 0, status: 'skipped' });
        continue;
      }
      if (depStates.every((s) => s === 'success')) {
        queue.splice(i, 1);
        const p = runWorker(t, outcomes).then((w) => { outcomes.set(t.id, w); inflight.delete(p); });
        inflight.set(p, t.id);
        continue;
      }
      i++; // 依赖尚在执行，等下一轮
    }
    if (inflight.size) await Promise.race([...inflight.keys()]);
  }
  const workers = ordered.map((t) => outcomes.get(t.id)!).filter(Boolean);

  // ③ 合成（1 次，旗舰）；失败 → DEGRADED 拼接摘要
  const succeeded = workers.filter((w) => w.status === 'success');
  totalCost = planRes.costUsd + workers.reduce((s, w) => s + w.costUsd, 0);
  const synthUser = `【原始请求】\n${origText}\n\n【各子任务结果】\n${succeeded.map((w) => `#${w.id} ${w.goal}\n${w.summary}`).join('\n\n')}\n\n【合成要求】\n${plan.synthesis}\n\n请输出最终完整答案，不要提及子任务编号。`;
  onEvent?.({ type: 'synthesis_start' });
  const tS = process.hrtime();
  const elapsedS = () => Math.round(process.hrtime(tS)[0] * 1000 + process.hrtime(tS)[1] / 1e6);
  const finalRes = await callOnce(plannerModel, [
    { role: 'system', content: '你是编排器中的合成者。把各子任务结果整合为连贯的最终答案，直接输出答案正文。' },
    { role: 'user', content: synthUser },
  ], token);
  if (finalRes) {
    bump(finalRes.usage, estimateCost(finalRes.usage, getModelCost(plannerModel).inputPrice, getModelCost(plannerModel).outputPrice));
    orchLog(orchId, 'synthesis', plannerModel, elapsedS(), finalRes.usage, 'success', null);
  } else {
    orchLog(orchId, 'synthesis', plannerModel, elapsedS(), null, 'fail', null, 'synthesis_call_failed');
  }

  const status: OrchResult['status'] = finalRes
    ? succeeded.length === plan.tasks.length ? 'DONE' : 'DEGRADED'
    : 'DEGRADED';
  onEvent?.({ type: 'status', status, totalCostUsd: Number(totalCost.toFixed(6)) });
  const final = finalRes?.content ?? (succeeded.map((w) => `【${w.goal}】\n${w.summary}`).join('\n\n') || '编排失败：无可用子任务结果');

  // ④ 计划快照落盘（审计/断点恢复预留）
  try {
    const dir = join(dirname(config.dbPath), 'plans');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `${orchId}.json`), JSON.stringify({ orchId, status, plan, workers, plannerModel, budgetCut }, null, 2));
  } catch { /* 落盘失败不影响主流程 */ }

  return { status, orchId, plan, plannerModel, workers, final, totalCostUsd: totalCost, usage: totalUsage };
}

// fail-open 直路由兜底（与 v1 非流式同构，取首个成功候选）
async function directRoute(orchId: string, baseModel: string, messages: Msg[], token: string): Promise<{ content: string; costUsd: number }> {
  const { decision, messages: routedMessages } = await decide({ requestModel: baseModel, messages });
  for (const m of decision.candidates) {
    const r = await callOnce(m, routedMessages, token);
    if (r) {
      const costUsd = estimateCost(r.usage, getModelCost(m).inputPrice, getModelCost(m).outputPrice);
      orchLog(orchId, 'worker', m, 0, r.usage, 'success', decision.policyId, undefined);
      return { content: r.content, costUsd };
    }
    orchLog(orchId, 'worker', m, 0, null, 'fail', decision.policyId, `direct_upstream_fail_${m}`);
  }
  return { content: '编排降级直路由也失败：上游无可用模型', costUsd: 0 };
}
