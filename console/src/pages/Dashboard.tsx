// 仪表盘：面向真实数据量——数据稀疏（<3 天）时趋势退化为当日大数 + 来源比例条
import * as echarts from 'echarts';
import { useEffect, useRef, useState } from 'react';
import { get } from '../api';
import { Card, Empty, StatCard } from '../components/ui';
import { getChartColors, tooltipStyle } from '../lib/chart';
import { onThemeChange } from '../lib/theme';
import type { PeriodCost, PeriodStats, StatsSummary } from '../types';

// 来源比例条的单色阶梯（同一 accent 不同透明度，克制不花哨）
const srcOpacity = [1, 0.62, 0.42, 0.28, 0.16, 0.1];
const srcName: Record<string, string> = { rule: '规则', judge: '裁判', tier: '档位', fallback: '兜底', passthrough: '透传', summarize: '摘要' };

// tokens 千进制缩写（K/M），完整值放 sub 保留精度
const fmtTokens = (v: number) => (v >= 1e6 ? `${(v / 1e6).toFixed(2)}M` : v >= 1e3 ? `${(v / 1e3).toFixed(1)}K` : String(v));

// 本地今天（YYYY-MM-DD）：与后端 localtime 切天口径一致
const todayStr = () => {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
};

// 概览周期切换
const RANGES = [
  { value: 'today', label: '今日' },
  { value: 'week', label: '本周' },
  { value: 'month', label: '本月' },
] as const;
type Range = (typeof RANGES)[number]['value'];
const RANGE_TITLE: Record<Range, string> = { today: '今日概览', week: '本周概览', month: '本月概览' };

// 今日/本周/本月分段切换器（今日概览与成本分析卡各自独立使用）
function RangeSwitch({ value, onChange }: { value: Range; onChange: (r: Range) => void }) {
  return (
    <div className="flex items-center gap-0.5 rounded-lg border border-line bg-panel2 p-0.5">
      {RANGES.map((r) => (
        <button
          key={r.value}
          type="button"
          onClick={() => onChange(r.value)}
          className={`rounded-md px-2 py-0.5 text-xs transition-all duration-150 ${value === r.value ? 'bg-panel text-ink shadow-sm' : 'text-dim hover:text-ink'}`}
        >
          {r.label}
        </button>
      ))}
    </div>
  );
}
// 周期范围文案：今日显示日期，周/月显示起点
const rangeLabel = (p: PeriodStats | null) =>
  !p ? '—' : p.range === 'today' ? p.to : p.range === 'week' ? `本周 · ${p.from} 起` : `本月 · ${p.from.slice(0, 7)}`;

