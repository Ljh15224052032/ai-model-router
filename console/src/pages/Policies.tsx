// 路由方案：JSON 编辑器（可视化编辑已移除——目标用户 JSON 无门槛，结构映射 UI 的维护成本高于价值）
// 编辑唯一入口是 JSON 文本；校验实时报错定位；新建内置经典模板（通用均衡/成本优先/质量优先/长上下文）
import { ChevronDown, Plus, Save } from 'lucide-react';
import { useEffect, useState } from 'react';
import { del, get, post, put } from '../api';
import { Button, Card, Empty, Tag } from '../components/ui';
import type { Policy, Rule } from '../types';

const uid = () => Math.random().toString(36).slice(2, 8);

// ---------- JSON 校验：返回第一条错误（中文 + 路径），null = 通过 ----------
const FIELDS = new Set(['inputTokens', 'lastMsgChars', 'turnCount', 'hasTools', 'hasSystem', 'keywordsAny', 'modelRequested']);
const OPS = new Set(['eq', 'ne', 'gt', 'gte', 'lt', 'lte', 'in', 'contains', 'exists']);

function validate(text: string): string | null {
  let p: Policy;
  try {
    p = JSON.parse(text) as Policy;
  } catch (e) {
    return `JSON 语法错误：${(e as Error).message}`;
  }
  if (typeof p?.name !== 'string' || !p.name.trim()) return 'name 必填（非空字符串）';
  if (!Array.isArray(p.rules)) return 'rules 必须为数组';
  for (let i = 0; i < p.rules.length; i++) {
    const r = p.rules[i];
    const at = `rules[${i}]`;
    if (typeof r?.name !== 'string' || !r.name) return `${at}.name 必填`;
    if (!Array.isArray(r?.when)) return `${at}.when 必须为数组`;
    for (let j = 0; j < r.when.length; j++) {
      const c = r.when[j];
      if (!FIELDS.has(c?.field)) return `${at}.when[${j}].field 非法（可用：${[...FIELDS].join(' / ')}）`;
      if (!OPS.has(c?.op)) return `${at}.when[${j}].op 非法（可用：eq/ne/gt/gte/lt/lte/in/contains/exists）`;
      if (!('value' in c) && c?.op !== 'exists') return `${at}.when[${j}].value 缺失`;
    }
    if (typeof r?.then?.model !== 'string' || !r.then.model) return `${at}.then.model 必填`;
    if (r?.then?.context && !['none', 'truncate', 'summarize'].includes(r.then.context.strategy)) {
      return `${at}.then.context.strategy 非法（none / truncate / summarize）`;
    }
  }
  if (typeof p?.fallback?.model !== 'string' || !p.fallback.model) return 'fallback.model 必填';
  if (p.tiers != null && !Array.isArray(p.tiers?.entries)) return 'tiers 必须为 null（继承全局）或含 entries 数组';
  return null;
}

// ---------- 经典模板：按模型库正则取最接近的角色模型，找不到回落 ----------
function buildTemplates(models: string[]): Array<{ name: string; desc: string; make: () => Policy }> {
  const pick = (re: RegExp, fb: string) => models.find((m) => re.test(m)) ?? (models.includes(fb) ? fb : (models[0] ?? 'deepseek-flash'));
  const cheap = pick(/flash|lite|mini|air|8b|instant/i, 'deepseek-flash');
  const strong = pick(/kimi|pro|max|think|reason|coder|coding/i, 'kimi-for-coding');
  const tools = pick(/kimi|tool|coding/i, strong);
  const long = pick(/kimi|128k|256k|context|coding/i, strong);

  const rule = (id: string, name: string, when: Rule['when'], model: string, context?: Rule['then']['context']): Rule => ({
    id, name, enabled: true, priority: 0, when, then: { model, ...(context ? { context } : {}) },
  });
  const hasTools = { field: 'hasTools', op: 'eq' as const, value: true };
  const longInput = { field: 'inputTokens', op: 'gt' as const, value: 24000 };

  return [
    {
      name: '通用均衡',
      desc: '工具→kimi，超长→长上下文截断，代码类→强模型，极简→便宜；兜底便宜',
      make: () => ({
        id: 'p' + uid(), name: '通用均衡', enabled: true, isDefault: false,
        description: '成本与质量兼顾的起步方案',
        rules: [
          rule(uid(), '函数调用', [hasTools], tools),
          rule(uid(), '超长输入', [longInput], long, { strategy: 'truncate' }),
          rule(uid(), '代码类提问', [{ field: 'keywordsAny', op: 'contains', value: ['代码', 'code', 'bug', '报错', '报錯'] }], strong),
          rule(uid(), '极简问候', [{ field: 'lastMsgChars', op: 'lt', value: 12 }], cheap),
        ],
        fallback: { model: cheap },
        tiers: null,
      }),
    },
    {
      name: '成本优先',
      desc: '仅函数调用走强模型，其余一律最便宜；兜底便宜',
      make: () => ({
        id: 'p' + uid(), name: '成本优先', enabled: true, isDefault: false,
        description: '极限压成本：只有带工具的请求才升级',
        rules: [rule(uid(), '函数调用', [hasTools], tools)],
        fallback: { model: cheap },
        tiers: null,
      }),
    },
    {
      name: '质量优先',
      desc: '全部走最强模型，仅超长输入截断控上下文；兜底强模型',
      make: () => ({
        id: 'p' + uid(), name: '质量优先', enabled: true, isDefault: false,
        description: '不计成本，主打回答质量',
        rules: [rule(uid(), '超长输入', [longInput], long, { strategy: 'truncate' })],
        fallback: { model: strong },
        tiers: null,
      }),
    },
    {
      name: '长上下文优先',
      desc: '超 32K token 一律走长上下文模型截断，其余便宜；兜底便宜',
      make: () => ({
        id: 'p' + uid(), name: '长上下文优先', enabled: true, isDefault: false,
        description: '喂大文档的场景：先保上下文容量再谈成本',
        rules: [
          rule(uid(), '超长输入', [{ field: 'inputTokens', op: 'gt', value: 32768 }], long, { strategy: 'truncate' }),
          rule(uid(), '函数调用', [hasTools], tools),
        ],
        fallback: { model: cheap },
        tiers: null,
      }),
    },
    {
      name: '空白方案',
      desc: '无规则，仅兜底；从零手写',
      make: () => ({
        id: 'p' + uid(), name: '新方案', enabled: true, isDefault: false,
        description: '',
        rules: [],
        fallback: { model: cheap },
        tiers: null,
      }),
    },
  ];
}

