// 模型库：表格形态，一行一模型，行内编辑（价格/上下文/启用）
import { Save } from 'lucide-react';
import { useEffect, useState } from 'react';
import { get, put } from '../api';
import { Empty, Input, Tag, Toggle } from '../components/ui';
import type { ModelInfo } from '../types';

const th = 'whitespace-nowrap py-2 pr-4 font-medium text-dim';
const td = 'py-2.5 pr-4 align-middle';
const NUM_FIELDS = ['inputPrice', 'outputPrice', 'contextWindow'] as const;
type NumField = (typeof NUM_FIELDS)[number];

export function Models() {
  const [models, setModels] = useState<ModelInfo[]>([]);
  const [msg, setMsg] = useState('');
  // 数字列本地草稿：输入过程保持字符串原样，空串/半输入不立即回写为 0，保存时才解析提交
  const [drafts, setDrafts] = useState<Record<string, string>>({});

  const load = async () => setModels(await get<ModelInfo[]>('/api/models'));
  useEffect(() => { load().catch((e) => setMsg(String(e.message))); }, []);

  const patch = (model: string, p: Partial<ModelInfo>) => {
    setModels((ms) => ms.map((m) => (m.model === model ? { ...m, ...p } : m)));
  };

  const draftKey = (model: string, f: NumField) => `${model}:${f}`;
  const draftOf = (m: ModelInfo, f: NumField) => drafts[draftKey(m.model, f)] ?? String(m[f] ?? '');

  const onNum = (m: ModelInfo, f: NumField, raw: string) => {
    setDrafts((s) => ({ ...s, [draftKey(m.model, f)]: raw }));
    const n = Number(raw);
    // 空串/非法输入只更新草稿展示，不动数据值（避免清空时闪 0）
    if (raw.trim() !== '' && Number.isFinite(n)) patch(m.model, { [f]: n } as Partial<ModelInfo>);
  };

  // 失焦时若草稿非法（空/半输入），恢复显示数据原值
  const settleDraft = (m: ModelInfo, f: NumField) => {
    setDrafts((s) => {
      const raw = s[draftKey(m.model, f)];
      if (raw === undefined) return s;
      const n = Number(raw);
      if (raw.trim() === '' || !Number.isFinite(n)) {
        const next = { ...s };
        delete next[draftKey(m.model, f)];
        return next;
      }
      return s;
    });
  };

  const save = async (m: ModelInfo) => {
    try {
      const body = { ...m };
      for (const f of NUM_FIELDS) {
        const raw = drafts[draftKey(m.model, f)];
        if (raw === undefined) continue;
        const n = Number(raw);
        if (raw.trim() !== '' && Number.isFinite(n)) body[f] = n;
      }
      await put(`/api/models/${m.model}`, body);
      setMsg(`已保存 ${m.model}`);
      setDrafts((s) => {
        const next = { ...s };
        for (const f of NUM_FIELDS) delete next[draftKey(m.model, f)];
        return next;
      });
    } catch (e) { setMsg(`保存失败: ${(e as Error).message}`); }
  };

  return (
    <div className="mx-auto max-w-6xl p-6 lg:p-8">
      <div className="mb-4 flex items-center justify-between">
        <h1 className="text-xl font-semibold tracking-[-0.015em] text-ink">模型库</h1>
        {msg && <span className="text-xs text-ok">{msg}</span>}
      </div>

      {models.length === 0 ? <Empty text="暂无模型" /> : (
        <div className="rounded-xl border border-line bg-panel shadow-[var(--shadow-card)]">
          <table className="w-full text-left text-xs">
            <thead>
              <tr className="border-b border-line">
                <th className={`${th} pl-5`}>模型</th>
                <th className={`${th} text-right`}>输入 $/M</th>
                <th className={`${th} text-right`}>输出 $/M</th>
                <th className={`${th} text-right`}>上下文</th>
                <th className={th}>Tools</th>
                <th className={th}>启用</th>
                <th className={`${th} pr-5`} />
              </tr>
            </thead>
            <tbody>
              {models.map((m) => (
                <tr key={m.model} className="border-b border-line/50 last:border-0">
                  <td className={`${td} pl-5`}>
                    <div className="flex items-center gap-2">
                      <span className="whitespace-nowrap text-[13px] font-medium text-ink">{m.displayName || m.model}</span>
                      <Tag color="dim">{m.provider}</Tag>
                    </div>
                    {/* 易配模型名回填：displayName 为空时已回退显示真实模型名；非空时补一行真实名 */}
                    {m.displayName && <div className="mt-0.5 font-mono text-xs text-dim">{m.model}</div>}
                    {m.note && <div className="mt-0.5 max-w-[280px] text-xs leading-snug text-dim/80">{m.note}</div>}
                  </td>
                  <td className={`${td} text-right`}>
                    <Input value={draftOf(m, 'inputPrice')} onChange={(v) => onNum(m, 'inputPrice', v)} onBlur={() => settleDraft(m, 'inputPrice')} className="tnum ml-auto w-20 text-right" />
                  </td>
                  <td className={`${td} text-right`}>
                    <Input value={draftOf(m, 'outputPrice')} onChange={(v) => onNum(m, 'outputPrice', v)} onBlur={() => settleDraft(m, 'outputPrice')} className="tnum ml-auto w-20 text-right" />
                  </td>
                  <td className={`${td} text-right`}>
                    <Input value={draftOf(m, 'contextWindow')} onChange={(v) => onNum(m, 'contextWindow', v)} onBlur={() => settleDraft(m, 'contextWindow')} className="tnum ml-auto w-24 text-right" />
                  </td>
                  <td className={td}><Tag color={m.supportsTools ? 'ok' : 'err'}>{m.supportsTools ? '支持' : '否'}</Tag></td>
                  <td className={td}><Toggle checked={m.enabled} onChange={(v) => patch(m.model, { enabled: v })} /></td>
                  <td className={`${td} pr-5 text-right`}>
                    <button
                      type="button"
                      title={`保存 ${m.model}`}
                      onClick={() => save(m)}
                      className="inline-flex h-7 w-7 items-center justify-center rounded-lg border border-line text-dim transition-all duration-150 hover:bg-panel2 hover:text-ink active:scale-95"
                    >
                      <Save size={13} />
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
