// 路由调试：左=模拟请求（配角），右=判定路径时间轴（主角）
// 设计：形随数据——decision 天然是管线（请求→判定→上下文→出口），UI 即管线
import { FlaskConical } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { post } from '../api';
import { Button, Card, Tag } from '../components/ui';
import type { TestRouteResp } from '../types';

const sourceColor: Record<string, 'ok' | 'warn' | 'dim' | 'accent'> = { rule: 'ok', judge: 'warn', fallback: 'dim', passthrough: 'accent' };

// 时间轴节点：dot + 连线 + 内容；dim=未触发分支
function Step({ title, badge, children, dim = false, last = false, delay = 0 }: {
  title: string; badge?: ReactNode; children?: ReactNode; dim?: boolean; last?: boolean; delay?: number;
}) {
  return (
    <div className="node-in relative flex gap-3" style={{ animationDelay: `${delay}ms` }}>
      <div className="flex flex-col items-center">
        <span className={`mt-1 h-2.5 w-2.5 shrink-0 rounded-full ${dim ? 'bg-dim/30' : 'bg-accent shadow-[0_0_6px_var(--accent)]'}`} />
        {!last && <span className={`w-px flex-1 ${dim ? 'bg-line' : 'bg-accent/25'}`} />}
      </div>
      <div className={`min-w-0 flex-1 ${last ? '' : 'pb-5'}`}>
        <div className="flex items-center gap-2">
          <span className={`text-[13px] font-medium ${dim ? 'text-dim/60' : 'text-ink'}`}>{title}</span>
          {badge}
        </div>
        {children && <div className="mt-1">{children}</div>}
      </div>
    </div>
  );
}

// 空态骨架：预告结果形态 = 空态即引导
function PathSkeleton({ onExample }: { onExample: () => void }) {
  const bars = ['w-40', 'w-28', 'w-32', 'w-24'];
  return (
    <div className="flex h-full flex-col items-center justify-center py-6">
      <div className="w-full max-w-xs opacity-50">
        {bars.map((w, i) => (
          <div key={i} className="flex gap-3">
            <div className="flex flex-col items-center">
              <span className={`mt-1 h-2.5 w-2.5 rounded-full ${i === 0 ? 'bg-dim/40' : 'bg-dim/20'}`} />
              {i < bars.length - 1 && <span className="w-px flex-1 border-l border-dashed border-line" />}
            </div>
            <div className={`node-in mb-5 h-3.5 ${w} rounded bg-panel2`} style={{ animationDelay: `${i * 80}ms` }} />
          </div>
        ))}
      </div>
      <p className="mt-2 text-sm text-dim">点「试跑」，看这条请求怎么走</p>
      <Button variant="ghost" onClick={onExample}>填入示例（函数调用）</Button>
    </div>
  );
}

