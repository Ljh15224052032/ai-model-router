// 自进化 L1：周期分析 request_logs，保守微调档位表（仅精确 taskType×complexity 格）
// 策略：某格当前模型成功率低于硬门槛且样本足够 → 换为同一 taskType 下更可靠/更省的健康模型；
// 健康格与 any/通配格一律不动，避免抖动。无在线探索（L2 才做）。
import { getDb } from '../db/db.ts';
import { getSetting, setSetting } from '../db/settings.ts';
import { normalizeTiers } from '../core/tiers.ts';
import type { PolicyTiers } from '../types.ts';

interface ModelStat {
  n: number; // 样本数
  success: number; // 成功次数
  costUsd: number; // 成本累计
  latencyMs: number; // 延迟累计
}

export interface OptimizeResult {
  enabled: boolean;
  ran: boolean;
  changed: number; // 实际应用了多少格替换
  rationale: string[];
  previousJson: string | null;
  newJson: string | null;
}

function getNum(key: string, fallback: number): number {
  const v = getSetting(key);
  if (v === null) return fallback;
  const n = parseFloat(v);
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
function collect(windowDays: string): {
  byGroup: Map<string, Map<string, ModelStat>>;
  byTaskType: Map<string, Map<string, ModelStat>>;
} {
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

export function runOptimizer(): OptimizeResult {
  const enabled = (getSetting('self_evolve_enabled') ?? '0') === '1';
  if (!enabled) {
    return { enabled: false, ran: false, changed: 0, rationale: [], previousJson: null, newJson: null };
  }

  const windowDays = String(Math.max(1, Math.floor(getNum('self_evolve_window_days', 7))));
  const minSample = Math.max(2, Math.floor(getNum('self_evolve_min_sample', 20)));
  const gate = getNum('self_evolve_success_gate', 0.9);

  const tiers = loadTiers();
  if (!tiers || !tiers.entries.length) {
    return { enabled: true, ran: true, changed: 0, rationale: ['no tiers configured'], previousJson: null, newJson: null };
  }

  const { byGroup, byTaskType } = collect(windowDays);
  const entries = tiers.entries.map((e) => ({ ...e }));
  const rationale: string[] = [];
  let changed = 0;

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

    const fromModel = e.model;
    entries[i].model = pick[0];
    changed++;
    rationale.push(
      `${e.taskType}/${e.complexity}: ${fromModel}(成功${((cur.success / cur.n) * 100).toFixed(0)}%) → ${pick[0]}(成功${(
        (pick[1].success / pick[1].n) * 100
      ).toFixed(0)}%, 成本$${avgCost(pick[1]).toFixed(4)}, 延迟${avgLt(pick[1]).toFixed(0)}ms)`
    );
  }

  if (changed === 0) {
    return { enabled: true, ran: true, changed: 0, rationale, previousJson: null, newJson: null };
  }

  const previousJson = JSON.stringify({ entries: tiers.entries });
  const newJson = JSON.stringify({ entries });
  setSetting('tiers_default_json', newJson);
  getDb()
    .prepare(`INSERT INTO optimizer_log (action, reason, previous_tiers_json, new_tiers_json) VALUES (?, ?, ?, ?)`)
    .run('auto_tune', rationale.join('\n'), previousJson, newJson);

  return { enabled: true, ran: true, changed, rationale, previousJson, newJson };
}