// 自进化：总开关与参数、手动触发一次、历史决策、一键回滚（L1：AI 决策 + 代码护栏）
import { Play, RotateCcw, ChevronDown } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { get, post, put } from '../api';
import { Button, Card, Empty, Input, Select, Spinner, Tag, Toggle } from '../components/ui';
import type { SelfEvolveInfo, SelfEvolveRunResp } from '../types';

const MODE_LABEL: Record<string, string> = {
  ai: 'AI 决策',
  'ai_guarded_tune': 'AI 决策（已过护栏）',
  'code-fallback': '代码兜底',
  code_tune: '纯代码微调',
  auto_tune: '纯代码微调',
  rollback: '回滚',
  skip: '跳过',
  none: '关闭',
};

const PARAMS: Array<{ key: string; label: string; hint: string; type?: string }> = [
  { key: 'self_evolve_interval_hours', label: '周期（小时）', hint: '自动运行的间隔' },
  { key: 'self_evolve_window_days', label: '统计窗口（天）', hint: '分析最近多少天数据' },
  { key: 'self_evolve_model', label: '决策模型', hint: '负责分析的 LLM（走 new-api）' },
  { key: 'self_evolve_min_sample', label: '最小样本数', hint: '某格证据不足则不强改' },
  { key: 'self_evolve_confidence', label: '最低置信度', hint: 'AI 建议 < 该值被护栏拦截', type: 'number' },
  { key: 'self_evolve_max_changes', label: '每轮最多改数', hint: '护栏限每轮改动格数上限' },
  { key: 'self_evolve_success_gate', label: '代码兜底门槛', hint: '代码兜底判健康用的成功率', type: 'number' },
];

