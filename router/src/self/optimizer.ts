// 自进化 L1：AI(LLM) 决策 + 代码护栏（默认）
// 流程：周期汇总请求历史 → 交给 LLM 产出结构化调优建议 → 代码校验合法性/限量/置信度/样本门槛 → 写回档位表 → 全量落 optimizer_log
// 护栏保证：AI 只能改 model_catalog 里 enabled 的模型、每轮限量、置信度达标、样本足够；any/通配格不动；
//      LLM 失败/超时/非法 JSON 一律静默跳过，不阻断在线路由。AI 不可用时按设置回退纯代码兜底或直接跳过。
import { getDb } from '../db/db.ts';
import { getSetting, setSetting } from '../db/settings.ts';
import { normalizeTiers } from '../core/tiers.ts';
import { callNewApi } from '../upstream/newapi-client.ts';
import { config } from '../config.ts';
import { listModels } from '../db/models.ts';
import type { PolicyTiers, TierEntry } from '../types.ts';

interface ModelStat {
  n: number; // 样本数
  success: number; // 成功次数
  costUsd: number; // 成本累计
  latencyMs: number; // 延迟累计
}

export interface OptimizeResult {
  enabled: boolean;
  ran: boolean;
  /** ai | code-fallback | skip */
  mode: 'ai' | 'code-fallback' | 'skip' | 'none';
  changed: number; // 实际应用了多少格替换
  rationale: string[];
  previousJson: string | null;
  newJson: string | null;
}

export interface AiChange {
  taskType: string;
  complexity: string;
  from: string;
  to: string;
  reason: string;
  confidence: number;
}

interface AiDecision {
  summary: string;
  changes: AiChange[];
}

function getNum(key: string, fallback: number): number {
  const v = getSetting(key);
  if (v === null) return fallback;
  const n = parseFloat(v);
  return Number.isFinite(n) ? n : fallback;
}

function getInt(key: string, fallback: number): number {
  const n = Math.floor(getNum(key, fallback));
  return Number.isFinite(n) ? n : fallback;
}

function parseGroup(json: string | null): { taskType: string; complexity: string } | null {
  if (!json) return null;
  try {
    const j = JSON.parse(json) as { taskType?: unknown; complexity?: unknown };
    if (typeof j?.taskType === 'string' && typeof j?.complexity === 'string') {
      return { taskType: j.taskType, complexity: j.complexity };
    }
  } catch {
    /* 损坏 JSON 忽略 */
  }
  return null;
}

function loadTiers(): PolicyTiers | null {
  const json = getSetting('tiers_default_json');
  if (!json) return null;
  try {
    return normalizeTiers(JSON.parse(json));
  } catch {
    return null;
  }
}

// 主指派观测：带 judge 分类、非降级链产生的首模型数据（tier/fallback/rule 来源）
function collect(windowDays: string): { byGroup: Map<string, Map<string, ModelStat>>; byTaskType: Map<string, Map<string, ModelStat>> } {
  const rows = getDb()
    .prepare(
      `SELECT judge_result_json, final_model, status, latency_ms, cost_usd
       FROM request_logs
       WHERE created_at >= datetime('now', ?)
         AND judge_result_json IS NOT NULL AND judge_result_json != ''
         AND route_source IN ('tier','fallback','rule')`
    )
    .all(`-${windowDays} days`) as Array<{
    judge_result_json: string;
    final_model: string;
    status: string;
    latency_ms: number;
    cost_usd: number;
  }>;

  const byGroup = new Map<string, Map<string, ModelStat>>();
  const byTaskType = new Map<string, Map<string, ModelStat>>();

  const addTo = (map: Map<string, Map<string, ModelStat>>, key: string, model: string, s: boolean, ms: number, cost: number) => {
    let m = map.get(key);
    if (!m) {
      m = new Map<string, ModelStat>();
      map.set(key, m);
    }
    let st = m.get(model);
    if (!st) {
      st = { n: 0, success: 0, costUsd: 0, latencyMs: 0 };
      m.set(model, st);
    }
    st.n += 1;
    if (s) st.success += 1;
    st.costUsd += cost;
    st.latencyMs += ms;
  };

  for (const r of rows) {
    if (!r.final_model) continue;
    const g = parseGroup(r.judge_result_json);
    if (!g) continue;
    const ok = r.status === 'success';
    addTo(byGroup, `${g.taskType}|${g.complexity}`, r.final_model, ok, r.latency_ms, r.cost_usd);
    addTo(byTaskType, g.taskType, r.final_model, ok, r.latency_ms, r.cost_usd);
  }
  return { byGroup, byTaskType };
}

