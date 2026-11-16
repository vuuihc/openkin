# 多设备会话架构（Hub + Node）

**Status:** 已实现并在真实环境运行（2026-10-23 更正——原写"设计待评审—尚未实现"，已过时）
**Date:** 2026-10-22
**Related:** [ADR 0022](../adr/0022-hub-node-multi-device-sessions.md) · [Local Agent Session Hub](./2026-09-17-local-agent-session-hub.md) · [ADR 0007](../adr/0007-pluggable-agent-runtime.md) · [ADR 0020](../adr/0020-user-owned-worker-leases.md) · [ADR 0014](../adr/0014-workspace-generations-and-lazy-promotion.md) · [REMOTE_ACCESS.md](../REMOTE_ACCESS.md)

> **2026-10-23 更正。** 本文写于设计阶段，正文若干处"现状"描述此后已被实现取代：
> Hub / Node 角色、设备配对、`updated_since` 游标同步、四种接入方式
> （loopback / LAN / Tailscale+Funnel / 自建 relay）均已落地（`internal/remote/`）；
> iOS 的 SwiftUI 客户端已被 `mobile/` 的 Capacitor 外壳取代（`b513573`，见 §10.3）。
> 正文保留为当时的设计记录，**不要据其"现状"段落判断今天的实现状态**。

---

## 0. 一页结论

### 要解决的问题

在同一个账号下，让多台设备共享同一批会话（session），服务端自托管；每台设备可以安装并配置不同的 agent；会话内可以通过 ACP 调用不同 agent。

### 核心判断

今天 Kin 的架构是 **一台机器一个全权威 daemon**。多设备是"客户端存 N 个 profile 来回切换"（iOS 已有 `DesktopSwitcherButton`），会话本身**不共享**——`SYSTEM_DESIGN.md` 与 iOS 计划都明确把这个当作非目标。

真正要做的不是"加一个同步协议"，而是把今天**耦合在同一个进程里的两件事拆开**：

> **会话的所有权**（谁保存 transcript、谁分配序号、谁裁决审批）
> 与 **agent 的执行**（谁的机器上有仓库、有 agent 二进制、有凭据）。

拆分之后：**Hub 拥有会话，Node 执行 turn。**

这不是新方向，而是把既有的 [M9 Local Agent Session Hub](./2026-09-17-local-agent-session-hub.md) 的意图 #3「keep one Kin conversation while switching the execution backend」从**一台机器**推广到**N 台机器**。

### 最小改动路径

| 判断 | 结论 |
|---|---|
| 要不要新增"会话"实体？ | **不要。** 沿用 M9 已确立的「Kin session = Task」。Task 已经是多轮会话（`FollowUpWith`），`events(task_id, seq)` 已经是干净的可合并日志。 |
| 为什么不能直接双向同步？ | `events.seq = MAX(seq)+1`（`internal/store/store.go:910`）且 `MaxOpenConns(1)`（`internal/store/store.go:36-42`）——**只支持单写者**。两个 daemon 同时写同一会话必然冲突。 |
| 解法 | **Hub 是唯一的 seq 分配者。** Node 不回写自己的库，只把 turn 事件上行给 Hub，由 Hub 追加。这条规则消除了整个冲突面。 |
| 本地单机体验会变吗？ | **不会。** standalone 模式下 Hub 与本地 Node 同进程，是同一套代码路径 + 进程内传输，无网络往返、无新配置。 |

### 四个诉求如何被满足

| 诉求 | 机制 |
|---|---|
| 同账号多设备会话保存 | Hub 权威存储 + 全局同步游标；客户端离线可读 |
| 服务端自托管 | `kin serve --role hub`；登录方式由**用户自选**（GitHub / 自建 OIDC / 邮箱密码）；OpenKin 不运营任何服务 |
| 每设备不同 agent | Node 本地持有 agent 配置与凭据；Hub 只存非敏感能力元数据 |
| 会话内通过 ACP 调用不同 agent | 新增 ACP adapter 家族；每个 turn 绑定 `(device, agent, model)`，可逐轮切换 |

### ACP 的定位：它是缺口，不是竞品

对照 ACP v1 官方规范核验后，得到一个比预期更强的结论——**ACP 在跨设备方向上的每一个缺口，恰好都是 Kin 已经拥有的能力**：

| ACP v1 官方承认的缺口 | Kin 已有的对应物 |
|---|---|
| 无多客户端 fan-out，官方称 "the single biggest architectural risk" | Kin 从不需要它：fan-out 发生在 Kin 的 `events` 上，ACP 连接永远只有一个 client |
| 权限是连接本地的阻塞请求，"no server-side approval queue, no delegation, no approve-from-another-device" | Kin 审批收件箱就是那个服务端队列 |
| "design your own transcript store above ACP" | Kin 的 `events` 就是它 |
| "Your supervisor must serialize per session itself" | Kin 的一会话一活跃 turn 写锁 |
| 无内建鉴权，"you own the entire authn/authz layer yourself" | Kin 的设备凭据 + 权限梯度 |

所以定位是：**ACP 是"IDE ↔ 本地 agent"的协议，Kin 是它上面缺的那一层。** 这也意味着差异化不能是"远程控制 agent"——生态里已有一批产品在做这件事（Reemoat、AgentDeck、Runmote 等）——也不能只是"自托管"（见 §7.7 的核验），而是会话/审批/审计/Artifacts 这条主线，加上**不绑定 ACP**（现有 5 个 adapter 继续工作）与**路径中无厂商**。

---

## 1. 现状：代码事实

这一节只列**会约束设计**的事实，均来自代码而非文档。

### 1.1 持久化与序号

| 事实 | 位置 |
|---|---|
| 全部结构化数据在一个 SQLite：`~/.kin/kin.db` | `internal/store/store.go:28-48` |
| `events` 主键 `(task_id, seq)`，`seq` 由 `MAX(seq)+1` 在事务内分配 | `internal/store/migrate.go:45-52`；`internal/store/store.go:910-920` |
| `MaxOpenConns(1)` + WAL，**单写者** | `internal/store/store.go:36-42` |
| `tasks.event_epoch` 是"整任务截断"开关（retry/replay 时 `DELETE FROM events WHERE seq >= ?` 并 `epoch+1`） | `internal/store/store.go:1084-1087` |
| 迁移是手写 `PRAGMA user_version` 链，当前 **v32** | `internal/store/migrate.go:8-9`、`:621-1822` |
| 空库直接跳到 head；`ensureDeviceSchema()` 是唯一的迁移后幂等钩子 | `internal/store/migrate.go:629-647`；`internal/store/device_schema.go:6-22` |

### 1.2 transcript 到底存在哪（三个store）

| 存储 | 覆盖范围 | 能否跨设备 |
|---|---|---|
| **`events` 表** | **所有** task 的 Kin 侧时间线，UI/iOS 渲染的就是它 | ✅ 可同步（自描述 JSON + `source`/`phase`/`visibility`） |
| `kin_messages` 表 | **仅** 内置 Kin agent 的多轮私有 transcript，键 `(task_id, idx)` | ✅ 可同步（小、整体替换） |
| **provider JSONL 磁盘文件** | Claude Code `~/.claude/projects`、Codex `~/.codex/sessions`、Droid `~/.factory/sessions` | ❌ **不可同步** |

第三行是关键：对 CLI agent，**完整 transcript 只存在于provider 自己的 JSONL 里，Kin 从设计上就不复制它**。

```go
// internal/sessioncatalog/file.go:1-2
// Package sessioncatalog reads provider-owned JSONL session stores without
// copying their transcript into Kin's database.
```

`agent_sessions.source_uri` 用 `json:"-"` 正是因为它是一条本机绝对路径（`internal/store/agent_sessions.go:42`）。

> **设计结论 D1：** Kin 自己的 `events` 必须成为**唯一权威 transcript**。provider JSONL 降级为"设备本地的可选取证来源"，不是会话保存的依赖。这是多设备能成立的前提。

### 1.3 没有任何数据面的设备/用户维度

`tasks`、`events`、`kin_messages`、`approvals`、`user_questions`、`agent_sessions`、`task_agent_sessions` **没有一列**是 device/user/owner/tenant。

设备身份只存在于**认证面**（`internal/remote/auth.go:22-31`）：

```go
type Principal struct {
    Kind     string // "master" | "device"
    DeviceID string
    Label    string
}
```

它只被用于 4 件事：认证、`masterOnly` 网关（54 条路由）、审计归属（`decided_via` = `"ios:"+DeviceID`）、WS 吊销轮询。

### 1.4 原生 agent 会话 id 是设备本地的

`tasks.session_ref` 是**单列全局**，但它的值是 Claude Code 的 `sessionId` / Codex 的 `session_id`——**只在生成它的那台机器上可 resume**。adapter 直接把它拼进 CLI 参数：`--resume <ref>`（`internal/adapter/claudecode/adapter.go:145-146`）、`codex exec resume <ref>`（`internal/adapter/codex/adapter.go:61-63`）。

M9 已经建了更正确的绑定层 `agent_sessions` + `task_agent_sessions`（v32），`UNIQUE(agent_id, external_ref)`，且明确"不复制 transcript"。

> **设计结论 D2：** `(device_id, agent_id, external_ref)` 才是原生会话的完整身份。D2 决定 resume 能否跨设备——答案是**不能**，跨设备必须走 handoff（重放 Kin transcript），而不是 resume。

### 1.5 `tasks` 里的绝对路径列

`cwd`、`workspace_source_root`、`workspace_root`、`execution_cwd`（`internal/store/migrate.go:20-31`），以及 `workspace_base_oid`、`task_checkpoints.head_oid|tree_oid`（指向只存在于产出机器的 git object store）。

> **设计结论 D3：** 会话必须携带一个**可跨设备解析的工作区锚点**，否则"换台设备继续"是悬空指针。

### 1.6 事件流没有全局游标

- WS `/api/ws` **无握手、无订阅、无重放、无客户端 offset**；客户端只能 ping（`internal/api/api.go:1691-1745`）。
- `Bus` 是**进程内** pub/sub，64 缓冲，慢订阅者被**关闭**（让空洞可观测），溢出计数在 `/api/health` 的 `bus_overflow`（`internal/task/bus.go:22-78`）。
- 唯一的持久游标是**每任务**的 `GET /api/tasks/{id}/events?since_seq=N`（`internal/api/api.go:690-714`）。
- iOS 的 `Reconciler` 用 `current.map(\.seq).max()` 增量拉取，并按 `"\(eventEpoch):\(seq)"` 去重（`ios/Kin/Networking/Reconciler.swift:75-78`、`:314-333`）。
- 计划里已把"WS 不是真相来源"写成锁定决策（`docs/plans/2026-09-05-ios-desktop-remote-control.md:76-87`）。

> **设计结论 D4：** 复用既有哲学——**HTTP 游标是真相，WS 只是加速**。需要补的是**跨任务的全局游标**（今天完全没有）。

### 1.7 能力是每台机器的事实

