# OpenKin 系统设计

[English](./SYSTEM_DESIGN.md)

**状态：** Draft v0.4 — 方向说明，不是 API 合同
**项目 / 品牌：** OpenKin · **产品主体：** Kin · **CLI：** `kin`（别名：`ok`）
**依据：** [PRINCIPLE.zh.md](./PRINCIPLE.zh.md) · [English](./PRINCIPLE.md) — §12 控制台优先；v0.4 记录 2026-10-23 的范围削减（见 §7）
**主张：** Your agents. Your machines. Any device.

探索性草稿与实现日记不放在本仓库。本文是**对外**架构快照：帮助判断 OpenKin 是否适合你，而不是内部工作备忘录。

---

## 1. 总览

```text
用户拥有的 Kin Core
  ├── Agent 插件注册表            ← 编译期插件（Kin / Claude Code / Codex …）；host 可互换
  ├── Agent 适配层               ← 各插件的进程 runner 与归一化事件
  ├── 任务引擎 + 确认/提问         ← 派发、监控、批准、提问、审计
  ├── Provider / 费用层          ← 按任务、按模型的用量与花费
  ├── Hub（可选）                ← 用户自己的服务器：账户、会话、多设备扇出
  ├── Node 通道                  ← 无需开放入站端口，即可触达 NAT 之后的机器
  ├── Artifacts（P0 已实现）     ← 会话可读产物库 + 阅读器
  └── Client Shells              ← 桌面 App + 手机 Web 控制台
```

**硬约束**（来自原则）：

| 约束 | 含义 |
|------|------|
| 用户拥有 | 不需要 OpenKin 运营的账户；可导出 / 删除 / 自托管 |
| 路径中没有厂商 | 单机独立运行，或运行用户自己的 Hub；绝不是我们的基础设施 |
| 模型无关 | Provider 特性不拥有会话与配置 |
| 权限渐进 | 外部影响需可授权、可审计 |
| 默认做小 | 可选层是以后的事，不是 v1 实体（[§5.11](./PRINCIPLE.zh.md)） |

**定位。** 两家厂商都已提供远程控制：Claude Code 的 Remote Control 把每条消息经由 Anthropic 云中继；Codex 的设备控制通过 OpenAI 账号同步状态，且宿主机必须运行其桌面 App。结构上都是单厂商、厂商云居中。OpenKin 是跨 agent、self-hosted 的另一条路：**在你自己的网络上，用一个控制台管理你所有的 agent。**

---

## 2. 先交付什么（MVP = agent 控制台）

切入点：**在任何设备上派发、监控、批准 agent 任务** —— self-hosted、跨 agent、流量不经过任何 agent 厂商。

**MVP 范围内**

- Kin daemon 通过**适配器**包住外部 coding agent：Claude Code / Codex / Grok 为一等公民（Tier 1）；已验证无头 CLI 走声明式通用适配器（Tier 2）；更广的 skills 目录仅做存在性探测 + 安装链接（Tier 3）；可选 raw PTY 跑用户显式 shell 命令
- 任务生命周期：派发 / 流式进度 / 取消 / 历史
- **确认收件箱**：权限请求与澄清问题推送到桌面与手机，每次决定/回答都有审计记录
- 费用透明：按任务、按 Provider 的 token 与花费
- 远程访问梯子（§5）：局域网扫码 → 内嵌 tailnet + Funnel → 完整 tailnet
- **用户自己运行的 Hub 上的一个账户**：在第二台设备登录，看到同一批会话
- 导出；核心使用不需要 OpenKin 运营的账户

**MVP 之后已交付的 P0 切片——Artifacts**

真实痛点：agent 常被用来写主题学习资料（Markdown / HTML），用户却要手动下载、难整理、与源会话脱节、多端阅读麻烦。
**Artifacts** 把会话中的**可读交付物**收成本地库，保留与源任务的关联，并在控制台提供阅读器；多端访问走用户自己的 Hub，而不是厂商内容云。
分期与验收见 [docs/TODO.md](./docs/TODO.md)；决策见 [docs/adr/0003-artifacts-and-reader.md](./docs/adr/0003-artifacts-and-reader.md)。