function avgCost(s: ModelStat): number {
  return s.n ? s.costUsd / s.n : 0;
}
function avgLt(s: ModelStat): number {
  return s.n ? s.latencyMs / s.n : 0;
}

// 在同 taskType 候选里选「健康且最省」：成功率达标 + 样本够 → 成本低者优先，成本并列再取延迟低
function bestHealthy(stats: Map<string, ModelStat> | undefined, minSample: number, gate: number): [string, ModelStat] | null {
  if (!stats) return null;
  let best: [string, ModelStat] | null = null;
  for (const [m, s] of stats) {
    if (s.n < minSample) continue;
    if (s.success / s.n < gate) continue;
    if (!best) {
      best = [m, s];
      continue;
    }
    const b = best[1];
    const aCost = avgCost(s);
    const bCost = avgCost(b);
    if (aCost < bCost - 1e-9) best = [m, s];
    else if (Math.abs(aCost - bCost) <= 1e-9 && avgLt(s) < avgLt(b)) best = [m, s];
  }
  return best;
}

// ---------- 1) 为 LLM 汇总数据 ----------
interface CellObs {
  taskType: string;
  complexity: string;
  model: string;
  n: number;
  successRate: number;
  avgCostUsd: number;
  avgLatencyMs: number;
}

function buildSummary(byGroup: Map<string, Map<string, ModelStat>>): { cells: CellObs[]; totalRequests: number } {
  const cells: CellObs[] = [];
  let totalRequests = 0;
  for (const [key, m] of byGroup) {
    const [taskType, complexity] = key.split('|');
    for (const [model, s] of m) {
      totalRequests += s.n;
      cells.push({
        taskType,
        complexity,
        model,
        n: s.n,
        successRate: s.n ? s.success / s.n : 0,
        avgCostUsd: avgCost(s),
        avgLatencyMs: avgLt(s),
      });
    }
  }
  cells.sort((a, b) => (a.taskType !== b.taskType ? a.taskType.localeCompare(b.taskType) : a.complexity.localeCompare(b.complexity) || a.model.localeCompare(b.model)));
  return { cells, totalRequests };
}

// 只有 model_catalog 里 enabled 的模型才允许被设为目标
function enabledModelSet(): Set<string> {
  return new Set(listModels().filter((m) => m.enabled).map((m) => m.model));
}

