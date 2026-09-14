// 前端类型（与 Router 端类型对应）
export interface Condition {
  field: string;
  op: 'eq' | 'ne' | 'gt' | 'gte' | 'lt' | 'lte' | 'in' | 'contains' | 'exists';
  value?: unknown;
}

export interface ContextPolicy {
  strategy: 'none' | 'truncate' | 'summarize';
  maxTokens?: number;
}

export type Complexity = 'low' | 'mid' | 'high';

// M8 档位表：taskType × complexity → 模型
export interface TierEntry {
  taskType: string;
  complexity: Complexity;
  model: string;
}
export interface PolicyTiers {
  entries: TierEntry[];
}

export interface Action {
  model: string;
  context?: ContextPolicy;
  maxCostUsd?: number;
  costDegrade?: string[];
  onError?: string[];   // P1：失败同档替代链
  escalate?: string[];  // P1：onError 全败后升级链
  reasonNote?: string;
}

export interface Rule {
  id: string;
  name: string;
  enabled: boolean;
  priority: number;
  when: Condition[];
  then: Action;
}

export interface Policy {
  id: string;
  name: string;
  enabled: boolean;
  isDefault: boolean;
  description?: string;
  rules: Rule[];
  fallback: Action;
  tiers?: PolicyTiers | null; // null=继承全局默认（settings tiers_default_json）
}

export interface ModelInfo {
  model: string;
  provider: string;
  displayName: string | null;
  contextWindow: number | null;
  inputPrice: number;
  outputPrice: number;
  supportsTools: boolean;
  tags: string[];
  enabled: boolean;
  note: string | null;
}

export interface TestRouteResp {
  decision: {
    finalModel: string;
    source: string;
    policyId: string | null;
    ruleId: string | null;
    reasonNote?: string;
    candidates?: string[]; // M8：首选+onError+escalate
    tier?: { taskType: string; complexity: string };
    judgeResult: { taskType: string; complexity: string; model: string; reason: string } | null;
    context: ContextPolicy;
  };
  features: {
    inputTokens: number;
    lastMsgChars: number;
    turnCount: number;
    hasTools: boolean;
    hasSystem: boolean;
    keywordsAny: string[];
    modelRequested: string;
  };
  contextAction: string;
}

// M8 模型健康（GET /api/health/models 返回数组；P2 持久化 + 可解除）
export interface ModelHealthItem {
  model: string;
  fails: number;
  cooledUntil: number;
  cooling: boolean;
}
export type ModelHealth = ModelHealthItem[];

export interface LogRow {
  id: number;
  created_at: string;
  client: string | null;
  requested_model: string;
  policy_id: string | null;
  rule_id: string | null;
  route_source: string;
  final_model: string;
  provider: string | null;
  context_action: string;
  prompt_tokens: number;
  completion_tokens: number;
  cached_tokens: number;
  cost_usd: number;
  latency_ms: number;
  status: string;
  error: string | null;
  judge_result_json: string | null;
}

export interface StatsSummary {
  total: { c: number; cost: number; costCny: number; tokens: number };
  today: number;
  byModel: Array<{ final_model: string; c: number; tokens: number; cost: number }>;
  bySource: Array<{ route_source: string; c: number }>;
  recent: Array<{ d: string; c: number; cost: number }>;
}

// 周期统计（概览卡：大数字 + 来源分布同源）
export interface PeriodStats {
  range: 'today' | 'week' | 'month';
  c: number;
  cost: number;
  bySource: Array<{ route_source: string; c: number }>;
  from: string;
  to: string;
}

// 峰谷成本（M6）：指定周期（today/week/month）的高峰/非高峰时段成本
export interface PeriodCost {
  range: string;
  peakCost: number;
  offpeakCost: number;
  peakC: number;
  offpeakC: number;
  peakCostX2: number;
  totalCost: number;
}