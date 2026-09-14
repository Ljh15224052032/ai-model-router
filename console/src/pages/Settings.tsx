// 设置：new-api 连接、裁判模型、成本上限、上游额度源（通用适配器）、全局档位、健康路由
import { X } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { del, get, post, put } from '../api';
import { Button, Card, Input, Select, Tag, Toggle } from '../components/ui';
import { TiersTable } from '../components/TiersTable';
import type { ModelHealth, PolicyTiers } from '../types';

// 上游额度源（凭据存本机 SQLite；列表返回打码 Key，明文仅添加时提交）
type Provider = { id?: string; name: string; adapter: string; baseUrl?: string; apiKey?: string; enabled: boolean };
type AdapterMeta = { value: string; label: string; baseUrl?: string };
type TestResult = { status: string; items?: Array<{ label: string; remaining: number; limit?: number }>; error?: string };

function UsageProviders() {
  const [providers, setProviders] = useState<Provider[]>([]);
  const [adapters, setAdapters] = useState<AdapterMeta[]>([]);
  const [form, setForm] = useState({ name: '', adapter: '', baseUrl: '', apiKey: '' });
  const [msg, setMsg] = useState('');

  useEffect(() => {
    get<Provider[]>('/api/usage/providers').then(setProviders).catch(() => {});
    get<AdapterMeta[]>('/api/usage/meta').then(setAdapters).catch(() => {});
  }, []);

  const persist = async (list: Provider[]) => {
    setProviders(list);
    try { await put('/api/usage/providers', list); } catch (e) { setMsg(`保存失败: ${(e as Error).message}`); }
  };

  const test = async () => {
    if (!form.adapter || !form.apiKey) { setMsg('请先选择适配器并填写 Key'); return; }
    setMsg('测试中…');
    try {
      const r = await post<TestResult>('/api/usage/test', form);
      setMsg(r.status === 'ok'
        ? `成功：${r.items?.map((i) => `${i.label} ${i.remaining}${i.limit !== undefined ? ` / ${i.limit}` : ''}`).join('、')}`
        : `失败：${r.error ?? '未知错误'}`);
    } catch (e) { setMsg(`失败：${(e as Error).message}`); }
  };

  const add = async () => {
    if (!form.name || !form.adapter) { setMsg('名称与适配器必填'); return; }
    const meta = adapters.find((a) => a.value === form.adapter);
    await persist([...providers, { name: form.name, adapter: form.adapter, baseUrl: form.baseUrl || meta?.baseUrl || undefined, apiKey: form.apiKey, enabled: true }]);
    setForm({ name: '', adapter: '', baseUrl: '', apiKey: '' });
    setMsg('已添加并启用');
  };

  return (
    <Card title="上游额度源">
      <p className="mb-3 text-xs text-dim">配置渠道凭据后，仪表盘「上游额度」卡自动显示；无启用渠道时该卡不出现。Key 仅存本机 SQLite，列表只显示尾 4 位。</p>
      {providers.length > 0 && (
        <div className="mb-3 space-y-2">
          {providers.map((p, i) => (
            <div key={p.id ?? i} className="flex items-center gap-3 rounded-lg border border-line bg-panel2 px-3 py-2">
              <div className="min-w-0 flex-1">
                <div className="text-sm text-ink">{p.name}</div>
                <div className="text-xs text-dim">{adapters.find((a) => a.value === p.adapter)?.label ?? p.adapter}{p.apiKey ? ` · ${p.apiKey}` : ''}</div>
              </div>
              <Toggle checked={p.enabled} onChange={(v) => persist(providers.map((x, j) => (j === i ? { ...x, enabled: v } : x)))} />
              <button onClick={() => persist(providers.filter((_, j) => j !== i))} className="text-dim transition-colors hover:text-err" title="删除">
                <X size={14} />
              </button>
            </div>
          ))}
        </div>
      )}
      <div className="grid grid-cols-2 gap-2">
        <Input placeholder="渠道名称" value={form.name} onChange={(v) => setForm((f) => ({ ...f, name: v }))} />
        <Select
          value={form.adapter}
          onChange={(v) => {
            const meta = adapters.find((a) => a.value === v);
            setForm((f) => ({ ...f, adapter: v, baseUrl: meta?.baseUrl ?? '' }));
          }}
          options={[{ value: '', label: '选择适配器' }, ...adapters.map((a) => ({ value: a.value, label: a.label }))]}
        />
        <Input placeholder="Base URL（留空用默认）" value={form.baseUrl} onChange={(v) => setForm((f) => ({ ...f, baseUrl: v }))} />
        <Input placeholder="API Key" value={form.apiKey} onChange={(v) => setForm((f) => ({ ...f, apiKey: v }))} />
      </div>
      <div className="mt-2 flex items-center gap-2">
        <Button variant="ghost" onClick={test}>测试</Button>
        <Button onClick={add}>添加</Button>
        {msg && <span className="text-xs text-dim">{msg}</span>}
      </div>
    </Card>
  );
}

