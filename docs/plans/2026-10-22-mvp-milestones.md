# MVP Milestones: Multi-Device Kin

目标用户场景，一句话：

> 在 NAS 上跑 Hub，绑定域名。桌面端和 iOS 都装上。用 GitHub 或邮箱密码登录。
> 在 iOS 上管理所有设备的 session；每个会话在拥有它的那台设备上、用它本地的 agent 执行。

配套设计文档：`docs/plans/2026-10-22-multi-device-session-architecture.md`（为什么这么设计）。
本文只讲**怎么落地**。

---

## 0. 一个前提改变了整个计划

**不需要兼容旧数据、旧行为。** 这让三件事从"必须小心处理"变成"直接删掉重做"：

| 原设计的负担 | 现在 |
|---|---|
| 迁移只能增列，索引重建要走 `_new` + `RENAME` | **删除**。schema 直接重排成正确的形状 |
| `tasks.session_ref` 要保留成兼容投影（5 个 adapter 依赖它） | **删除**。直接换成 `(device_id, agent_id, external_ref)` 三元组，adapter 一次性改到位 |
| standalone 零回归是硬验收项 | **降级**。standalone 仍要能用，但不必与升级前逐字节一致 |

这三条省下的时间，比任何一个功能都多。**建议把这条前提明确写死**，否则后面会有人（包括未来的我）不自觉地又去加兼容层。

---

## 1. 技术选型

| 层 | 选型 | 状态 | 理由 |
|---|---|---|---|
| Hub / Node | **Go 单二进制**，一个二进制两个角色 | 复用 | 已有 337 个 Go 文件；NAS 上零依赖 |
| 存储 | **SQLite**（`modernc.org/sqlite`，纯 Go） | 复用 | 单用户 NAS 的正确选择，无 CGO，无外部服务 |
| NAS 部署 | **Docker 镜像（多架构 amd64 + arm64）** + 裸二进制备用 | **新增** | 群晖/威联通/unRAID 都支持 Docker；这是最省事的分发 |
| 公网接入 | **有公网 IP + 端口转发**，Hub 内置 autocert 申请证书 | **新增** | 你的实际环境。不需要 Cloudflare Tunnel 或额外反代 |
| 登录 | **邮箱密码（argon2id）+ 通用 OIDC 客户端**；GitHub 走 Dex sidecar（compose profile） | **新增** | Kin 只实现 OIDC 一种协议。加 provider 是改 Dex 配置，不改 Kin 代码 |
| Passkey | **M2 之后** | 延后 | `go-webauthn/webauthn` 健康，但不是 MVP 阻塞项 |
| 实时通道 | **SSE 优先 + 有界 long-poll 兜底** | **改** | 公司内网常拦 WebSocket；SSE 走普通 HTTP，穿透性最好 |
| Agent 接入 | **ACP 优先**，现有 7 个 adapter 作过渡 | **改** | 1 个协议客户端 vs 7 个私有格式解析器 |
| 控制台 | **React + TypeScript + Zustand** | 复用 | 已有 |
| 桌面 | **Electron** | 复用 | 已有 |
| iOS | **Capacitor + React + Konsta UI** | **重写** | 与 console 共享组件与状态层；旧 SwiftUI 直接删 |

**关于"agent 优先 ACP"的诚实说明：** ACP 降低的是**长期**维护量，不是短期工作量。
它是净新增（ACP 客户端 + 事件映射 + 审批桥），M2 会因此明显变长。
分层现实：厂商自带 ACP 的 → 约 0 代码；厂商是私有 RPC 的 → 要写一个 proxy；厂商是完整 harness 的 → 等于重写一个 agent。
ACP 不是"接什么都是零成本"，它是"只维护一个协议客户端，而不是七个"。

---

## 2. 系统设计

### 2.1 部署形状（对应你的场景）