`agent.Status{Installed, Available, Binary}`（`internal/agent/types.go:54-59`）描述的是**本机** PATH 上有没有这个二进制。`/api/agents` 返回的是**本 daemon** 的 agent。

`agent.default` 是**daemon 全局**的 settings key，不是每设备（`ui/src/pages/AgentsPage.tsx:213` 通过 `PUT /api/settings` 写）。

### 1.8 已有的、应当复用的东西

| 能力 | 位置 | 复用方式 |
|---|---|---|
| 设备配对 + 可吊销设备凭据 | `internal/api/devices.go`、`internal/store/device_schema.go:14-22` | 直接作为 Node 传输凭据 |
| Worker 注册/心跳（device principal） | `internal/api/workers.go`、ADR 0020 | Node 注册的雏形；但**注册表是进程内的**，必须落库 |
| 出站中继（用户自己的 CF Worker） | `internal/remote/relay/relay.go` | Node↔Hub 的兜底传输 |
| turn 级 handoff（跨 agent 切换） | `internal/task/approvals.go:408-442` | **跨设备切换直接复用** |
| ACP 的结构模板：双向 JSON-RPC over stdio + 反向请求 | `internal/adapter/droid/` | ACP adapter 照着它写 |
| 每设备审计归属 | `clientTypeFromRequest` → `"ios:"+DeviceID` | 扩展到 turn 归属 |

---

## 2. 与既有决策的冲突：必须先显式修订

**这是本方案最重要的一节。** 用户诉求与仓库里**已经写死的非目标**直接冲突。如果不修订就实现，代码会与 PRINCIPLE、SYSTEM_DESIGN 和两份计划互相矛盾。

| 文档 | 原决策（原文） | 本次改动 | 处理 |
|---|---|---|---|
| `docs/plans/2026-09-05-ios-desktop-remote-control.md:39-50` | 锁定"一个权威 daemon"，非目标含 **"Peer-to-peer or multi-master database synchronization"**、"A Kin account" | 引入 Hub + N Node | **部分修订**：仍然**不是** multi-master——Hub 是唯一写者，Node 不持有可写副本。原决策保留，边界更清晰 |
| `SYSTEM_DESIGN.md:71` | "Explicitly later — or never: **Full sync product, multi-user**" | 多设备会话同步 | **修订**：见下方 §5.11 三问 |
| `PRINCIPLE.md` §5.11 | "Do not prepay distant architecture"；默认不做 "Multi-device orchestration as a product center"、"Full sync stacks before single-machine excellence" | 现在做 | **修订**，理由见下 |
| `docs/plans/2026-09-17-ios-console-parity.md:33-38` | 非目标："Official OpenKin account login"、"Cloud-hosted user data or identity" | 登录方式由用户自选（GitHub / 自建 OIDC / 邮箱密码） | **不冲突，但需澄清**：OpenKin 不运营账号服务、不托管数据，登录只发生在**你自己的 Hub** 上。见 §8 |
| `docs/OPEN_DEVELOPMENT.md:59,72` | 避免 "multi-device demos before single-machine excellence" | — | **保留**：本方案不改变单机默认体验（standalone），仍是同一条主路径 |
| `docs/adr/0003-artifacts-and-reader.md:46` | 否决 "Kin-hosted multi-device sync service" | — | **不冲突**：本方案是**用户自托管**，不是 Kin 托管 |

### 用 PRINCIPLE §5.11 的三问自检

| 问题 | 回答 |
|---|---|
| 1. 今天的主路径离开它还成立吗？ | **成立**。standalone 模式就是今天的行为，不配置 Hub 的用户完全无感。 |
| 2. 它解决反复出现的摩擦，还是预付未来？ | **解决真实摩擦**。用户已经在手工用 iOS 的 `DesktopSwitcherButton` 在多台 daemon 之间来回切；每切一次就丢失会话连续性，这是每天发生的。 |
| 3. 用户日常要学新概念吗？ | **不需要**。默认 standalone 下"设备"概念完全隐藏；只有当用户主动加第二台机器时才出现。 |

**结论：** 三条都通过。但 §5.11 的"少加实体"要求仍然生效——所以本方案**不新增会话实体**，并且把新概念压到最少（Hub / Node / Device，且前两个默认不可见）。

### 必须落一份 ADR

这些修订需要 ADR 0022 显式记录，否则未来读者会认为代码违反了 PRINCIPLE。ADR 内容见 [0022](../adr/0022-hub-node-multi-device-sessions.md)。

---

## 3. 设计原则

本方案自己的硬约束，后续实现不得违反：

1. **单写者（D5）** — Hub 是唯一分配 `events.seq` 的进程。Node 永不写自己的 `events` 表；它**上行**事件。
2. **执行跟随工作区（D6）** — turn 只在能解析工作区锚点**且**装了目标 agent 的 Node 上执行。两者缺一即**显式失败**，不静默换设备、不静默换 agent（对齐 Magpie 分析里"一个路由所有者"的结论）。
3. **秘密不出设备（D7）** — provider API key、agent OAuth、`~/.kin/secrets/` 永不上行。Hub 只存非敏感能力元数据。对齐 PRINCIPLE §9.5「设备级密钥默认不同步」。
4. **一条代码路径（D8）** — standalone = Hub + 本地 Node，走同一套调度与事件路径，只是传输换为进程内。**不允许**为单机写特例分支。
5. **HTTP 游标是真相（D9）** — 任何实时通道断了都不能丢数据；重连后靠游标补齐。
6. **不新增会话实体（D10）** — Task 就是 session（沿用 M9）。
7. **失败必须可解释（D11）** — 每个 turn 记录 `requested_device` / `executed_device` / `reason`；无法执行时给出确定原因，不降级。

---

## 4. 目标架构

```text
                         ┌──────────────────────────────────────────┐
                         │            Kin Hub (自托管)               │
                         │  · 账号 (users + user_identities, 见 §8.2)  │
                         │  · 会话 = tasks（权威）                   │
                         │  · events（唯一 seq 分配者）              │
                         │  · approvals / user_questions            │
                         │  · 设备注册表 + agent 能力目录            │
                         │  · 调度器（选 Node）                      │
                         └──────────────────────────────────────────┘
                            ▲                ▲                ▲
              出站 WS + 设备凭据│                │                │ HTTPS（浏览器/iOS）
                            │                │                │
              ┌─────────────┴────┐  ┌────────┴─────────┐  ┌───┴──────────────┐
              │ Node: MacBook    │  │ Node: Linux box  │  │ 客户端（瘦）      │
              │ agents:          │  │ agents:          │  │ · Web console    │
              │  claude-code     │  │  codex           │  │ · iOS            │
              │  acp(gemini)     │  │  acp(claude)     │  │ · Desktop shell  │
              │  kin             │  │                  │  │                  │
              │ workspaces: ~/w  │  │ workspaces: /srv │  │ 无本地权威副本     │
              │ secrets: 本地    │  │ secrets: 本地     │  │                  │
              └──────────────────┘  └──────────────────┘  └──────────────────┘
```

### 4.1 角色

| 角色 | 职责 | 启动方式 |
|---|---|---|
| **Hub** | 会话权威、seq 分配、审批裁决、设备注册表、调度 | `kin serve --role hub` |
| **Node** | 执行 turn：本地 agent 进程、工作区、凭据 | `kin serve --role node --hub <url>` |
| **Standalone** | Hub + 本地 Node 同进程（**默认，保持今天行为**） | `kin serve` |
| **Client** | 只读投影 + 控制（Web/iOS/Electron） | 浏览器 / app |

`--role` 默认 `standalone`。**升级后不配置任何东西，行为与今天完全一致。**

### 4.2 核心概念（沿用既有词汇，不造新词）

| 概念 | 含义 | 今天是否已存在 |
|---|---|---|
| **Session / Task** | 多轮会话线程，用户看到的"对话" | ✅ `tasks` |
| **Turn** | 一次用户输入 → 一次 agent 执行 | ✅ `FollowUpWith` 的语义，但未显式建模 |
| **Event** | 会话时间线的一条，`(task_id, seq)` | ✅ `events` |
| **Device** | 一台已配对的机器 = 一个 Node 的身份 | ⚠️ 仅认证面，需落库 |
| **Agent** | adapter 支持的执行器 | ✅ `internal/agent` |
| **Workspace anchor** | 可跨设备解析的工作区引用 | ❌ 需新增 |
| **Account** | Hub 上的用户身份（`users` + 多条 `user_identities`） | ❌ 需新增 |

---

## 5. 数据模型

迁移 **v33**（`internal/store/migrate.go`，沿用 `if v == 32 { ... }` 链式写法 + `ensureDeviceSchema()` 同款幂等钩子）。

### 5.1 新增表

```sql
-- 账号。standalone/local 模式下只有一个隐含的 local owner（无 identity 行）。
-- id 是唯一真正的键；email 只是属性，可改，账号不散。
CREATE TABLE IF NOT EXISTS users (
  id             TEXT PRIMARY KEY,         -- ULID
  email          TEXT,                     -- 属性，非键；用于展示与 password 登录名
  email_verified INTEGER NOT NULL DEFAULT 0,
  email_source   TEXT,                     -- 哪个凭据验证的：github | oidc | password
  display_name   TEXT,
  created_at     INTEGER NOT NULL,
  disabled_at    INTEGER
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_email
  ON users(email) WHERE email IS NOT NULL;

-- 登录凭据。一个账号可挂多条 → GitHub 与邮箱密码进同一个账号（§8.2）。
-- subject 必须取 provider 侧不可变 id：GitHub 用数值 id（不用 login）。
CREATE TABLE IF NOT EXISTS user_identities (
  id           TEXT PRIMARY KEY,           -- ULID
  user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider     TEXT NOT NULL,              -- github | oidc | password
  subject      TEXT NOT NULL,              -- GitHub 数值 id / OIDC sub / 规范化 email
  secret_hash  TEXT,                       -- 仅 provider='password'：argon2id
  created_at   INTEGER NOT NULL,
  last_used_at INTEGER
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_user_identities_key
  ON user_identities(provider, subject);

-- 设备 = 一个 Node 的身份。跨 Hub 重启持久。
CREATE TABLE IF NOT EXISTS devices (
  id             TEXT PRIMARY KEY,         -- 沿用现有 "ios-xxxx"/"desktop_xxxx" 形态
  owner_user_id  TEXT REFERENCES users(id) ON DELETE CASCADE,
  label          TEXT NOT NULL,
  platform       TEXT,                     -- darwin | linux | windows
  arch           TEXT,
  role           TEXT NOT NULL DEFAULT 'node' CHECK (role IN ('node','hub','client')),
  kin_version    TEXT,
  capabilities   TEXT NOT NULL DEFAULT '{}',  -- JSON：见 §5.2
  reachability   TEXT NOT NULL DEFAULT 'unknown', -- online | offline | unknown
  last_seen_at   INTEGER,
  created_at     INTEGER NOT NULL,
  revoked_at     INTEGER
);

-- 每设备 agent 目录（非敏感）。这是"每台设备配置不同 agent"的落点。
CREATE TABLE IF NOT EXISTS device_agents (
  device_id      TEXT NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  agent_id       TEXT NOT NULL,
  installed      INTEGER NOT NULL DEFAULT 0,
  available      INTEGER NOT NULL DEFAULT 0,
  version        TEXT,
  reason         TEXT,                     -- 不可用原因（原样透出给用户）
  default_model  TEXT,
  models         TEXT NOT NULL DEFAULT '[]', -- JSON ModelOption[]
  is_default     INTEGER NOT NULL DEFAULT 0, -- 该设备默认 agent
  updated_at     INTEGER NOT NULL,
  PRIMARY KEY (device_id, agent_id)
);

-- 工作区锚点：会话跨设备继续时的可解析引用。
CREATE TABLE IF NOT EXISTS workspace_anchors (
  id            TEXT PRIMARY KEY,          -- ULID
  project_id    TEXT REFERENCES projects(id) ON DELETE SET NULL,
  kind          TEXT NOT NULL CHECK (kind IN ('git_remote','device_path')),
  remote_url    TEXT,                      -- kind=git_remote
  relative_path TEXT,                      -- kind=git_remote：仓库内相对路径
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL
);

-- 锚点在每台设备上的实际路径。
CREATE TABLE IF NOT EXISTS workspace_anchor_roots (
  anchor_id   TEXT NOT NULL REFERENCES workspace_anchors(id) ON DELETE CASCADE,
  device_id   TEXT NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  abs_path    TEXT NOT NULL,
  verified_at INTEGER,
  PRIMARY KEY (anchor_id, device_id)
);
```

