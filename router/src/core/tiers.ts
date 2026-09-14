// 档位映射（OpenSquilla 四档思路）：taskType×complexity → 模型
// 匹配序：精确(taskType+complexity) → 仅 taskType(complexity=any) → any(taskType=any) → null(交 fallback)
import { getSetting } from '../db/settings.ts';
import type { Policy, PolicyTiers, TierEntry } from '../types.ts';

export const TASK_TYPES = ['chat', 'code', 'write', 'summarize', 'translate', 'analyze', 'reason', 'unknown'];
export const COMPLEXITIES = ['low', 'mid', 'high'];

function parseTiers(json: string | null): PolicyTiers | null {
  if (!json) return null;
  try {
    const o = JSON.parse(json) as PolicyTiers;
    if (!Array.isArray(o?.entries)) return null;
    return { entries: o.entries.filter((e) => typeof e?.taskType === 'string' && typeof e?.complexity === 'string' && typeof e?.model === 'string') };
  } catch {
    return null;
  }
}

// 方案级档位 → 全局默认档位 → null
export function resolveTiers(policy: Policy): PolicyTiers | null {
  if (policy.tiers && Array.isArray(policy.tiers.entries) && policy.tiers.entries.length) return policy.tiers;
  return parseTiers(getSetting('tiers_default_json'));
}

// 按匹配序选模型；找不到返回 null（调用方走 fallback）
export function resolveTierModel(tiers: PolicyTiers | null, taskType: string, complexity: string): string | null {
  if (!tiers) return null;
  const entries = tiers.entries;
  // ① 精确匹配 taskType+complexity
  const exact = entries.find((e) => e.taskType === taskType && e.complexity === complexity);
  if (exact) return exact.model;
  // ② 仅 taskType（complexity=any）
  const byType = entries.find((e) => e.taskType === taskType && e.complexity === 'any');
  if (byType) return byType.model;
  // ③ any 通配（taskType=any，complexity 精确或 any）
  const anyEntry = entries.find((e) => e.taskType === 'any' && (e.complexity === complexity || e.complexity === 'any'));
  if (anyEntry) return anyEntry.model;
  return null;
}

// 归一化（兼容历史数据：字段缺失补空）
export function normalizeTiers(tiers: unknown): PolicyTiers | null {
  if (!tiers || typeof tiers !== 'object') return null;
  const t = tiers as Partial<PolicyTiers>;
  if (!Array.isArray(t.entries)) return null;
  const out: TierEntry[] = [];
  for (const e of t.entries) {
    if (!e || typeof e !== 'object') continue;
    const { taskType, complexity, model } = e as TierEntry;
    if (typeof taskType !== 'string' || typeof model !== 'string') continue;
    out.push({ taskType, complexity: (['low', 'mid', 'high', 'any'] as string[]).includes(complexity) ? complexity : 'low', model });
  }
  return out.length ? { entries: out } : null;
}

// 默认档位（seed 同步写入 settings.tiers_default_json；此处供启动兜底）
export function defaultTiersJson(): string {
  const rows: TierEntry[] = [
    { taskType: 'code', complexity: 'high', model: 'kimi-for-coding' },
    { taskType: 'code', complexity: 'mid', model: 'deepseek-flash' },
    { taskType: 'code', complexity: 'low', model: 'deepseek-flash' },
    { taskType: 'reason', complexity: 'high', model: 'deepseek-flash' },
    { taskType: 'reason', complexity: 'mid', model: 'deepseek-flash' },
    { taskType: 'reason', complexity: 'low', model: 'deepseek-flash' },
    { taskType: 'analyze', complexity: 'high', model: 'deepseek-flash' },
    { taskType: 'analyze', complexity: 'mid', model: 'deepseek-flash' },
    { taskType: 'analyze', complexity: 'low', model: 'deepseek-flash' },
    { taskType: 'summarize', complexity: 'high', model: 'deepseek-flash' },
    { taskType: 'summarize', complexity: 'mid', model: 'deepseek-flash' },
    { taskType: 'summarize', complexity: 'low', model: 'deepseek-flash' },
    { taskType: 'translate', complexity: 'high', model: 'deepseek-flash' },
    { taskType: 'translate', complexity: 'mid', model: 'deepseek-flash' },
    { taskType: 'translate', complexity: 'low', model: 'deepseek-flash' },
    { taskType: 'write', complexity: 'high', model: 'deepseek-flash' },
    { taskType: 'write', complexity: 'mid', model: 'deepseek-flash' },
    { taskType: 'write', complexity: 'low', model: 'deepseek-flash' },
    { taskType: 'chat', complexity: 'high', model: 'deepseek-flash' },
    { taskType: 'chat', complexity: 'mid', model: 'deepseek-flash' },
    { taskType: 'chat', complexity: 'low', model: 'deepseek-flash' },
    { taskType: 'unknown', complexity: 'high', model: 'deepseek-flash' },
    { taskType: 'unknown', complexity: 'mid', model: 'deepseek-flash' },
    { taskType: 'unknown', complexity: 'low', model: 'deepseek-flash' },
  ];
  return JSON.stringify({ entries: rows });
}