```
        ┌─────────────────────────────────────────┐
        │  NAS — Hub 角色                          │
        │  · 会话权威（唯一分配 seq）               │
        │  · 账号与登录                            │
        │  · 审批收件箱                            │
        │  · HTTPS + 域名（autocert）              │
        │  · 不跑 agent，不碰代码                   │
        └────────────┬────────────────────────────┘
                     │  HTTPS / WSS
        ┌────────────┴────────────┬─────────────────┐
        │                         │                 │
   ┌────▼─────┐            ┌──────▼─────┐     ┌─────▼──────┐
   │ 桌面机 A  │            │ 桌面机 B    │     │  iPhone    │
   │ Node     │            │ Node       │     │ 纯客户端    │
   │ 有代码    │            │ 有代码      │     │ 只看/审批/发指令│
   │ 有 agent │            │ 有 agent   │     │            │
   └──────────┘            └────────────┘     └────────────┘
```

**关键点：NAS 只做 Hub。** 你的 NAS 上没有代码库也没有 agent，所以执行必须留在桌面机上。Hub 只负责"谁该干什么、干到哪了、要不要批准"。

### 2.2 三条不可让步的规则

1. **只有 Hub 分配 `events.seq`。** Node 从不写自己的事件日志，只上行事件。这一条让整个设计不需要 CRDT、向量时钟、冲突合并。
2. **秘密不出设备。** provider API key、agent 登录凭据永不上行到 NAS。Hub 只存非敏感的能力元数据（"这台机器装了 codex"）。
3. **一个会话同时只有一个活跃 turn。** 既是序号正确的必要条件，也是既有的"打断后接管"产品行为。

### 2.3 数据模型（干净重排，不留兼容）

新增：`users`、`user_identities`、`devices`、`device_agents`、`workspace_anchors`
扩展：`tasks`（owner / 执行设备 / 工作区锚点 / `hub_seq`）、`events`（`hub_seq`）
改键：`agent_sessions` 的唯一键 → `(device_id, agent_id, external_ref)`

---

## 3. 复用 / 改动 / 删除

### 3.1 直接复用（不动）

Go daemon 骨架 · chi 路由 · 配置与日志 · SQLite store 与迁移机制 ·
**Task/Event 语义核心（Task 就是 session）** · 审批收件箱 · 用户提问 ·
WebSocket 失效通知（作为 SSE 的补充，不是真相来源）· QR 配对与设备凭据 ·
React 控制台与设计系统 · Electron 壳 ·
**7 个 agent adapter**（作为 ACP 落地前的过渡，不是终态）

### 3.2 必须改（因为模型变了，不是因为有 bug）

| 什么 | 为什么 | 量级 |
|---|---|---|
| **执行路径** | 今天 agent 在 daemon 进程内跑；要拆成 Hub 调度 + Node 执行 | **L（最大的一块）** |
| `events` 序号 | 加全局游标 `hub_seq`，Hub 唯一分配 | M |
| `agent_sessions` 唯一键 | 原生 session id 是设备本地的 | M（牵动全部 adapter） |
| `tasks` 归属维度 | owner / 执行设备 / 工作区锚点 | S |
| **实时通道** | WebSocket → SSE + 有界 long-poll 兜底 | M |
| **移动端** | SwiftUI → Capacitor + React + Konsta，与 console 共享组件 | **L** |
| 控制台 | 显示"这个会话哪台设备能跑"；新增登录页 | S |

### 3.3 直接删除（不兼容反而更简单）

- **整个 `ios/` 目录（47 个 Swift 文件 / 15,364 行）** —— 换成 Capacitor 壳。git 历史保留，需要时可回溯。
- **`tasks.session_ref` 兼容投影** —— 原设计为了不动 5 个 adapter 才保留它。现在直接换成三元组。
- **迁移的"只增列"约束** —— schema 一次排成正确形状，不走 `_new` + `RENAME`。
- **单机假设的 workspace 绝对路径列** —— 换成锚点。
- **单 owner 下多余的权限梯度** —— read/write/admin 三档砍成"已认证设备 / 未认证"。

---

## 4. 砍掉的范围（明确不做，避免计划膨胀）