export function Dashboard() {
  const [stats, setStats] = useState<StatsSummary | null>(null);
  const [range, setRange] = useState<Range>('today');
  // 成本分析卡独立周期（与今日概览分开控制，互不联动）
  const [costRange, setCostRange] = useState<Range>('today');
  const [period, setPeriod] = useState<PeriodStats | null>(null);
  const chartRef = useRef<HTMLDivElement>(null);
  const costLineRef = useRef<HTMLDivElement>(null);
  const barRef = useRef<HTMLDivElement>(null);
  const pieRef = useRef<HTMLDivElement>(null);
  const [err, setErr] = useState('');
  const [colors, setColors] = useState(getChartColors());
  // P2 校准报表：错配列表（低价值任务用高价模型 / 单请求成本超阈值）
  const [mismatch, setMismatch] = useState<Array<{ id: number; created_at: string; final_model: string; task_type: string; cost_usd: number; rule: string }> | null>(null);
  // 校准提示可关闭：按最新一条错配的 id 记忆（sessionStorage，会话内刷新不复活）；出现新错配才重新提示
  const [mismatchDismissed, setMismatchDismissed] = useState(() => sessionStorage.getItem('router-mismatch-dismissed') ?? '');
  // M6 峰谷成本：近 14 天高峰/非高峰时段对比（null=首次加载中，'err'=接口不可用；切换周期时保留旧数据防屏闪）
  const [periodCost, setPeriodCost] = useState<PeriodCost | null | 'err'>(null);
  // 成本卡切换周期时的过渡态：true=拉取中（旧数据减淡+禁点），false=新数据淡入
  const [costLoading, setCostLoading] = useState(true);
  // M6 渠道成本分布：按供应商聚合请求数与成本
  const [byProvider, setByProvider] = useState<Array<{ provider: string | null; c: number; cost: number }>>([]);
  // M9.3 编排统计：近 14 天编排次数 / 子任务成功率 / worker 成本
  const [orch, setOrch] = useState<{ orchs: number; avgWorkers: number; workerOkRate: number; costUsd: number; plannerModel: string; recent: Array<{ orch_id: string; workers: number; workers_ok: number; cost_usd: number; started: string }> } | null>(null);

  useEffect(() => onThemeChange(() => setColors(getChartColors())), []);

  useEffect(() => {
    get<StatsSummary>('/api/stats/summary').then(setStats).catch((e) => setErr(String((e as Error).message)));
    get<{ items: Array<{ id: number; created_at: string; final_model: string; task_type: string; cost_usd: number; rule: string }> }>('/api/stats/mismatch')
      .then((r) => setMismatch(r.items ?? []))
      .catch(() => setMismatch([]));
    get<{ orchs: number; avgWorkers: number; workerOkRate: number; costUsd: number; plannerModel: string; recent: Array<{ orch_id: string; workers: number; workers_ok: number; cost_usd: number; started: string }> }>('/api/stats/orchestration')
      .then(setOrch)
      .catch(() => setOrch(null));
  }, []);

  // 成本分析卡数据：跟随自身独立周期切换；切换时保留旧数据（减淡过渡），两接口齐了再整卡淡入，避免屏闪
  useEffect(() => {
    setCostLoading(true);
    let cancelled = false;
    Promise.all([
      get<PeriodCost>(`/api/stats/period-cost?range=${costRange}`),
      get<Array<{ provider: string | null; c: number; cost: number }>>(`/api/stats/by-provider?range=${costRange}`),
    ]).then(([pc, bp]) => {
      if (cancelled) return;
      setPeriodCost(pc);
      setByProvider(Array.isArray(bp) ? bp : []);
      setCostLoading(false);
    }).catch(() => {
      if (cancelled) return;
      setPeriodCost('err');
      setCostLoading(false);
    });
    return () => { cancelled = true; };
  }, [costRange]);

  // 概览卡周期数据：大数字与来源分布同源
  useEffect(() => {
    get<PeriodStats>(`/api/stats/period?range=${range}`).then(setPeriod).catch(() => {});
  }, [range]);

  // ---- 派生数据（供各图表 useEffect 与 JSX 使用；必须声明在所有 useEffect 之前）----
  const sources = stats ? [...stats.bySource].sort((a, b) => b.c - a.c) : [];
  const periodSources = period ? [...period.bySource].sort((a, b) => b.c - a.c) : [];
  const daysWithData = stats ? stats.recent.filter((d) => d.c > 0).length : 0;
  const degraded = stats !== null && daysWithData < 3;
  // 派生：用于 Card claim title（按置信度直接展示真实数据，不靠 hover）
  const avgPerDay = stats && daysWithData > 0 ? Math.round(stats.recent.reduce((s, d) => s + d.c, 0) / daysWithData) : 0;
  const topModel = stats ? [...stats.byModel].sort((a, b) => b.cost - a.cost)[0] : null;
  const topModelPct = stats && topModel && stats.byModel.reduce((s, m) => s + m.cost, 0) > 0
    ? Math.round((topModel.cost / stats.byModel.reduce((s, m) => s + m.cost, 0)) * 100)
    : 0;
  const topSrc = sources.length > 0 ? sources[0] : null;
  const topSrcPct = stats && topSrc && stats.total.c > 0 ? Math.round((topSrc.c / stats.total.c) * 100) : 0;
  // 渠道按成本排序；provider 为空（透传等）记「未知」；maxCost 用于 in-cell bar 视觉编码
  const providers = [...byProvider].sort((a, b) => b.cost - a.cost);
  const maxCost = providers.length > 0 && providers[0].cost > 0 ? providers[0].cost : 1;
  // 趋势（≥3 天）small multiples——上图请求柱 + 下图成本线，共享 X 轴对齐（替代双 Y 轴，避免反模式）
  useEffect(() => {
    if (!stats || degraded || !chartRef.current) return;
    const chart = echarts.init(chartRef.current);
    const c = colors;
    const days = [...stats.recent].reverse();
    chart.setOption({
      backgroundColor: 'transparent',
      grid: { left: 36, right: 16, top: 4, bottom: 4 },
      tooltip: { trigger: 'axis', ...tooltipStyle(c) },
      xAxis: {
        type: 'category', data: days.map((d) => d.d),
        axisLine: { lineStyle: { color: c.axisLine } },
        axisTick: { show: false },
        axisLabel: { show: false },
      },
      yAxis: {
        type: 'value', splitLine: { lineStyle: { color: c.splitLine } },
        axisLabel: { color: c.label, fontSize: 10 },
      },
      series: [{
        name: '请求数', type: 'bar', data: days.map((d) => d.c),
        itemStyle: { color: c.accentSoft, borderRadius: [3, 3, 0, 0] }, barWidth: '50%',
      }],
    });
    const onResize = () => chart.resize();
    window.addEventListener('resize', onResize);
    return () => { window.removeEventListener('resize', onResize); chart.dispose(); };
  }, [stats, colors, degraded]);

  // 成本线（与上图共享 X 轴对齐的 small multiple 下图）：单 Y 轴，避免双轴解释成本
  useEffect(() => {
    if (!stats || degraded || !costLineRef.current) return;
    const chart = echarts.init(costLineRef.current);
    const c = colors;
    const days = [...stats.recent].reverse();
    chart.setOption({
      backgroundColor: 'transparent',
      grid: { left: 36, right: 16, top: 4, bottom: 18 },
      tooltip: { trigger: 'axis', ...tooltipStyle(c), valueFormatter: (v: number) => `$${Number(v).toFixed(4)}` },
      xAxis: {
        type: 'category', data: days.map((d) => d.d),
        axisLine: { lineStyle: { color: c.axisLine } },
        axisTick: { show: false },
        axisLabel: { color: c.label, fontSize: 10, formatter: (v: string) => v.slice(5) },
      },
      yAxis: {
        type: 'value', splitLine: { lineStyle: { color: c.splitLine } },
        axisLabel: { color: c.label, fontSize: 10, formatter: (v: number) => `$${v}` },
      },
      series: [{
        name: '成本 ($)', type: 'line', smooth: true, data: days.map((d) => Number(d.cost.toFixed(6))),
        lineStyle: { color: c.accent, width: 2 }, itemStyle: { color: c.accent },
        showSymbol: days.length <= 6, symbolSize: 5,
        areaStyle: { color: c.accent, opacity: 0.08 },
      }],
    });
    const onResize = () => chart.resize();
    window.addEventListener('resize', onResize);
    return () => { window.removeEventListener('resize', onResize); chart.dispose(); };
  }, [stats, colors, degraded]);

  // 模型成本排行
  useEffect(() => {
    if (!stats || !barRef.current) return;
    const chart = echarts.init(barRef.current);
    const c = colors;
    const byModel = [...stats.byModel].sort((a, b) => b.cost - a.cost).slice(0, 8);
    chart.setOption({
      backgroundColor: 'transparent',
      grid: { left: 100, right: 16, top: 10, bottom: 24 },
      tooltip: { trigger: 'axis', ...tooltipStyle(c) },
      xAxis: {
        type: 'value', splitLine: { lineStyle: { color: c.splitLine } },
        axisLabel: { color: c.label, fontSize: 11 },
      },
      yAxis: {
        type: 'category', data: byModel.map((m) => m.final_model),
        axisTick: { show: false },
        axisLabel: { color: c.label, fontSize: 11 },
      },
      series: [{
        name: '成本 ($)', type: 'bar', data: byModel.map((m) => Number(m.cost.toFixed(6))),
        itemStyle: { color: c.accent, borderRadius: [0, 4, 4, 0] }, barWidth: 14,
      }],
    });
    const onResize = () => chart.resize();
    window.addEventListener('resize', onResize);
    return () => { window.removeEventListener('resize', onResize); chart.dispose(); };
  }, [stats, colors]);

  // 路由来源分布：环形图直接标签（slice 旁标名称+百分比），删独立 legend，避免远端图例解码
  useEffect(() => {
    if (!pieRef.current || sources.length === 0) return;
    const chart = echarts.init(pieRef.current);
    const c = colors;
    chart.setOption({
      backgroundColor: 'transparent',
      tooltip: { trigger: 'item', ...tooltipStyle(c), formatter: '{b}: {c} 次 ({d}%)' },
      series: [{
        type: 'pie',
        radius: ['48%', '72%'],
        center: ['50%', '50%'],
        label: {
          show: true,
          color: c.label,
          fontSize: 11,
          formatter: '{b}\n{d}%',
        },
        labelLine: { length: 8, length2: 6, lineStyle: { color: c.axisLine } },
        emphasis: { scaleSize: 4 },
        itemStyle: { borderColor: c.tooltipBg, borderWidth: 2, borderRadius: 4 },
        data: sources.map((s, i) => ({
          name: srcName[s.route_source] ?? s.route_source,
          value: s.c,
          itemStyle: { color: c.accent, opacity: srcOpacity[i % srcOpacity.length] },
        })),
      }],
    });
    const onResize = () => chart.resize();
    window.addEventListener('resize', onResize);
    return () => { window.removeEventListener('resize', onResize); chart.dispose(); };
  }, [sources, colors]);

  if (err) return <div className="p-6 text-sm text-err">{err}</div>;
  if (!stats) return <div className="p-6"><Empty text="加载中…" /></div>;

  const maxDayC = Math.max(...stats.recent.map((d) => d.c), 1);

  return (
    <div className="mx-auto max-w-6xl p-6 lg:p-8">
      <h1 className="mb-5 text-xl font-semibold tracking-[-0.015em] text-ink">仪表盘</h1>

      <div className="mb-5 grid grid-cols-2 gap-4 md:grid-cols-4">
        <StatCard label="总请求" value={stats.total.c} sub="Router 服务至今" />
        <StatCard
          label="总成本"
          value={
            <span>
              ${stats.total.cost.toFixed(4)}
              <span className="ml-1.5 text-sm font-normal text-dim">≈ ¥{stats.total.costCny.toFixed(2)}</span>
            </span>
          }
          sub="按 model_catalog 单价估算"
        />
        <StatCard label="总 tokens" value={fmtTokens(stats.total.tokens)} sub={`${stats.total.tokens.toLocaleString()} · prompt + completion`} />
        <StatCard label="今日请求" value={stats.today ?? 0} sub={todayStr()} />
      </div>

      {/* P2 校准提示：错配非空且未被关闭时展示；× 关闭（同会话不再出现，新错配 id 变化才重新提示） */}
      {mismatch !== null && mismatch.length > 0 && mismatchDismissed !== String(mismatch[0].id) && (
        <div className="mb-5 rounded-xl border border-warn/25 bg-warn/5 px-4 py-3">
          <div className="mb-1.5 flex items-center gap-2 text-xs font-medium text-warn">
            校准提示 · {mismatch.length} 条错配
            <button
              type="button"
              aria-label="关闭校准提示"
              title="关闭（出现新错配时会再次提示）"
              onClick={() => {
                const id = String(mismatch[0].id);
                sessionStorage.setItem('router-mismatch-dismissed', id);
                setMismatchDismissed(id);
              }}
              className="ml-auto rounded p-0.5 leading-none text-dim transition-colors hover:bg-warn/10 hover:text-ink"
            >
              ×
            </button>
          </div>
          <div className="space-y-1">
            {mismatch.slice(0, 3).map((m) => (
              <div key={m.id} className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-ink">
                <span className="tnum text-dim">{m.created_at.slice(5, 16)}</span>
                <span className="font-mono">{m.final_model}</span>
                <span className="text-dim/80">
                  {m.rule === 'cost_over_threshold' ? `单请求成本 $${m.cost_usd.toFixed(6)}` : `低价值任务(${m.task_type || '?'})用高价模型`}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* 行 1：趋势 + 模型成本（等高；图表模式 small multiples 上下双图；退化模式=当日大数） */}
      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
        <Card
          title={degraded ? RANGE_TITLE[range] : `近 14 天 · 日均 ${avgPerDay} 次`}
          action={degraded ? <RangeSwitch value={range} onChange={setRange} /> : undefined}
        >
          {degraded ? (
            <div className="flex h-56 flex-col justify-center">
              <div className="flex items-end gap-2">
                <span className="tnum text-[44px] font-semibold leading-none tracking-[-0.03em] text-ink">{period?.c ?? 0}</span>
                <span className="mb-1 text-sm text-dim">次请求 · {rangeLabel(period)}</span>
              </div>
              {periodSources.length > 0 && (
                <>
                  <div className="mt-5 flex h-2.5 w-full overflow-hidden rounded-full bg-panel2">
                    {periodSources.map((s, i) => (
                      <div key={s.route_source} className="bg-accent" style={{ width: `${(s.c / period!.c) * 100}%`, opacity: srcOpacity[i % srcOpacity.length] }} />
                    ))}
                  </div>
                  <div className="mt-3 space-y-1.5">
                    {periodSources.map((s, i) => (
                      <div key={s.route_source} className="flex items-center gap-2 text-xs">
                        <span className="h-2 w-2 shrink-0 rounded-full bg-accent" style={{ opacity: srcOpacity[i % srcOpacity.length] }} />
                        <span className="text-dim">{srcName[s.route_source] ?? s.route_source}</span>
                        <span className="tnum ml-auto text-ink">{s.c}</span>
                        <span className="tnum w-10 text-right text-dim/70">{Math.round((s.c / period!.c) * 100)}%</span>
                      </div>
                    ))}
                  </div>
                </>
              )}
            </div>
          ) : (
            <div className="flex h-56 flex-col gap-1.5">
              <div className="flex items-center justify-between text-[10px] uppercase tracking-[0.16em] text-dim/70">
                <span>请求数</span>
              </div>
              <div ref={chartRef} className="h-[84px]" />
              <div className="flex items-center justify-between text-[10px] uppercase tracking-[0.16em] text-dim/70">
                <span>成本</span>
              </div>
              <div ref={costLineRef} className="h-[84px]" />
            </div>
          )}
        </Card>

        <Card title={topModel ? `成本 TOP1 · ${topModel.final_model} 占 ${topModelPct}%` : '模型成本'}>
          <div ref={barRef} className="h-56" />
        </Card>
      </div>

      {/* 行 2：成本分析（峰谷大数字+渠道表合并——两个标量不值得一张柱图）+ 来源饼图（图表模式）/ 最近 7 天（退化模式，来源已并入当日卡） */}
      <div className="mt-4 grid grid-cols-1 gap-4 md:grid-cols-2">
        <Card title={periodCost && periodCost !== 'err' && periodCost.totalCost > 0 ? `峰谷成本 · 高峰占 ${Math.round((periodCost.peakCost / periodCost.totalCost) * 100)}%` : '成本分析'} action={<RangeSwitch value={costRange} onChange={setCostRange} />}>
          <div className="flex h-56 flex-col">
            {periodCost === null || periodCost === 'err' ? (
              <div className="flex flex-1 items-center justify-center text-xs text-dim">
                {periodCost === 'err' ? '峰谷统计暂不可用' : '加载中…'}
              </div>
            ) : periodCost.totalCost <= 0 ? (
              <div className="flex flex-1 items-center justify-center text-xs text-dim">所选周期暂无成功请求</div>
            ) : (
              <div
                key={costLoading ? `${costRange}-l` : costRange}
                className={`flex flex-1 flex-col ${costLoading ? 'pointer-events-none opacity-40 transition-opacity duration-150' : 'animate-page-in'}`}
              >
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <div className="text-xs text-dim">高峰时段 <span className="text-dim/60">工作日 9-12 / 14-18</span></div>
                    <div className="tnum mt-1 text-[22px] font-semibold leading-tight tracking-[-0.02em] text-ink">${periodCost.peakCost.toFixed(4)}</div>
                    <div className="tnum mt-0.5 text-xs text-dim">{periodCost.peakC === 0 ? '无高峰时段请求' : `${periodCost.peakC} 次 · 占 ${Math.round((periodCost.peakCost / periodCost.totalCost) * 100)}%`}</div>
                  </div>
                  <div>
                    <div className="text-xs text-dim">非高峰</div>
                    <div className="tnum mt-1 text-[22px] font-semibold leading-tight tracking-[-0.02em] text-ink">${periodCost.offpeakCost.toFixed(4)}</div>
                    <div className="tnum mt-0.5 text-xs text-dim">{periodCost.offpeakC} 次 · 占 {Math.round((periodCost.offpeakCost / periodCost.totalCost) * 100)}%</div>
                  </div>
                </div>
                {/* 峰谷占比堆叠条：一组标量的形态就是比例，一根条说完 */}
                <div className="mt-3 flex h-2 overflow-hidden rounded-full bg-panel2">
                  <div className="bg-accent" style={{ width: `${(periodCost.peakCost / periodCost.totalCost) * 100}%` }} />
                  <div className="bg-accent/35" style={{ width: `${(periodCost.offpeakCost / periodCost.totalCost) * 100}%` }} />
                </div>
                <div className="tnum mt-1.5 text-xs text-dim">合计 ${periodCost.totalCost.toFixed(4)}</div>
                <div className="mt-auto border-t border-line pt-2.5">
                  <div className="mb-1.5 text-xs text-dim">渠道成本</div>
                  {providers.length === 0 ? (
                    <div className="text-xs text-dim/70">暂无成功请求</div>
                  ) : (
                    <div className="space-y-1.5">
                      {providers.map((p) => (
                        <div key={p.provider ?? 'unknown'} className="flex items-center gap-2 text-xs">
                          <span className="w-20 shrink-0 truncate text-ink" title={p.provider ?? ''}>{p.provider ?? '未知'}</span>
                          <div className="h-1.5 w-16 shrink-0 overflow-hidden rounded-full bg-panel2">
                            <div className="h-full rounded-full bg-accent" style={{ width: `${Math.max((p.cost / maxCost) * 100, p.cost > 0 ? 4 : 0)}%`, opacity: p.cost > 0 ? 1 : 0.3 }} />
                          </div>
                          <span className="tnum text-ink">${p.cost.toFixed(4)}</span>
                          <span className="tnum ml-auto text-dim/70">{p.c} 次</span>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              </div>
            )}
          </div>
        </Card>

        {degraded ? (
          <Card title="最近 7 天消耗">
            <div className="space-y-2">
              {stats.recent.slice(0, 7).map((d) => (
                <div key={d.d} className="flex items-center gap-2.5 text-xs">
                  <span className="tnum w-20 shrink-0 text-dim">{d.d}</span>
                  <div className="h-2 flex-1 overflow-hidden rounded-full bg-panel2">
                    <div className="h-full rounded-full bg-accent/60" style={{ width: `${(d.c / maxDayC) * 100}%` }} />
                  </div>
                  <span className="tnum w-12 text-right text-ink">{d.c} 次</span>
                  <span className="tnum w-24 text-right text-dim">${d.cost.toFixed(6)}</span>
                </div>
              ))}
            </div>
          </Card>
        ) : (
          <Card title={topSrc ? `路由来源 · ${srcName[topSrc.route_source] ?? topSrc.route_source} 占 ${topSrcPct}%` : '路由来源分布'}>
            {sources.length === 0 ? (
              <div className="flex h-56 items-center justify-center text-xs text-dim">暂无请求</div>
            ) : (
              <div ref={pieRef} className="h-56" />
            )}
          </Card>
        )}
      </div>

      {/* 行 3：编排模式（M9.3，整行）：核心指标 + 最近编排列表；未使用时给引导文案 */}
      <Card title="编排模式" className="mt-4" action={<span className="text-xs text-dim/70">近 14 天 · planner {orch?.plannerModel ?? '—'}</span>}>
        {!orch || orch.orchs === 0 ? (
          <div className="flex h-24 items-center justify-center text-xs text-dim">
            尚未使用编排——请求 model 传 <code className="mx-1 rounded bg-panel2 px-1.5 py-0.5 font-mono">auto@orchestrate</code> 即可触发「规划-执行分离」
          </div>
        ) : (
          <div>
            <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
              <div>
                <div className="text-xs text-dim">编排次数</div>
                <div className="tnum mt-1 text-[22px] font-semibold leading-tight tracking-[-0.02em] text-ink">{orch.orchs}</div>
              </div>
              <div>
                <div className="text-xs text-dim">平均子任务</div>
                <div className="tnum mt-1 text-[22px] font-semibold leading-tight tracking-[-0.02em] text-ink">{orch.avgWorkers}</div>
              </div>
              <div>
                <div className="text-xs text-dim">Worker 成功率</div>
                <div className="tnum mt-1 text-[22px] font-semibold leading-tight tracking-[-0.02em] text-ink">{orch.workerOkRate}%</div>
              </div>
              <div>
                <div className="text-xs text-dim">Worker 成本</div>
                <div className="tnum mt-1 text-[22px] font-semibold leading-tight tracking-[-0.02em] text-ink">${orch.costUsd.toFixed(4)}</div>
                <div className="tnum mt-0.5 text-xs text-dim">规划/合成走订阅（$0）</div>
              </div>
            </div>
            <div className="mt-4 border-t border-line pt-2.5">
              <div className="mb-1.5 text-xs text-dim">最近编排</div>
              <div className="space-y-1.5">
                {orch.recent.map((o) => {
                  const okPct = o.workers > 0 ? (o.workers_ok / o.workers) * 100 : 0;
                  const allOk = o.workers_ok === o.workers;
                  return (
                    <div key={o.orch_id} className="flex items-center gap-2 text-xs">
                      <span className="tnum text-dim">{o.started.slice(5, 16)}</span>
                      <span className="font-mono text-dim/70" title={o.orch_id}>{o.orch_id.slice(0, 14)}</span>
                      <div className="flex h-1.5 w-12 shrink-0 overflow-hidden rounded-full bg-panel2" title={`${o.workers_ok}/${o.workers} 成功`}>
                        <div className={allOk ? 'bg-ok' : 'bg-accent'} style={{ width: `${okPct}%` }} />
                      </div>
                      <span className="tnum ml-auto text-ink">{o.workers_ok}/{o.workers}</span>
                      <span className="tnum w-16 text-right text-dim">${o.cost_usd.toFixed(4)}</span>
                    </div>
                  );
                })}
              </div>
            </div>
          </div>
        )}
      </Card>
    </div>
  );
}