### 5.2 变更既有表（全部 nullable，向后兼容读）

```sql
-- 会话归属与执行归属
ALTER TABLE tasks ADD COLUMN owner_user_id     TEXT REFERENCES users(id);
ALTER TABLE tasks ADD COLUMN origin_device_id  TEXT REFERENCES devices(id);
ALTER TABLE tasks ADD COLUMN executing_device_id TEXT REFERENCES devices(id);
ALTER TABLE tasks ADD COLUMN workspace_anchor_id TEXT REFERENCES workspace_anchors(id);

-- 全局同步游标：单调、跨任务。由 Hub 单点分配。
ALTER TABLE tasks ADD COLUMN hub_seq INTEGER;   -- 该任务的元数据最后变更序号

-- 原生会话绑定设备化（D2）
ALTER TABLE agent_sessions     ADD COLUMN device_id TEXT REFERENCES devices(id);
ALTER TABLE task_agent_sessions ADD COLUMN device_id TEXT REFERENCES devices(id);

-- approvals / user_questions 增加结构化归属，替代今天的 "ios:<id>" 自由文本
ALTER TABLE approvals      ADD COLUMN device_id TEXT REFERENCES devices(id);
ALTER TABLE user_questions ADD COLUMN device_id TEXT REFERENCES devices(id);
```

**索引**（同步查询的关键路径）：

```sql
CREATE INDEX IF NOT EXISTS idx_tasks_hub_seq      ON tasks(hub_seq);
CREATE INDEX IF NOT EXISTS idx_tasks_owner_updated ON tasks(owner_user_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_devices_owner       ON devices(owner_user_id);
```

> **注意：** `agent_sessions` 的 `UNIQUE(agent_id, external_ref)` 需改为 `UNIQUE(device_id, agent_id, external_ref)`。SQLite 不能直接改约束，走既有的 `_new` + `RENAME` 重建模式（`internal/store/migrate.go:1557-1570` 有先例）。

### 5.3 一个**不做**的变更

`tasks.session_ref` **保留不动**。它继续作为"当前执行设备上的原生会话指针"的缓存投影，由绑定表派生。理由：它是 5 个 adapter 的 resume 入口，改动面远大于收益；只要保证**跨设备时清空**（已有 `ClearSessionRef` 机制，`internal/task/approvals.go:667`）即可。

---

## 6. 协议

### 6.1 Node ↔ Hub 控制通道

**方向：Node 主动出站连接 Hub**（Hub 从不反向拨号）。这样 Node 不需要公网入口、不需要端口映射、不需要 Tailscale——家庭/办公 NAT 后可直接工作。

复用既有的设备凭据（`device_credentials`）做认证。传输分层：

| 优先级 | 传输 | 说明 |
|---|---|---|
| 1 | 直连 HTTPS/WSS 到 Hub | 同 LAN 或 Hub 有公网入口 |
| 2 | 经用户自己的 CF Worker relay | 复用 `internal/remote/relay`，不新增基础设施 |
| 3 | 进程内（standalone） | 同一 interface，零网络 |

三条传输实现**同一个接口**，standalone 走第 3 条——这是 D8「一条代码路径」的落地方式。

```go
// internal/node/transport (概念示意，非最终签名)
type Transport interface {
    // Send 上行一帧（事件、心跳、turn 状态）
    Send(ctx context.Context, frame Frame) error
    // Recv 下行一帧（turn 派发、取消、审批裁决）
    Recv(ctx context.Context) (Frame, error)
}
```

帧类型（版本化，与 ADR 0020 的 worker 协议同族）：

| 帧 | 方向 | 载荷 |
|---|---|---|
| `hello` | Node→Hub | device_id, platform, arch, kin_version, agents[], workspace_roots[] |
| `hello_ack` | Hub→Node | 接受的协议版本, 心跳间隔 |
| `heartbeat` | Node→Hub | 负载、活跃 turn 数 |
| `turn.dispatch` | Hub→Node | task_id, turn_id, agent, model, prompt, workspace_anchor+path, permission_mode, provider_cfg |
| `turn.event` | Node→Hub | task_id, turn_id, 局部序号, type, payload |
| `turn.finish` | Node→Hub | turn_id, status, error, session_ref(设备本地) |
| `turn.cancel` | Hub→Node | turn_id |
| `approval.request` | Node→Hub | 由 ACP `session/request_permission` 或 CLI 审批桥触发 |
| `approval.decision` | Hub→Node | 裁决结果 |

### 6.2 Turn 生命周期

```text
        ┌─────────┐   POST /api/tasks/{id}/prompt {device_id?, agent?}
        │ Client  │──────────────────────────────────────────────┐
        └─────────┘                                              ▼
                                                    ┌───────────────────────┐
                                                    │ Hub                   │
                                                    │ 1. 校验会话写锁        │
                                                    │ 2. 解析 agent + device │
                                                    │ 3. 落 turn 行 (queued) │
                                                    │ 4. 写 user message 事件│
                                                    └───────────┬───────────┘
                                                                │ turn.dispatch
                                                                ▼
                                                    ┌───────────────────────┐
                                                    │ Node                  │
                                                    │ 5. 解析工作区锚点      │
                                                    │ 6. 启动 adapter        │
                                                    │ 7. 流式 turn.event     │
                                                    └───────────┬───────────┘
                                                                │ turn.event (流)
                                                    ┌───────────▼───────────┐
                                                    │ Hub                   │
                                                    │ 8. 追加 events(seq++)  │
                                                    │ 9. 广播 + 更新 hub_seq │
                                                    └───────────┬───────────┘
                                                                │ WS（加速，非真相）
                                                                ▼
                                                          所有在线客户端
```

**Hub 侧关键规则：**

- **一会话同时只有一个活跃 turn（写锁）。** 这是 `events.seq` 单写者之外的第二个不变量，也为产品提供了自然的"打断"语义——已有 `interruptAndFollowUp` 就是这个行为（`internal/task/approvals.go:444-453`）。
- **Hub 在追加事件时分配 `seq`**（沿用 `nextEventSeq`），并同事务更新 `tasks.hub_seq = nextGlobalHubSeq()`。
- **Node 的局部事件序号只用于 turn 内排序与去重**，不是权威序号。Hub 按 `(turn_id, local_seq)` 幂等去重，因此**重连重放是安全的**。
- **turn 终结必须落定。** Node 掉线 / Hub 重启 / 进程被杀，turn 都必须收敛到 `failed` 或 `canceled`，并保留已收到的部分 transcript。这是 ADR 0020 明确留下的缺口（"an in-flight remote assignment cannot be recovered from the lease registry alone"），本方案必须补上。

### 6.3 同步游标

补上今天完全缺失的**全局游标**（D4）。

```http
GET /api/sessions?updated_since=<hub_seq>&limit=200&owner=me
→ { "sessions": [ {id, title, status, agent, executing_device_id, hub_seq, updated_at, ...} ],
    "next_cursor": 12345,
    "has_more": false }
```

- `hub_seq` 单调、Hub 单点分配、跨任务全局有序。
- 客户端保存 `next_cursor`，重连后从该点续拉 → **离线期间的变化可补齐**。
- 单会话内继续用既有的 `GET /api/tasks/{id}/events?since_seq=N`（不改）。
- 破坏性变更（retry 截断）已由 `event_epoch` 表达，客户端丢弃低于新 epoch 的事件即可（iOS 已实现，`Reconciler.swift:315-336`）。

**这套设计保持了"HTTP 游标是真相、WS 只是加速"的既有哲学**，不需要把 WS 改造成可靠投递通道。

**`hub_seq` 的分配**（与既有 `nextEventSeq` 同风格，保持一处实现）：

```sql
-- 与 events 插入同一事务：
--   1. seq      = SELECT MAX(seq)     FROM events WHERE task_id = ?  + 1   （既有逻辑，不改）
--   2. hub_seq  = SELECT MAX(hub_seq) FROM tasks                     + 1   （新增，全局）
--   3. INSERT events(...); UPDATE tasks SET hub_seq = ? WHERE id = ?
```

因为 Hub 是唯一写者（`MaxOpenConns(1)` 已经保证），`MAX(hub_seq)+1` 天然单调无洞，不需要额外的序列表或锁。写入放大是每个事件多一次 `tasks` 行更新——在个人 agent 的事件速率下可接受，且可后续按 turn 批量提交优化。

**为什么不用墙钟时间做游标：** 多设备时钟必然漂移，`updated_at` 会漏事件或重复。单调整数游标没有这个问题，且与既有 `seq`/`event_epoch` 的语义一致。

### 6.4 幂等

- 客户端提交 turn 时携带 `turn_id`（UUIDv7，客户端生成）。Hub 以 `(task_id, turn_id)` 唯一约束去重。网络重试不会双跑。
- 已有先例可复用：`store.ReserveA2AIdempotency`（`internal/store/a2a.go`）。

---

## 7. ACP 集成

> 本节协议细节已于 2026-10-22 对照官方规范原文核验。来源：`agentclientprotocol.com/protocol/v1/*`、`schema/v1/schema.json`、`github.com/agentclientprotocol/agent-client-protocol`。

### 7.1 版本与范围

**目标版本是 ACP v1（stable）。** v2 于 2026-07-20 作为 **Draft** 发布，官方明确要求"gate v2 support behind explicit version negotiation and feature flags until it stabilizes"。