- **P0** — 捕获（提议入库）· 本地文件真源 + 索引 · 库列表 · MD/沙箱 HTML 阅读 · 跳转源任务
- **P1** — 阅读器陪读侧栏（选区解释 / 出题 / 章节摘要）· 按 `artifact_id` 续聊 · 标签与检索

**明确后置——或永不做**

- 完整 LLM Wiki / 第二大脑式 PKM —— 不在 Artifacts 之前抢主路径
- Kin 自研 code agent —— **永不**；适配器负责监督，不做重新实现
- 原生移动 App —— 基于同一 API 的快速跟进；先 Web 控制台（App Store 审核周期不能卡住 MVP 迭代）
- OpenKin 运营的中继 / 内容云 —— 只有 traction 需要时才考虑中继，且仍保持可选
- ~~完整同步产品~~ —— **2026-10-22 由 [ADR 0022](./docs/adr/0022-hub-node-multi-device-sessions.md) 撤回**，该 ADR 为多端会话引入 Hub/Node 分工
- 多用户、长期 Routine、自动模型路由 —— **仍然后置或永不做。** Hub 默认只有一个所有者：所有权用一次性终端码认领，认领后即关闭注册。开放注册的前提——账户隔离——**已经落地**；注册入口本身还没有（见 §5b）

**关于 PRINCIPLE §12 的说明。** 本版重排了 MVP：控制台先于对话。理由：对话已经发生在 Kin 所监督的 agent 内部；未被满足的需求——两家厂商先后推出远程控制即是验证——是「没有厂商居中的跨 agent 监督」。PRINCIPLE §12/§13 已同步更新（2026-07）。
**2026-07-17：** 在控制台 MVP 与后续工作之间插入 **Artifacts** 已交付切片。
**2026-10-23：** 可治理记忆、Kin Identity 与持续学习主题已从路线图中**移除**，不是推迟。见 PRINCIPLE §11 *Retired 2026-10-23*。多端从「以后」移到当下：作为用户自己 Hub 上的一个账户。

---

## 3. 概念模型（稳定语义）

即使用户只先看到控制台，下列名词的含义在后续版本中保持稳定。

| 概念 | 含义 |
|------|------|
| **Kin** | 用户拥有的主体；不是某一个模型，也不是某一个聊天窗口 |
| **任务** | 一次有目标的 agent 工作单元（派发、流式输出、确认、结果） |
| **适配器** | 把外部 agent CLI 接到统一的任务 / 事件 / 确认接口 |
| **确认** | 在产生外部影响前的人工决定；记入审计 |
| **UserQuestion** | 回合中的结构化澄清问题（选项 + 可选自由文本）；与权限模式无关；任务状态为 `waiting_input`（见 ADR 0010） |
| **费用记录** | 任务与 Provider 上的 token 与花费；本地价格表；每 agent 每日用量上限（仅展示） |
| **Provider 配置** | 端点与能力；密钥在系统密钥体系，不进日志 |
| **Artifact**（近端） | 会话可读交付物（md/html/…）；文件为真源；元数据含来源任务与状态（`proposed|saved|archived`） |
| **Export bundle** | 可版本化的带走包（**不含**密钥；**含** artifacts 目录约定） |
| **Hub** | 用户自己的常开服务器：账户、会话、多设备扇出。可选——单机 daemon 就是只有一个成员的 Hub |
| **Node** | 运行 agent、并向外连接 Hub 的机器；无需入站端口 |
| **账户** | Hub 上的一个登录身份。认领该 Hub 的账户即是它的所有者；已配对设备以所有者名义行事 |

用户应感知的产物路径：**提议入库 · 确认/忽略 · 阅读 ·（P1）陪读**。

权限阶梯（产品语言）：观察 → 准备 → 确认后执行 → 范围内委托 → 用户定义的例程。

