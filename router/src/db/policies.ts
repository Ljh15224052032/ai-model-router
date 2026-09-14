// 方案存取：读库 + 内存缓存
import { getDb } from './db.ts';
import { normalizeTiers } from '../core/tiers.ts';
import type { Action, Policy, Rule } from '../types.ts';

let cache: Map<string, Policy> | null = null;

// 归一化 Action：onError/escalate 缺省补空数组（历史数据无这些字段）
function normAction(a: Action): Action {
  return {
    ...a,
    onError: Array.isArray(a.onError) ? a.onError : [],
    escalate: Array.isArray(a.escalate) ? a.escalate : [],
  };
}

function load(): Map<string, Policy> {
  const db = getDb();
  const rows = db.prepare('SELECT * FROM policies').all() as Array<{
    id: string; name: string; enabled: number; is_default: number; description: string | null;
    rules_json: string; fallback_json: string; tiers_json: string | null;
  }>;
  const map = new Map<string, Policy>();
  for (const r of rows) {
    const rules = (JSON.parse(r.rules_json) as Rule[]).map((x) => ({ ...x, then: normAction(x.then) }));
    map.set(r.id, {
      id: r.id,
      name: r.name,
      enabled: !!r.enabled,
      isDefault: !!r.is_default,
      description: r.description ?? undefined,
      rules,
      fallback: normAction(JSON.parse(r.fallback_json) as Action),
      tiers: normalizeTiers(r.tiers_json ? JSON.parse(r.tiers_json) : null),
    });
  }
  return map;
}

export function listPolicies(): Policy[] {
  cache ??= load();
  return [...cache.values()];
}

export function getPolicy(id: string): Policy | undefined {
  cache ??= load();
  return cache.get(id);
}

export function getDefaultPolicy(): Policy | undefined {
  cache ??= load();
  return [...cache.values()].find((p) => p.isDefault && p.enabled) ?? [...cache.values()].find((p) => p.enabled);
}

// 管理 API 写入后刷新缓存
export function refreshPolicies() {
  cache = null;
}