- v1 只有 **stdio 一种稳定传输**；Streamable HTTP / WebSocket 仍是 RFD 草案。
- v1 有 **25 个方法**（client→agent 12 请求 + 1 通知；agent→client 9 请求 + 2 通知；协议级 1）。
- **`session/set_model` 不存在**（v1、v2 都没有）。模型通过 `configOptions` 中 `category: "model"` 的选项表达，用 `session/set_config_option` 修改。
- `session/set_mode` 仍可用但**已标记废弃**，官方建议同时提供 config options 以兼容。
- 仓库已从 `zed-industries/*` 迁到 `agentclientprotocol/*`（是改名，不是弃坑）。

### 7.2 为什么 ACP 正好与本方案互补

官方文档把 ACP 定位为**本地 IDE 协议**，并明确列出了它在"跨设备监督"方向上的缺口。**这些缺口恰好就是 Kin 已经拥有的东西**：

| ACP v1 的缺口（官方原文结论） | Kin 的对应物 |
|---|---|
| 无多客户端 fan-out。规范对"两个 client 同时 `session/prompt`"完全沉默，官方称这是 "the single biggest architectural risk" | **Kin 从不需要 ACP 的 fan-out**：ACP 连接始终只有一个 client（Node），fan-out 发生在 Kin 的 `events` 上 |
| 权限是**连接本地的阻塞请求**："no server-side approval queue, no delegation, no 'approve from another device' primitive" | **Kin 审批收件箱就是那个服务端队列**，且天然支持跨设备裁决与审计 |
| 无持久化/重放保证："Assume a session is gone when the subprocess dies, and **design your own transcript store above ACP**" | **Kin 的 `events` 就是规范建议你自建的那个 transcript store** |
| 协议对并发 prompt 沉默："Your supervisor **must serialize per session itself**" | Kin 的「一会话一个活跃 turn」写锁（§3 D3） |
| 无内建鉴权授权："If you expose agents over a network **you own the entire authn/authz layer yourself**" | Kin 的设备凭据 + 权限梯度（§8.4） |
| `session/update` **无背压、无顺序保证、无投递 ack**，慢消费者静默丢更新 | Node 本地序号 + Hub 权威 `seq` + 游标重放（§6.2/6.3） |
| `session/list` 可选且**无 running 状态**，无归属过滤 | Kin 的 task 状态机与设备归属 |

> **这就是本方案的定位论证：** ACP 是"IDE ↔ 本地 agent"的协议；Kin 是它上面缺的那一层。生态里已经有一批产品走同一条路（Reemoat、AgentDeck 的 `agentdeckd`、Runmote、`acp_rpc_bridge` 等，见 §7.7），官方也把"自建 sidecar 持有 stdio 子进程、再用自己的网络协议重新暴露"列为跨设备监督的正规做法之一——**Kin 的 Node 角色正是这个 sidecar**，只是它同时还是会话权威与审批中心。

### 7.3 落点与 SDK 决策

`internal/adapter/droid/` 已经是"双向 JSON-RPC over stdio + 反向请求"的完整实现：`protocol.go` 声明版本与方法集，`handleServerRequest`（`internal/adapter/droid/adapter.go:348`）处理反向的 `request_permission`/`ask_user`，`bridge.go` 转发进 Kin 审批 API。

> **ACP adapter 照 droid 的结构写**，并把其中的"双向 JSON-RPC 客户端"抽成可复用的小包（droid 目前是包内私有）。

**SDK 决策：手写，不引第三方。** ACP 官方**没有 Go SDK**（官方只有 Kotlin/Java/Python/Rust/TypeScript），社区有若干 Go 实现但成熟度不一。仓库既有做法就是手写协议（`internal/mcp/server.go:1-6` 明确写 "No MCP SDK: JSON-RPC 2.0 over newline-delimited JSON on stdin/stdout"），**ACP 沿用同一做法**，与 ADR 0007「编译期注册的 builtin plugin」一致。

### 7.4 事件映射

`session/update` 有**恰好 14 个** `sessionUpdate` 取值，全部需要处理（未列出的取值必须安全忽略，不能崩）：

| ACP `sessionUpdate` | Kin `adapter.Event.Type` | 备注 |
|---|---|---|
| `user_message_chunk` | `message`（role=user） | |
| `agent_message_chunk` | `message`（role=assistant, `Partial: true`） | 主要流式路径 |
| `agent_thought_chunk` | `message`（`role=reasoning`, `phase=progress`） | **落地时改了映射**：早先发的是 `phase=thought`——那是控制台**没听说过**的 phase，于是 agent 的私有推理被当成它的回答画出来（一轮最后一段思维链就是"答案"）。改成全仓统一的推理形状（`role=reasoning` + `phase=progress`，kinagent/codex 都这样） |
| `tool_call` | `tool_use`（+ 输出已在同一条里时补 `tool_result`） | 新建 |
| `tool_call_update` | 终态 → `tool_result`，其余 → `tool_use` | 补丁语义：除 `toolCallId` 外全部可选。**落地时改了映射**：控制台按 `tool_use`/`tool_result` 配对合并步骤，一条永不闭合的步骤看起来像卡住的 turn（见 `update.go` 的 `toolCallUpdateEvents`） |
| `plan` | `plan` → 控制台里是流程框里的一行 | 每次都是**完整替换**（schema 里这个 update 就是 `$ref` 到 `Plan`）。控制台没有独立的计划面板：投影**持有那条 note 本身**（按 speaker 一行、每轮重置）就地改写，不管它落在哪个流程框里——按前缀在"当前框"里找是不够的：一条回答会把框关掉，下一版计划就会另起一行。写之前先 `flushStream()`（和其它产步事件一致），否则 plan 会和流式的 prompt 回显互相吞掉（一边被改成半句话、key 被抢走，计划从屏幕上消失）。`entries` 为空表示 agent 撤回计划，那一行改写为「计划已被 agent 撤回」。（ADR 0018 讲的是持久化的 worker steps，不是这个事件类型；早先版本把它写成"对齐 ADR 0018"是错的） |
| `usage_update` | `notice`（状态行） | **不记账**。schema 里 `cost.amount` 是"整个会话的累计成本"、`used/size` 是上下文占用，都不是一轮的增量；而 Kin 的 `usage` 事件是增量账目，且是 critical 事件（不可记账即整轮失败）。更何况引擎只在**本轮没有 `usage` 事件**时才把 `session/prompt` 返回里带的 token 记上——在这里记一笔等于让这一轮丢掉自己那份数字。`session/prompt` 返回里的 `usage` 同样**只显示不记账**：那是 UNSTABLE 字段，schema 自己就自相矛盾（字段说 "for this turn"，里面的 `inputTokens` 说 "across all turns"、`totalTokens` 说 "across session"），上游还有一个未决的 RFD。Kin 的账是增量账，口径没定的数字不进账（见「M2.6 第三轮复审」） |
| `available_commands_update` | `notice` | 完整替换列表 |
| `current_mode_update` | `notice` | |
| `config_option_update` | `notice` | 完整 config 状态，含模型变化 |
| `session_info_update` | `notice` | `{title?, updatedAt?}`。**落地时改了映射**：`tasks.title` 由 prompt（或 summarizer）写，事件流里没有第二条改名路径，在适配器里现造一条就是给同一个字段加第二个写者 |
| `notice` | `notice` | `{severity, title, description}`，需 client 能力 |
| `compaction_update` | `notice` | 需 client 能力 |
| `compaction_summary_chunk` | `message`（`phase=compaction`） | 需 client 能力 |
| （`session/prompt` 的返回） | `result` | 含 `stopReason` |
| （`session/request_permission`） | 进了收件箱 → 由持有该行的引擎/Hub 写 `approval_requested`；没进 → `notice` | 见 §7.5 |

#### ⚠️ 一个必须避开的陷阱：`session/load` 的重放

规范原文：`session/load` 时 "The Agent **MUST** replay the entire conversation to the Client in the form of `session/update` notifications"。

**如果朴素地把 `session/update` 全部映射成 Kin 事件，一次 `session/load` 就会把整段历史重复写进 `events`。** 必须显式区分"重放"与"实时"：

- `session/load` 期间收到的 `session/update` 只用于**校验**（与 Kin 已有的 transcript 比对），**不追加**到 `events`；
- 实现上用一个 `replaying` 标志位包住 `session/load` 的整个请求周期（它在重放完成前不返回）。

### 7.5 审批桥（本方案最有价值的一处统一）

ACP 的权限请求是 agent→client 的**请求**（要回响应），参数 `{sessionId, toolCall, options}`，其中 `PermissionOption{optionId, name, kind}`，`kind ∈ allow_once | allow_always | reject_once | reject_always`。

响应有**双层嵌套**（实现时容易写错）：

```json
{ "result": { "outcome": { "outcome": "selected", "optionId": "allow-once" } } }
{ "result": { "outcome": { "outcome": "cancelled" } } }
```

```text
agent  ──session/request_permission──▶  Kin ACP adapter (Node)
                                              │  有收件箱：建行，事件由持行者写
                                              │  （engine 本地 / Hub 派发）
                                              │  没收件箱：写一条 notice
                                              ▼
                                    Hub 审批引擎（既有）
                                              │
                              ┌───────────────┴───────────────┐
                              ▼                               ▼
                     桌面/iOS 审批收件箱                  MCP 桥（既有）
                              │
                              ▼ approval.decision（经 §6.1 回到 Node）
                     adapter ──▶ outcome: selected | cancelled
```

**记录这件事只有一个写者。** 建了行就有卡片：事件由持有该行的引擎（本地轮）或 Hub（派发轮）写，带 `approval_id`。适配器再写一条就是同一个问题进两次转写——而且后到的那条会落在人已经回答之后。所以适配器只在**没建行**时留痕，并且留的是 `notice` 而不是 `approval_requested`：那条路径恰恰是"没有任何东西可批准"（agent 只给了拒绝选项、一个选项都没给、没有 Kin 可问、建行失败），而控制台把 `approval_requested` 画成「needs your approval ↓」——指着一张永远不会出现的卡片。

`approval_requested` 是 critical 事件（丢了这一轮就得算失败），`notice` 不是；把"没人被问过"记成前者，等于给一个没有裁决者的问题套上裁决语义。

**三条必须遵守的规范约束：**