// ---------- 2) 请求 LLM 决策 ----------
async function askAi(model: string, token: string, statsJson: string, tiersJson: string, catalogJson: string): Promise<AiDecision | null> {
  const sys = `你是 AI 模型路由器的「自进化调优器」。你会收到一段窗口期内的请求历史统计、当前档位表、可用模型目录。
目标是保守地优化精确挡位：当某个 (taskType, complexity) 格当前指定的模型在该格表现不佳（成功率低 / 成本偏高 / 延迟偏高），建议换一个更合适的目标模型。
硬性要求：
- 只对精确格 (taskType, complexity) 提出替换建议；taskType 或 complexity 为 "any" 的通配格一律不改。
- 目标模型必须来自给定的可用模型目录（model 字段），且要权衡成功率、成本、延迟。
- 每格最多一条修改；理由必须用中文一句话写清楚。
- 没有把握就不要硬改；宁可少改也不抖动。
输出严格 JSON，不要输出任何额外文字、不要用 markdown 代码块包裹。JSON 格式：
{"summary":"一句话总体判断","changes":[{"taskType":"code","complexity":"high","from":"当前模型","to":"目标模型","reason":"中文理由","confidence":0.9}]}`;

  const user = `【窗口内请求统计】(按 taskType/complexity/model 聚合)
${statsJson}

【当前档位表】
${tiersJson}

【可用模型目录】(enabled，含单价/上下文)
${catalogJson}`;

  const res = await callNewApi(
    '/v1/chat/completions',
    {
      model,
      messages: [
        { role: 'system', content: sys },
        { role: 'user', content: user },
      ],
      stream: false,
      temperature: 0.3,
    },
    { token, stream: false }
  );

  const raw = await new Response(res.bodyStream).text();
  if (res.status >= 400) {
    let extra = '';
    try {
      const j = JSON.parse(raw) as { error?: { message?: unknown } };
      if (typeof j?.error?.message === 'string' && j.error.message) extra = ` · ${j.error.message.slice(0, 120)}`;
    } catch {
      /* 忽略非 JSON 错误体 */
    }
    throw new Error(`上游返回 ${res.status}${extra}`);
  }
  const parsed = JSON.parse(raw) as { choices?: Array<{ message?: { content?: string } }> };
  const content = parsed.choices?.[0]?.message?.content ?? '';
  const dec = parseAiDecision(content);
  if (!dec) throw new Error('LLM 未返回合法 JSON / 无有效变更');
  return dec;
}

function parseAiDecision(content: string): AiDecision | null {
  const block = content.match(/\{[\s\S]*\}/);
  if (!block) return null;
  try {
    const o = JSON.parse(block[0]) as Partial<AiDecision>;
    if (!o || typeof o !== 'object') return null;
    const changes = (Array.isArray(o.changes) ? o.changes : [])
      .filter((c: unknown) => c && typeof c === 'object')
      .map((c) => {
        const cj = c as Partial<AiChange>;
        return {
          taskType: String(cj.taskType ?? ''),
          complexity: String(cj.complexity ?? ''),
          from: String(cj.from ?? ''),
          to: String(cj.to ?? ''),
          reason: String(cj.reason ?? '').slice(0, 200),
          confidence: Number.isFinite(Number(cj.confidence)) ? Number(cj.confidence) : 0,
        };
      })
      .filter((c) => c.taskType && c.complexity && c.from && c.to);
    if (!changes.length) return null;
    return { summary: String(o.summary ?? '').slice(0, 200), changes };
  } catch {
    return null;
  }
}

// ---------- 3) 代码护栏 ----------
export interface GuardResult {
  applied: AIAppliedChange[];
  rejected: string[];
}

export function guard(
  entries: TierEntry[],
  changes: AiChange[],
  byGroup: Map<string, Map<string, ModelStat>>,
  enabled: Set<string>,
  minSample: number,
  confidence: number,
  maxChanges: number,
  trustAi: boolean
): GuardResult {
  const applied: AIAppliedChange[] = [];
  const rejected: string[] = [];
  const touched = new Set<string>();

  for (const c of changes) {
    if (applied.length >= maxChanges) {
      rejected.push(`${c.taskType}/${c.complexity}: 每轮最多 ${maxChanges} 格，已满`);
      break;
    }
    const key = `${c.taskType}|${c.complexity}`;
    if (touched.has(key)) continue; // 每格只改一次

    const idx = entries.findIndex((e) => e.taskType === c.taskType && e.complexity === c.complexity);
    if (idx < 0) {
      rejected.push(`${c.taskType}/${c.complexity}: 档位表中无此精确格`);
      continue;
    }
    const cur = entries[idx];
    if (cur.model !== c.from) {
      rejected.push(`${c.taskType}/${c.complexity}: 当前实际是 ${cur.model}，AI 建议从 ${c.from} 出发已过期，忽略`);
      continue;
    }
    if (!enabled.has(c.to)) {
      rejected.push(`${c.taskType}/${c.complexity}: 目标模型 ${c.to} 不在启用模型目录，拒绝`);
      continue;
    }
    if (c.to === c.from) continue; // 无变化
    if (!trustAi && c.confidence < confidence) {
      rejected.push(`${c.taskType}/${c.complexity}: 置信度 ${c.confidence} < ${confidence}，拒绝`);
      continue;
    }
    if (!trustAi) {
      const cellTotal = [...(byGroup.get(key)?.values() ?? [])].reduce((a, s) => a + s.n, 0);
      if (cellTotal < minSample) {
        rejected.push(`${c.taskType}/${c.complexity}: 该格样本 ${cellTotal} < ${minSample}，证据不足，拒绝`);
        continue;
      }
    }

    touched.add(key);
    applied.push({
      taskType: c.taskType,
      complexity: c.complexity,
      from: c.from,
      to: c.to,
      reason: `${c.reason}（AI 置信度 ${c.confidence.toFixed(2)}）`,
    });
    entries[idx] = { ...cur, model: c.to };
  }
  return { applied, rejected };
}

