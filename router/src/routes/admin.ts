// 管理 API（Console 使用，仅监听本机）：方案/模型/统计/日志/调试（方案文档第 8 节）
import type { FastifyInstance } from 'fastify';
import { listPolicies, getPolicy, refreshPolicies, getDefaultPolicy } from '../db/policies.ts';
import { listModels, getModelCost } from '../db/models.ts';
import { getSetting, setSetting } from '../db/settings.ts';
import { getDb } from '../db/db.ts';
import { decide } from '../core/dispatcher.ts';
import { extractFeatures } from '../core/classifier.ts';
import { healthSnapshot, clearHealth } from '../core/health.ts';
import { ADAPTER_META, listProviders, migrateEnvKimi, saveProviders, summarizeUsage, testProvider, type ProviderConfig } from '../core/usage.ts';
import { config } from '../config.ts';
import { createReadStream, copyFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Policy } from '../types.ts';

export function registerAdmin(app: FastifyInstance) {
  // .env kimiUsageKey 一次性迁移进 settings（已有额度源配置则跳过）
  migrateEnvKimi(config.kimiUsageKey);

  // ---------- 方案 ----------
  app.get('/api/policies', async () => listPolicies());

  app.get('/api/policies/:id', async (req) => {
    const { id } = req.params as { id: string };
    const p = getPolicy(id);
    if (!p) return { error: '方案不存在' };
    return p;
  });

  app.post('/api/policies', async (req, reply) => {
    const body = req.body as Partial<Policy>;
    if (!body.id || !body.name) return reply.code(400).send({ error: 'id 与 name 必填' });
    const now = new Date().toISOString();
    const db = getDb();
    db.prepare(
      `INSERT INTO policies (id, name, enabled, is_default, description, rules_json, fallback_json, tiers_json, updated_at)
       VALUES (?, ?, ?, 0, ?, ?, ?, ?, ?)`
    ).run(
      body.id,
      body.name,
      body.enabled === false ? 0 : 1,
      body.description ?? '',
      JSON.stringify(body.rules ?? []),
      JSON.stringify(body.fallback ?? { model: 'deepseek-flash' }),
      body.tiers && Array.isArray(body.tiers.entries) ? JSON.stringify(body.tiers) : null,
      now
    );
    refreshPolicies();
    return { success: true };
  });

  app.put('/api/policies/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = req.body as Partial<Policy>;
    const db = getDb();
    const existed = db.prepare('SELECT id FROM policies WHERE id = ?').get(id);
    if (!existed) return reply.code(404).send({ error: '方案不存在' });
    const hasName = body.name !== undefined;
    const hasRules = body.rules !== undefined;
    const hasFallback = body.fallback !== undefined;
    const hasTiers = body.tiers !== undefined;
    const sets: string[] = [];
    const vals: (string | number | null)[] = [];
    if (hasName) { sets.push('name = ?'); vals.push(body.name as string); }
    if (body.enabled !== undefined) { sets.push('enabled = ?'); vals.push(body.enabled ? 1 : 0); }
    if (body.description !== undefined) { sets.push('description = ?'); vals.push(body.description as string); }
    if (hasRules) { sets.push('rules_json = ?'); vals.push(JSON.stringify(body.rules)); }
    if (hasFallback) { sets.push('fallback_json = ?'); vals.push(JSON.stringify(body.fallback)); }
    if (hasTiers) { sets.push('tiers_json = ?'); vals.push(body.tiers && Array.isArray(body.tiers.entries) ? JSON.stringify(body.tiers) : null); }
    if (body.isDefault !== undefined) { sets.push('is_default = ?'); vals.push(body.isDefault ? 1 : 0); }
    sets.push('updated_at = datetime(\'now\')');
    if (sets.length === 0) return reply.code(400).send({ error: '无更新字段' });
    vals.push(id);
    db.prepare(`UPDATE policies SET ${sets.join(', ')} WHERE id = ?`).run(...vals);
    refreshPolicies();
    return { success: true };
  });

  app.delete('/api/policies/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const def = getDefaultPolicy();
    if (def?.id === id) return reply.code(400).send({ error: '默认方案不可删除' });
    const result = getDb().prepare('DELETE FROM policies WHERE id = ?').run(id);
    if (result.changes === 0) return reply.code(404).send({ error: '方案不存在' });
    refreshPolicies();
    return { success: true };
  });

  // ---------- 模型库 ----------
  app.get('/api/models', async () => listModels());

  app.put('/api/models/:model', async (req) => {
    const { model } = req.params as { model: string };
    const body = req.body as Record<string, unknown>;
    const fields: string[] = [];
    const vals: (string | number | null)[] = [];
    if (body.displayName !== undefined) { fields.push('display_name = ?'); vals.push(String(body.displayName)); }
    if (body.inputPrice !== undefined) { fields.push('input_price = ?'); vals.push(Number(body.inputPrice)); }
    if (body.outputPrice !== undefined) { fields.push('output_price = ?'); vals.push(Number(body.outputPrice)); }
    if (body.supportsTools !== undefined) { fields.push('supports_tools = ?'); vals.push(body.supportsTools ? 1 : 0); }
    if (body.tags !== undefined) { fields.push('tags = ?'); vals.push((body.tags as string[]).join(',')); }
    if (body.enabled !== undefined) { fields.push('enabled = ?'); vals.push(body.enabled ? 1 : 0); }
    if (body.note !== undefined) { fields.push('note = ?'); vals.push(String(body.note)); }
    if (body.contextWindow !== undefined) { fields.push('context_window = ?'); vals.push(Number(body.contextWindow)); }
    if (fields.length === 0) return { success: true };
    vals.push(model);
    getDb().prepare(`UPDATE model_catalog SET ${fields.join(', ')} WHERE model = ?`).run(...vals);
    return { success: true };
  });

  // ---------- 设置 ----------
  app.get('/api/settings', async () => {
    const rows = getDb().prepare('SELECT key, value FROM settings').all() as Array<{ key: string; value: string }>;
    const obj: Record<string, string> = {};
    rows.forEach((r) => { obj[r.key] = r.value; });
    return obj;
  });

  app.put('/api/settings', async (req) => {
    const body = req.body as Record<string, string>;
    for (const [k, v] of Object.entries(body)) setSetting(k, String(v));
    return { success: true };
  });

  // ---------- 调试 ----------
  app.post('/api/test-route', async (req) => {
    const body = req.body as { model?: string; messages?: Array<{ role: string; content: unknown }>; tools?: unknown[] };
    const requestedModel = body.model ?? 'auto';
    const { decision, features, contextAction } = await decide({
      requestModel: requestedModel,
      messages: body.messages ?? [],
      tools: body.tools,
      dryRun: true, // 调试不落正式日志（含裁判调用）
    });
    const cost = getModelCost(decision.finalModel);
    return { decision, features, contextAction, estimatedCost: cost };
  });

  // ---------- 模型健康（M8：失败冷却状态，P2 持久化 model_health 表 + 冷却管理）----------
  app.get('/api/health/models', async () => ({ models: healthSnapshot() }));

  app.delete('/api/health/models/:model', async (req) => {
    const { model } = req.params as { model: string };
    clearHealth(model); // 解除冷却/清零失败计数
    return { success: true, model };
  });

  // ---------- 统计 ----------
  app.get('/api/stats/summary', async () => {
    const db = getDb();
    const total = db.prepare('SELECT COUNT(*) c, COALESCE(SUM(cost_usd),0) cost, COALESCE(SUM(prompt_tokens + completion_tokens),0) tokens FROM request_logs').get() as { c: number; cost: number; tokens: number };
    // 今日独立查询 + localtime 切天：跨天后即使零请求也返回 0，绝不沿用昨天数据
    const today = db.prepare("SELECT COUNT(*) c FROM request_logs WHERE date(created_at, 'localtime') = date('now', 'localtime')").get() as { c: number };
    const byModel = db.prepare('SELECT final_model, COUNT(*) c, SUM(prompt_tokens + completion_tokens) tokens, COALESCE(SUM(cost_usd),0) cost FROM request_logs WHERE status=\'success\' GROUP BY final_model ORDER BY cost DESC').all();
    const bySource = db.prepare('SELECT route_source, COUNT(*) c FROM request_logs GROUP BY route_source').all();
    // 日期聚合用 localtime：天界与用户时区对齐（否则北京时间 0-8 点的请求会被计入前一天）
    const recent = db.prepare("SELECT date(created_at, 'localtime') d, COUNT(*) c, COALESCE(SUM(cost_usd),0) cost FROM request_logs GROUP BY d ORDER BY d DESC LIMIT 14").all();
    const rate = Number(getSetting('usd_cny_rate')) || 7.2; // USD→CNY 汇率，设置页可调
    return { total: { ...total, costCny: total.cost * rate }, today: today.c, byModel, bySource, recent };
  });

  app.get('/api/stats/by-provider', async (req) => {
    // 与「成本分析」卡同周期窗口同口径（success-only），否则卡内峰谷次数与渠道次数对不上
    const { range = 'today' } = req.query as { range?: string };
    const where = rangeConds[range];
    if (!where) return { error: 'range 必须是 today / week / month' };
    const rows = getDb().prepare(`SELECT provider, COUNT(*) c, COALESCE(SUM(cost_usd),0) cost FROM request_logs WHERE status='success' AND ${where} GROUP BY provider`).all();
    return rows;
  });

  // ---------- 数据备份（M6）：一键导出 Router 全部状态（router.db 一致快照）----------
  app.get('/api/backup', async (_req, reply) => {
    // 先合并 WAL 再复制主库，保证快照含全部已提交事务
    getDb().exec('PRAGMA wal_checkpoint(TRUNCATE);');
    const tmp = join(tmpdir(), `router-backup-${Date.now()}.db`);
    copyFileSync(config.dbPath, tmp);
    const stamp = new Date().toISOString().slice(0, 19).replace(/[T:]/g, '-');
    reply.header('Content-Type', 'application/octet-stream');
    reply.header('Content-Disposition', `attachment; filename="router-backup-${stamp}.db"`);
    return reply.send(createReadStream(tmp));
  });

  // 周期窗口（today/week/month，localtime 口径）：period / period-cost / by-provider 三接口同源，保证卡内各区块口径一致
  const rangeConds: Record<string, string> = {
    today: `date(created_at, 'localtime') = date('now', 'localtime')`,
    // 本周以周一为起点：偏移 = (星期 %w + 6) % 7 天
    week: `date(created_at, 'localtime') >= date('now', 'localtime', '-' || ((CAST(strftime('%w', 'now', 'localtime') AS INT) + 6) % 7) || ' days')`,
    month: `strftime('%Y-%m', created_at, 'localtime') = strftime('%Y-%m', 'now', 'localtime')`,
  };

  // ---------- 时段成本（M6）：peak/off-peak 统计，支持 today/week/month ----------
  // peak = 北京时间周一至五 9:00-12:00、14:00-18:00（翻倍计价体现峰谷），其余 off-peak（按 off-peak 单价估算）
  app.get('/api/stats/period-cost', async (req) => {
    const { range = 'today' } = req.query as { range?: string };
    const where = rangeConds[range];
    if (!where) return { error: 'range 必须是 today / week / month' };
    const db = getDb();
    // pk 只管时段判定；status='success' 放外层 WHERE，两侧口径一致（否则失败请求全落"非高峰"，次数对不上渠道分布）
    const pk = `strftime('%w', created_at, 'localtime') IN ('1','2','3','4','5')
      AND (CAST(strftime('%H', created_at, 'localtime') AS INT) BETWEEN 9 AND 11 OR CAST(strftime('%H', created_at, 'localtime') AS INT) BETWEEN 14 AND 17)`;
    const row = db.prepare(`
      SELECT
        SUM(CASE WHEN ${pk} THEN cost_usd ELSE 0 END) peak_cost,
        SUM(CASE WHEN NOT (${pk}) THEN cost_usd ELSE 0 END) offpeak_cost,
        SUM(CASE WHEN ${pk} THEN 1 ELSE 0 END) peak_c,
        SUM(CASE WHEN NOT (${pk}) THEN 1 ELSE 0 END) offpeak_c
      FROM request_logs WHERE status='success' AND ${where}
    `).get() as { peak_cost: number; offpeak_cost: number; peak_c: number; offpeak_c: number };
    const peak = Number(row.peak_cost ?? 0);
    const off = Number(row.offpeak_cost ?? 0);
    return {
      range,
      peakCost: peak,
      offpeakCost: off,
      peakC: Number(row.peak_c ?? 0),
      offpeakC: Number(row.offpeak_c ?? 0),
      peakCostX2: peak * 2, // 若 peak 翻倍计价的总成本（体现峰谷差）
      totalCost: peak + off,
    };
  });

  // ---------- 编排统计（M9.3）：近 14 天编排次数 / 子任务成功率 / 成本 ----------
  app.get('/api/stats/orchestration', async () => {
    const db = getDb();
    const win = `orch_id IS NOT NULL AND created_at >= datetime('now', 'localtime', '-13 days')`;
    const tot = db.prepare(`
      SELECT COUNT(DISTINCT orch_id) orchs,
        SUM(CASE WHEN orch_role='worker' THEN 1 ELSE 0 END) worker_calls,
        SUM(CASE WHEN orch_role='worker' AND status='success' THEN 1 ELSE 0 END) worker_ok,
        SUM(cost_usd) cost_usd
      FROM request_logs WHERE ${win}
    `).get() as { orchs: number; worker_calls: number; worker_ok: number; cost_usd: number };
    const planner = db.prepare(`SELECT final_model FROM request_logs WHERE orch_role='planner' ORDER BY id DESC LIMIT 1`).get() as { final_model: string } | undefined;
    const recent = db.prepare(`
      SELECT orch_id,
        SUM(CASE WHEN orch_role='worker' THEN 1 ELSE 0 END) workers,
        SUM(CASE WHEN orch_role='worker' AND status='success' THEN 1 ELSE 0 END) workers_ok,
        ROUND(SUM(cost_usd), 4) cost_usd,
        MIN(created_at) started
      FROM request_logs WHERE ${win}
      GROUP BY orch_id ORDER BY started DESC LIMIT 5
    `).all() as Array<{ orch_id: string; workers: number; workers_ok: number; cost_usd: number; started: string }>;
    return {
      orchs: tot.orchs ?? 0,
      avgWorkers: tot.orchs ? Number((tot.worker_calls / tot.orchs).toFixed(1)) : 0,
      workerOkRate: tot.worker_calls ? Math.round((100 * tot.worker_ok) / tot.worker_calls) : 0,
      costUsd: Number((tot.cost_usd ?? 0).toFixed(4)),
      plannerModel: planner?.final_model ?? '—',
      recent,
    };
  });

  // 按周期统计（today/week/month，localtime 口径）：概览卡的大数字与来源分布同源
  app.get('/api/stats/period', async (req) => {
    const { range = 'today' } = req.query as { range?: string };
    const conds: Record<string, string> = {
      today: `date(created_at, 'localtime') = date('now', 'localtime')`,
      // 本周以周一为起点：偏移 = (星期 %w + 6) % 7 天
      week: `date(created_at, 'localtime') >= date('now', 'localtime', '-' || ((CAST(strftime('%w', 'now', 'localtime') AS INT) + 6) % 7) || ' days')`,
      month: `strftime('%Y-%m', created_at, 'localtime') = strftime('%Y-%m', 'now', 'localtime')`,
    };
    const where = conds[range];
    if (!where) return { error: 'range 必须是 today / week / month' };
    const fromExpr = range === 'today'
      ? `date('now', 'localtime')`
      : range === 'week'
        ? `date('now', 'localtime', '-' || ((CAST(strftime('%w', 'now', 'localtime') AS INT) + 6) % 7) || ' days')`
        : `date('now', 'localtime', 'start of month')`;
    const db = getDb();
    const total = db.prepare(`SELECT COUNT(*) c, COALESCE(SUM(cost_usd),0) cost FROM request_logs WHERE ${where}`).get() as { c: number; cost: number };
    const bySource = db.prepare(`SELECT route_source, COUNT(*) c FROM request_logs WHERE ${where} GROUP BY route_source ORDER BY c DESC`).all();
    const bounds = db.prepare(`SELECT ${fromExpr} from_d, date('now', 'localtime') to_d`).get() as { from_d: string; to_d: string };
    return { range, c: total.c, cost: total.cost, bySource, from: bounds.from_d, to: bounds.to_d };
  });

  app.get('/api/logs', async (req) => {
    const q = req.query as { page?: string; model?: string; source?: string; limit?: string };
    const page = Math.max(1, Number(q.page ?? 1));
    const limit = Math.min(100, Math.max(1, Number(q.limit ?? 20)));
    const conds: string[] = [];
    const vals: (string | number)[] = [];
    if (q.model) { conds.push('final_model = ?'); vals.push(q.model); }
    if (q.source) { conds.push('route_source = ?'); vals.push(q.source); }
    const where = conds.length ? `WHERE ${conds.join(' AND ')}` : '';
    const total = (getDb().prepare(`SELECT COUNT(*) c FROM request_logs ${where}`).get(...vals) as { c: number }).c;
    const rows = getDb()
      .prepare(`SELECT * FROM request_logs ${where} ORDER BY id DESC LIMIT ? OFFSET ?`)
      .all(...vals, limit, (page - 1) * limit);
    return { total, page, limit, rows };
  });

  // ---------- 校准报表（P2）：错配列表（方案文档 9 节，首期两条规则）----------
  // 规则 A：低价值任务（judge 分类 taskType∈{chat,unknown}）却命中高价档模型
  // 高价档 = 非「便宜」标记的启用模型（配额型 kimi/k3 + 高单价旧旗舰），便宜主力（deepseek-flash）不计入
  // 规则 B：单请求成本 > 阈值（settings global_max_cost_usd，默认 0.05）
  app.get('/api/stats/mismatch', async () => {
    const db = getDb();
    const highTier = db.prepare(
      `SELECT model FROM model_catalog WHERE enabled=1 AND tags NOT LIKE '%便宜%'`
    ).all() as Array<{ model: string }>;
    const highSet = highTier.map((r) => r.model);
    const threshold = Number(getSetting('global_max_cost_usd')) || 0.05;
    const items: Array<Record<string, unknown>> = [];

    if (highSet.length) {
      const ph = highSet.map(() => '?').join(',');
      const rowsA = db.prepare(
        `SELECT id, created_at, requested_model, final_model, route_source, judge_result_json, cost_usd, latency_ms
         FROM request_logs
         WHERE status='success' AND route_source='tier'
           AND (judge_result_json LIKE '%"taskType":"chat"%' OR judge_result_json LIKE '%"taskType":"unknown"%')
           AND final_model IN (${ph})
         ORDER BY id DESC LIMIT 50`
      ).all(...highSet) as Array<Record<string, unknown>>;
      for (const r of rowsA) {
        let taskType = '';
        try { taskType = (JSON.parse(String(r.judge_result_json ?? '{}')) as { taskType?: string }).taskType ?? ''; } catch { /* ignore */ }
        items.push({ ...r, task_type: taskType, rule: 'low_value_high_model' });
      }
    }

    const rowsB = db.prepare(
      `SELECT id, created_at, requested_model, final_model, route_source, judge_result_json, cost_usd, latency_ms
       FROM request_logs WHERE status='success' AND cost_usd > ?
       ORDER BY id DESC LIMIT 50`
    ).all(threshold) as Array<Record<string, unknown>>;
    for (const r of rowsB) {
      items.push({ ...r, task_type: '', rule: 'cost_over_threshold' });
    }

    items.sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
    return {
      threshold,
      highTierModels: highSet,
      rules: [
        { code: 'low_value_high_model', desc: 'judge 分类 chat/unknown 却命中高价档模型（非「便宜」标记）' },
        { code: 'cost_over_threshold', desc: `单请求成本超过阈值 $${threshold}` },
      ],
      items: items.slice(0, 50),
    };
  });

  // ---------- 上游额度源（通用适配器，设置页管理凭据）----------
  app.get('/api/usage/summary', async () => ({ sources: await summarizeUsage() }));

  app.get('/api/usage/meta', async () => ADAPTER_META);

  // 列表返回打码 Key（尾 4 位），明文只在保存新 Key 时传入
  app.get('/api/usage/providers', async () =>
    listProviders().map((p) => ({ ...p, apiKey: p.apiKey ? `****${p.apiKey.slice(-4)}` : '' }))
  );

  app.put('/api/usage/providers', async (req) => {
    const incoming = req.body as Array<Partial<ProviderConfig>>;
    const old = listProviders();
    const merged = incoming.map((p) => {
      const prev = p.id ? old.find((o) => o.id === p.id) : undefined;
      const apiKey = p.apiKey && !String(p.apiKey).startsWith('****') ? String(p.apiKey) : (prev?.apiKey ?? '');
      return {
        id: p.id ?? `p-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
        name: String(p.name ?? prev?.name ?? '未命名'),
        adapter: String(p.adapter ?? prev?.adapter ?? ''),
        baseUrl: p.baseUrl ? String(p.baseUrl) : prev?.baseUrl,
        apiKey,
        enabled: p.enabled !== false,
      };
    });
    saveProviders(merged);
    return { success: true };
  });

  app.post('/api/usage/test', async (req) => {
    const b = req.body as Partial<ProviderConfig>;
    if (!b.adapter || !b.apiKey) return { status: 'unavailable', items: [], error: '适配器与 Key 必填' };
    return testProvider({ name: b.name ?? '测试', adapter: b.adapter, baseUrl: b.baseUrl, apiKey: b.apiKey });
  });

  // ---------- 模型成本查询（供 /v1 内部）----------
  app.get('/api/health', async () => ({ success: true, time: new Date().toISOString() }));
}

// 供 v1 路由复用：特征提取后返回（调试用）
export { extractFeatures };