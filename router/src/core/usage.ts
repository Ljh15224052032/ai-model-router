// 上游额度适配器：把各家的额度/余额接口归一化为统一结构
// kind: 'window'（周期重置额度池，环形展示）| 'balance'（充值余额，金额展示）
// 渠道凭据存 settings 表（usage_providers），由设置页增删启用；无启用渠道时仪表盘隐藏额度卡
import { getSetting, setSetting } from '../db/settings.ts';

export type QuotaItem = {
  label: string;
  remaining: number;
  limit?: number;
  unit: 'count' | 'money';
  currency?: string;
  resetAt?: string | null;
};

export type QuotaSource = {
  id: string;
  name: string;
  adapter: string;
  kind: 'window' | 'balance';
  status: 'ok' | 'unavailable';
  items: QuotaItem[];
  error?: string;
  fetchedAt: string;
};

export type ProviderConfig = {
  id: string;
  name: string;
  adapter: string;
  baseUrl?: string;
  apiKey: string;
  enabled: boolean;
};

const PROVIDERS_KEY = 'usage_providers';

export function listProviders(): ProviderConfig[] {
  const raw = getSetting(PROVIDERS_KEY);
  if (!raw) return [];
  try { return JSON.parse(raw) as ProviderConfig[]; } catch { return []; }
}

export function saveProviders(list: ProviderConfig[]) {
  setSetting(PROVIDERS_KEY, JSON.stringify(list));
  cache = null; // 配置变更后聚合缓存立即失效（否则启用/停用 60s 内不生效）
}

