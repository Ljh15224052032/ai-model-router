// 请求流水落库（统计唯一数据源，方案文档 7.3）
import { getDb } from '../db/db.ts';
import type { Usage } from '../upstream/newapi-client.ts';

export interface LogEntry {
  client?: string;
  requestedModel: string;
  policyId: string | null;
  ruleId: string | null;
  routeSource: string;
  judgeResultJson: string | null;
  finalModel: string;
  provider: string | null;
  contextAction: string;
  usage: Usage | null;
  costUsd: number;
  latencyMs: number;
  status: 'success' | 'fail';
  error?: string;
  degraded?: number; // 命中降级链（onError/escalate）次数
  retried?: number; // 重试次数
  orchId?: string; // M9 编排：同一编排请求共享 id（planner/worker/synthesis）
  orchRole?: 'planner' | 'worker' | 'synthesis'; // M9 编排：子调用角色
  exploreFrom?: string | null; // L2 在线探索：记录探索前的主模型
}

export function insertLog(e: LogEntry) {
  const db = getDb();
  db.prepare(
    `INSERT INTO request_logs
      (client, requested_model, policy_id, rule_id, route_source, judge_result_json, final_model, provider, context_action,
       prompt_tokens, completion_tokens, cached_tokens, cost_usd, latency_ms, status, error, degraded, retried, orch_id, orch_role, explored_from)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    e.client ?? null,
    e.requestedModel,
    e.policyId,
    e.ruleId,
    e.routeSource,
    e.judgeResultJson,
    e.finalModel,
    e.provider ?? null,
    e.contextAction,
    e.usage?.promptTokens ?? 0,
    e.usage?.completionTokens ?? 0,
    e.usage?.cachedTokens ?? 0,
    e.costUsd,
    e.latencyMs,
    e.status,
    e.error ?? null,
    e.degraded ?? 0,
    e.retried ?? 0,
    e.orchId ?? null,
    e.orchRole ?? null,
    e.exploreFrom ?? null
  );
}

// 估算成本：单价为每百万 token 美元
export function estimateCost(usage: Usage | null, inputPrice: number, outputPrice: number): number {
  if (!usage) return 0;
  const inTokens = usage.promptTokens - (usage.cachedTokens ?? 0);
  const outTokens = usage.completionTokens;
  // 缓存命中按 1/10 计价（DeepSeek 官方约 1/50，Kimi 未知；保守取 0.1）
  const cachedPrice = inputPrice * 0.1;
  return (inTokens * inputPrice + (usage.cachedTokens ?? 0) * cachedPrice + outTokens * outputPrice) / 1_000_000;
}