外部 coding agent 是**适配器背后的受管 worker** —— Kin 监督它们，不重新实现它们，它们也不是第二套 Kin 身份。

---

## 4. 组件（稳定命名）

| 组件 | 职责 |
|------|------|
| Agent 插件注册表 | 编译期插件（descriptor / readiness / runner / 可选 controller 与 session hooks）；Kin 也是插件之一 |
| 适配层 | 驱动外部 agent；归一化事件、确认请求、费用遥测 |
| 任务引擎 | 派发、状态机、暂停/取消、历史；适配器使用有效执行 cwd，原始 cwd 仍作任务归属/出处 |
| Trust & Audit | 授权、确认、凭据、出站感知 |
| Providers / 费用 | Provider 配置、用量记账、按任务花费；每 agent 每日上限（仅展示） |
| Artifacts（P0 已实现） | 捕获、索引、库、阅读器；P1 陪读线程；HTML 沙箱 |
| Hub | 账户、会话存储、多设备扇出，以及提供给客户端的全局变更游标 |
| 远程访问 | §5 的梯子；绝不是必需的 OpenKin 中继 |
| 控制台 UI | 桌面壳与任意设备 Web 共用同一套 UI |
| Store / Export | 本地持久化与用户拥有的备份（含 artifacts 文件树） |

用户应感知的主路径：

1. **Dispatch** — 选 agent 与工作目录，提交任务
2. **Watch** — 流式进度与费用
3. **Approve** — 从任意已连接设备处理确认
4. **Review** — 历史、审计、花费
5. **Read / Artifacts** — 将会话交付物入库、阅读；P1 起就当前文档陪读

---

## 5. 远程访问梯子

目标：用**最低用户成本**到达「在另一台设备上批准与查看」，永不把流量强制送进 Kin 运营的云。

| 层级 | 用户成本 | 机制 |
|------|----------|------|
| 同一局域网 | 零 | 扫码，手机打开局域网 IP + token |
| 内嵌 tailnet + Funnel | 一次设备登录 | 二进制内 tsnet；可选 Funnel 给出可达 URL |
| 用户自己的 tailnet | 已有 Tailscale 的人 | 以节点加入用户的 tailnet |
| 用户自己的隧道 | 高级 | 自备 frp / Cloudflare Tunnel 等；文档化，非必须 |

**明确不做（除非未来 traction 证明必要，且仍保持可选）：** OpenKin 运营的中继，或把 OpenKin 运营的消息总线作为唯一路径。厂商 remote control 可以继续存在；Kin 提供**不经过该厂商**的那条路径。

Artifacts 的多端阅读走用户自己的 Hub 或 daemon，而不是 OpenKin 托管的网盘。

---

## 5b. 跨端会话

Hub 保存某个账户的会话，并以一个单调递增的游标把它们提供给每一台已登录设备。Node——运行 agent 的机器——**向外**连接 Hub，因此处在 NAT 之后的笔记本既不需要入站端口，也不需要 tailnet。

三条规则让这件事保持简单，而它们就是整个设计：

1. **会话只追加。** 一个写入者（Node）、一个顺序，由 Hub 分配。客户端从游标重放。没有合并步骤，也没有 CRDT，因为两个写入者永远不会编辑同一份会话。
2. **离线写入在本地排队。** 断线时写下的消息立刻显示，重连后发出；Hub 在它到达时分配位置。
3. **密钥不离开持有它的机器。** Provider API key、agent OAuth token 和 `~/.kin/secrets/` 都不同步。Hub 承载的是能力元数据，不是凭据。

端到端加密与冲突解决**不**在提供之列。见 [ADR 0022](./docs/adr/0022-hub-node-multi-device-sessions.md)。

账户的存在，是为了让第二台设备能看到第一台设备的工作。Hub 默认只有一个所有者；向他人开放注册需要先按账户隔离任务、产物与实时事件流，而这一点尚未实现。

---

## 6. 实现快照

当前选择；随证据可变。唯一不变量：**UI 只通过 HTTP/WebSocket 与核心通信** —— 跨语言边界绝不做进程内绑定。

