// 种子数据：M2 内置默认方案 + 模型库（与方案文档 4.5/4.6 一致）+ M8 全局默认档位/重试参数
import type { DatabaseSync } from 'node:sqlite';
import type { Policy } from '../types.ts';
import { defaultTiersJson } from '../core/tiers.ts';

const defaultPolicy: Policy = {
  id: 'default',
  name: '通用智能路由',
  enabled: true,
  isDefault: true,
  description: '订阅制优先高价值任务，按量模型兜底日常',
  rules: [
    {
      id: 'funccall',
      name: '函数调用',
      enabled: true,
      priority: 10,
      when: [{ field: 'hasTools', op: 'eq', value: true }],
      then: { model: 'kimi-for-coding', reasonNote: 'Kimi 支持 tools，订阅制套餐内不另计费' },
    },
    {
      id: 'longctx',
      name: '超长输入',
      enabled: true,
      priority: 20,
      when: [{ field: 'inputTokens', op: 'gt', value: 24000 }],
      then: {
        model: 'kimi-for-coding',
        context: { strategy: 'truncate', maxTokens: 60000, tailRounds: 2, maxToolChars: 4000 },
        reasonNote: '262K 上下文，超长走订阅避免按量开销',
      },
    },
    {
      id: 'reason',
      name: '推理类',
      enabled: true,
      priority: 30,
      when: [
        {
          field: 'keywordsAny',
          op: 'contains',
          value: ['证明', '规划', '为什么', '一步步', '分析', '推理', '比较'],
        },
      ],
      then: { model: 'deepseek-flash', reasonNote: '思考模式，1M 上下文，价格低于 V3.2 系' },
    },
    {
      id: 'greeting',
      name: '极简问候',
      enabled: true,
      priority: 40,
      when: [
        { field: 'lastMsgChars', op: 'lt', value: 20 },
        { field: 'turnCount', op: 'eq', value: 1 },
      ],
      then: { model: 'deepseek-flash', reasonNote: '最便宜快模型' },
    },
  ],
  fallback: { model: 'deepseek-flash', reasonNote: '兜底：未命中规则，后续 M4 由 LLM 裁判接管' },
};

const models = [
  { model: 'kimi-for-coding', provider: 'kimi', display_name: 'Kimi Code', context_window: 262144, input_price: 0, output_price: 0, supports_tools: 1, tags: '订阅制,代码,长上下文,tools', note: '编程套餐内扣额度，5h/周限额；套餐外 API ¥6.5/M 输入、¥27/M 输出' },
  { model: 'deepseek-flash', provider: 'deepseek', display_name: 'DeepSeek V4.1-Flash', context_window: 1000000, input_price: 0.15, output_price: 0.6, supports_tools: 1, tags: '便宜,快,思考模式,1M上下文,vision', note: 'off-peak 价，peak 翻倍；默认思考模式' },
  { model: 'deepseek-reasoner', provider: 'deepseek', display_name: 'DeepSeek V3.2-Think', context_window: 128000, input_price: 0.28, output_price: 0.43, supports_tools: 0, tags: '推理', note: 'V3.2 旧模型，保留兼容，不推荐主用' },
  { model: 'deepseek-chat', provider: 'deepseek', display_name: 'DeepSeek V3.2', context_window: 128000, input_price: 0.28, output_price: 0.43, supports_tools: 1, tags: '通用', note: 'V3.2 旧模型，保留兼容' },
  { model: 'k3', provider: 'kimi', display_name: 'Kimi K3', context_window: 262144, input_price: 0, output_price: 0, supports_tools: 1, tags: '订阅制,旗舰' },
  { model: 'k3-256k', provider: 'kimi', display_name: 'Kimi K3-256K', context_window: 262144, input_price: 0, output_price: 0, supports_tools: 1, tags: '订阅制,长上下文' },
];

export function seed(db: DatabaseSync) {
  const upsert = db.prepare(
    `INSERT INTO policies (id, name, enabled, is_default, description, rules_json, fallback_json, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'))
     ON CONFLICT(id) DO UPDATE SET name=excluded.name, rules_json=excluded.rules_json, fallback_json=excluded.fallback_json`
  );
  upsert.run(
    defaultPolicy.id,
    defaultPolicy.name,
    defaultPolicy.enabled ? 1 : 0,
    defaultPolicy.isDefault ? 1 : 0,
    defaultPolicy.description ?? '',
    JSON.stringify(defaultPolicy.rules),
    JSON.stringify(defaultPolicy.fallback)
  );

  const mUpsert = db.prepare(
    `INSERT INTO model_catalog (model, provider, display_name, context_window, input_price, output_price, supports_tools, tags, note)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(model) DO UPDATE SET input_price=excluded.input_price, output_price=excluded.output_price, note=excluded.note`
  );
  for (const m of models) {
    mUpsert.run(m.model, m.provider, m.display_name, m.context_window, m.input_price, m.output_price, m.supports_tools, m.tags, m.note ?? null);
  }

  const s = db.prepare('INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)');
  s.run('judge_model', 'deepseek-flash');
  s.run('judge_enabled', '1');
  s.run('default_policy', 'default');
  s.run('global_max_cost_usd', '0.05');
  // M8：全局默认档位（judge 分类 → 档位映射的兜底）与失败重试/冷却参数
  s.run('tiers_default_json', defaultTiersJson());
  s.run('retry_on_error', '1');
  s.run('cooldown_fail_threshold', '3');
  s.run('cooldown_seconds', '300');
  // 自进化 L1（默认关闭；开启后定时微调档位表）
  s.run('self_evolve_enabled', '0');
  s.run('self_evolve_window_days', '7');
  s.run('self_evolve_min_sample', '20');
  s.run('self_evolve_success_gate', '0.9');
  s.run('self_evolve_interval_hours', '6');
}