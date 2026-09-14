// 转发 new-api：真实 HTTP 转发，兼容 stream（SSE 原样透传），并抓取 usage 供落库
import { config } from '../config.ts';

export interface Usage {
  promptTokens: number;
  completionTokens: number;
  cachedTokens: number;
}

export interface UpstreamResult {
  status: number;
  contentHeaders: Headers;
  bodyStream: ReadableStream<Uint8Array>;
  hasUsage: Promise<Usage | null>;
  /** 流是否完整结束（流式 = 收到 [DONE]；非流式 = body 读毕无中断） */
  completed: Promise<boolean>;
}

function extractUsage(text: string): Usage | null {
  // 逐行解析 SSE 的 data: {...}，避免贪婪正则跨多个 JSON 对象导致 parse 失败
  let lastUsage: Usage | null = null;
  for (const line of text.split('\n')) {
    const t = line.trim();
    if (!t.startsWith('data:')) continue;
    const payload = t.slice(5).trim();
    if (!payload || payload === '[DONE]') continue;
    try {
      const j = JSON.parse(payload);
      const u = j?.usage;
      if (u && typeof u === 'object') {
        lastUsage = {
          promptTokens: u.prompt_tokens ?? 0,
          completionTokens: u.completion_tokens ?? 0,
          cachedTokens: u.prompt_tokens_details?.cached_tokens ?? 0,
        };
      }
    } catch {
      // 非 JSON 行（如 [DONE] 或半个 chunk）忽略
    }
  }
  return lastUsage;
}

// 超时保护：首字节 30s；body 空闲（流式 60s / 非流式 180s 无新数据）视为上游挂死——宁可快速失败，不让客户端无限等待
const HEADER_TIMEOUT_MS = 30_000;
const IDLE_TIMEOUT_MS = { stream: 60_000, plain: 180_000 };

export async function callNewApi(
  path: string,
  body: unknown,
  opts: { token: string; stream: boolean }
): Promise<UpstreamResult> {
  const controller = new AbortController();
  const upCtrl = controller; // body 阶段空闲超时同样通过它中止上游连接
  let headerTimedOut = false;
  const headerTimer = setTimeout(() => { headerTimedOut = true; controller.abort(); }, HEADER_TIMEOUT_MS);
  let res: Response;
  try {
    res = await fetch(`${config.newapiBase}${path}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${opts.token}`,
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } catch (e) {
    if (headerTimedOut) throw new Error(`上游 ${HEADER_TIMEOUT_MS / 1000}s 内无响应头（可能上游挂死）: ${(e as Error).message}`);
    throw e;
  } finally {
    clearTimeout(headerTimer);
  }

  if (!res.body) {
    const empty = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(new TextEncoder().encode(JSON.stringify({ error: { message: '上游无响应体' } })));
        c.close();
      },
    });
    return { status: res.status, contentHeaders: res.headers, bodyStream: empty, hasUsage: Promise.resolve(null), completed: Promise.resolve(false) };
  }

  // 单一 read 循环：chunk 既透传下游，又滚动扫描 usage。规避多 reader 竞争。
  const reader = res.body.getReader();
  let resolveUsage!: (u: Usage | null) => void;
  let resolveCompleted!: (ok: boolean) => void;
  const hasUsage = new Promise<Usage | null>((r) => { resolveUsage = r; });
  const completed = new Promise<boolean>((r) => { resolveCompleted = r; });

  const bodyStream = new ReadableStream<Uint8Array>({
    start(controller) {
      (async () => {
        const decoder = new TextDecoder();
        let acc = '';
        let lastUsage: Usage | null = null;
        // 空闲看门狗：持续出数据则不断重置；超时 abort 上游连接（快速失败优于挂死）
        let idleTimer = setTimeout(() => upCtrl.abort(), IDLE_TIMEOUT_MS[opts.stream ? 'stream' : 'plain']);
        const resetIdle = () => { clearTimeout(idleTimer); idleTimer = setTimeout(() => upCtrl.abort(), IDLE_TIMEOUT_MS[opts.stream ? 'stream' : 'plain']); };
        let interrupted = false;
        try {
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            resetIdle();
            controller.enqueue(value);
            acc += decoder.decode(value, { stream: true });
            if (acc.length > 524_288) acc = acc.slice(-65536); // 保留尾部滚动窗口
            const u = extractUsage(acc);
            if (u && (u.promptTokens || u.completionTokens)) lastUsage = u;
          }
        } catch {
          interrupted = true; // 空闲超时 abort 或上游连接异常
        } finally {
          clearTimeout(idleTimer);
          try { controller.close(); } catch { /* 已关闭 */ }
          resolveUsage(lastUsage);
          resolveCompleted(!interrupted && (!opts.stream || acc.trimEnd().endsWith('[DONE]')));
        }
      })();
    },
    cancel() {
      reader.cancel();
    },
  });

  return { status: res.status, contentHeaders: res.headers, bodyStream, hasUsage, completed };
}