export function Policies() {
  const [policies, setPolicies] = useState<Policy[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [jsonText, setJsonText] = useState('');
  const [savedText, setSavedText] = useState(''); // 服务端当前值（归一化排序后的 JSON），dirty = jsonText !== savedText
  const [msg, setMsg] = useState('');
  const [models, setModels] = useState<string[]>([]);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [pendingSwitch, setPendingSwitch] = useState<string | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);

  const load = async () => {
    const ps = await get<Policy[]>('/api/policies');
    setPolicies(ps);
    if (ps.length && !ps.some((p) => p.id === activeId)) setActiveId(ps[0].id);
  };

  useEffect(() => {
    load().catch((e) => setMsg(String(e.message)));
    get<Array<{ model: string }>>('/api/models').then((ms) => setModels(ms.map((m) => m.model))).catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 进入编辑：按优先级排序（数组顺序 = 执行顺序）生成规范化 JSON 文本
  useEffect(() => {
    if (!activeId) return;
    const p = policies.find((x) => x.id === activeId);
    if (p) {
      const e: Policy = { ...structuredClone(p), rules: [...p.rules].sort((a, b) => a.priority - b.priority) };
      const text = JSON.stringify(e, null, 2);
      setJsonText(text);
      setSavedText(text);
    }
  }, [activeId, policies]);

  const active = policies.find((x) => x.id === activeId);
  const error = validate(jsonText);
  const dirty = active != null && jsonText !== savedText;

  const save = async () => {
    if (!active || error) return;
    setMsg('');
    try {
      const parsed = JSON.parse(jsonText) as Policy;
      await put(`/api/policies/${active.id}`, {
        name: parsed.name,
        enabled: parsed.enabled ?? true,
        description: parsed.description ?? '',
        rules: parsed.rules.map((r, i) => ({ ...r, id: r.id ?? uid(), priority: (i + 1) * 10 })),
        fallback: parsed.fallback,
        isDefault: active.isDefault,
        tiers: parsed.tiers ?? null,
      });
      setMsg('已保存');
      setTimeout(() => setMsg(''), 3000);
      await load();
    } catch (e) {
      setMsg(`保存失败: ${(e as Error).message}`);
    }
  };

  const createFromTemplate = async (make: () => Policy) => {
    try {
      const p = make();
      p.rules.forEach((r, i) => { r.priority = (i + 1) * 10; });
      await post('/api/policies', p);
      setMenuOpen(false);
      setActiveId(p.id);
      await load();
    } catch (e) { setMsg(String((e as Error).message)); }
  };

  const removePolicy = async () => {
    if (!active) return;
    try {
      await del(`/api/policies/${active.id}`);
      setConfirmingDelete(false);
      setActiveId(null);
      await load();
    } catch (e) { setMsg(String((e as Error).message)); }
  };

  // 切换方案时保护未保存修改
  const trySwitch = (id: string) => {
    if (id === activeId) return;
    if (dirty) setPendingSwitch(id);
    else setActiveId(id);
  };
  const saveAndSwitch = async () => {
    await save();
    if (pendingSwitch) setActiveId(pendingSwitch);
    setPendingSwitch(null);
  };

  return (
    <div className="mx-auto max-w-6xl p-6 lg:p-8">
      <div className="mb-5 flex items-center justify-between">
        <h1 className="text-xl font-semibold tracking-[-0.015em] text-ink">路由方案</h1>
        <div className="flex items-center gap-2">
          {msg && <span className={`text-xs ${msg.includes('失败') || msg.includes('不可') ? 'text-err' : 'text-ok'}`}>{msg}</span>}
          {dirty && <Tag color="warn">未保存</Tag>}
          <Button onClick={save} disabled={!dirty || !!error}><Save size={15} /> 保存</Button>
          <div className="relative">
            <Button variant="ghost" onClick={() => setMenuOpen(!menuOpen)}><Plus size={15} /> 新建方案 <ChevronDown size={13} /></Button>
            {menuOpen && (
              <>
                <div className="fixed inset-0 z-20" onClick={() => setMenuOpen(false)} />
                <div className="absolute right-0 top-full z-30 mt-1 w-72 rounded-lg border border-line bg-panel p-1 shadow-lg">
                  {buildTemplates(models).map((t) => (
                    <button
                      key={t.name}
                      onClick={() => createFromTemplate(t.make)}
                      className="w-full rounded-md px-2.5 py-2 text-left transition-colors duration-150 hover:bg-panel2"
                    >
                      <div className="text-sm text-ink">{t.name}</div>
                      <div className="mt-0.5 text-[11px] leading-snug text-dim">{t.desc}</div>
                    </button>
                  ))}
                </div>
              </>
            )}
          </div>
        </div>
      </div>

      {policies.length === 0 && <Empty text="暂无方案，点击右上角新建" />}

      <div className="flex gap-5">
        {/* 方案列表 */}
        <Card className="w-60 shrink-0 self-start">
          <div className="space-y-1">
            {policies.map((p) => (
              <div
                key={p.id}
                onClick={() => trySwitch(p.id)}
                className={`cursor-pointer rounded-md px-2.5 py-2 transition-colors duration-150 ${activeId === p.id ? 'bg-accent/15' : 'hover:bg-panel2'}`}
              >
                <div className="flex items-center justify-between text-sm">
                  <span className={activeId === p.id ? 'text-accent' : 'text-ink'}>{p.name}</span>
                  <div className="flex items-center gap-1">
                    {p.isDefault && <Tag color="ok">默认</Tag>}
                    {!p.enabled && <Tag color="dim">停用</Tag>}
                  </div>
                </div>
                <div className="mt-0.5 text-[11px] text-dim">{p.rules.length} 条规则 · 兜底 {p.fallback?.model ?? '—'}</div>
              </div>
            ))}
          </div>
        </Card>

        {/* 编辑区：纯 JSON */}
        <div className="min-w-0 flex-1">
          {active ? (
            <Card>
              {/* 脏状态切换保护 */}
              {pendingSwitch && (
                <div className="mb-3 flex items-center gap-2 rounded-lg border border-warn/40 bg-warn/10 p-2.5 text-xs text-ink">
                  <span>当前修改未保存，切换到「{policies.find((p) => p.id === pendingSwitch)?.name}」？</span>
                  <div className="ml-auto flex gap-2">
                    <Button variant="ghost" onClick={saveAndSwitch}>保存并切换</Button>
                    <Button variant="ghost" onClick={() => { setActiveId(pendingSwitch); setPendingSwitch(null); }}>不保存切换</Button>
                  </div>
                </div>
              )}

              <div className="mb-3 flex items-center gap-2">
                <span className="text-base font-medium text-ink">{JSON.parse(savedText || '{}').name ?? active.name}</span>
                {active.isDefault && <Tag color="ok">默认</Tag>}
                <span className="text-xs text-dim">规则自上而下命中，数组顺序 = 执行顺序</span>
                <div className="ml-auto flex items-center gap-3">
                  {!active.isDefault && (
                    confirmingDelete ? (
                      <span className="flex items-center gap-1.5">
                        <span className="text-xs text-err">删除后不可恢复</span>
                        <button
                          onClick={removePolicy}
                          className="rounded-md bg-err px-2 py-0.5 text-xs font-medium text-white transition-colors hover:bg-err/85"
                        >
                          确认删除
                        </button>
                        <button onClick={() => setConfirmingDelete(false)} className="text-xs text-dim transition-colors hover:text-ink">
                          取消
                        </button>
                      </span>
                    ) : (
                      <button onClick={() => setConfirmingDelete(true)} className="text-xs text-dim underline-offset-2 transition-colors hover:text-err hover:underline">
                        删除方案
                      </button>
                    )
                  )}
                </div>
              </div>

              <textarea
                value={jsonText}
                onChange={(e) => setJsonText(e.target.value)}
                spellCheck={false}
                className={`h-[560px] w-full rounded-md border bg-panel2 p-3 font-mono text-xs text-ink outline-none focus:border-accent ${error ? 'border-err' : 'border-line'}`}
              />
              <div className={`mt-2 text-xs ${error ? 'text-err' : 'text-ok'}`}>
                {error ?? '✓ 校验通过'}
              </div>
            </Card>
          ) : (
            <Empty text="选择左侧方案开始编辑" />
          )}
        </div>
      </div>
    </div>
  );
}
