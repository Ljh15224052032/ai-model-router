// 特征提取：轻量估算，不额外调模型
import type { Feature } from '../types.ts';

const REASON_KWS = ['证明', '规划', '为什么', '一步步', '分析', '推理', '比较', 'prove', 'plan', 'reason', 'analyze', 'compare', 'why'];

function estimateTokens(messages: unknown[]): number {
  // 粗略估算：JSON 序列化字符数 / 4（兼顾中英文混合）
  try {
    const text = JSON.stringify(messages);
    return Math.ceil(text.length / 4);
  } catch {
    return 0;
  }
}

export function extractFeatures(body: {
  messages?: Array<{ role?: string; content?: unknown }>;
  tools?: unknown[];
  model?: string;
}): Feature {
  const messages = Array.isArray(body.messages) ? body.messages : [];
  const userMsgs = messages.filter((m) => m.role === 'user');
  const lastUser = userMsgs[userMsgs.length - 1];
  let lastText = '';
  if (lastUser && typeof lastUser.content === 'string') lastText = lastUser.content;
  else if (lastUser && Array.isArray(lastUser.content)) lastText = lastUser.content.map((c: { text?: string }) => c.text ?? '').join(' ');

  const lowerLast = lastText.toLowerCase();
  const matched = REASON_KWS.filter((k) => lastText.includes(k) || lowerLast.includes(k));

  return {
    inputTokens: estimateTokens(messages),
    lastMsgChars: lastText.length,
    turnCount: userMsgs.length,
    hasTools: Array.isArray(body.tools) && body.tools.length > 0,
    hasSystem: messages.some((m) => m.role === 'system'),
    keywordsAny: matched,
    modelRequested: body.model ?? '',
  };
}