export interface AIAppliedChange {
  taskType: string;
  complexity: string;
  from: string;
  to: string;
  reason: string;
}

// ---------- 4) 纯代码兜底（AI 不可用时） ----------
// 与旧版相同：某精确格当前模型成功率低于硬门槛且样本足够 → 换同 taskType 下健康且最省的模型
function codeFallback(entries: TierEntry[], byGroup: Map<string, Map<string, ModelStat>>, byTaskType: Map<string, Map<string, ModelStat>>, minSample: number, gate: number): { applied: AIAppliedChange[]; rationale: string[] } {
  const applied: AIAppliedChange[] = [];
  const rationale: string[] = [];
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i];
    if (e.taskType === 'any' || e.complexity === 'any') continue; // 只微调精确格，通配保留
    const group = byGroup.get(`${e.taskType}|${e.complexity}`);
    const cur = group?.get(e.model);
    if (!cur) continue; // 该格无观测
    if (cur.n < minSample) continue; // 样本不足，不动
    if (cur.success / cur.n >= gate) continue; // 当前健康，保守保持

    const pick = bestHealthy(byTaskType.get(e.taskType), minSample, gate);
    if (!pick || pick[0] === e.model) continue;

    applied.push({ taskType: e.taskType, complexity: e.complexity, from: e.model, to: pick[0], reason: '' });
    rationale.push(
      `${e.taskType}/${e.complexity}: ${e.model}(成功${((cur.success / cur.n) * 100).toFixed(0)}%) → ${pick[0]}(成功${(
        (pick[1].success / pick[1].n) * 100
      ).toFixed(0)}%, 成本$${avgCost(pick[1]).toFixed(4)}, 延迟${avgLt(pick[1]).toFixed(0)}ms)`
    );
    entries[i] = { ...e, model: pick[0] };
  }
  return { applied, rationale };
}

