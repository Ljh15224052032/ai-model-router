// 模型健康状态（P2 持久化版）：连续失败达到阈值 → 冷却窗口内绕开（DSH/LiteLLM 健康路由轻量版）
// 存储：model_health 表（重启不丢）；内存缓存为热路径读源，状态变更即落库
// 规则首选模型不受冷却改道（用户显式意图），仅过滤后缀链
import { getDb } from '../db/db.ts';
import { getSetting } from '../db/settings.ts';

interface HealthState {
  fails: number;
  cooledUntil: number;
}

const cache = new Map<string, HealthState>();
let loaded = false;

function cooldownParams(): { threshold: number; seconds: number } {
  const threshold = Number(getSetting('cooldown_fail_threshold')) || 3;
  const seconds = Number(getSetting('cooldown_seconds')) || 300;
  return { threshold, seconds };
}

// 启动懒加载：从库读入未过期的健康状态（内存态优先，库仅作持久化）
function load() {
  if (loaded) return;
  loaded = true;
  try {
    const rows = getDb().prepare('SELECT model, fails, cooled_until FROM model_health').all() as Array<{ model: string; fails: number; cooled_until: number }>;
    const now = Date.now();
    for (const r of rows) {
      if (r.cooled_until && r.cooled_until <= now) continue; // 已过期不载入
      cache.set(r.model, { fails: r.fails, cooledUntil: r.cooled_until });
    }
  } catch (e) {
    console.error('[router] model_health 加载失败:', e);
  }
}

// 落库失败不影响路由（健康状态仅影响候选过滤）
function persist(model: string, state: HealthState | null) {
  try {
    if (!state) {
      getDb().prepare('DELETE FROM model_health WHERE model = ?').run(model);
      return;
    }
    getDb().prepare(
      `INSERT INTO model_health (model, fails, cooled_until, updated_at) VALUES (?, ?, ?, datetime('now'))
       ON CONFLICT(model) DO UPDATE SET fails=excluded.fails, cooled_until=excluded.cooled_until, updated_at=excluded.updated_at`
    ).run(model, state.fails, state.cooledUntil);
  } catch (e) {
    console.error('[router] model_health 写入失败:', e);
  }
}

export function recordFail(model: string) {
  load();
  const now = Date.now();
  const cur = cache.get(model);
  const { threshold, seconds } = cooldownParams();
  const fails = (cur?.fails ?? 0) + 1;
  const cooledUntil = fails >= threshold ? now + seconds * 1000 : cur?.cooledUntil ?? 0;
  cache.set(model, { fails, cooledUntil });
  persist(model, { fails, cooledUntil });
}

export function recordSuccess(model: string) {
  load();
  cache.delete(model); // 成功即清零
  persist(model, null);
}

// 手动解除冷却（管理 API 用）
export function clearHealth(model: string) {
  load();
  cache.delete(model);
  persist(model, null);
}

// 冷却判定：threshold 未达成前返回 false（仅统计，不拦截）
export function isCooled(model: string): boolean {
  load();
  const cur = cache.get(model);
  if (!cur) return false;
  if (cur.fails < cooldownParams().threshold) return false;
  if (Date.now() < cur.cooledUntil) return true;
  cache.delete(model); // 冷却期过自动清除（内存 + 库）
  persist(model, null);
  return false;
}

export function healthSnapshot(): Array<{ model: string; fails: number; cooledUntil: number; cooling: boolean }> {
  load();
  const now = Date.now();
  const { threshold } = cooldownParams();
  return [...cache.entries()].map(([model, st]) => ({
    model,
    fails: st.fails,
    cooledUntil: st.cooledUntil,
    cooling: st.fails >= threshold && now < st.cooledUntil,
  }));
}