1. **取消是耦合的。** 规范要求：client 一旦发出 `session/cancel`，**MUST** 立即对所有待决的 `session/request_permission` 回 `outcome: "cancelled"`。所以 Kin 取消 turn 时必须级联取消所有待决审批——**不能留悬挂的反向请求**，否则 agent 侧永久阻塞。
2. **绝不自动批准。** 规范允许 client "MAY auto-allow or auto-reject"，并指出"supervisor 必须决定谁的自动批准策略说了算"。**Kin 是唯一的所有者**：Node 掉线 / 审批超时 / 任何不确定状态一律收敛为 `cancelled`，**永不 `allow`**。
3. **agent 可能不理会取消。** 规范承认"an agent that ignores `session/cancel` leaves `session/prompt` pending forever"，且取消无超时语义。因此 Kin 侧必须有**自己的超时与终态收敛**，不能依赖 agent 配合。
4. **权限模式不由 Kin 执行，也不能假装它被执行。** 协议里没有"权限模式"这个东西：Kin 没有开关可以拨，而"要不要问"是 agent 自己的选择（§7.4 的映射表里没有一项能改变这一点）。所以一个 `yolo` / `accept_edits` 的 ACP turn，既不是"Kin 会让它无人值守地跑"，也不是"Kin 保证它每一步都问人"——**Kin 保证不了**。Node 的权限天花板因此必须把这两种模式当成"审批被绕过"（`AutoApprovesAll` 返回 true），只有操作者用 `--allow-yolo` 明确同意才放行；`default` 不受影响（agent 问，人就答）。这正是天花板要问适配器而不是问模式名的原因。

### 7.6 会话切换与 handoff

"会话里通过 ACP 调用不同 agent"有两条路径，**都复用既有 `FollowUpWith` 的语义**（`internal/task/approvals.go:408-442`）：

| 场景 | 机制 |
|---|---|
| 同一设备换 agent | 已有：清 `session_ref` → 换 `task.agent` → 注入 handoff context |
| **换设备**（新增） | 清 `session_ref` → 换 `executing_device_id` → 从 Kin `events` 重建 handoff context |

规范进一步支持"跨设备不做原生 resume"这个判断：

- `sessionId` 是**不透明 `string`，无格式约束**，且规范未保证跨 agent 二进制全局唯一 → 必须当作 blob 存，键为 `(device_id, agent_id, external_ref)`（对应 D2）；
- `session/load` **要求重新提供 `cwd` 且必须与 session 的 `cwd` 一致** → 同一 agent 在另一台设备上路径不同即无法 load；
- 规范对"一个 agent 进程能否服务另一个进程创建的 session""session 能否跨 agent 重启存活"**完全沉默**；
- `session/load` 需要 agent 声明 `loadSession` 能力，且规范**从未要求 agent 持久化 session**。

**结论：跨设备一律走 handoff（从 Kin `events` 重建），不依赖 ACP 的 load/resume。** 这也再次说明为什么 D1（Kin 自己的 transcript 权威）是必需的。

### 7.7 边界、风险与竞争现实

**实现边界：**

- ACP v1 **stdio-only** → agent 必须与 Node 同机。这与 D6「执行跟随工作区」一致，不冲突，也正是官方认可的做法。
- **必须写 baseline-only 回退路径。** 只实现基线（`session/new`、`session/prompt`、`session/cancel`、`session/update`）的 agent 不会有 list / resume / history replay。能力探测矩阵很大：`loadSession`、`sessionCapabilities.{list,delete,resume,close}`、`auth.logout`、`promptCapabilities.*`、`mcpCapabilities.*`，以及 client 侧 `session.{compaction,notices,configOptions}`、`elicitation.{form,url}`。
- `_meta` **不是**结构扩展点：规范禁止在规范类型的根部添加自定义字段，自定义结构只能放进 `_meta` 或 `_` 前缀方法。`Error` 对象甚至没有 `_meta`，**无法在错误响应上挂 correlation id**——需要的话得走带内约定。
- **v1→v2 的漂移是真实且快速的**：`session/load`、`session/set_mode`、`fs/*`、`terminal/*` 在 v2 中已被移除或替换。**因此 v1↔v2 的方法映射要做成可替换的映射表，不能烤进领域模型**——这是对 ADR 0007「adapter 只做归一化」的一次具体检验。

**战略现实（2026-10-22 逐家核验一手来源）：** ACP 生态里已有一批**直接竞品**在做"跨设备监督 agent"（客户端列表约 80 项）。但核验后得到的结论比预期更尖锐——

**"自部署"本身不是差异化。** 这个生态里一半项目之所以"自部署"，是因为中继就是本机的一个进程，隐私问题被平凡地消解（operator 就是你自己）：tlbx、Remote Agent Server、Agmente、`acp_rpc_bridge` 都属此类。真正稀缺的轴是**"中继可以是你不信任的那台机器"**，即对中继 E2EE。有源码或测试向量佐证的只有五家：

| 项目 | 对中继 E2EE | 证据强度 | 采用度 |
|---|---|---|---|
| **Happy** | ✅ libsodium `crypto_box_easy` / `crypto_secretbox_easy` | 出货源码；但**默认走厂商服务器** `api.cluster-fluster.com` | **24.3k★**，生态里唯一有真实采用 |
| **Reemoat** | ✅ `Noise_IK_25519_ChaChaPoly_BLAKE2s` | 有向量测试，且主动写出残余信任边界 | 25★ |
| **Mobvibe** | ✅ libsodium 兼容 KDF + `crypto_box_seal` | 源码 | 145★，停更约 3 个月 |
| **AgentDeck** | ⚠️ 仅 `adk1_` 配对 ID；**旧 UUID 配对是明文** | 源码 + 隐私政策自陈；中继仓库无 LICENSE | 5★ |
| **Superlite** | ✅ 内容走 WebRTC P2P | 源码；但信令走**共享 Firebase 项目（硬编码凭据）**，且强制 Google 登录 | 活跃 |

其余多数连 E2EE 都不宣称，只有 TLS / 隧道 / VPN overlay——对"你已经信任的中继"够用，对"你租来的中继"等于没有（Runmote、VibeAround、Aptove Bridge、ACP Remote）。**Bellows** 声音最大（"sealed end to end… it never sees the conversation"）但闭源、无架构文档，"sealed" 在所有公开材料里没有定义——**只能算宣称，不能算实现**。

**Lody 的情况（与原始观察一致）：** 仓库里确有 `packages/e2ee-core`，但其 README 自陈 **"Production E2EE composition is not enabled"**（该包仍是 `private: true`、版本 `0.0.0`）；隐私政策明列收集 "Conversation content and related workflow context"，后端为 Cloudflare + Convex，且必须 GitHub OAuth 登录。**即：E2EE 代码存在，但在生产里是关掉的。**

**大厂一律不是自部署：** Anthropic 文档直说 "While Remote Control is connected, the session transcript … is stored on Anthropic servers"，且 Pro/Max/Team/Enterprise 账号必需（API key 不可用）；即便走 self-hosted environments 仍是 "Session content still goes to `api.anthropic.com`"。Cursor 的 self-hosted worker 文档同样直白："Cursor runs the agent loop, inference, and planning. Your worker performs file edits and terminal commands."，并列出 "file contents, terminal output, diffs, screenshots, local MCP results" 都会离开你的网络。OpenAI Codex 远程连接过厂商 relay + ChatGPT 账号；GitHub Copilot 远程控制需企业策略 "Store local sessions in the Cloud"。**四家模式一致：自部署（若有）搬走的是*执行*，*编排与会话内容*留在厂商侧。**

**由此修正本方案的定位论证（原先那句"用户自托管 + 模型中立"说得太顺）：**

Kin 的 Hub **不是中继，是权威**——它必须持有明文才能分配 `seq`、做审批、跑调度。所以 Kin **在结构上不可能**提供 Reemoat/Happy 式的"运营商看不见"，也不该假装能。诚实的说法只有两条：

1. **路径中没有厂商。** 这是 Kin 真正占得住的位置，且市场上只有 tlbx / Remote Agent Server / Agmente 默认如此（Happy 默认厂商服务器，AgentDeck 默认 `agentdeck.xianqiao.wang`）。Kin 的 standalone 更彻底：**连 Hub 都可以不存在**。
2. **信任边界写在明处。** 核验结论是"没人把这条做全"，Reemoat 最接近（它在 `DECISIONS.md` 里主动写出 E2EE 挡不住 Authority、也挡不住官方客户端）。Kin 应当照做：Hub 看得到全部会话内容（它是权威），**但看不到 provider API key、agent 凭据、`~/.kin/secrets/`（D7）**，也不需要工作区文件的本地路径。

**同时必须说清代价：Hub 要部署在你信任的机器上。** 把 Hub 放在一台你不信任的 VPS 上、再指望 Kin 保护你——本方案不提供这个保证，也不打算用 E2EE 去绕，那与"Hub 是会话权威"直接矛盾。这条要落进文档与 ADR，避免日后被读成"自部署 = 隐私"。

**结论：差异化既不能是"远程控制 agent"，也不能只是"自托管"。** 是：① 会话/审批/审计/Artifacts 是产品主线而非附属；② **不绑定 ACP**——现有 5 个 adapter + Tier-2 泛型继续工作，ACP 只是新增一族；③ **路径中无厂商**（连 Hub 都可选），且明确声明信任边界。

**明确不做：** 不用 ACP 替换现有 adapter；不支持 v2（等它稳定）；不实现自定义 ACP 传输（Node 通道是 Kin 自己的协议，不是 ACP 传输的替代品）。

---

## 8. 身份、账号与自托管

### 8.1 部署模式

| 模式 | 命令 | 账号 | 适用 |
|---|---|---|---|
| **Standalone（默认）** | `kin serve` | 隐含 local owner，**无需登录** | 今天的单机用户，行为不变 |
| **Hub** | `kin serve --role hub`（首次启动打印配对码；登录方式按需配 GitHub / OIDC / 密码） | 用户自选 | 多设备中心 |
| **Node** | `kin serve --role node --hub https://...` | 设备凭据 | 执行节点 |

### 8.2 身份模型（2026-10-22 修订）

诉求是"**GitHub 登录 + 邮箱密码登录，进同一个账号**"。原先写的"一个 Hub 只接受一个 issuer、识别键 `(issuer, subject)`、不按 email 合并"要改——但改法不是放宽，而是**把"账号"和"凭据"分成两层**：

```
users            -- 账号。id 是 ULID，永不改变；它才是真正的键
  id, email, email_verified, email_source, display_name, created_at, disabled_at

user_identities  -- 登录凭据。一个账号可挂多条 → 多条登录路径
  id, user_id, provider, subject, secret_hash, created_at, last_used_at
  UNIQUE(provider, subject)
```

| provider | subject 用什么 | 协议 |
|---|---|---|
| `github` | GitHub 的**数值 `id`**（不用 `login`——login 可改） | OAuth 2.0（**不是 OIDC**，见下） |
| `oidc` | IdP 的 `sub` | OpenID Connect |
| `password` | email 的小写规范化形式 | `secret_hash` = argon2id |

**关于 GitHub 的协议（2026-10-22 核实）：** GitHub 官方文档明说：

> GitHub does not currently implement OpenID Connect in its OAuth flows and does not issue ID tokens for users or apps.
> — <https://docs.github.com/en/apps/github-authentication-discovery-endpoints>

细节要说准，否则会写错方向：GitHub **确实**在 `https://github.com/login/oauth/.well-known/openid-configuration` 发布了一份 discovery 文档（HTTP 200），但它是给 MCP 客户端做端点发现用的——其 `claims_supported` 只有 `sub/aud/exp/nbf/iat/iss/act`，**既没有 `email` 也没有 `email_verified`**，而且 GitHub 不签发 ID token。所以拿一个通用 OIDC 客户端去接 GitHub，会在"验签 ID token"那一步断掉。