export function Settings() {
  const [settings, setSettings] = useState<Record<string, string>>({});
  const [models, setModels] = useState<string[]>([]);
  const [health, setHealth] = useState<ModelHealth>([]);
  const [msg, setMsg] = useState('');
  // 数据备份（M6）：一键导出 router.db 快照，本地浏览器保存
  const [backupMsg, setBackupMsg] = useState('');
  const [backupErr, setBackupErr] = useState(false);
  // 立改立生效：输入变更后防抖自动保存（500ms），显示保存状态
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [saveState, setSaveState] = useState('');

  const load = async () => {
    setSettings(await get<Record<string, string>>('/api/settings'));
  };
  const refreshHealth = async () => {
    const r = await get<{ models: ModelHealth }>('/api/health/models').catch(() => null);
    if (r) setHealth(Array.isArray(r.models) ? r.models : []);
  };
  useEffect(() => {
    load().catch(() => {});
    get<Array<{ model: string }>>('/api/models').then((ms) => setModels(ms.map((m) => m.model))).catch(() => {});
    refreshHealth();
    return () => { if (saveTimer.current) clearTimeout(saveTimer.current); };
  }, []);

  // 变更即保存（防抖）：任何输入改动 500ms 后自动 PUT，无需手动保存
  const scheduleSave = (snapshot: Record<string, string>) => {
    setSaveState('保存中…');
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(async () => {
      try {
        await put('/api/settings', snapshot);
        setSaveState(`已自动保存 ${new Date().toLocaleTimeString()}`);
      } catch (e) { setSaveState(`保存失败: ${(e as Error).message}`); }
    }, 500);
  };
  const set = (k: string, v: string) => setSettings((s) => {
    const next = { ...s, [k]: v };
    scheduleSave(next);
    return next;
  });

  // 全局默认档位：tiers_default_json 存 JSON 字符串，缺省/解析失败 → 空表
  const globalTiers = useMemo<PolicyTiers | null>(() => {
    const raw = settings.tiers_default_json;
    if (!raw) return null;
    try { const p = JSON.parse(raw) as PolicyTiers; return p?.entries ? p : null; } catch { return null; }
  }, [settings.tiers_default_json]);

  // 健康状态：冷却中 + 失败计数（P2 持久化，可一键解除）
  const cooling = health.filter((h) => h.cooling);
  const failing = health.filter((h) => h.fails > 0 && !h.cooling);
  const clearHealth = async (m: string) => {
    try { await del(`/api/health/models/${encodeURIComponent(m)}`); await refreshHealth(); }
    catch (e) { setMsg(`解除失败: ${(e as Error).message}`); }
  };

  // 备份下载：GET 返回二进制流（octet-stream），不能用 api() 的 JSON 解析，直接 fetch + blob 保存
  const backup = async () => {
    try {
      setBackupMsg('导出中…'); setBackupErr(false);
      const res = await fetch('/api/backup');
      if (!res.ok) throw new Error(`${res.status}`);
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      const stamp = new Date().toISOString().slice(0, 19).replace(/[T:]/g, '-');
      a.href = url;
      a.download = `router-backup-${stamp}.db`;
      a.click();
      URL.revokeObjectURL(url);
      setBackupMsg(`已导出（${(blob.size / 1024).toFixed(0)} KB）`);
    } catch (e) { setBackupErr(true); setBackupMsg(`失败: ${(e as Error).message}`); }
  };

  return (
    <div className="mx-auto max-w-2xl p-6">
      <div className="mb-4 flex items-center justify-between">
        <h1 className="text-lg font-semibold text-ink">设置</h1>
        <div className="flex items-center gap-2">
          {msg && <span className="text-xs text-ok">{msg}</span>}
          <span className={`text-xs ${saveState.startsWith('保存失败') ? 'text-err' : 'text-dim'}`}>{saveState}</span>
        </div>
      </div>

      <div className="space-y-4">
        <Card title="new-api 连接">
          <p className="mb-2 text-xs text-dim">地址与令牌仅在 Router 环境变量中管理（.env.example 或 start.ps1），此处仅展示当前生效值。</p>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <div className="mb-1 text-xs text-dim">默认路由方案</div>
              <Input value={settings.default_policy ?? 'default'} onChange={(v) => set('default_policy', v)} />
            </div>
            <div>
              <div className="mb-1 text-xs text-dim">裁判模型（M4 启用）</div>
              <Input value={settings.judge_model ?? ''} onChange={(v) => set('judge_model', v)} />
            </div>
            <div>
              <div className="mb-1 text-xs text-dim">LLM 裁判开关（关闭则规则未命中直接走兜底）</div>
              <div className="flex h-9 items-center">
                <Toggle checked={settings.judge_enabled !== '0'} onChange={(v) => set('judge_enabled', v ? '1' : '0')} />
              </div>
            </div>
            <div>
              <div className="mb-1 text-xs text-dim">全局单次成本上限（$）</div>
              <Input value={settings.global_max_cost_usd ?? ''} onChange={(v) => set('global_max_cost_usd', v)} />
            </div>
            <div>
              <div className="mb-1 text-xs text-dim">USD→CNY 汇率（总成本人民币估算，默认 7.2）</div>
              <Input value={settings.usd_cny_rate ?? ''} onChange={(v) => set('usd_cny_rate', v)} placeholder="7.2" />
            </div>
          </div>
        </Card>

        <Card title="全局档位表（M8）">
          <p className="mb-3 text-xs text-dim">裁判分类后的模型选择依据；各路由方案未单独配置档位时继承此表。</p>
          <TiersTable
            value={globalTiers}
            onChange={(v) => set('tiers_default_json', v && v.entries.length ? JSON.stringify(v) : '')}
            models={models}
            noInherit
          />
        </Card>

        <Card title="健康路由（M8）">
          <p className="mb-3 text-xs text-dim">上游失败时沿候选链重试；连续失败达到阈值进入冷却，冷却期内该模型被候选链跳过（规则首选不受影响）。</p>
          <div className="grid grid-cols-3 gap-3">
            <div>
              <div className="mb-1 text-xs text-dim">失败自动重试</div>
              <div className="flex h-9 items-center">
                <Toggle checked={settings.retry_on_error !== '0'} onChange={(v) => set('retry_on_error', v ? '1' : '0')} />
              </div>
            </div>
            <div>
              <div className="mb-1 text-xs text-dim">冷却阈值（连续失败）</div>
              <Input value={settings.cooldown_fail_threshold ?? ''} onChange={(v) => set('cooldown_fail_threshold', v)} type="number" />
            </div>
            <div>
              <div className="mb-1 text-xs text-dim">冷却时长（秒）</div>
              <Input value={settings.cooldown_seconds ?? ''} onChange={(v) => set('cooldown_seconds', v)} type="number" />
            </div>
          </div>
          <div className="mt-3">
            <div className="mb-1.5 text-xs text-dim">模型状态（P2 持久化，重启保留；可手动解除）</div>
            {cooling.length === 0 && failing.length === 0 ? (
              <div className="rounded-lg border border-dashed border-line bg-panel p-2.5 text-xs text-dim">无异常模型</div>
            ) : (
              <div className="flex flex-wrap gap-1.5">
                {cooling.map((h) => (
                  <Tag key={h.model} color="err" title={`冷却至 ${new Date(h.cooledUntil).toLocaleTimeString()}`}>
                    {h.model} 冷却中·{h.fails} 次失败
                    <button onClick={() => clearHealth(h.model)} className="ml-1 text-err/60 transition-colors hover:text-err" title="解除冷却">
                      <X size={10} />
                    </button>
                  </Tag>
                ))}
                {failing.map((h) => (
                  <Tag key={h.model} color="warn">
                    {h.model} {h.fails} 次失败
                    <button onClick={() => clearHealth(h.model)} className="ml-1 text-dim/60 transition-colors hover:text-err" title="清零失败计数">
                      <X size={10} />
                    </button>
                  </Tag>
                ))}
              </div>
            )}
          </div>
        </Card>

        <UsageProviders />

        <Card title="数据备份">
          <p className="mb-3 text-xs text-dim">一键导出 Router 全部状态（router.db 一致快照，含方案/模型/设置/日志）。备份 = 单个 .db 文件；恢复时停服替换同名文件后重启即可。</p>
          <div className="flex items-center gap-2">
            <Button onClick={backup}>导出备份</Button>
            {backupMsg && <span className={`text-xs ${backupErr ? 'text-err' : 'text-ok'}`}>{backupMsg}</span>}
          </div>
        </Card>
      </div>

      {/* 页脚说明：静态提示不占卡片层级，与上方功能卡区分 */}
      <ul className="mt-6 space-y-1 border-t border-line pt-4 text-xs text-dim/80">
        <li>· Router 默认只绑定 127.0.0.1:33333，不对外暴露</li>
        <li>· 供应商 Key 只存在 new-api 渠道中，Router 仅持有一个访问令牌</li>
        <li>· 数据全部在两个 SQLite 文件中：new-api-data\one-api.db 与 router-data\router.db</li>
      </ul>
    </div>
  );
}