export function Debug() {
  const [messages, setMessages] = useState(JSON.stringify([{ role: 'user', content: '你好' }], null, 2));
  const [tools, setTools] = useState('');
  const [modelReq, setModelReq] = useState('auto');
  const [resp, setResp] = useState<TestRouteResp | null>(null);
  const [err, setErr] = useState('');

  const run = async () => {
    setErr('');
    try {
      const parsed = JSON.parse(messages) as Array<{ role: string; content: unknown }>;
      const r = await post<TestRouteResp>('/api/test-route', {
        model: modelReq,
        messages: parsed,
        tools: tools.trim() ? JSON.parse(tools) : undefined,
      });
      setResp(r);
    } catch (e) { setErr(String((e as Error).message)); }
  };

  const fillExample = () => {
    setModelReq('auto');
    setMessages(JSON.stringify([{ role: 'user', content: '帮我写一个函数，解析 URL 的 query 参数' }], null, 2));
    setTools(JSON.stringify([{ type: 'function', function: { name: 'run_code', description: '执行代码片段', parameters: { type: 'object', properties: {} } } }], null, 2));
  };

  const d = resp?.decision;
  const f = resp?.features;
  const src = d?.source ?? '';

  return (
    <div className="mx-auto max-w-6xl p-6 lg:p-8">
      <div className="mb-5 flex items-center gap-3">
        <h1 className="text-xl font-semibold tracking-[-0.015em] text-ink">路由调试</h1>
        <Button onClick={run}><FlaskConical size={15} /> 试跑</Button>
      </div>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-5">
        {/* 模拟请求（配角，2/5） */}
        <Card title="模拟请求" className="lg:col-span-2">
          <div className="mb-2 flex items-center gap-2 text-xs text-dim">
            <span>model（auto / auto:方案 / 真实模型名）</span>
            <input
              value={modelReq}
              onChange={(e) => setModelReq(e.target.value)}
              className="w-36 rounded border border-line bg-panel2 px-2 py-1 text-xs text-ink outline-none focus:border-accent"
            />
          </div>
          <div className="mb-2 text-xs text-dim">messages JSON（最后一条 user 消息参与关键词判定）</div>
          <textarea
            value={messages}
            onChange={(e) => setMessages(e.target.value)}
            spellCheck={false}
            className="h-52 w-full rounded-md border border-line bg-panel2 p-2.5 font-mono text-xs text-ink outline-none focus:border-accent"
          />
          <div className="mt-2 text-xs text-dim">tools JSON（可选，留空表示无）</div>
          <textarea
            value={tools}
            onChange={(e) => setTools(e.target.value)}
            spellCheck={false}
            placeholder="[{ &quot;type&quot;: &quot;function&quot;, ... }]"
            className="mt-1 h-20 w-full rounded-md border border-line bg-panel2 p-2.5 font-mono text-xs text-ink outline-none focus:border-accent"
          />
          {err && <div className="mt-2 text-xs text-err">{err}</div>}
        </Card>

        {/* 判定路径（主角，3/5） */}
        <Card title="判定路径" className="lg:col-span-3">
          {!resp || !d || !f ? (
            <PathSkeleton onExample={fillExample} />
          ) : (
            <div>
              <Step
                title="请求"
                delay={0}
                badge={<Tag color="dim">{f.modelRequested}</Tag>}
              >
                <div className="flex flex-wrap gap-x-3 gap-y-1 text-xs text-dim">
                  <span>~{f.inputTokens} tok</span>
                  <span>{f.turnCount} 轮</span>
                  <span>{f.hasTools ? '带 tools' : '无 tools'}</span>
                  {f.hasSystem && <span>含 system</span>}
                  {f.keywordsAny.length > 0 && <span>关键词：{f.keywordsAny.join('、')}</span>}
                </div>
              </Step>

              <Step
                title="判定"
                delay={80}
                badge={<Tag color={sourceColor[src] ?? 'dim'}>{src}</Tag>}
              >
                {src === 'rule' && (
                  <>
                    <div className="text-xs text-ink">
                      规则命中 <span className="font-mono text-accent">{d.ruleId}</span>
                    </div>
                    {d.reasonNote && <div className="mt-0.5 text-xs text-dim">{d.reasonNote}</div>}
                    <div className="mt-1.5 text-xs text-dim/50">LLM 裁判 · 未触发（规则已命中）</div>
                  </>
                )}
                {src === 'judge' && d.judgeResult && (
                  <>
                    <div className="text-xs text-dim/50">规则 · 未命中</div>
                    <div className="mt-1.5 rounded-lg border border-warn/30 bg-warn/5 p-2.5">
                      <div className="flex flex-wrap items-center gap-1.5">
                        <Tag color="warn">{d.judgeResult.taskType}</Tag>
                        <Tag color="dim">{d.judgeResult.complexity}</Tag>
                        <span className="text-xs text-dim">由 {d.judgeResult.model} 判定</span>
                      </div>
                      <div className="mt-1.5 text-xs leading-relaxed text-dim">{d.judgeResult.reason}</div>
                    </div>
                  </>
                )}
                {src === 'fallback' && (
                  <>
                    <div className="text-xs text-dim/50">规则 · 未命中</div>
                    <div className="text-xs text-dim/50">LLM 裁判 · 未触发</div>
                    {d.reasonNote && <div className="mt-1 text-xs text-dim">{d.reasonNote}</div>}
                  </>
                )}
                {src === 'passthrough' && (
                  <div className="text-xs text-dim">指定了真实模型，跳过判定直接透传</div>
                )}
              </Step>

              <Step
                title="上下文"
                delay={160}
                badge={<Tag color={resp.contextAction === 'none' ? 'dim' : 'accent'}>{resp.contextAction}</Tag>}
              >
                <div className="text-xs text-dim">
                  策略 {d.context.strategy}
                  {d.context.maxTokens ? ` · 预算 ${d.context.maxTokens} tok` : ''}
                </div>
              </Step>

              <Step title="出口" last delay={240}>
                <span className="font-mono text-sm text-accent">{d.finalModel}</span>
                {d.policyId && <span className="ml-2 text-xs text-dim">方案 {d.policyId}</span>}
              </Step>
            </div>
          )}
        </Card>
      </div>
    </div>
  );
}