结论：**"接外部 OIDC"和"用 GitHub 登录"在实现上是两个 adapter，不是一个。** 这不是设计选择，是 GitHub 的事实。（顺带排除一个常见误解：`token.actions.githubusercontent.com` 上那份 OIDC 文档是给 **Actions workflow 换云厂商凭据**用的，它连 `authorization_endpoint` 和 `token_endpoint` 都没有，跟"用户登录"无关。）

**并且不要反过来把登录流程建在那份 discovery 文档上**：它是 2026 年才出现的（文档页首次归档约 2026-05），GitHub 自己标注为 public preview，并明说在某些部署上"**contain incorrect information**"，而且**没有对应的 changelog 公告**。这些文档的用途是让 MCP 客户端发现端点，不是承诺一个稳定的登录 IdP 接口。GitHub 登录走**手写 OAuth 2.0 授权码流程**，不依赖 discovery 驱动。

#### 为什么不让 email 当唯一 id

这不是风格偏好，是**规范明令禁止**。OpenID Connect Core §5.7 原文：

> other Claims such as `email`, `phone_number`, `preferred_username`, and `name` **MUST NOT be used as unique identifiers for the End-User**, whether obtained from the ID Token or the UserInfo Endpoint.
> — <https://openid.net/specs/openid-connect-core-1_0.html#ClaimStability>

§5.1 对 `email` 的措辞同样是 "The RP **MUST NOT** rely upon this value being unique"。**这条约束把完全合规的 OIDC provider 也一起管住了**——它不是说某家实现不好，而是说这个声明本身就不承担唯一性。

> ⚠️ **不要把 §5.7 读过头。** 它说的是 email **不唯一、不稳定**，**没有**说 `email_verified` 不可信——规范在这里是刻意留白的，`email_verified` 只断言"OP 在验证当时采取了积极步骤确认该地址受最终用户控制"，强度交给"信任框架或合同约定"决定。所以正确的推论是"**email 不能当键**"，而不是"OIDC 给的 email 不可信"。GitHub 的特殊问题另有其因（不签发 ID token、不发 `email` 声明、允许未验证 primary、还会伪造占位地址），与 §5.7 是两件事。

落到 GitHub 上，风险是具体的、可利用的：

1. **账号会丢**：用户在 GitHub 改了邮箱，就找不回自己的 session 池了。
2. **会被冒名（要害）**：GitHub 允许账号挂着**未验证**的邮箱——`POST /user/emails` 的官方响应示例里，新加的三个地址 `verified` 全是 `false`。唯一的护栏是"一个邮箱只能属于一个 GitHub 账号"，**不是"你得证明你能收信"**。所以只要逻辑是"email 相同即同一个人"，攻击者把自己账号的邮箱填成你的，登录即拿到你的全部会话。GitHub 的最佳实践文档正是为此而写：

   > **_Never_** use identifiers that can change over time, including user handles, organization slugs, or email addresses.
   > — <https://docs.github.com/en/apps/creating-github-apps/about-creating-github-apps/best-practices-for-creating-a-github-app#use-the-durable-unique-id-to-store-the-user>

   同一页给出了唯一稳定的键，措辞是保证级的："This value **will never change for the user or be used to point to a different user**"——指的就是 `GET /user` 的数值 `id`。

   还有两个坑必须处理：GitHub 对未验证的 Enterprise Managed User 会返回**伪造的占位邮箱**（形如 `email+shortcode@domain.com`）；用户的 primary email 未验证时，token 交换会直接以 `unverified_user_email` 失败——这要当**一等错误**处理（提示"请先在 GitHub 验证邮箱"），不能混进"登录失败"一笔带过。

3. **即使 provider 给了 `email_verified` 也不能当键。** 而且**连"给了"这件事都不能假设**——实测各家并不一致：

   | Provider | `email_verified` | 证据强度 |
   |---|---|---|
   | Google | ✅ | 高（claim 定义 + scope 映射 + 实测 discovery 文档） |
   | Okta | ✅ | 高（表格行显式标注 boolean） |
   | Microsoft Entra ID（workforce 租户） | ❌ | 高（ID token claims 参考里没有；替代物是可选 `xms_edov`，而那是"**域名归属**已验证"，不是"这个地址归此人所有"） |
   | Microsoft Entra External ID | ⚠️ 仅作**入站** claim：联邦到外部 IdP（Google/Apple/Facebook）注册时接收，不为自己的原生账号签发 | 高 |
   | GitHub | ❌ | 高（`claims_supported` 里连 `email` 都没有） |

   也就是说"用 email 当键"的方案换一家 IdP 就会**静默出错**（登录成功但认错人），而下面的设计对这个差异完全免疫。

   **还有一个真实实现陷阱：同一个 `email_verified`，各家的 JSON 类型不一样。** Google 的 ID token 示例写的是字符串 `"email_verified": "true"`，Okta 的示例写的是布尔 `true`。所以**不要写 `value === true` 这种严格比较**，要按 provider 各自归一化。（Google 实际签发的类型尚未实测，列为待验证项。）

   Google 自己给的警告是所有 provider 里最重的，值得原文记下：

   > **Warning:** Don't use the `email` field as a unique identifier for a user. Always use the `sub` field.
   > — <https://developers.google.com/identity/openid-connect/openid-connect>

   加上 Okta 的 "The resource provider must not rely on this value being unique."、Microsoft 的 "Never use it for authorization or to save data for a user." —— 到这里是**四份互相独立的一手来源**（OIDC Core §5.7、GitHub 最佳实践、Google、Okta）在说同一件事：email 不是身份键。

所以要的是这三条，而不是 email 当键：

- **`users.id`（ULID）是账号键**；`email` 只是属性，额外带 `email_verified` 与 `email_source`（哪个凭据验证的）。属性可改，账号不散。
- **凭据键是 `(provider, subject)`**，且 `subject` 必须取 provider 侧**不可变**的 id——GitHub 用数值 `id`，不用 `login`。用 login 当 subject 会在用户改名后变成一个新账号。
- **关联第二条登录方式必须是"已认证动作"**：先登录着，再在设置里"添加密码"/"绑定 GitHub"。**永不按 email 自动合并。** 这是硬约束，不是偏好。

这样你要的体验完全成立——GitHub 和邮箱密码进同一个账号、同一个 session 池——而且**不依赖 email 可信**。原来"一个 Hub 只接受一个 issuer"的约束也随之取消：多 provider 现在是安全的，因为每条凭据单独一行，关联只能靠认证动作。

#### GitHub 侧的落地细节

- **用 GitHub App，不用 OAuth App。** GitHub 官方对 OAuth App 的文档里直接写着 "If possible, consider using a GitHub App instead of an OAuth app"——GitHub App 权限更细、token 更短命。两者都是 OAuth 2.0，代码路径一样。
- **注意作用域模型不同**：GitHub App **不用 scope**，改用注册时配置的细粒度权限。要读邮箱得申请 **`email_addresses`（read）** 用户权限；OAuth App 的对应物才是 `user:email` scope。照 OAuth App 的写法去配 GitHub App 会拿不到邮箱。
- **PKCE 用 S256**（GitHub 的元数据里 `code_challenge_methods_supported` 只有 `["S256"]`，**没有 `plain`**）；但**不要**去验签 ID token——GitHub 不签发。身份靠"拿 access token 调 `GET /user`"确认。GitHub 同时声明 `authorization_response_iss_parameter_supported: true`，可以按 RFC 9207 校验 `iss`。
- 若要展示邮箱，调 `GET /user/emails` 并**只接受 `verified === true`** 的条目，同时挡掉 `email+shortcode@domain.com` 形态的占位串。**比较前先归一化类型**（见上文 `email_verified` 的字符串/布尔陷阱）。拿不到已验证邮箱不是错误——**本设计里 email 不是键，缺它不影响登录**。
- ⚠️ 一个待验证项：GitHub OpenAPI 给 `GET /user`、`GET /user/emails` 标了 `x-github.enabledForGitHubApps: false`，但渲染出的 REST 文档又明确把 "GitHub App user access tokens" 列为支持。该标记管的是 *installation* token 而非 *user* token，判断是文档不一致而非真限制——**但实现时必须实测一次**，别照推断写。

### 8.3 首次接入与后续接入

#### 首次启动：终端配对码，不是"先到先得"

`kin serve --role hub` 首次启动时在**终端打印一次性配对码**，必须凭该码才能完成 owner 认领。

原设计是"首个登录者成为 owner"。这有一个真实的抢注窗口：**Hub 一旦暴露到公网，任何先到的人都能成为 owner**，而你还没来得及登录。终端码只有能物理/SSH 接触到 Hub 机器的人看得到，直接把这个窗口消掉。这是自托管软件的通行做法（Jellyfin / Grafana 等）。

认领完成后**注册即关闭**：`users` 表非空时不再接受新账号。新增登录方式只能由 owner 在已认证状态下添加（§8.2 的硬约束）。

#### 后续接入有两条路径

诉求原话是"私有化部署后，新设备配置认证下就能同步全部设备上面的 session"：

| 路径 | 怎么用 | 限制 |
|---|---|---|
| **A. 配对**（已有机制） | 新设备扫码 → 拿设备凭据 → 立刻看到全部 session | **手上必须有一台已授权设备**。手机丢了、电脑不在身边就不行 |
| **B. 登录**（新增） | 打开 Hub 地址 → GitHub / OIDC / 邮箱密码登录 → Hub 认出是你 → 发设备凭据 → 看到全部 session | 需要 Hub 能访问 IdP（**仅 GitHub/OIDC 登录时**；密码登录不需要） |

**登录相对配对的增量就是这一格：没有任何一台已授权设备在手时，仍能把新设备接进来。** 对个人使用就是"换台电脑、登录一下，全部会话都在"。

#### 三层安全细节（都必须定死）

1. **登录只用于换凭据，不参与日常请求。** 登录成功即签发设备凭据（复用 `device_credentials`），之后所有流量用设备凭据：IdP 挂了不影响已登录设备；复用既有吊销机制（`revoked_at` 一置，WS 也会被踢）；Node 的长期连接不需要刷新 token。
2. **ID 是自建 provider，要按 ID 做对待。** 密码用 argon2id；登录端点必须有**每 IP + 每账号的失败限速与锁定**（否则暴露到公网的 Hub 就是一个可离线爆破的密码库）；密码比对走常数时间。这三点是密码登录的入场费，不做就别开这个 provider。
3. **密码重置不做自助，走 Hub 本机 CLI**：

   ```bash
   kin hub reset-password --email <email>
   ```

   这样**不需要 SMTP、不需要发信通道、不引入任何厂商**——与 §7.7 的"路径中无厂商"一致。代价是忘了密码又 SSH 不上机器时麻烦；但对自托管单用户产品，这比为了重置密码去维护一条邮件发送链路 solid 得多（而且邮件重置本身就依赖"email 可信"，正是 §8.2 否掉的那个假设）。

