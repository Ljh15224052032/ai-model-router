// 模型库存取：单价/上下文/能力
import { getDb } from './db.ts';
import type { Policy } from '../types.ts';

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

export function listModels(): ModelInfo[] {
  const rows = getDb().prepare('SELECT * FROM model_catalog ORDER BY provider, model').all() as Array<{
    model: string; provider: string; display_name: string | null; context_window: number | null;
    input_price: number; output_price: number; supports_tools: number; tags: string | null; enabled: number; note: string | null;
  }>;
  return rows.map((r) => ({
    model: r.model,
    provider: r.provider,
    displayName: r.display_name,
    contextWindow: r.context_window,
    inputPrice: r.input_price,
    outputPrice: r.output_price,
    supportsTools: !!r.supports_tools,
    tags: (r.tags ?? '').split(',').filter(Boolean),
    enabled: !!r.enabled,
    note: r.note,
  }));
}

// 方案里配置到的模型集合，供 /v1/models 返回
export function policyModels(policies: Policy[]): string[] {
  const set = new Set<string>();
  for (const p of policies) {
    p.rules.forEach((r) => set.add(r.then.model));
    set.add(p.fallback.model);
  }
  return [...set];
}

export function getModelCost(model: string): { inputPrice: number; outputPrice: number } {
  const row = getDb().prepare('SELECT input_price, output_price FROM model_catalog WHERE model = ?').get(model) as
    | { input_price: number; output_price: number }
    | undefined;
  return { inputPrice: row?.input_price ?? 0, outputPrice: row?.output_price ?? 0 };
}