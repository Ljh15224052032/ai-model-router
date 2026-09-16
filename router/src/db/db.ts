// 数据库：node:sqlite（Node 24 内置，无原生依赖）
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { config } from '../config.ts';
import { seed } from './seed.ts';

let db: DatabaseSync | null = null;

export function getDb(): DatabaseSync {
  if (db) return db;
  mkdirSync(dirname(config.dbPath), { recursive: true });
  db = new DatabaseSync(config.dbPath);
  db.exec('PRAGMA journal_mode = WAL;');
  migrate(db);
  seed(db);
  return db;
}

function migrate(db: DatabaseSync) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS model_catalog (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      model TEXT NOT NULL UNIQUE,          -- new-api 中真实模型名
      provider TEXT NOT NULL,
      display_name TEXT,
      context_window INTEGER,
      input_price REAL DEFAULT 0,          -- 每百万 token 输入单价（美元）
      output_price REAL DEFAULT 0,
      supports_tools INTEGER DEFAULT 0,
      tags TEXT DEFAULT '',                -- 逗号分隔能力标签
      enabled INTEGER DEFAULT 1,
      note TEXT
    );
    CREATE TABLE IF NOT EXISTS policies (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      enabled INTEGER DEFAULT 1,
      is_default INTEGER DEFAULT 0,
      description TEXT,
      rules_json TEXT NOT NULL,
      fallback_json TEXT NOT NULL,
      tiers_json TEXT,
      updated_at TEXT DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS request_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      created_at TEXT DEFAULT (datetime('now')),
      client TEXT,
      requested_model TEXT,
      policy_id TEXT,
      rule_id TEXT,
      route_source TEXT,
      judge_result_json TEXT,
      final_model TEXT,
      provider TEXT,
      context_action TEXT DEFAULT 'none',
      prompt_tokens INTEGER DEFAULT 0,
      completion_tokens INTEGER DEFAULT 0,
      cached_tokens INTEGER DEFAULT 0,
      cost_usd REAL DEFAULT 0,
      latency_ms INTEGER DEFAULT 0,
      status TEXT,
      error TEXT,
      degraded INTEGER DEFAULT 0,
      retried INTEGER DEFAULT 0,
      orch_id TEXT,
      orch_role TEXT
    );
    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT
    );
    CREATE TABLE IF NOT EXISTS model_health (
      model TEXT PRIMARY KEY,
      fails INTEGER DEFAULT 0,
      cooled_until INTEGER DEFAULT 0,
      updated_at TEXT DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS optimizer_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      created_at TEXT DEFAULT (datetime('now')),
      action TEXT,
      reason TEXT,
      previous_tiers_json TEXT,
      new_tiers_json TEXT
    );
  `);

  // 列级迁移：旧库补 tiers_json（PRAGMA 检测，幂等）
  const cols = db.prepare("PRAGMA table_info(policies)").all() as Array<{ name: string }>;
  if (!cols.some((c) => c.name === 'tiers_json')) {
    db.exec('ALTER TABLE policies ADD COLUMN tiers_json TEXT');
  }
  // M9 编排：旧库补 orch_id / orch_role
  const logCols = db.prepare("PRAGMA table_info(request_logs)").all() as Array<{ name: string }>;
  if (!logCols.some((c) => c.name === 'orch_id')) {
    db.exec('ALTER TABLE request_logs ADD COLUMN orch_id TEXT');
  }
  if (!logCols.some((c) => c.name === 'orch_role')) {
    db.exec('ALTER TABLE request_logs ADD COLUMN orch_role TEXT');
  }
  // L2 在线探索：记录探索前的主模型（探索请求 final_model 为候选人，source 仍 tier）
  const exploreCols = db.prepare('PRAGMA table_info(request_logs)').all() as Array<{ name: string }>;
  if (!exploreCols.some((c) => c.name === 'explored_from')) {
    db.exec('ALTER TABLE request_logs ADD COLUMN explored_from TEXT');
  }
}