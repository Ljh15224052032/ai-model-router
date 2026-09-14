// 上游额度指示器：侧边栏底部紧凑 chip（最紧俏渠道余量）+ hover 明细面板
// 数据来自通用适配器聚合端点；无启用渠道时不渲染；点击跳设置页管理
import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { get } from '../api';

export type QuotaItem = { label: string; remaining: number; limit?: number; unit: 'count' | 'money'; currency?: string; resetAt?: string | null };
export type QuotaSource = { id: string; name: string; kind: 'window' | 'balance'; status: 'ok' | 'unavailable'; items: QuotaItem[]; error?: string; fetchedAt?: string };

// 剩余占比与健康色（>30% 正常 / 10-30% 橙 / <10% 红）
const rateOf = (src: QuotaSource): number | null => {
  const it = src.items[0];
  if (src.status !== 'ok' || !it?.limit) return null;
  return Math.max(0, Math.min(100, Math.round((it.remaining / it.limit) * 100)));
};
const rateColor = (pct: number) => (pct > 30 ? 'var(--ok)' : pct > 10 ? 'var(--warn)' : 'var(--err)');
const fmtMoney = (v: number, ccy?: string) => `${ccy === 'USD' ? '$' : '¥'}${v.toFixed(2)}`;

// 迷你环：16px，展示占比
function MiniRing({ pct }: { pct: number }) {
  const C = 2 * Math.PI * 6;
  return (
    <svg viewBox="0 0 16 16" className="h-4 w-4 -rotate-90 shrink-0">
      <circle cx="8" cy="8" r="6" fill="none" stroke="var(--panel-2)" strokeWidth="2.5" />
      <circle cx="8" cy="8" r="6" fill="none" stroke={rateColor(pct)} strokeWidth="2.5" strokeLinecap="round" strokeDasharray={`${(pct / 100) * C} ${C}`} />
    </svg>
  );
}

// 渠道明细行（面板内）
function SourceLine({ src }: { src: QuotaSource }) {
  const ok = src.status === 'ok' && src.items.length > 0;
  const pct = rateOf(src);
  return (
    <div className={`flex items-center justify-between gap-4 py-1.5 ${ok ? '' : 'opacity-55'}`} title={src.error}>
      <span className="flex min-w-0 items-center gap-1.5 text-xs text-dim">
        {pct !== null && <span className="h-1.5 w-1.5 shrink-0 rounded-full" style={{ background: rateColor(pct) }} />}
        <span className="truncate">{src.name}</span>
      </span>
      <span className="tnum shrink-0 text-xs text-ink">
        {ok
          ? src.items.map((it) =>
            it.unit === 'money'
              ? fmtMoney(it.remaining, it.currency)
              : `${it.remaining}${it.limit !== undefined ? ` / ${it.limit}` : ''}`
          ).join(' · ')
          : '不可用'}
      </span>
    </div>
  );
}

export function UsageIndicator() {
  const [sources, setSources] = useState<QuotaSource[]>([]);
  const [open, setOpen] = useState(false);
  const navigate = useNavigate();

  const load = () => { get<{ sources: QuotaSource[] }>('/api/usage/summary').then((r) => setSources(r.sources)).catch(() => {}); };
  // mount 拉一次 + 60s 轮询（后端聚合缓存 60s；保证额度源启用/停用后指示器自动更新）
  useEffect(() => {
    load();
    const t = setInterval(load, 60_000);
    return () => clearInterval(t);
  }, []);

  // 最紧俏渠道的剩余率（窗口型取剩余率，余额型无数值则只计渠道数）
  const rates = sources.map(rateOf).filter((r): r is number => r !== null);
  const tight = rates.length > 0 ? Math.min(...rates) : null;

  if (sources.length === 0) return null;

  return (
    <div className="relative px-3 pb-3" onMouseEnter={() => { setOpen(true); load(); }} onMouseLeave={() => setOpen(false)}>
      {/* chip：迷你环 + 最紧俏余量 */}
      <button
        type="button"
        onClick={() => navigate('/settings')}
        className="flex w-full items-center gap-2 rounded-lg border border-line px-2.5 py-1.5 text-xs text-dim transition-all duration-150 hover:bg-panel2 hover:text-ink"
      >
        {tight !== null ? (
          <>
            <MiniRing pct={tight} />
            <span className={`tnum font-medium ${tight <= 10 ? 'text-err' : tight <= 30 ? 'text-warn' : ''}`}>{tight}%</span>
          </>
        ) : (
          <span className="truncate">{sources.length} 个额度源</span>
        )}
      </button>

      {/* hover 明细面板：向右上方弹出 */}
      {open && (
        <div className="absolute bottom-0 left-full z-50 ml-2 w-64 rounded-xl border border-line bg-panel p-3 shadow-[var(--shadow-pop)]">
          <div className="mb-1 text-xs font-medium text-ink">上游额度</div>
          <div className="divide-y divide-line/60">
            {sources.map((s) => <SourceLine key={s.id} src={s} />)}
          </div>
          <div className="mt-2 border-t border-line pt-2 text-[11px] text-dim/60">点击指示器进入设置管理</div>
        </div>
      )}
    </div>
  );
}