CLI / Node（无浏览器场景）用 Device Authorization Grant（RFC 8628）。

**standalone 模式完全不走登录**，隐含 local owner，所以 PRINCIPLE §5.1「核心能力不依赖官方账号」继续成立。

### 8.4 安全加固（自托管暴露到公网的必备项）

现状是**明文 HTTP、无 TLS、无 CORS、无请求超时、无每设备限流**（`internal/server/server.go:667`，无 `http.Server` timeouts）。作为自托管服务器对外时必须补：

| 项 | 措施 |
|---|---|
| TLS | 推荐反向代理终止（Caddy/nginx）；Hub 支持 `--tls-cert/--tls-key` 便于直连 |
| 请求超时 | `http.Server` 设置 `ReadHeaderTimeout` 等（当前完全没有） |
| 权限梯度 | 把 ADR 0017 已定义的 read/write/admin 梯度从 MCP **扩展到 REST**（当前 REST 只有 `masterOnly` 粗粒度，被偷的手机 token 能建任务、花钱、读所有 artifact） |
| 限流 | 每设备请求限流，今天只有每 IP 认证失败限流 |
| CORS | 若 console 与 Hub 不同源则必须显式配置；默认同源不开放 |

---

## 9. 每设备 Agent 配置

### 9.1 归属划分

| 数据 | 归属 | 理由 |
|---|---|---|
| agent 二进制路径、版本 | Node 本地 | 是机器的 PATH 事实 |
| provider API key、agent OAuth | Node 本地 secret store | D7，永不上行 |
| 默认 agent、默认 model | Node 本地 | 用户是"在这台机器上"设的 |
| 是否安装 / 是否可用 / 不可用原因 | **上行到 Hub** | 调度需要，非敏感 |
| 可用 model 列表（非敏感元数据） | 上行到 Hub | 用户要在别的设备上选 |

**model 列表的来源因 adapter 而异**（这是 §7 的一处具体影响）：ACP agent 的可用模型来自 `session/new` / `session/load` 返回的 `configOptions` 中 `category: "model"` 的选项，并且会随后续 `config_option_update` 变化；而今天 Claude/Codex adapter 返回的是硬编码或 `default_only`（`internal/server/agents.go:198-224`）。因此 `device_agents.models` 是**带时间戳的缓存**，不是权威——UI 要能表达"这台设备上该 agent 的模型列表尚未探测"。

这直接满足 AGENTS.md 的 **External integration UX gates**：「打开设置不得隐式读取 secret 或调用第三方 API」。Hub 上的 agent 列表来自 `device_agents` 的**持久化元数据**，不是现场探测；真实探测只在用户显式动作（refresh / test / 首次连接）时发生，且发生在 Node 本地。

### 9.2 API

```http
GET  /api/devices                       → 设备列表 + 在线状态 + agent 摘要
GET  /api/devices/{id}/agents           → 该设备的 agent 目录（来自 device_agents）
PUT  /api/devices/{id}/agents/{agent}   → 设默认/改默认 model（转发到 Node，Node 落本地）
GET  /api/agents?device_id=             → 按设备过滤；不传则聚合所有在线设备
```

今天 `agent.default` 是全局 settings key，需要按设备作用域化。**兼容策略**：standalone 下 `device_id` 恒为本地设备，旧 key 继续有效并被读作本地设备的值。

---

## 10. 客户端影响

### 10.1 词汇统一（当前很混乱）

| 概念 | Go | React UI | iOS |
|---|---|---|---|
| 一次对话 | `task` | 代码写 `session`，文案写"对话/chat" | 类型 `KinTask`，文案写 "conversation" |
| 导入的第三方会话 | `agent-session` | `AgentSession` | 无 |

**建议：** 后端与前端统一用 **`session`** 作为用户可见名词，API 路径保持 `/api/tasks`（避免大规模破坏性重命名），但**文档与新代码一律称 session**，并明确 `agent-session` 是另一件事（provider 会话，不会再新增歧义用法）。

### 10.2 Web console

| 变更 | 说明 |
|---|---|
| 设备徽标 | 会话列表 / turn 上显示执行设备（今天**完全没有**设备概念） |
| 设备选择器 | 发起 turn 时可选设备（默认"会话上次的设备"） |
| Agents 页 | 按设备分组，只读运行态摘要（借鉴 Magpie 分析的 §7.2） |
| 会话同步 | 用 §6.3 的全局游标，替换今天的"整表重拉" |
| i18n | en + zh 同步更新 |

### 10.3 iOS

> **本小节已按 `b513573` 修正。** 下面原来描述的 SwiftUI 客户端
> （`ios/`、`ServerProfile`、`DesktopSwitcherButton`）**已经不存在**：那 47 个
> Swift 文件连同构建它们的 workflow 一起删掉了。

今天的 iOS 是 `mobile/` 里的一个 **Capacitor 外壳**，`capacitor.config.ts` 把它
指向 Hub 自己的控制台（`server.url = KIN_HUB_URL`，在 `cap sync` 时定死，所以是
per-deployment 的）。它**不是第二个客户端**——登录、每一个相对 `/api` 调用、游标
同步，走的都是浏览器控制台那同一份代码。

- **好消息：** 与 Hub 权威模型天然吻合，而且比 SwiftUI 时期更吻合——没有第二份
  需要跟着改的客户端。设备列表、会话同步这些能力**只做一遍**，Web 和手机同时得到。
- **要改的：** 不存在"从 N 个 profile 切换到 1 个 Hub"的改造了；外壳只认一个
  origin。多 Hub 需求若出现，是给外壳加一个 origin 选择，不是恢复 profile 切换。
- **约束：** 手机上的体验**等于** Web 控制台在 ~390–440px 下的体验。手机的短板
  不是原生能力，是控制台的窄屏质量——见 `2026-10-23-lody-parity.md` §2.2 与 P3b。
- **无 APNs**：外壳没有推送通道，通知仍靠 Bark / ntfy webhook。P3b 要求的
  "从通知进会话"要额外做（见该计划）。

---

## 11. 分阶段实施

### 为什么把"读路径"排在"写路径"前面

诉求可以拆成两半，难度差一个量级：

| | 读路径（会话同步） | 写路径（远程执行） |
|---|---|---|
| 内容 | Hub 权威存储 + 全局游标 + 客户端接入 | Node 注册 + turn 派发 + 事件上行 |
| 新增风险 | 无（Hub 仍是唯一写者） | turn 收敛、跨网审批、租约、掉线 |
| 兑现的诉求 | ①同账号多设备会话保存 ②服务端自托管 | ③每设备不同 agent（执行侧） |
| 规模 | 小，数天可 dogfood | 中，需专门的收敛与断线测试 |

**P0-A 是纯粹的重心迁移，不引入任何新的分布式失败模式**——Hub 本来就是唯一写者，只是从"本机 daemon"变成"独立 Hub"。先把这块 dogfood 掉，能验证数据模型、游标语义和客户端改造这三件最容易返工的事，再上远程执行。

每阶段独立可验证、可 dogfood。

### P0-A：会话同步（读路径）— **本轮优先**

| 项 | 内容 |
|---|---|
| 目标 | 一个 Hub，两台设备打开看到**同一批会话**，实时更新、断线可补齐 |
| 改动 | 迁移 v33 中与归属/游标有关的部分（`users` 隐含 local owner、`devices`、`tasks.owner_user_id`/`origin_device_id`/`hub_seq`、索引）；`--role hub`；`GET /api/sessions?updated_since=` 全局游标；WS 广播带上 `hub_seq`；客户端改为"一个 Hub + 游标续拉" |
| 验收 | ① Hub 跑在机器 A，浏览器在 A、iOS 在 B；② A 上新建会话并跑完一个 turn；③ B 上无需刷新即可看到，且 `GET /api/tasks/{id}/events` 的 `seq` 连续无洞；④ B 断网 5 分钟后重连，靠游标补齐且无重复；⑤ **standalone 模式零回归** |
| 风险 | 低。无分布式执行，无租约，无跨网审批 |
| 不做 | 远程执行、ACP、登录流程、离线写 |

### P0-B：远程执行（写路径）

| 项 | 内容 |
|---|---|
| 目标 | 会话在 A 发起、在 B 执行，两端都看到完整 transcript |
| 改动 | 设备注册表落库 + agent 能力上行；Node 出站通道（先只做直连）；turn 派发 + `turn.event` 上行（Hub 分配 `seq`）；工作区锚点解析；turn 写锁；**turn 收敛**（Node 掉线/Hub 重启→确定终态且保留部分 transcript） |
| 验收 | ① 两个 daemon（不同 state dir）+ 一个 Hub；② A 上建会话，指定在 B 执行；③ B 本地 agent 跑完；④ `tasks.executing_device_id` 正确；⑤ 执行中 kill Node → turn 收敛为 `failed`，已收到的事件保留，Hub 不挂；⑥ 跨设备换 agent 时 `session_ref` 被清空且 handoff context 从 `events` 重建 |
| 风险 | 中高。主要是收敛与写锁正确性 |
| 不做 | ACP、relay 承载 Node 通道、跨设备工作区自动 provision |

### P0-C：ACP 接入

| 项 | 内容 |
|---|---|
| 目标 | 用 ACP 跑通至少一个 agent，并让它的权限请求进入 Kin 审批收件箱 |
| 改动 | 抽出可复用的双向 JSON-RPC 客户端（参考 droid）；`internal/adapter/acp/`；事件映射（§7.3）；审批桥跨网络（§7.4）；ACP conformance 套件 |
| 验收 | ① ACP agent 完成一个 turn，流式 chunk 正确渲染；② `session/request_permission` 在 Web/iOS 上可批准/拒绝；③ 拒绝后 agent 收到 `outcome: {outcome: "cancelled"}`，且**双层嵌套结构**被正确构造；④ Node 在等待裁决时掉线 → turn 收敛为 `failed` 且**不自动批准**；⑤ **级联取消**：Kin 取消 turn 时，所有待决权限请求都被回 `cancelled`（规范 MUST），无悬挂请求 |
| 风险 | 中高。协议细节多（14 种 update、能力矩阵、双层嵌套 outcome、取消耦合），agent 实现质量参差 → 先 conformance 再放开 |

### P0-D：账号与每设备配置

| 项 | 内容 |
|---|---|
| 目标 | 登录流程（GitHub / OIDC / 邮箱密码，进同一账号）；用户只见自己的会话；每设备 agent 配置可见可改 |
| 改动 | `users` + `user_identities`（§8.2）；终端配对码认领（§8.3）；provider adapter 按需实现，**先做 `password` 与 `github`**（`oidc` 后补，因为自建 IdP 的用户最少）；`owner_user_id` 贯穿查询；`device_agents` + `/api/devices` 系列；控制台设备/agent UI；REST 权限梯度（§8.4） |
| 验收 | ① 未登录不可访问；② 未持配对码者无法认领 owner；③ **同一账号用 GitHub 与密码登录看到同一个 session 池**；④ 跨用户数据不可见（含会话、事件、artifact）；⑤ **用他人 email 无法进入他人账号**（R13 的回归测试）；⑥ standalone 仍无需登录；⑦ 打开设置不读 secret、不探测第三方；⑧ 在设备 B 的 UI 上能看到并修改 B 上的默认 agent |
| 风险 | 中高。权限梯度铺开面广，需逐路由核对；密码 provider 是新增的攻击面（R15），限速与锁定必须与 provider 同批落地，不能延后 |

