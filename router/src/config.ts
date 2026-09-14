// 全局配置：环境变量优先（支持 .env 自动加载），默认本机自用
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// 轻量 .env 加载：优先真环境变量，缺失时用 .env 文件值（避免手动重启丢令牌）
function loadEnv() {
  const file = fileURLToPath(new URL('../.env', import.meta.url));
  if (!existsSync(file)) return;
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    const m = line.trim().match(/^(?:export\s+)?([A-Z_][A-Z0-9_]*)=(.*)$/);
    if (!m) continue;
    const [, k, v] = m;
    if (process.env[k] === undefined) process.env[k] = v.trim().replace(/^["']|["']$/g, '');
  }
}
loadEnv();

export const config = {
  port: Number(process.env.ROUTER_PORT ?? 33333),
  host: process.env.ROUTER_HOST ?? '127.0.0.1', // Router 只绑本机，不对外
  newapiBase: process.env.NEWAPI_BASE ?? 'http://127.0.0.1:22222',
  // Router→new-api 令牌：创建于 new-api 令牌页，格式 sk-xxx
  newapiToken: process.env.NEWAPI_TOKEN ?? '',
  dbPath: process.env.ROUTER_DB_PATH ?? 'router-data/router.db',
  // Kimi Code 编程套餐 API Key：控制台额度展示用（api.kimi.com/coding/v1/usages）
  kimiUsageKey: process.env.KIMI_USAGE_KEY ?? '',
};

if (!config.newapiToken) {
  console.warn('[config] 未设置 NEWAPI_TOKEN，/v1 转发将 401；请配置 .env 或环境变量');
}