**Agent 平台实现状态（2026-09）：** 当前 M1 本地切片已经交付自动路由，
包括确定性的复杂度分类、自适应阶段、质量 floor、同 agent 的
Provider/模型 fallback，以及可审计的路由决策。Routine 在产品层没有定义
数量上限；分页、搜索、受限后台并发、错过运行策略和 backlog 健康指标已经
纳入当前契约。Quota wait 是持久化工作：有 reset 的等待、未知 reset 探测、
事务 claim 和重启恢复都写入 durable state，不依赖用户保持页面打开。现有
`approve-mcp` 命令是受管 Worker 的内部、按任务运行的审批/生命周期桥接，
不是公共 OpenKin 控制面 MCP Server；公共 MCP 调用必须复用与 REST 相同的
任务、审批、凭据、scope 和审计服务。

| 层 | 选型 |
|----|------|
| Daemon | Go，单静态二进制；纯 Go SQLite（无 CGO）；内嵌 Web 控制台；内建 tsnet |
| 桌面壳 | Electron；daemon 作为受管 sidecar；托盘、原生通知批确认、自动更新 |
| 本地终端 | 属于拥有工作区的那台机器，不属于看它的客户端；输出是会话流上的一个 item，所以任何控制台都能渲染。每条终端路由都需要那台机器的操作者显式开启（默认关，且绝不由 Hub 凭据或账户角色隐含授予）——见 ADR 0004 |
| 任务工作区 | Task 可跨越零个或多个 Kin 自有工作区代际；支持延迟提升的适配器在已发布任务续聊时先以只读方式使用当前源检出，并在首次请求写入时自动创建新代际；最终 diff 按代际保持不可变且可寻址 |
| UI | React + Tailwind 一套代码，Electron 窗口与手机 Web 共用 |
| API 契约 | 检入仓库的 OpenAPI 是任务/审批/用户问题 live-resource 子域的单一来源，不覆盖完整 HTTP API。TypeScript 类型由其生成，CI 仅校验生成物漂移；Go handler 仍为手写，服务端一致性校验与其他端点覆盖暂缓。 |
| 分发 | 桌面 .dmg / .exe 双击；headless 机器 `curl \| sh` 或 brew |
| Artifacts 真源 | 用户数据目录下的文件树 + SQLite 元数据索引（实现阶段再钉路径） |

---

## 7. 对外路线图主题

只谈主题，不排日历。细节会变；价值顺序不应乱。

1. **Watch** — 包住一个 agent，本地控制台看流式进度
2. **Approve** — 桌面与手机批确认，全程审计
3. **Reach** — 远程梯子、扫码上手
4. **Track** — 按任务、按 Provider 的费用
5. **Artifacts** — 可读产物入库与阅读器；P1 陪读侧栏（[TODO](./docs/TODO.md) · [ADR 0003](./docs/adr/0003-artifacts-and-reader.md)）
6. **Follow** — 你自己运行的 Hub、一个账户，以及每台设备上同一批会话（[ADR 0022](./docs/adr/0022-hub-node-multi-device-sessions.md)）
7. **Live in it** — 打磨到维护者把每天的 agent 工作都跑在 Kin 里

---

## 8. 开放开发

公开边界与邀请节奏：[docs/OPEN_DEVELOPMENT.md](./docs/OPEN_DEVELOPMENT.md)。

有代码后的开源核心承诺：daemon、适配层、任务引擎、权限与审计、费用记账、控制台 UI、导入导出、本地模式，**以及 Hub**——**不**强迫绑定厂商云。Artifacts 同样开源：用户可见的数据面最值得被看到。

---

## 9. 摘要

Kin 是 **self-hosted 的 agent 控制台**：一个地方派发、监控、批准跨厂商的 agent 工作——在你自己机器上，或你自己的 Hub 上；会话中的可读产物经 Artifacts 留下，可在任意设备上重新打开。

> Kin should grow with the user, without owning the user.
