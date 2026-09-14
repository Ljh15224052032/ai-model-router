# AI Model Router

[![status](https://img.shields.io/badge/status-active-purple)](https://github.com/Ljh15224052032/ai-model-router)
[![license](https://img.shields.io/badge/license-MIT-blue)](#license)
[![node](https://img.shields.io/badge/node-%E2%89%A522.5-brightgreen)](#quick-start)
[![models](https://img.shields.io/badge/models-Kimi%20%7C%20DeepSeek%20%7C%20auto-orange)](#model-parameter-semantics)

> An OpenAI-compatible AI model routing layer: aggregate multiple LLMs behind one endpoint, auto-dispatch the best fit per request, and apply layered context control for long conversations.

> 一个 OpenAI 兼容的 AI 模型路由调度层：把多个模型聚合到一个入口，按规则自动分发给最合适的模型，并对超长上下文做分层控制。

---

## Table of Contents / 目录

| Section | EN | 中文 |
| :--- | :--- | :--- |
| Architecture | [Jump](#architecture) | [跳转](#架构) |
| Core Features | [Jump](#core-features) | [跳转](#核心特性) |
| Design Highlights | [Jump](#design-highlights) | [跳转](#设计要点) |
| Quick Start | [Jump](#quick-start) | [跳转](#快速开始) |
| Model Parameter | [Jump](#model-parameter-semantics) | [跳转](#model-参数语义) |
| Project Layout | [Jump](#project-layout) | [跳转](#项目结构) |
| Docs | [Jump](#docs) | [跳转](#文档) |
| License | [Jump](#license) | [跳转](#协议) |

---

## Architecture

```
Client / Script
    │  POST /v1/chat/completions  model=auto
    ▼
┌─────────────────────────┐     ┌──────────────────┐     ┌────────────────┐
│  Router (this repo)     │────►│  new-api         │────►│  LLM Providers │
│  rules / judge / context│     │  channels & keys │     │  Kimi/DeepSeek │
└─────────────────────────┘     └──────────────────┘     └────────────────┘
        ▲
┌───────┴──────────┐
│ Console (web UI) │ policy edit / model catalog / logs / stats
└──────────────────┘
```

| Component | Port | Stack | Storage |
| :--- | :--- | :--- | :--- |
| new-api | 22222 | Official release (Go binary) | SQLite (bundled) |
| Router | 33333 | Node 22.5+ · TypeScript · Fastify | SQLite (`node:sqlite`, no native build) |
| Console | 5173 (dev) / 33333 (prod) | React 19 · Vite · Tailwind v4 · ECharts | None (calls Router admin API) |

---

## 架构

```
客户端 / 脚本
    │  请求 model=auto
    ▼
┌─────────────────────────┐     ┌──────────────────┐     ┌────────────────┐
│  Router（本仓库自研）   │────►│  new-api（接入层）│────►│  模型供应商     │
│  规则路由 / 裁判 / 上下文│     │  渠道与密钥管理   │     │  Kimi/DeepSeek │
└─────────────────────────┘     └──────────────────┘     └────────────────┘
        ▲
┌───────┴──────────┐
│ Console（可视化）│ 方案配置 / 模型库 / 日志 / 统计
└──────────────────┘
```

| 组件 | 端口 | 技术 | 数据 |
| :--- | :--- | :--- | :--- |
| new-api | 22222 | 官方发行版（Go 单文件） | 自带 SQLite |
| Router | 33333 | Node 22.5+ · TypeScript · Fastify | SQLite（`node:sqlite`，免原生编译） |
| Console | 5173（dev）/ 33333（prod 托管） | React 19 · Vite · Tailwind v4 · ECharts | 无独立存储，调 Router 管理 API |

---

## Core Features

| Module | Capability | Status |
| :--- | :--- | :--- |
| Unified Entry | OpenAI-compatible `/v1/chat/completions`; `model=auto` as the universal model name | ✅ Done |
| Rule Routing | Match request features (tokens / tools / keywords / turns) against policies; first hit wins | ✅ Done |
| LLM Judge | When no rule matches, a cheap model structurally decides `task_type/complexity` and picks a model; failure never blocks | ✅ Done |
| Context Control | Three layers: tool-result budget L0 / smart truncation L1 / snapshot summary L2 (see [design doc](docs/上下文控制设计.md)) | ✅ Done |
| Tiered Routing 2.0 | Tier policy + retry chain + cooldown; failover across provider/model on error or cost-over-threshold | ✅ Done |
| Orchestration | `model=auto@orchestrate` — planner splits task → workers run in parallel (DAG) → synthesizer merges; budget guardrails | ✅ Done |
| Cost Tracking | Per-call cost from model price catalog; cost caps + downgrade chain | 🚧 Planned |
| Visual Console | Policy editor, model catalog, Test Route, request logs, stats dashboard, orchestration view | 🚧 In Progress |

---

## 核心特性

| 模块 | 能力 | 状态 |
| :--- | :--- | :--- |
| 统一入口 | OpenAI 兼容 `/v1/chat/completions`，`model=auto` 万能模型名 | ✅ 完成 |
| 规则路由 | 按请求特征（token 量/工具/关键词/轮数等）匹配方案与规则，首条命中即停 | ✅ 完成 |
| LLM 裁判 | 规则未命中时，由便宜模型结构化判定 `task_type/complexity` 并选模型，失败不阻断 | ✅ 完成 |
| 上下文控制 | 三层机制：工具结果预算 L0 / 智能截断 L1 / 快照摘要 L2（详见 [设计文档](docs/上下文控制设计.md)） | ✅ 完成 |
| 路由方案 2.0 | 档位策略 + 重试链 + 冷却；按错误或成本超阈值在供应商/模型间降级 | ✅ 完成 |
| 编排模式 | `model=auto@orchestrate` —— planner 拆任务 → worker 并发执行（DAG）→ synthesizer 合成；预算护栏 | ✅ 完成 |
| 成本核算 | 按模型单价表自动计算每次调用成本，支持成本上限与降级链 | 🚧 规划 |
| 可视化控制台 | 方案可视化编辑、模型库单价维护、Test Route 调试、请求日志、统计看板、编排视图 | 🚧 开发中 |

---

## Design Highlights

- **Stateless Forwarding**: Router only reshapes a single request (swap model, trim context); it never holds any provider keys. Real keys live only inside new-api channels.
- **Decision Chain**: rules → LLM judge → fallback, with progressive degradation. Any stage failure never blocks the main request.
- **Context Control, Three Layers**: first strip the "largest chunk" (oversized tool output), then trim "mission-complete" older turns, and only then summarize. The last user message is never truncated (unless it alone exceeds the budget). Design informed by research into Claude Code / OpenAI Codex / Gemini CLI / DeepSeek / GLM mechanisms.
- **Observable Audit**: every request logs hit source, final model, context action, usage, cost, latency; response headers carry `x-route-*` debug info.

---

## 设计要点

- **无状态转发**：Router 只整形单次请求（换模型、裁上下文），不持有任何供应商密钥，真实密钥只存在 new-api 渠道里。
- **决策链路**：规则 → LLM 裁判 → 兜底，逐级降级，任何环节失败都不阻断主请求。
- **上下文控制三层**：先清"最大块"（超大工具输出），再裁"完成使命"的旧轮次，最后才整体摘要；最后一条用户消息永不截断（除非单条消息自身超过预算）。设计借鉴 Claude Code / OpenAI Codex / Gemini CLI / DeepSeek / GLM 的机制研究。
- **审计可观测**：每次请求记录命中来源、最终模型、上下文动作、usage、成本、延迟；响应头带 `x-route-*` 调试信息。

---

## Quick Start

**Prerequisites**: Node.js ≥ 22.5 (experimental SQLite support).

1. **Start new-api** on port 22222. After login, create Kimi / DeepSeek channels with your API keys, then generate an access token on the "Tokens" page.
2. **Configure Router**: copy `router/.env.example` to `router/.env` and fill in the token.

   ```bash
   cd router
   npm install
   npm run start
   ```

3. **Call it**:

   ```bash
   curl http://127.0.0.1:33333/v1/chat/completions \
     -H "Content-Type: application/json" \
     -d '{"model":"auto","messages":[{"role":"user","content":"hello"}]}'
   ```

   Inspect response headers: `x-route-model` (actual model), `x-route-source` (rule/judge/fallback), `x-context-action` (context op).

4. **(Optional) Start the console**:

   ```bash
   cd console
   npm install
   npm run dev
   ```

   Open http://localhost:5173/ — dashboard, policy editor, model catalog, logs, debug.

---

## 快速开始

**前置**：Node 22.5+（实验性 SQLite 支持）。

1. **启动 new-api**（端口 22222），登录后创建 Kimi / DeepSeek 渠道并填入密钥，在"令牌"页生成一个访问令牌。
2. **配置 Router**：复制 `router/.env.example` 为 `router/.env`，填入令牌。

   ```bash
   cd router
   npm install
   npm run start
   ```

3. **调用**：

   ```bash
   curl http://127.0.0.1:33333/v1/chat/completions \
     -H "Content-Type: application/json" \
     -d '{"model":"auto","messages":[{"role":"user","content":"你好"}]}'
   ```

   响应头可观察 `x-route-model`（实际模型）、`x-route-source`（rule/judge/fallback）、`x-context-action`（上下文动作）。

4. **（可选）启动控制台**：

   ```bash
   cd console
   npm install
   npm run dev
   ```

   打开 http://localhost:5173/ —— 仪表盘、方案编辑、模型库、日志、调试。

---

## Model Parameter Semantics

| Value | Behavior |
| :--- | :--- |
| `auto` | Full decision chain: rules → judge → fallback |
| `auto:<policy>` | Pin a specific policy, e.g. `auto:code` |
| `auto@orchestrate` | Orchestration mode: planner splits → workers run → synthesizer merges |
| Real model name (e.g. `deepseek-chat`) | Skip decision, pass through as-is (for A/B testing) |

---

## model 参数语义

| 取值 | 行为 |
| :--- | :--- |
| `auto` | 完整判定：规则 → 裁判 → 兜底 |
| `auto:<方案名>` | 指定路由方案，如 `auto:code` |
| `auto@orchestrate` | 编排模式：planner 拆任务 → worker 执行 → synthesizer 合成 |
| 真实模型名（如 `deepseek-chat`） | 跳过判定，原样透传（便于对比测试） |

---

## Project Layout

```
ai-model-router/
├─ new-api-data/        # new-api release + data (gitignored)
├─ router/              # Routing layer
│  ├─ src/core/         # classifier / rule-engine / judge / dispatcher / context / tiers / orchestrator
│  ├─ src/upstream/     # new-api forward (incl. SSE pass-through)
│  ├─ src/routes/       # /v1 compat endpoints + /api admin endpoints
│  ├─ src/db/           # SQLite access (policies / models / settings / seed)
│  └─ src/stats/        # logging + stats queries
├─ console/             # Visual console (Vite project)
│  ├─ src/components/   # Card / Button / Select / Tag / Toggle / StatCard
│  ├─ src/pages/        # Dashboard / Policies / Models / Logs / Debug / Settings
│  ├─ src/lib/          # chart theme tokens + theme switcher
│  └─ src/index.css     # OKLCH dual-theme tokens + mesh gradient + grain
└─ docs/                # Design docs
```

---

## 项目结构

```
ai-model-router/
├─ new-api-data/        # new-api 发行版与数据（不进 git）
├─ router/              # 调度层
│  ├─ src/core/         # classifier / rule-engine / judge / dispatcher / context / tiers / orchestrator
│  ├─ src/upstream/     # new-api 转发（含 SSE 透传）
│  ├─ src/routes/       # /v1 兼容端点 + /api 管理端点
│  ├─ src/db/           # SQLite 访问（policies / models / settings / seed）
│  └─ src/stats/        # 日志落库与统计查询
├─ console/             # 可视化控制台（Vite 工程）
│  ├─ src/components/   # Card / Button / Select / Tag / Toggle / StatCard
│  ├─ src/pages/        # Dashboard / Policies / Models / Logs / Debug / Settings
│  ├─ src/lib/          # 图表主题取色 + 主题切换
│  └─ src/index.css     # OKLCH 双主题 tokens + mesh 渐变 + grain 噪点
└─ docs/                # 设计文档
```

---

## Docs

| Doc | Content |
| :--- | :--- |
| [Context Control Design](docs/上下文控制设计.md) | Vendor mechanism research + Router three-layer context control design |

---

## 文档

| 文档 | 内容 |
| :--- | :--- |
| [上下文控制设计](docs/上下文控制设计.md) | 厂商机制研究结论 + Router 三层上下文控制方案 |

---

## License

MIT — see [LICENSE](LICENSE). Built by [@Ljh15224052032](https://github.com/Ljh15224052032).

---

## 协议

MIT —— 见 [LICENSE](LICENSE)。由 [@Ljh15224052032](https://github.com/Ljh15224052032) 构建。
