// 对外 /v1 路由：chat/completions（OpenAI 兼容）、models
import type { FastifyInstance } from 'fastify';
import { decide } from '../core/dispatcher.ts';
import { callNewApi } from '../upstream/newapi-client.ts';
import { getModelCost, listModels, policyModels } from '../db/models.ts';
import { insertLog, estimateCost } from '../stats/logger.ts';
import { listPolicies } from '../db/policies.ts';
import { getSetting } from '../db/settings.ts';
import { config } from '../config.ts';
import { recordFail, recordSuccess } from '../core/health.ts';
import { orchestrate } from '../core/orchestrator.ts';

interface ChatBody {
  model?: string;
  messages?: Array<{ role: string; content: unknown }>;
  tools?: unknown[];
  stream?: boolean;
  [k: string]: unknown; // 其余字段原样透传
}

function providerOf(model: string): string | null {
  return listModels().find((m) => m.model === model)?.provider ?? null;
}

function retryEnabled(): boolean {
  return getSetting('retry_on_error') !== '0';
}

export function registerV1(app: FastifyInstance) {
  app.post('/v1/chat/completions', async (req, reply) => {
    const body = req.body as ChatBody;
    if (!body || typeof body !== 'object') {
      return reply.code(400).send({ error: { message: '请求体必须是 JSON 对象' } });
    }
    const requestedModelRaw = body.model ?? 'auto';
    let requestedModel = requestedModelRaw;
    const messages = body.messages ?? [];
    const start = process.hrtime();
    const elapsed = () => Math.round(process.hrtime(start)[0] * 1000 + process.hrtime(start)[1] / 1e6);

    const token = getSetting('newapi_token') || config.newapiToken;
    if (!token) {
      return reply.code(500).send({ error: { message: 'Router 未配置 new-api 令牌（设置 newapi_token 或环境变量 NEWAPI_TOKEN）' } });
    }

    // ---------- M9 编排模式（显式 opt-in，非流式）----------
    // 触发：model 以 @orchestrate 结尾，或 body.router.orchestrate === true
    // 流式请求不支持编排 → 静默回落直路由（fail-open 原则，普通请求零影响）
    const orchSuffix = requestedModelRaw.endsWith('@orchestrate');
    const orchFlag = (body as { router?: { orchestrate?: boolean } }).router?.orchestrate === true;
    if (orchSuffix || orchFlag) {
      // 剥后缀：后续直路由回落用干净模型名
      if (orchSuffix) requestedModel = requestedModelRaw.replace(/@orchestrate$/, '') || 'auto';
      if (body.stream) {
        // SSE 过程事件流：plan → worker_start/done → synthesis → status → 最终 OpenAI chunk → [DONE]
        reply.header('Content-Type', 'text/event-stream');
        reply.header('Cache-Control', 'no-cache');
        reply.header('Connection', 'keep-alive');
        const enc = new TextEncoder();
        const send = (ctrl: ReadableStreamDefaultController<Uint8Array>, obj: unknown) =>
          ctrl.enqueue(enc.encode(`data: ${JSON.stringify(obj)}\n\n`));
        const stream = new ReadableStream<Uint8Array>({
          async start(ctrl) {
            try {
              const r = await orchestrate({
                baseModel: requestedModel,
                messages: messages as Array<{ role: string; content: unknown }>,
                token,
                onEvent: (e) => send(ctrl, { router_event: e }),
              });
              // 最终回答按 OpenAI chunk 形态补发（完整内容 + 编排元信息）
              send(ctrl, {
                id: r.orchId,
                object: 'chat.completion.chunk',
                created: Math.floor(Date.now() / 1000),
                model: `${requestedModel}@orchestrate`,
                choices: [{ index: 0, delta: { role: 'assistant', content: r.final }, finish_reason: 'stop' }],
                router: {
                  orchestration: {
                    status: r.status,
                    plannerModel: r.plannerModel,
                    plan: r.plan,
                    workers: r.workers,
                    totalCostUsd: Number(r.totalCostUsd.toFixed(6)),
                  },
                },
              });
              ctrl.enqueue(enc.encode('data: [DONE]\n\n'));
            } catch (e) {
              send(ctrl, { router_event: { type: 'status', status: 'DIRECT', totalCostUsd: 0 }, error: (e as Error).message });
              ctrl.enqueue(enc.encode('data: [DONE]\n\n'));
            } finally {
              ctrl.close();
            }
          },
        });
        return reply.send(stream);
      }
      try {
          const r = await orchestrate({ baseModel: requestedModel, messages: messages as Array<{ role: string; content: unknown }>, token });
          return {
            id: r.orchId,
            object: 'chat.completion',
            created: Math.floor(Date.now() / 1000),
            model: `${requestedModel}@orchestrate`,
            choices: [{ index: 0, message: { role: 'assistant', content: r.final }, finish_reason: 'stop' }],
            usage: {
              prompt_tokens: r.usage.promptTokens,
              completion_tokens: r.usage.completionTokens,
              total_tokens: r.usage.promptTokens + r.usage.completionTokens,
            },
            router: {
              orchestration: {
                status: r.status,
                plannerModel: r.plannerModel,
                plan: r.plan,
                workers: r.workers,
                totalCostUsd: Number(r.totalCostUsd.toFixed(6)),
              },
            },
          };
        } catch (e) {
          // 编排内部异常：不吞请求，回落直路由
          console.error('[router] 编排失败，回落直路由:', (e as Error).message);
        }
    }

    try {
      const { decision, contextAction, messages: outMessages } = await decide({
        requestModel: requestedModel,
        messages: messages as Array<{ role: string; content: unknown }>,
        tools: body.tools,
        stream: !!body.stream, // P2：成本降级仅非流式生效
      });
      // P2：成本降级计为一次降级（retried 保持重试次数）
      const costDeg = decision.costDegraded ? 1 : 0;

      const baseLog = {
        client: (req.headers['x-client'] as string) ?? undefined,
        requestedModel,
        policyId: decision.policyId,
        ruleId: decision.ruleId,
        routeSource: decision.source,
        judgeResultJson: decision.judgeResult ? JSON.stringify(decision.judgeResult) : null,
        finalModel: decision.finalModel,
        provider: providerOf(decision.finalModel),
        contextAction,
        exploreFrom: decision.exploreFrom ?? null,
      };

      // 组装上游请求：替换 model，其余原样；截断则用处理后 messages
      const upstreamBody = (m: string) => ({ ...body, model: m, messages: outMessages });
      const canRetry = retryEnabled();

      // ---------- SSE 流式透传 ----------
      if (body.stream) {
        // 候选链：响应头 >=400（未透传 body）可换下一个候选；已透传后即使中断也不重试
        let lastErr: { status: number; raw: string } | null = null;
        let tried = 0;
        for (const m of decision.candidates) {
          if (tried > 0 && !canRetry) break;
          tried++;
          const upstream = await callNewApi('/v1/chat/completions', upstreamBody(m), { token, stream: true });
          if (upstream.status >= 400) {
            recordFail(m);
            lastErr = { status: upstream.status, raw: await new Response(upstream.bodyStream).text() };
            insertLog({
              ...baseLog,
              finalModel: m,
              provider: providerOf(m),
              usage: null,
              costUsd: 0,
              latencyMs: elapsed(),
              status: 'fail',
              error: `upstream_http_${upstream.status}`,
              retried: tried - 1,
              degraded: tried - 1 + costDeg,
            });
            continue;
          }
          recordSuccess(m);
          reply.hijack();
          reply.raw.writeHead(upstream.status, {
            'Content-Type': upstream.contentHeaders.get('content-type') ?? 'text/event-stream',
            'Cache-Control': 'no-cache',
            Connection: 'keep-alive',
            'x-route-model': m,
            'x-route-source': decision.source,
            'x-route-rule': decision.ruleId ?? '',
            'x-route-policy': decision.policyId ?? '',
            'x-context-action': contextAction,
          });
          const reader = upstream.bodyStream.getReader();
          const pump = async () => {
            for (;;) {
              const { done, value } = await reader.read();
              if (done) break;
              reply.raw.write(value);
            }
            reply.raw.end();
          };
          pump().catch(() => { try { reply.raw.end(); } catch { /* ignore */ } });

          // 流结束后落库（usage 从 SSE 尾部分析；completed=false 视为流中断，记 fail 可追溯）
          Promise.all([upstream.hasUsage, upstream.completed]).then(([usage, ok]) => {
            const { inputPrice, outputPrice } = getModelCost(m);
            insertLog({
              ...baseLog,
              finalModel: m,
              provider: providerOf(m),
              usage,
              costUsd: estimateCost(usage, inputPrice, outputPrice),
              latencyMs: elapsed(),
              status: ok ? 'success' : 'fail',
              error: ok ? undefined : 'stream_interrupted',
              retried: tried - 1,
              degraded: tried - 1 + costDeg,
            });
            if (!ok) console.error('[router] 流式中断: model=%s source=%s', m, decision.source);
          }).catch((e) => {
            console.error('[router] 流式落库失败:', e);
            insertLog({ ...baseLog, finalModel: m, provider: providerOf(m), usage: null, costUsd: 0, latencyMs: elapsed(), status: 'success', retried: tried - 1, degraded: tried - 1 + costDeg });
          });

          return; // hijack 后由上游流接管响应
        }
        // 全部候选失败：返回最后一次错误
        insertLog({
          ...baseLog,
          usage: null,
          costUsd: 0,
          latencyMs: elapsed(),
          status: 'fail',
          error: `upstream_http_${lastErr?.status ?? 0}`,
          retried: Math.max(0, tried - 1),
          degraded: Math.max(0, tried - 1) + costDeg,
        });
        return reply.code(lastErr?.status ?? 502).header('content-type', 'application/json').send(lastErr?.raw ?? JSON.stringify({ error: { message: '上游无可用模型' } }));
      }

      // ---------- 非流式 ----------
      let lastErr: { status: number; raw: string } | null = null;
      let tried = 0;
      for (const m of decision.candidates) {
        if (tried > 0 && !canRetry) break;
        tried++;
        const upstream = await callNewApi('/v1/chat/completions', upstreamBody(m), { token, stream: false });
        const raw = await new Response(upstream.bodyStream).text();
        if (upstream.status >= 400) {
          recordFail(m);
          lastErr = { status: upstream.status, raw };
          insertLog({
            ...baseLog,
            finalModel: m,
            provider: providerOf(m),
            usage: null,
            costUsd: 0,
            latencyMs: elapsed(),
            status: 'fail',
            error: `upstream_http_${upstream.status}`,
            retried: tried - 1,
            degraded: tried - 1 + costDeg,
          });
          continue;
        }
        recordSuccess(m);
        let parsed: unknown;
        try {
          parsed = JSON.parse(raw);
        } catch {
          parsed = raw;
        }
        const usageRaw = (parsed as { usage?: { prompt_tokens?: number; completion_tokens?: number; prompt_tokens_details?: { cached_tokens?: number } } })?.usage;
        const usage = usageRaw
          ? {
              promptTokens: usageRaw.prompt_tokens ?? 0,
              completionTokens: usageRaw.completion_tokens ?? 0,
              cachedTokens: usageRaw.prompt_tokens_details?.cached_tokens ?? 0,
            }
          : null;
        const { inputPrice, outputPrice } = getModelCost(m);
        insertLog({
          ...baseLog,
          finalModel: m,
          provider: providerOf(m),
          usage,
          costUsd: estimateCost(usage, inputPrice, outputPrice),
          latencyMs: elapsed(),
          status: 'success',
          retried: tried - 1,
          degraded: tried - 1 + costDeg,
        });

        reply
          .header('x-route-model', m)
          .header('x-route-source', decision.source)
          .header('x-route-rule', decision.ruleId ?? '')
          .header('x-route-policy', decision.policyId ?? '')
          .header('x-context-action', contextAction)
          .header('x-route-cost-degraded', decision.costDegraded ? 'true' : ''); // P2：成本降级标记
        return parsed;
      }
      // 全部候选失败：返回最后一次错误
      insertLog({
        ...baseLog,
        usage: null,
        costUsd: 0,
        latencyMs: elapsed(),
        status: 'fail',
        error: `upstream_http_${lastErr?.status ?? 0}`,
        retried: Math.max(0, tried - 1),
        degraded: Math.max(0, tried - 1) + costDeg,
      });
      return reply.code(lastErr?.status ?? 502).header('content-type', 'application/json').send(lastErr?.raw ?? JSON.stringify({ error: { message: '上游无可用模型' } }));
    } catch (e) {
      const err = e as Error;
      insertLog({
        requestedModel,
        policyId: null,
        ruleId: null,
        routeSource: 'fallback',
        judgeResultJson: null,
        finalModel: 'none',
        provider: null,
        contextAction: 'none',
        usage: null,
        costUsd: 0,
        latencyMs: elapsed(),
        status: 'fail',
        error: `router_internal: ${err.message}`,
      });
      return reply.code(500).send({ error: { message: `路由内部错误: ${err.message}` } });
    }
  });

  app.get('/v1/models', async () => {
    const policies = listPolicies().filter((p) => p.enabled);
    const models = policyModels(policies);
    return {
      object: 'list',
      data: [
        { id: 'auto', object: 'model', owned_by: 'router' },
        ...policies.filter((p) => p.id !== 'default' || true).map((p) => ({ id: `auto:${p.id}`, object: 'model', owned_by: 'router' })),
        ...models.map((m) => ({ id: m, object: 'model', owned_by: 'router' })),
      ],
    };
  });
}