| 砍掉 | 为什么可以砍 |
|---|---|
| **手写 GitHub / Google / … OAuth 适配器** | 改用 Dex sidecar。Kin 只实现通用 OIDC 客户端，加 provider 是改 Dex 配置，不是改 Kin 代码 |
| **多用户 / 开放注册** | 单 owner，首个账号由终端配对码认领，之后注册关闭 |
| **跨设备原生 session resume** | 原生 session id 是设备本地的，跨设备一律重建上下文（既有 handoff 机制） |
| **离线写** | 离线写会引入真正的冲突合并，与"单写者"冲突 |
| **OpenKin 运营的账号/中继/云** | 永不做 |

---

## 5. 里程碑

每个里程碑都以**一句话的真实验收场景**结束，而不是以"代码写完"结束。

### M0 — 能在 NAS 上跑起来，并且能登录

| | |
|---|---|
| 交付 | 多架构 Docker 镜像 + compose；内置 autocert TLS + 域名；`--role hub`；账号体系（邮箱密码 + 通用 OIDC 客户端）；终端配对码认领 owner；schema 干净重排（身份部分） |
| 验收 | NAS 上 `docker compose up -d`，浏览器打开 `https://你的域名`，**用邮箱密码登录进去，并被认领为 owner** |
| 大小 | M |
| 依赖 | 无 |

**M0 分两步，先跑通再加外援：**
1. 密码登录端到端可用——这一步不依赖任何第三方，验收完全自足。
2. 再挂 Dex sidecar（compose profile `github`），验证 GitHub 登录。它需要你自己建一个 GitHub OAuth App。

**不把 Dex 放进默认路径**是有意的：GitHub 登录要求你在 GitHub 侧建应用、填回调地址，这一步不该阻塞"Hub 能不能跑起来"的验证。

### M1 — 多端看到同一批会话

| | |
|---|---|
| 交付 | Hub 权威 + `hub_seq` 全局游标；HTTP 游标续拉 API；SSE 通道；控制台与移动端改成"一个 Hub + 游标"；Capacitor 壳替换 SwiftUI |
| 验收 | 桌面端和手机打开看到**同一批会话**；杀掉网络再恢复，能补齐断线期间的变化 |
| 大小 | M–L（含移动端重写） |
| 依赖 | M0 |

**为什么读路径排在写路径前面：** 它不引入任何新的分布式失败模式——Hub 本来就是唯一写者，只是从"本机 daemon"变成"NAS 上的服务"。先把这块 dogfood 掉，能验证数据模型、游标语义、客户端改造这三件最容易返工的事。

### M2 — 各设备用自己的 agent 干活

| | |
|---|---|
| 交付 | Node 角色（注册 / 心跳 / 能力上报，主动外连 Hub）；turn 派发（Hub 调度 → Node 执行 → 事件上行）；工作区锚点；跨设备审批；**ACP 客户端 + 事件映射 + 审批桥** |
| 验收 | **在手机上发一个任务 → 它在装了 agent 的那台桌面机上跑起来 → 过程与结果回到手机；能批准/拒绝权限请求** |
| 大小 | **L**（整个计划最重的一块） |
| 依赖 | M1 |

**M2 内部顺序（不要并行）：** 先让 Node 用**现有 adapter** 把链路跑通（Hub 调度 → 执行 → 上行 → 回到手机），
再把执行层换成 ACP。这样 ACP 出问题时，你有一个已知可用的对照组，而不是两个新东西同时不确定。

### M3 — 装到真机上

| | |
|---|---|
| 交付 | 桌面打包（.dmg / .exe，脚本已有）；iOS TestFlight 打包 |
| 验收 | 两台电脑 + 一台 iPhone 全部装好，**连续用一周不重启 daemon** |
| 大小 | S–M（桌面管线大部分已存在；TestFlight 是新增） |
| 依赖 | M2 |

**注：M3 不是"最后才做"。** 每个里程碑结束都应该能出一个可安装的版本，M3 只是把分发正式化。

### M4 — dogfood 加固（边用边修）

