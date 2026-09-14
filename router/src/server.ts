// Router 启动入口
import Fastify from 'fastify';
import { config } from './config.ts';
import { getDb } from './db/db.ts';
import { registerV1 } from './routes/v1.ts';
import { registerAdmin } from './routes/admin.ts';

const app = Fastify({ logger: false, bodyLimit: 32 * 1024 * 1024 });

registerV1(app);
registerAdmin(app);

// 兜底 404
app.setNotFoundHandler((req, reply) => {
  void req;
  reply.code(404).send({ error: { message: `Not Found: ${req.method} ${req.url}` } });
});

// 统一错误处理：异常时仍返回标准 OpenAI 结构
app.setErrorHandler((err, req, reply) => {
  void req;
  const msg = err instanceof Error ? err.message : 'Internal Server Error';
  const code = typeof (err as { statusCode?: number }).statusCode === 'number' ? (err as { statusCode: number }).statusCode : 500;
  reply.code(code).send({
    error: {
      message: msg,
      type: 'router_error',
    },
  });
});

try {
  getDb();
  await app.listen({ port: config.port, host: config.host });
  console.log(`[router] listening on http://${config.host}:${config.port}`);
  console.log(`[router] new-api upstream: ${config.newapiBase}`);
} catch (e) {
  console.error('[router] 启动失败:', e);
  process.exit(1);
}