export function SelfEvolve() {
  const [info, setInfo] = useState<SelfEvolveInfo | null>(null);
  const [models, setModels] = useState<string[]>([]);
  const [saveState, setSaveState] = useState('');
  const [runState, setRunState] = useState<string>('');
  const [runResp, setRunResp] = useState<SelfEvolveRunResp | null>(null);
  const [rolling, setRolling] = useState(false);
  const [expanded, setExpanded] = useState<number | null>(null);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const load = async () => {
    try { setInfo(await get<SelfEvolveInfo>('/api/self-evolve')); } catch { /* ignore */ }
  };
  useEffect(() => {
    load();
    get<Array<{ model: string }>>('/api/models').then((ms) => setModels(ms.map((m) => m.model))).catch(() => {});
    return () => { if (saveTimer.current) clearTimeout(saveTimer.current); };
  }, []);

  const s = info?.settings ?? {};

  // 变更即保存（防抖 500ms，复用 PUT /api/settings）
  const scheduleSave = (next: Record<string, string>) => {
    setSaveState('保存中…');
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(async () => {
      try { await put('/api/settings', next); setSaveState(`已自动保存 ${new Date().toLocaleTimeString()}`); }
      catch (e) { setSaveState(`保存失败: ${(e as Error).message}`); }
    }, 500);
  };
  const set = (k: string, v: string) => {
    if (!info) return;
    const next = { ...info.settings, [k]: v };
    setInfo({ ...info, settings: next });
    scheduleSave(next);
  };

  const runNow = async () => {
    setRunState('运行中…');
    try {
      const r = await post<SelfEvolveRunResp>('/api/self-evolve/run', {});
      setRunResp(r);
      setRunState(r.ran ? (r.changed ? `本次改动 ${r.changed} 格（${MODE_LABEL[r.mode] ?? r.mode}）` : '运行完成，无需要调整的格') : '未启用');
      await load();
    } catch (e) { setRunState(`运行失败: ${(e as Error).message}`); }
  };

  const rollback = async () => {
    if (!confirm('确定回滚到最近一次自进化改动之前的档位？此操作会覆盖当前档位表（记录在案）。')) return;
    setRolling(true);
    try {
      const r = await post<{ success: boolean; rolledBackId: number }>('/api/self-evolve/rollback', {});
      setSaveState(`已回滚 #${r.rolledBackId}`);
      setRunResp(null);
      await load();
    } catch (e) { setSaveState(`回滚失败: ${(e as Error).message}`); }
    finally { setRolling(false); }
  };

  const valid = useMemo(() => !!info && !!info.settings.self_evolve_enabled, [info]);

  return (
    <div className="mx-auto max-w-3xl p-6">
      <div className="mb-4 flex items-center justify-between">
        <h1 className="text-lg font-semibold text-ink">自进化</h1>
        <span className={`text-xs ${saveState.startsWith('保存失败') ? 'text-err' : 'text-dim'}`}>{saveState}</span>
      </div>

      {/* 状态 + 总开关 */}
      <Card title="自进化开关" action={
        <div className="flex items-center gap-2">
          {valid ? <Tag color="ok">运行中</Tag> : <Tag color="dim">已关闭</Tag>}
          <Toggle checked={valid} onChange={(v) => set('self_evolve_enabled', v ? '1' : '0')} />
        </div>
      }>
        <p className="text-xs text-dim leading-relaxed">
          路由器定期把窗口内请求历史交给 AI(LLM) 分析，产出挡位调优建议；代码只做护栏（模型必须启用存在、每轮限量、置信度达标、样本足够、通配格不动），LLM 失败或输出非法时静默跳过、绝不阻塞在线路由，全部决策落日志可回滚。关闭后停止自动运行（仍可手动触发）。
        </p>
      </Card>

      {/* 参数 */}
      <div className="mt-4">
        <Card title="参数">
          <div className="grid grid-cols-2 gap-x-4 gap-y-3 sm:grid-cols-3">
            {PARAMS.map((p) => (
              <div key={p.key}>
                <div className="mb-1 text-xs text-dim" title={p.hint}>{p.label}</div>
                {p.key === 'self_evolve_model' ? (
                  <Select value={s[p.key] ?? ''} onChange={(v) => set(p.key, v)} options={[{ value: '', label: '选择模型' }, ...models.map((m) => ({ value: m, label: m }))]} />
                ) : (
                  <Input value={s[p.key] ?? ''} onChange={(v) => set(p.key, v)} type={p.type ?? 'text'} placeholder={p.hint} />
                )}
              </div>
            ))}
            <div>
              <div className="mb-1 text-xs text-dim">关护栏直信 AI</div>
              <div className="flex h-9 items-center">
                <Toggle checked={(s.self_evolve_trust_ai ?? '0') === '1'} onChange={(v) => set('self_evolve_trust_ai', v ? '1' : '0')} />
              </div>
            </div>
            <div>
              <div className="mb-1 text-xs text-dim">AI 不可用时代码兜底</div>
              <div className="flex h-9 items-center">
                <Toggle checked={(s.self_evolve_fallback_code ?? '1') !== '0'} onChange={(v) => set('self_evolve_fallback_code', v ? '1' : '0')} />
              </div>
            </div>
          </div>
          <p className="mt-2 text-xs text-dim/70">改动自动保存。护栏推荐保持开启；「关护栏直信 AI」属高风险的实验项，慎用。</p>
        </Card>
      </div>

      {/* 手动触发 */}
      <div className="mt-4">
        <Card title="手动运行">
          <div className="flex items-center gap-3">
            <Button onClick={runNow} disabled={runState === '运行中…'}>
              {runState === '运行中…' ? <Spinner /> : <Play size={14} />}
              {runState === '运行中…' ? '运行中…' : '立即运行一次'}
            </Button>
            {info?.rollbackTarget ? (
              <Button variant="danger" onClick={rollback} disabled={rolling}>
                {rolling ? <Spinner /> : <RotateCcw size={14} />}
                回滚最近一次改动
              </Button>
            ) : null}
            {runState && runState !== '运行中…' && <span className="text-xs text-dim">{runState}</span>}
          </div>
          {runResp?.rationale?.length ? (
            <ul className="mt-3 space-y-1 rounded-lg border border-line bg-panel2 p-3 text-xs text-ink/80">
              {runResp.rationale.map((r, i) => <li key={i}>· {r}</li>)}
            </ul>
          ) : null}
        </Card>
      </div>

      {/* 历史 */}
      <div className="mt-4">
        <Card title="调优历史（optimizer_log）">
          {!info || info.logs.length === 0 ? (
            <Empty text="暂无自进化记录" />
          ) : (
            <div className="-mx-1 space-y-2">
              {info.logs.map((l) => {
                const isRollTarget = info.rollbackTarget?.id === l.id;
                return (
                  <div key={l.id} className={`rounded-lg border bg-panel2/60 ${isRollTarget ? 'border-accent/40' : 'border-line'}`}>
                    <button
                      className="flex w-full items-center gap-3 px-3 py-2.5 text-left"
                      onClick={() => setExpanded(expanded === l.id ? null : l.id)}
                    >
                      <ChevronDown size={14} className={`shrink-0 text-dim transition-transform duration-200 ${expanded === l.id ? 'rotate-180' : ''}`} />
                      <Tag color={l.action === 'rollback' ? 'warn' : l.action === 'ai_guarded_tune' || l.action === 'ai_tune' ? 'ok' : 'accent'}>
                        {MODE_LABEL[l.action] ?? l.action}
                      </Tag>
                      <span className="min-w-0 flex-1 truncate text-xs text-ink/80">{l.reason || '—'}</span>
                      <span className="shrink-0 font-mono text-[11px] text-dim">{l.created_at}</span>
                      {isRollTarget && <Tag color="accent">可回滚</Tag>}
                    </button>
                    {expanded === l.id && (
                      <div className="grid grid-cols-2 gap-2 border-t border-line p-3">
                        <div className="rounded-md border border-line bg-panel p-2">
                          <div className="mb-1 font-mono text-[11px] text-dim">改动前档位</div>
                          <pre className="max-h-40 overflow-auto whitespace-pre-wrap break-all text-[11px] text-ink/80">{l.previous_tiers_json ?? '（无）'}</pre>
                        </div>
                        <div className="rounded-md border border-line bg-panel p-2">
                          <div className="mb-1 font-mono text-[11px] text-dim">改动后档位</div>
                          <pre className="max-h-40 overflow-auto whitespace-pre-wrap break-all text-[11px] text-ink/80">{l.new_tiers_json ?? '（无）'}</pre>
                        </div>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </Card>
      </div>

      <ul className="mt-6 space-y-1 border-t border-line pt-4 text-xs text-dim/80">
        <li>· 自进化每周期自动运行；「立即运行一次」仅手动触发，不改变周期</li>
        <li>· 所有改动全量落 optimizer_log，可从最近一次改动一键回滚（覆盖当前档位表，谨慎）</li>
        <li>· 带上你自己的判断，推荐把「关护栏直信 AI」保持关闭</li>
      </ul>
    </div>
  );
}