设备吊销即时生效 · Node 重连与事件补传 · Passkey · 首次迁移把既有本地会话认领到 local owner · 中英文档对齐

---

## 6. 三个最大的风险

| 风险 | 为什么危险 | 应对 |
|---|---|---|
| **M2 的执行路径拆分** | 今天 agent 跑在 daemon 进程内，要拆成两个角色、两种部署。这是唯一一块"不是改，是重写" | 单独排期，不要在 M0/M1 里顺手做；先做直连，relay 承载 Node 通道留到之后 |
| **Hub 成为单点** | NAS 挂了全部设备看不到会话 | standalone 模式始终可用；Hub 数据可导出；Hub 能跑在任意一台设备上 |
| **ACP 的覆盖度被高估** | ACP 只对"厂商愿意说 ACP"的 agent 零成本。私有 RPC 的要写 proxy，完整 harness 的等于重写 | M2 内部先跑通 adapter 路径再换 ACP（见 §5）；换的时候保留 adapter 作为回退，确认覆盖够再删 |
| **"不兼容"这条前提被遗忘** | 后面有人不自觉加回兼容层，计划立刻膨胀 | 已在 §0 写死 |

---

## 7. 已经定下来的决策（2026-10-22）

原来这里挂着两个待确认项。都已拍板：

| 问题 | 决定 |
|---|---|
| NAS 是否同时是 Node？ | **不是。NAS 只做 Hub** —— 上面没有代码库也没有 agent |
| ACP 的位置 | **M2 就上，且优先**。代价是 M2 变长，换的是不返工 |
| 公网接入 | **有公网 IP + 端口转发**，Hub 内置 autocert |
| iOS 分发 | **TestFlight** |
| 移动端技术 | **Capacitor + React + Konsta UI**，SwiftUI 删除 |
| 登录 | **通用 OIDC 客户端 + 本地密码**；GitHub 走 Dex sidecar（compose profile） |
| Passkey | M2 之后 |
| Node → Hub 方向 | **Node 主动外连 Hub**（NAS 在家，桌面机可能在外面，只能是这个方向） |
| Hub ↔ Node 协议 | **复用 Hub 的 HTTP + SSE**，Node 是"会执行的特殊客户端"，不另造协议 |
| 工作区锚点范围 | M2 只做 `device_path` + 每台设备手动声明仓库路径；`git_remote` 自动匹配延后 |
| Hub owner 的权限 | **owner 就是运维者**：settings / providers / devices / relay 全都能配。设备 token 仍然被挡在外面。见 ADR 0023 |
| 浏览器会话能否拿到 master token | **不能**。Hub owner 用的是账户会话，不是 daemon 自己的凭据 |

---

## 8. 已知的未验证项（不要当成已解决）

诚实列出，避免后面把它们当成既定事实：

| 项 | 状态 |
|---|---|
| Dex sidecar 本身 | **从未启动过**。只检查了镜像（`/var/dex` 属主 1001:1001，非 root 用户可写；entrypoint 是 ELF）。OIDC 全流程没有跑通过 |
| 各 IdP / Dex 的实际内存占用 | **从未测量**。NAS 上的资源预算目前是估的 |
| Dex 从容器内访问自身公网 issuer | **未验证**。OIDC 要求 issuer 字符串精确匹配，容器内解析公网域名常需 NAT 回环。M0 第二步必须实测，不能推断 |
| Keycloak / Authentik / Zitadel 能否当普通 OIDC IdP 接 | 未确认。不影响 MVP（用 Dex），但影响"以后想换 IdP"的说法 |
| 同类自托管产品实际发布哪些登录方式 | **完全未调研**（Immich / Jellyfin / Gitea 等）。不影响实现，只影响"这是不是行业常态"的论断 |

M0 第一步（邮箱密码）这一侧已经实测通过，不算未验证项：镜像能构建、容器内以
uid 1000 绑得住 80/443、认领码能打印、认领 → 会话 cookie → 登录 → 退出登录
整条链路在真实浏览器里跑过。