// ---------- 主入口 ----------
export async function runOptimizer(): Promise<OptimizeResult> {
  const enabled = (getSetting('self_evolve_enabled') ?? '0') === '1';
  if (!enabled) {
    return { enabled: false, ran: false, mode: 'none', changed: 0, rationale: [], previousJson: null, newJson: null };
  }

  const windowDays = String(Math.max(1, Math.floor(getNum('self_evolve_window_days', 7))));
  const minSample = Math.max(2, getInt('self_evolve_min_sample', 20));
  const confidence = getNum('self_evolve_confidence', 0.7);
  const maxChanges = Math.max(0, getInt('self_evolve_max_changes', 5));
  const gate = getNum('self_evolve_success_gate', 0.9);
  const trustAi = (getSetting('self_evolve_trust_ai') ?? '0') === '1';
  const fallbackCode = (getSetting('self_evolve_fallback_code') ?? '1') === '1';

  const tiers = loadTiers();
  if (!tiers || !tiers.entries.length) {
    return { enabled: true, ran: true, mode: 'skip', changed: 0, rationale: ['no tiers configured'], previousJson: null, newJson: null };
  }

  const { byGroup, byTaskType } = collect(windowDays);
  const entries = tiers.entries.map((e) => ({ ...e }));
  const enabledSet = enabledModelSet();
  const previousJson = JSON.stringify({ entries: tiers.entries });
  const totalApplied: AIAppliedChange[] = [];
  const notes: string[] = [];
  let mode: OptimizeResult['mode'] = 'skip';
  let aiNote = ''; // 本次改动的 AI 一句话说明（【说明】首行）

  // A) 尝试 AI 决策
  const aiModel = getSetting('self_evolve_model') || 'deepseek-flash';
  const token = getSetting('newapi_token') || config.newapiToken;
  if (token && maxChanges > 0) {
    const { cells } = buildSummary(byGroup);
    const catalogJson = JSON.stringify(
      listModels()
        .filter((m) => m.enabled)
        .map((m) => ({
          model: m.model,
          provider: m.provider,
          contextWindow: m.contextWindow,
          inputPrice: m.inputPrice,
          outputPrice: m.outputPrice,
          tags: m.tags,
        }))
    );
    const statsJson = JSON.stringify(cells);
    const tiersForAi = JSON.stringify({ entries: entries.filter((e) => e.taskType !== 'any' && e.complexity !== 'any') });

    try {
      const decision = await askAi(aiModel, token, statsJson, tiersForAi, catalogJson);
      if (decision) {
        const { applied, rejected } = guard(entries, decision.changes, byGroup, enabledSet, minSample, confidence, maxChanges, trustAi);
        applied.forEach((a) => totalApplied.push(a));
        if (rejected.length) notes.push(`AI 被护栏拦截 ${rejected.length} 条：` + rejected.join('；'));
        if (totalApplied.length) {
          mode = 'ai';
          aiNote = decision.summary || '';
          notes.unshift(`AI 决策（${decision.summary || '无摘要'}）`);
        }
      }
    } catch (e) {
      notes.push(`LLM 决策失败：${(e as Error).message}`);
    }
  } else if (maxChanges <= 0) {
    notes.push('self_evolve_max_changes=0，禁用任何自动修改');
  }

  // B) 代码兜底：AI 未成功或未产生有效变更时，按设置回退纯代码策略或直接跳过
  if (totalApplied.length === 0 && fallbackCode && maxChanges > 0 && byGroup.size > 0) {
    const { applied, rationale } = codeFallback(entries, byGroup, byTaskType, minSample, gate);
    if (applied.length) {
      applied.forEach((a, i) => {
        a.reason = a.reason || rationale[i] || '';
        totalApplied.push(a);
      });
      notes.unshift('AI 未产出有效变更，已回退纯代码保守兜底');
      aiNote = 'AI 不可用，已按代码保守策略兜底调整挡位';
      mode = 'code-fallback';
    } else {
      notes.push('代码兜底未发现可调整的格');
    }
  }

  if (totalApplied.length === 0) {
    return { enabled: true, ran: true, mode, changed: 0, rationale: notes, previousJson: null, newJson: null };
  }

  const newJson = JSON.stringify({ entries });
  setSetting('tiers_default_json', newJson);
  const detail = totalApplied.map((a) => `${a.taskType}/${a.complexity}: ${a.from} → ${a.to}（${a.reason}）`).join('\n');
  const reason = (aiNote ? `【说明】${aiNote}\n` : '') + detail;
  getDb()
    .prepare(`INSERT INTO optimizer_log (action, reason, previous_tiers_json, new_tiers_json) VALUES (?, ?, ?, ?)`)
    .run(trustAi ? 'ai_tune' : 'ai_guarded_tune', reason, previousJson, newJson);

  return { enabled: true, ran: true, mode, changed: totalApplied.length, rationale: notes, previousJson, newJson };
}