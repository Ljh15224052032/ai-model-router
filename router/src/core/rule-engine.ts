// 规则匹配引擎：按 priority 升序匹配，首条命中即停（方案文档 4.3 条件操作符）
import type { Condition, Feature, Rule } from '../types.ts';

function getFieldValue(f: Feature, field: string): unknown {
  switch (field) {
    case 'inputTokens': return f.inputTokens;
    case 'lastMsgChars': return f.lastMsgChars;
    case 'turnCount': return f.turnCount;
    case 'hasTools': return f.hasTools;
    case 'hasSystem': return f.hasSystem;
    case 'keywordsAny': return f.keywordsAny;
    case 'modelRequested': return f.modelRequested;
    case 'client': return f.client;
    default: return undefined;
  }
}

function compare(v: unknown, target: unknown, op: Condition['op']): boolean {
  switch (op) {
    case 'eq': return v === target;
    case 'ne': return v !== target;
    case 'gt': return typeof v === 'number' && typeof target === 'number' && v > target;
    case 'gte': return typeof v === 'number' && typeof target === 'number' && v >= target;
    case 'lt': return typeof v === 'number' && typeof target === 'number' && v < target;
    case 'lte': return typeof v === 'number' && typeof target === 'number' && v <= target;
    case 'in': return Array.isArray(target) && target.includes(v);
    case 'contains': {
      // 数组特征：任一元素等于 target；字符串特征：包含 target
      if (Array.isArray(v)) return (target as unknown[]).some((t) => (v as unknown[]).includes(t));
      if (typeof v === 'string') return v.includes(String(target));
      return false;
    }
    case 'exists': return v !== undefined && v !== null && v !== '';
    default: return false;
  }
}

export function matchRule(rule: Rule, f: Feature): boolean {
  if (!rule.enabled) return false;
  return rule.when.every((c) => {
    // 特别处理 args 条件：报错/失败仍命中（简化，深参条件后续扩展）
    if (c.field === 'hasCostOver') return false;
    const v = getFieldValue(f, c.field);
    return compare(v, c.value, c.op);
  });
}

export function matchFirst(
  rules: Rule[],
  f: Feature
): { rule: Rule } | null {
  const sorted = [...rules].sort((a, b) => a.priority - b.priority);
  for (const r of sorted) {
    if (matchRule(r, f)) return { rule: r };
  }
  return null;
}