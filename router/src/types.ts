// 共享类型定义：路由方案 DSL（与方案文档第 4 节对应）

export interface Condition {
  field: string; // 特征字段名（见 Feature）
  op: 'eq' | 'ne' | 'gt' | 'gte' | 'lt' | 'lte' | 'in' | 'contains' | 'exists';
  value?: unknown; // eq/ne/gt... 的比较值；exists 不需要
}

export interface ContextPolicy {
  strategy: 'none' | 'truncate' | 'summarize';
  maxTokens?: number; // 生效阈值/上限（默认 60000）
  tailRounds?: number; // 保留最近 N 轮原文（默认 2，最后一条 user 永不截断）
  maxToolChars?: number; // L0 工具结果预算（默认 4000）
  summarizeModel?: string; // L2 摘要模型（默认取设置 summary_model 或 deepseek-flash）
}

// 档位映射（OpenSquilla 思路）：taskType×complexity → 模型；complexity 支持 'any' 通配
export interface TierEntry {
  taskType: string; // 任务类型或 'any'（通配）
  complexity: 'low' | 'mid' | 'high' | 'any';
  model: string;
}
export interface PolicyTiers {
  entries: TierEntry[];
}

export interface Action {
  model: string; // 目标模型 id（new-api 中的模型名）
  context?: ContextPolicy;
  maxCostUsd?: number;
  costDegrade?: string[]; // P2：预算超限降级链（仅非流式）
  onError?: string[]; // 失败同档替代链（依次试）
  escalate?: string[]; // onError 全败后升级链
  reasonNote?: string;
}

export interface Rule {
  id: string;
  name: string;
  enabled: boolean;
  priority: number; // 越小越先
  when: Condition[]; // AND 关系
  then: Action;
}

export interface Policy {
  id: string;
  name: string;
  enabled: boolean;
  isDefault: boolean;
  description?: string;
  rules: Rule[]; // 按 priority 升序匹配，首条命中即停
  fallback: Action; // 全部未命中时的动作
  tiers?: PolicyTiers | null; // null=继承全局默认档位
  updatedAt?: string;
}

// classifier 从请求中提取的特征
export interface Feature {
  inputTokens: number; // 全量消息估算 token
  lastMsgChars: number; // 最后一条用户消息字符数
  turnCount: number; // 对话轮数（user 消息数）
  hasTools: boolean;
  hasSystem: boolean;
  keywordsAny: string[]; // 最后用户消息命中的关键词
  modelRequested: string; // 原始请求 model
  client?: string; // 客户端标识（请求头或 model 后缀）
}

export interface JudgeResult {
  taskType: string;
  complexity: 'low' | 'mid' | 'high';
  model: string;
  reason: string;
}

export interface RouteDecision {
  finalModel: string;
  candidates: string[]; // 首选 + onError + escalate（冷却已过滤后缀链，首选保留）
  source: 'rule' | 'judge' | 'tier' | 'fallback' | 'passthrough' | 'degraded';
  policyId: string | null;
  ruleId: string | null;
  judgeResult: JudgeResult | null;
  tier?: { taskType: string; complexity: string };
  reasonNote?: string;
  context: ContextPolicy;
  costDegraded?: boolean; // P2：估算成本超 maxCostUsd，沿 costDegrade 链降级（仅非流式）
  exploreFrom?: string | null; // L2：在线探索时记录原主模型（探索流量落库标实，供审计与统计）
}