async function httpJson(url: string, headers: Record<string, string> = {}) {
  const res = await fetch(url, { headers: { Accept: 'application/json', ...headers }, signal: AbortSignal.timeout(15_000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return (await res.json()) as Record<string, unknown>;
}

type FetchResult = { kind: 'window' | 'balance'; items: QuotaItem[] };

// kimi usages 的窗口字段 → QuotaItem
const kimiItem = (label: string, o: { limit?: unknown; used?: unknown; remaining?: unknown; resetTime?: unknown } | undefined): QuotaItem | null =>
  o && o.limit !== undefined
    ? { label, limit: Number(o.limit), remaining: Number(o.remaining ?? Number(o.limit) - Number(o.used ?? 0)), unit: 'count', resetAt: (o.resetTime as string) ?? null }
    : null;

// 适配器注册表：新渠道在这里加一个函数即可
const ADAPTERS: Record<string, (cfg: ProviderConfig) => Promise<FetchResult>> = {
  // Kimi Code 编程套餐（社区实测接口，非官方文档）：周额度 + 5 小时窗口
  'kimi-coding': async (cfg) => {
    const body = await httpJson('https://api.kimi.com/coding/v1/usages', { Authorization: `Bearer ${cfg.apiKey}` }) as {
      usage?: { limit?: number; used?: number; remaining?: number; resetTime?: string };
      limits?: Array<{ detail?: { limit?: number; used?: number; remaining?: number; resetTime?: string } }>;
    };
    const items = [kimiItem('周额度', body.usage), kimiItem('5 小时窗口', body.limits?.[0]?.detail)].filter((x): x is QuotaItem => x !== null);
    if (items.length === 0) throw new Error('响应中无额度字段');
    return { kind: 'window', items };
  },

  // Moonshot 按量计费（官方）：可用余额（现金 + 代金券）
  moonshot: async (cfg) => {
    const body = await httpJson(`${(cfg.baseUrl || 'https://api.moonshot.cn').replace(/\/+$/, '')}/v1/users/me/balance`, { Authorization: `Bearer ${cfg.apiKey}` }) as {
      data?: { available_balance?: number | string; voucher_balance?: number | string };
    };
    const d = body.data;
    if (!d) throw new Error('响应中无余额字段');
    const cash = Number(d.available_balance ?? 0);
    const voucher = Number(d.voucher_balance ?? 0);
    const items: QuotaItem[] = [{ label: '现金余额', remaining: cash, unit: 'money', currency: 'CNY' }];
    if (voucher > 0) items.push({ label: '代金券', remaining: voucher, unit: 'money', currency: 'CNY' });
    return { kind: 'balance', items };
  },

  // DeepSeek（官方）：总余额
  deepseek: async (cfg) => {
    const body = await httpJson(`${(cfg.baseUrl || 'https://api.deepseek.com').replace(/\/+$/, '')}/user/balance`, { Authorization: `Bearer ${cfg.apiKey}` }) as {
      balance_infos?: Array<{ currency?: string; total_balance?: string }>;
    };
    const info = body.balance_infos?.[0];
    if (!info) throw new Error('响应中无余额字段');
    return { kind: 'balance', items: [{ label: '余额', remaining: Number(info.total_balance ?? 0), unit: 'money', currency: info.currency ?? 'CNY' }] };
  },

  // OpenAI 兼容 billing（new-api 等中转通用）：总额度 - 本年已用
  'openai-billing': async (cfg) => {
    const base = (cfg.baseUrl ?? '').replace(/\/+$/, '');
    if (!base) throw new Error('需要填写 Base URL');
    const headers = { Authorization: `Bearer ${cfg.apiKey}` };
    const sub = await httpJson(`${base}/v1/dashboard/billing/subscription`, headers) as { hard_limit_usd?: number };
    const now = new Date();
    const p = (n: number) => String(n).padStart(2, '0');
    const start = `${now.getFullYear()}-01-01`;
    const end = `${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())}`;
    const usage = await httpJson(`${base}/v1/dashboard/billing/usage?start_date=${start}&end_date=${end}`, headers) as { total_usage?: number };
    const total = Number(sub.hard_limit_usd ?? 0);
    const used = Number(usage.total_usage ?? 0) / 100; // OpenAI 惯例：美分
    return { kind: 'balance', items: [{ label: '剩余额度', remaining: total - used, limit: total, unit: 'money', currency: 'USD' }] };
  },
};

// 适配器元数据（设置页表单用；baseUrl 为默认模板）
export const ADAPTER_META = [
  { value: 'kimi-coding', label: 'Kimi Code 编程套餐', baseUrl: '' },
  { value: 'moonshot', label: 'Moonshot 按量计费', baseUrl: 'https://api.moonshot.cn' },
  { value: 'deepseek', label: 'DeepSeek', baseUrl: 'https://api.deepseek.com' },
  { value: 'openai-billing', label: 'OpenAI 兼容中转（new-api 等）', baseUrl: '' },
] as const;

async function fetchSource(cfg: ProviderConfig): Promise<QuotaSource> {
  const base = { id: cfg.id, name: cfg.name, adapter: cfg.adapter, fetchedAt: new Date().toISOString() };
  const fn = ADAPTERS[cfg.adapter];
  if (!fn) return { ...base, kind: 'window', status: 'unavailable', items: [], error: `未知适配器: ${cfg.adapter}` };
  try {
    const r = await fn(cfg);
    return { ...base, kind: r.kind, status: 'ok', items: r.items };
  } catch (e) {
    return { ...base, kind: 'window', status: 'unavailable', items: [], error: (e as Error).message };
  }
}

// 测试单条配置（设置页「测试」按钮，不走缓存）
export function testProvider(cfg: Omit<ProviderConfig, 'id' | 'enabled'>): Promise<QuotaSource> {
  return fetchSource({ id: 'test', name: cfg.name, adapter: cfg.adapter, baseUrl: cfg.baseUrl, apiKey: cfg.apiKey, enabled: true });
}

// 聚合所有启用渠道：并发拉取、60s 缓存、单渠道失败不影响其他
let cache: { at: number; data: QuotaSource[] } | null = null;
export async function summarizeUsage(): Promise<QuotaSource[]> {
  if (cache && Date.now() - cache.at < 60_000) return cache.data;
  const data = await Promise.all(listProviders().filter((p) => p.enabled).map(fetchSource));
  cache = { at: Date.now(), data };
  return data;
}

// .env kimiUsageKey 一次性迁移：settings 无任何额度源时自动注册为启用渠道
export function migrateEnvKimi(key: string | undefined) {
  if (!key || listProviders().length > 0) return;
  saveProviders([{ id: 'kimi-code', name: 'Kimi Code', adapter: 'kimi-coding', apiKey: key, enabled: true }]);
}
