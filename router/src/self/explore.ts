// 自进化 L2：在线小流量探索（保守，默认关闭）
// 在 tier 主指派确定后，以低概率把该格模型替换为一个候选探索模型，给没数据的模型攒样本；
// 探索流量 final_model=候选、route_source 仍为 tier（以便被 optimizer 统计到候选在该格的表现），
// 原主模型写入 request_logs.explored_from 供审计。探索模型必须 enabled 且在指定列表内、不得是当前主模型、不得处于冷却。
import { getSetting } from '../db/settings.ts';
import { listModels } from '../db/models.ts';
import { isCooled } from '../core/health.ts';

export interface ExploreOutcome {
  model: string;
  exploredFrom: string | null; // 原主模型；null=未探索
}

// 决策函数：给定 tier 主模型，返回最终模型与是否探索
export function maybeExplore(currentModel: string): ExploreOutcome {
  // 未开启 / 无 token 环境兜底（不依赖 token，仅概率与配置）
  if ((getSetting('self_evolve_explore_enabled') ?? '0') !== '1') {
    return { model: currentModel, exploredFrom: null };
  }
  const rate = clamp01(getNum('self_evolve_explore_rate', 0.05));
  if (Math.random() >= rate) {
    return { model: currentModel, exploredFrom: null };
  }

  const enabledSet = new Set(listModels().filter((m) => m.enabled).map((m) => m.model));
  const candidates = (getSetting('self_evolve_explore_models') ?? 'k3,k3-256k')
    .split(',')
    .map((s) => s.trim())
    .filter((m) => m && m !== currentModel && enabledSet.has(m) && !isCooled(m) && m !== currentModel);

  if (!candidates.length) {
    return { model: currentModel, exploredFrom: null };
  }
  // 等概率随机选一个候选
  const pick = candidates[Math.floor(Math.random() * candidates.length)];
  return { model: pick, exploredFrom: currentModel };
}

function getNum(key: string, fallback: number): number {
  const v = getSetting(key);
  if (v === null) return fallback;
  const n = parseFloat(v);
  return Number.isFinite(n) ? n : fallback;
}
function clamp01(n: number): number {
  return Math.min(1, Math.max(0, n));
}