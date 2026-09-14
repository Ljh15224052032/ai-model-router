// 请求日志：流水表 + 过滤 + 失败可视化 + 自动刷新
import { RefreshCw } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { get } from '../api';
import { Card, Empty, Select, Tag, Toggle } from '../components/ui';
import type { LogRow } from '../types';

const srcColor: Record<string, 'ok' | 'warn' | 'dim' | 'accent'> = { rule: 'ok', judge: 'warn', fallback: 'dim', passthrough: 'accent' };

// SQLite datetime('now') 为 UTC（"2026-09-12 07:34:44"），补 Z 转本地；显示 MM-DD HH:mm:ss（年份省略）
const fmtTime = (raw: string) => {
  const d = new Date(raw.includes('T') ? raw : `${raw.replace(' ', 'T')}Z`);
  if (Number.isNaN(d.getTime())) return raw;
  const p = (n: number) => String(n).padStart(2, '0');
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
};

export function Logs() {
  const [rows, setRows] = useState<LogRow[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [source, setSource] = useState('');
  const [model, setModel] = useState('');
  const [models, setModels] = useState<string[]>([]);
  const [err, setErr] = useState('');
  const [autoRefresh, setAutoRefresh] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const reqSeq = useRef(0);

  // 加载器（参数变化 / 手动刷新 / 定时器共用）：请求序号丢弃过期响应，成功时清空旧错误
  const load = useCallback(async () => {
    const seq = ++reqSeq.current;
    try {
      const q = new URLSearchParams({ page: String(page), limit: '20' });
      if (source) q.set('source', source);
      if (model) q.set('model', model);
      const r = await get<{ total: number; rows: LogRow[] }>(`/api/logs?${q}`);
      if (seq !== reqSeq.current) return;
      setRows(r.rows);
      setTotal(r.total);
      setErr('');
    } catch (e) { if (seq === reqSeq.current) setErr(String((e as Error).message)); }
  }, [page, source, model]);

  useEffect(() => { load(); }, [load]);

  // 自动刷新：10s 轮询，开关关闭或离开页面时停止
  useEffect(() => {
    if (!autoRefresh) return;
    const t = setInterval(load, 10000);
    return () => clearInterval(t);
  }, [autoRefresh, load]);

  useEffect(() => {
    get<Array<{ model: string }>>('/api/models').then((m) => setModels(m.map((x) => x.model))).catch(() => {});
  }, []);

  const manualRefresh = () => {
    load();
    setRefreshing(true);
    window.setTimeout(() => setRefreshing(false), 600);
  };

  return (
    <div className="mx-auto max-w-6xl p-6">
      <div className="mb-4 flex items-center justify-between">
        <h1 className="text-lg font-semibold text-ink">请求日志</h1>
        <div className="flex items-center gap-2">
          <Select value={source} onChange={(v) => { setPage(1); setSource(v); }} options={[{ value: '', label: '全部来源' }, { value: 'rule', label: '规则' }, { value: 'judge', label: '裁判' }, { value: 'fallback', label: '兜底' }, { value: 'passthrough', label: '透传' }]} />
          <Select value={model} onChange={(v) => { setPage(1); setModel(v); }} options={[{ value: '', label: '全部模型' }, ...models.map((m) => ({ value: m, label: m }))]} />
          <div className="ml-1 flex items-center gap-2 border-l border-line pl-2.5">
            <span className="text-xs text-dim">自动刷新</span>
            <Toggle checked={autoRefresh} onChange={setAutoRefresh} />
            <button
              onClick={manualRefresh}
              title="刷新"
              className="flex h-7 w-7 items-center justify-center rounded-lg border border-line text-dim transition-all duration-150 hover:bg-panel2 hover:text-ink active:scale-95"
            >
              <RefreshCw size={13} className={refreshing ? 'animate-spin' : ''} />
            </button>
          </div>
        </div>
      </div>
      {err && <div className="mb-2 text-xs text-err">{err}</div>}

      {rows.length === 0 ? <Empty text="暂无请求记录" /> : (
        <Card>
          <table className="w-full text-left text-xs">
            <thead>
              <tr className="border-b border-line text-dim">
                <th className="whitespace-nowrap py-2 pr-3 font-medium">时间</th>
                <th className="whitespace-nowrap py-2 pr-3 font-medium">请求模型</th>
                <th className="whitespace-nowrap py-2 pr-3 font-medium">来源</th>
                <th className="whitespace-nowrap py-2 pr-3 font-medium">规则</th>
                <th className="whitespace-nowrap py-2 pr-3 font-medium">最终模型</th>
                <th className="whitespace-nowrap py-2 pr-3 font-medium">状态</th>
                <th className="whitespace-nowrap py-2 pr-3 text-right font-medium">延迟</th>
                <th className="whitespace-nowrap py-2 pr-3 text-right font-medium">tokens</th>
                <th className="whitespace-nowrap py-2 text-right font-medium">成本 $</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id} className={`border-b border-line/50 last:border-0 ${r.status === 'fail' ? 'bg-err/5' : ''}`}>
                  <td className="whitespace-nowrap py-2 pr-3 font-mono text-dim">{fmtTime(r.created_at)}</td>
                  <td className="max-w-[150px] truncate whitespace-nowrap py-2 pr-3 font-mono" title={r.requested_model}>
                    {r.requested_model === 'auto'
                      ? <span className="text-dim/50" title="auto：由路由自动判定模型">{r.requested_model}</span>
                      : r.requested_model}
                  </td>
                  <td className="whitespace-nowrap py-2 pr-3"><Tag color={srcColor[r.route_source as keyof typeof srcColor] ?? 'dim'}>{r.route_source}</Tag></td>
                  <td className="max-w-[110px] truncate whitespace-nowrap py-2 pr-3 font-mono text-dim" title={r.rule_id ?? undefined}>{r.rule_id ?? <span className="text-dim/50">—</span>}</td>
                  <td className="max-w-[150px] whitespace-nowrap py-2 pr-3">
                    <button
                      onClick={() => { setPage(1); setModel(model === r.final_model ? '' : r.final_model); }}
                      title={model === r.final_model ? '取消筛选，查看全部模型' : `只看 ${r.final_model} 的记录`}
                      className={`block max-w-[150px] truncate rounded px-1.5 py-0.5 font-mono transition-colors duration-150 ${
                        model === r.final_model ? 'bg-accent-soft text-accent' : 'text-accent/80 hover:bg-accent-soft/60 hover:text-accent'
                      }`}
                    >
                      {r.final_model}
                    </button>
                  </td>
                  <td className="whitespace-nowrap py-2 pr-3">
                    {r.status === 'fail'
                      ? <Tag color="err" title={r.error ?? undefined}>失败</Tag>
                      : <span className="text-dim/50">—</span>}
                  </td>
                  <td className="whitespace-nowrap py-2 pr-3 text-right font-mono">{r.latency_ms.toLocaleString()}ms</td>
                  <td className="whitespace-nowrap py-2 pr-3 text-right font-mono">
                    {(r.prompt_tokens + r.completion_tokens) ? (r.prompt_tokens + r.completion_tokens).toLocaleString() : <span className="text-dim/50">—</span>}
                  </td>
                  <td className="whitespace-nowrap py-2 text-right font-mono">
                    {r.cost_usd > 0 ? r.cost_usd.toFixed(6) : <span className="text-dim/50">—</span>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className="mt-3 flex items-center justify-between text-xs text-dim">
            <span>共 {total.toLocaleString()} 条</span>
            <div className="flex items-center gap-1.5">
              <button
                className="rounded-lg border border-line px-2.5 py-1 transition-colors duration-150 hover:bg-panel2 hover:text-ink disabled:pointer-events-none disabled:opacity-40"
                disabled={page <= 1}
                onClick={() => setPage(page - 1)}
              >
                上一页
              </button>
              <span className="font-mono px-1">{page} / {Math.max(1, Math.ceil(total / 20))}</span>
              <button
                className="rounded-lg border border-line px-2.5 py-1 transition-colors duration-150 hover:bg-panel2 hover:text-ink disabled:pointer-events-none disabled:opacity-40"
                disabled={page * 20 >= total}
                onClick={() => setPage(page + 1)}
              >
                下一页
              </button>
            </div>
          </div>
        </Card>
      )}
    </div>
  );
}
