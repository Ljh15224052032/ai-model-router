// LLM 裁判（M4）：规则未命中时，用便宜模型对任务做结构化判定，产出最终模型
// 失败（网络/解析/模型非法）一律返回 null，由 dispatcher 走 fallback，不阻断主链路
import { config } from '../config.ts';
import { getSetting } from '../db/settings.ts';
import { callNewApi } from '../upstream/newapi-client.ts';
import { listModels } from '../db/models.ts';
import { insertLog, estimateCost } from '../stats/logger.ts';
import type { Feature, JudgeResult } from '../types.ts';
import type { Usage } from '../upstream/newapi-client.ts';

const TASK_TYPES = ['chat', 'code', 'write', 'summarize', 'translate', 'analyze', 'reason', 'unknown'];
const COMPLEXITY = ['low', 'mid', 'high'];

// 取内容文本（兼容 string 与多模态数组）
function textOf(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((c) => (typeof c === 'object' && c && typeof (c as { text?: unknown }).text === 'string' ? (c as { text: string }).text : ''))
      .join(' ');
  }
  return '';
}

export async function judge(
  f: Feature,
  policyId: string | null,
  messages: Array<{ role: string; content: unknown }>,
  opts?: { log?: boolean }
): Promise<JudgeResult | null> {
  if (getSetting('judge_enabled') === '0') return null; // 设置里可整体关闭裁判
  const model = getSetting('judge_model') || 'deepseek-flash';
  const token = getSetting('newapi_token') || config.newapiToken;
  if (!token) return null;

  const last = [...messages].reverse().find((m) => m.role === 'user');
  const userText = textOf(last?.content) || '(无用户消息)';

  const sys = `你是路由裁判。用户请求未命中规则表，请你判断该任务的任务类型与复杂度。模型选择由路由档位表负责，你不需要选模型。
输出严格 JSON，不要输出任何额外文字、不要用 markdown 代码块包裹。JSON 格式：
{"taskType":"chat|code|write|summarize|translate|analyze|reason|unknown","complexity":"low|mid|high","reason":"一句话中文理由"}`;

  const user = `【请求特征】
- 估算输入 token：${f.inputTokens}
- 对话轮数：${f.turnCount}
- 末条用户消息字符数：${f.lastMsgChars}
- 是否带 tools：${f.hasTools}
- 是否带 system：${f.hasSystem}

【末条用户消息】
${userText.slice(0, 2000)}`;

  const start = process.hrtime();
  const elapsed = () => Math.round(process.hrtime(start)[0] * 1000 + process.hrtime(start)[1] / 1e6);
  const finalLog = (jr: JudgeResult | null, err?: string, usage?: Usage | null) => {
    if (opts?.log === false) return; // test-route 不落正式日志
    const jm = listModels().find((c) => c.model === model);
    insertLog({
      client: 'router-judge',
      requestedModel: f.modelRequested,
      policyId,
      ruleId: null,
      routeSource: 'judge',
      judgeResultJson: jr ? JSON.stringify(jr) : null,
      finalModel: model,
      provider: jm?.provider ?? null,
      contextAction: 'none',
      usage: usage ?? null,
      costUsd: estimateCost(usage ?? null, jm?.inputPrice ?? 0, jm?.outputPrice ?? 0),
      latencyMs: elapsed(),
      status: err ? 'fail' : 'success',
      error: err,
    });
  };

  try {
    const res = await callNewApi('/v1/chat/completions', {
      model,
      messages: [
        { role: 'system', content: sys },
        { role: 'user', content: user },
      ],
      stream: false,
      temperature: 0,
    }, { token, stream: false });

    const raw = await new Response(res.bodyStream).text();
    if (res.status >= 400) {
      finalLog(null, `judge_http_${res.status}`);
      return null;
    }

    const parsed = JSON.parse(raw) as {
      choices?: Array<{ message?: { content?: string } }>;
      usage?: { prompt_tokens?: number; completion_tokens?: number; prompt_tokens_details?: { cached_tokens?: number } };
    };
    const content = parsed.choices?.[0]?.message?.content ?? '';
    const consumed: Usage | null = parsed.usage
      ? {
          promptTokens: parsed.usage.prompt_tokens ?? 0,
          completionTokens: parsed.usage.completion_tokens ?? 0,
          cachedTokens: parsed.usage.prompt_tokens_details?.cached_tokens ?? 0,
        }
      : null;

    const jr = parseResult(content);
    if (!jr) {
      finalLog(null, 'judge_response_invalid', consumed);
      return null;
    }

    finalLog(jr, undefined, consumed);
    return jr;
  } catch (e) {
    finalLog(null, `judge_error: ${(e as Error).message}`);
    return null;
  }
}

function parseResult(content: string): JudgeResult | null {
  const block = content.match(/\{[\s\S]*\}/);
  if (!block) return null;
  try {
    const o = JSON.parse(block[0]) as Partial<JudgeResult>;
    if (!o || typeof o !== 'object') return null;
    const taskType = TASK_TYPES.includes(String(o.taskType)) ? String(o.taskType) : 'unknown';
    const complexity = COMPLEXITY.includes(String(o.complexity)) ? (String(o.complexity) as 'low' | 'mid' | 'high') : 'low';
    // model 由档位表映射，不再由裁判选择；保留空串兼容旧日志结构
    return { taskType, complexity, model: '', reason: String(o.reason ?? '').slice(0, 200) };
  } catch {
    return null;
  }
}