### P0-E：dogfood 加固

| 项 | 内容 |
|---|---|
| 内容 | 既有本地数据迁移（首次启用 Hub 时把本地会话认领到 local owner）；Node 重连与事件补传；relay 承载 Node 通道；设备吊销即时生效；文档（中英对齐）；`./scripts/desktop-rebuild.sh` |
| 验收 | 升级不丢数据；断网 5 分钟后恢复，transcript 完整无重复 |

### 后续（不在本轮）

- 跨设备工作区自动 provision（git clone / 同步）
- 多 Hub 联邦（`ServerProfile` 多 Hub 的会话聚合）
- 端到端加密同步（当时 PRINCIPLE §6.6 提到过；2026-10-23 起 PRINCIPLE §6.5 明确**不承诺** E2EE 与冲突解决）
- provider JSONL 的跨设备取证

### dogfood 怎么跑（P0-A 完成后）

```bash
# 机器 A：Hub（也是工作区所在机器，自带本地 Node）
kin serve --role hub --port 7777

# 机器 B：什么都不用装，浏览器/iOS 指向 http://<A>:7777
#   扫码配对一次，之后两台设备看到同一批会话

# 不配置任何 role 的既有用户：行为与升级前完全一致
kin serve
```

---

## 12. 验证策略

| 层 | 手段 |
|---|---|
| 迁移 | 空库 + 已填充库（v32 → v33）双向测试，沿用 `internal/store/checkpoints_test.go` 的既有模式 |
| 序号 | 专门测试：并发 turn 提交时 `seq` 严格单调且无洞；`hub_seq` 全局单调 |
| 幂等 | 重复 `turn_id` 只落一次；Node 重放同一批事件不产生重复行 |
| 收敛 | 表驱动：Node 掉线 / Hub 重启 / 取消 / 超时 → turn 终态正确且 transcript 保留 |
| 传输一致性 | standalone / 直连 / relay 三条传输跑**同一套**集成测试（D8 的强制验证） |
| ACP | 仿 `internal/adapter/adaptertest/conformance.go` 建 conformance；含审批、取消、拒绝、断线 |
| 回归 | `go test ./...`、`go vet ./...`、`cd ui && npm run build`、`make test` |
| 端到端 | 两个 daemon + 一个 Hub 的集成测试，真实跑一个 turn |

---

## 13. 风险与未决问题

| # | 风险 | 影响 | 缓解 |
|---|---|---|---|
| R1 | Hub 成为单点故障 | 全部设备不可用会话 | Hub 无状态化不可行（它是写者）；缓解：standalone 模式始终可用、Hub 数据可导出、Hub 可跑在任意一台设备上 |
| R2 | 跨设备工作区解析失败 | "换设备继续"直接不可用 | P0 只支持两种锚点；解析失败**显式报错**并提示在哪台设备可用 |
| R3 | 索引重建可能丢约束 | 数据完整性 | 走既有 `_new`+`RENAME` 模式 + 迁移测试（空库/满库） |
| R4 | 与既有非目标冲突引发定位漂移 | 产品方向 | ADR 0022 显式修订（已 accept）；登录边界写进文档（§8.2、§8.3） |
| R13 | **拿 email 当身份键导致账号被冒名**（GitHub 允许未验证邮箱） | 账号接管 | 账号键是 `users.id`，凭据键是 `(provider, subject)`；关联只允许已认证动作，**永不按 email 自动合并**（§8.2） |
| R14 | **Hub 暴露到公网后被抢注 owner** | 账号接管 | 首次认领需终端打印的一次性配对码，不是"先到先得"（§8.3） |
| R15 | **密码登录把 Hub 变成 ID 系统**：需要限速、锁定、哈希，且重置密码需要发信通道 | 安全/运维 | 用 argon2id + 每 IP/每账号失败限速（不做就不开该 provider）；重置走 Hub 本机 CLI，不引入 SMTP（§8.3） |
| R16 | **GitHub 不是 OIDC**：不签发 ID token，discovery 文档里也没有 `email`/`email_verified` | 返工 | GitHub 与 OIDC 实现为两个 adapter；不去验签 ID token，身份靠 `GET /user` 确认；`subject` 取数值 `id`（§8.2） |
| R17 | **GitHub 未验证邮箱**：token 交换可能直接以 `unverified_user_email` 失败；EMU 还会返回伪造占位邮箱 | 登录失败且提示难懂/脏数据 | 把 `unverified_user_email` 当一等错误，提示"请先在 GitHub 验证邮箱"；邮箱只接受 `GET /user/emails` 里 `verified === true` 的条目，并挡掉 `email+shortcode@` 形态（§8.2） |
| R18 | **GitHub App 的 `x-github.enabledForGitHubApps: false` 标记**与 REST 文档所述支持相矛盾 | 实现期卡住 | 该标记管 installation token 而非 user token，判断是文档不一致；**实现时先实测一次**，不照推断写（§8.2） |
| R5 | ACP agent 质量参差 | 用户遇到难懂的失败 | conformance 门禁 + `device_agents.reason` 原样透出 |
| R6 | 权限梯度铺开引入越权或误拒 | 安全/体验 | 逐路由核对表 + 表驱动测试；先只读/任务控制/审批/管理四档 |
| R7 | 事件上行放大 Hub 写入量 | 性能 | Hub 单写者本就串行；批量追加 + 事务合并；必要时按 turn 批量提交 |
| R8 | **ACP v1→v2 漂移**：`session/load`、`set_mode`、`fs/*`、`terminal/*` 在 v2 已被移除/替换 | 后续返工 | v1↔v2 映射做成**可替换映射表**，不烤进领域模型；v2 等稳定后再做，且走显式版本协商 |
| R9 | **baseline-only agent**：只实现基线方法的 agent 没有 list/resume/replay | 用户遇到难懂的行为 | 能力探测矩阵 + 显式回退路径；`device_agents.reason` 原样透出缺失的能力 |
| R10 | **与 ACP 远程监督竞品同质化**（Reemoat/AgentDeck/Runmote/tlbx/…） | 定位 | 差异化写进 ADR 与文档：会话/审批/审计/Artifacts 是主线；不绑定 ACP；路径中无厂商（§7.7） |
| R12 | **把"自部署"当隐私卖点**：Kin 的 Hub 是会话权威，结构上做不到 Reemoat/Happy 式的"运营商看不见" | 信任误导 | 定位改为"路径中无厂商 + 信任边界写在明处"；文档与 ADR 明说 Hub 必须部署在受信任机器上，不用 E2EE 假称能绕（§7.7、§14） |
| R11 | `session/load` 重放污染 `events` | 数据重复 | §7.4 的 `replaying` 标志位 + 专门的回归测试 |

### 未决问题（实现前需定）

1. **`hub_seq` 的分配粒度**：每事件一个全局序号，还是每 turn 一个？前者查询简单但写入放大；后者反之。倾向**每事件**（与既有 `seq` 同事务，最简单）。
2. **Node 离线时能否创建会话**：P0 建议**不能**（会话由 Hub 创建）。离线写会引入真正的冲突合并，与本方案的"单写者"原则冲突。
3. **Hub 自身是否作为 Node**：standalone 下是。纯 Hub 模式下，Hub 也可注册为设备（复用同一路径，符合 D8）。
4. **relay 能否承载 Node 通道**：relay 是"每个 room 一个 daemon + ≤8 client"（`relay/relay.js:4`）。Node 通道需要 daemon↔daemon 或复用 client 角色——需要一次小的 relay 协议扩展，或 P0 先只支持直连。

### 待实测项（本轮核实**未能**确认，实现前必须先验证）

这几条是推断或二手，**不要照抄进实现**：

| # | 待验证 | 为何未确认 | 怎么验 |
|---|---|---|---|
| V1 | GitHub App 的 user token 能否调 `GET /user`、`GET /user/emails` | OpenAPI 标了 `x-github.enabledForGitHubApps: false`，渲染文档又说支持——**两者矛盾**（R18） | 建一个 GitHub App 实测一次 |
| V2 | Google 实际签发的 `email_verified` 是字符串还是布尔 | 文档示例是字符串，未跑真实登录 | 跑一次真实 Google 登录，打印原始 ID token |
| V3 | `GET /user` 返回的 `email` 是否可能是未验证值 | **GitHub 完全没有文档说明** | 不依赖它——本设计只用 `GET /user/emails` 的 `verified` |
| V4 | `xms_edov` 出现在 ID token 还是 access token | 文档只标 JWT，未区分 | 只在真要接 Entra ID 时才需要 |
| V5 | Auth0 是否真的签发 `email_verified` | 该页只在正文列举，**同页示例 token 里没有** | 查 `<tenant>.auth0.com/.well-known/openid-configuration` 的 `claims_supported` |
| V6 | `api.github.com/.well-known/openid-configuration` 的真实状态 | 探测时撞上 GitHub API 限流（403），不是真答案 | 预期 404（GitHub 只文档化了两份元数据），但未证实 |

---

## 14. 明确不做

- **不做 multi-master**。Node 不持有可写副本；Hub 是唯一写者。这保留了 `2026-09-05` 计划的原意。
- **不做 OpenKin 运营的账号/中继/云**。登录方式由用户自选并跑在用户自己的 Hub 上，OpenKin 不运营账号服务、不托管数据。
- **不做"运营商看不见"的中继模式**。Hub 是会话权威，必须持有明文；Kin 不提供对 Hub 的 E2EE，也不宣称"自部署 = 隐私"。信任边界是：路径中无厂商 + 秘密不出设备（D7）+ Hub 部署在你信任的机器上。
- **不新增会话实体**。Task 就是 session。
- **不复制 provider transcript 进 Kin**。Kin 的 `events` 是权威，provider JSONL 不再是会话保存的依赖。
- **不做跨设备原生会话 resume**。原生 session id 是设备本地的；跨设备一律走 handoff。
- **不用 ACP 替换现有 adapter**。新增一族，收敛以证据驱动。
- **不支持 ACP v2**（Draft，2026-07-20 发布）。映射表预留可替换性，等官方稳定并完成版本协商后再做。
- **不为 ACP 实现自定义传输**。Node 通道是 Kin 自己的节点协议（§6.1），不是 ACP 传输层的替代品；ACP 侧永远只有 stdio 一条连接。
- **不做跨设备工作区自动 provision**（本轮）。
- **不做 CRDT / 向量时钟**。单写者 + 显式失败已经覆盖本轮需求。
