# Kin 系统设计

[English](./SYSTEM_DESIGN.md)

**状态：** Draft v0.3 — 方向说明，不是 API 合同
**依据：** [PRINCIPLE.zh.md](./PRINCIPLE.zh.md) · [English](./PRINCIPLE.md) — §12 控制台优先；v0.3 起在记忆之前增加 Artifacts 切片（见 §2、§7）
**主张：** Your agent. Your memory. Any model.

探索性草稿与实现日记不放在本仓库。本文是**对外**架构快照：帮助判断 Kin 是否适合你，而不是内部工作备忘录。

---

## 1. 总览

```text
用户拥有的 Kin Core（local-first daemon）
  ├── Agent 插件注册表            ← 编译期插件（Kin / Claude Code / Codex …）；host 可互换
  ├── Agent 适配层               ← 各插件的进程 runner 与归一化事件
  ├── 任务引擎 + 确认            ← 派发、监控、批准、审计
  ├── Provider / 费用层          ← 按任务、按模型的用量与花费
  ├── 远程访问（梯子）           ← 局域网 → tailnet / Funnel；绝不做 Kin 云
  ├── Artifacts（近端）          ← 会话可读产物入库、阅读器；多端读同一 daemon
  ├── Identity + Memory（v2）    ← 连续主体、可治理记忆（可从 Artifacts 提炼）
  └── Client Shells              ← 桌面 App + 任意设备的 Web 控制台
```

**硬约束**（来自原则）：

| 约束 | 含义 |
|------|------|
| 用户拥有 | 不需要 Kin 账户；可导出 / 删除 / 自托管 |
| Local-first | 设备是主本；云仅在明确启用时出现 |
| 模型无关 | Provider 特性不拥有身份与记忆 |
| 权限渐进 | 外部影响需可授权、可审计 |
| 默认做小 | 可选层是以后的事，不是 v1 实体（[§5.11](./PRINCIPLE.zh.md)） |

**定位。** 两家厂商都已提供远程控制：Claude Code 的 Remote Control 把每条消息经由 Anthropic 云中继；Codex 的设备控制通过 OpenAI 账号同步状态，且宿主机必须运行其桌面 App。结构上都是单厂商、厂商云居中。Kin 是跨 agent、self-hosted 的另一条路：**在你自己的网络上，用一个控制台管理你所有的 agent。**

---

## 2. 先交付什么（MVP = agent 控制台）

切入点：**在任何设备上派发、监控、批准 agent 任务** —— self-hosted、跨 agent、流量不经过任何 agent 厂商。

**MVP 范围内**

- Kin daemon 通过**适配器**包住外部 coding agent：Claude Code 与 Codex 为一等公民，通用 PTY 兜底任意 CLI
- 任务生命周期：派发 / 流式进度 / 取消 / 历史
- **确认收件箱**：agent 的权限请求推送到桌面与手机，每次决定都有审计记录
- 费用透明：按任务、按 Provider 的 token 与花费
- 远程访问梯子（§5）：局域网扫码 → 内嵌 tailnet + Funnel → 完整 tailnet
- 导出；核心使用不需要任何 Kin 账户

**MVP 之后、Memory 之前的近端切片——Artifacts**

真实痛点：agent 常被用来写主题学习资料（Markdown / HTML），用户却要手动下载、难整理、与源会话脱节、多端阅读麻烦。
**Artifacts** 把会话中的**可读交付物**收成本地库，保留与源任务的关联，并在控制台提供阅读器；多端通过已有远程梯子访问同一 daemon，不把 Kin 做成内容云。
分期与验收见 [docs/TODO.md](./docs/TODO.md)；决策见 [docs/adr/0003-artifacts-and-reader.md](./docs/adr/0003-artifacts-and-reader.md)。

- **P0** — 捕获（提议入库）· 本地文件真源 + 索引 · 库列表 · MD/沙箱 HTML 阅读 · 跳转源任务
- **P1** — 阅读器陪读侧栏（选区解释 / 出题 / 章节摘要）· 按 `artifact_id` 续聊 · 标签与检索

**明确后置——或永不做**

- 可治理记忆 + 身份 —— v2 故事（「Kin 跨 agent 越用越懂你」）；§3 中语义不变；**可从 Artifacts 提炼，但不与产物库混成同一对象**
- 完整 LLM Wiki / 第二大脑式 PKM —— 不在 Artifacts 之前抢主路径
- Kin 自研 code agent —— **永不**；适配器负责监督，不做重新实现
- 原生移动 App —— 基于同一 API 的快速跟进；先 Web 控制台（App Store 审核周期不能卡住 MVP 迭代）
- Kin 托管中继 / 内容云 —— 只有 traction 需要时才考虑中继；**产物同步不作 Kin 云**
- 完整同步产品、多用户、长期 Routine、自动模型路由

**关于 PRINCIPLE §12 的说明。** 本版重排了 MVP：控制台先于对话/记忆（§12 P1）交付。理由：对话已经发生在 Kin 所监督的 agent 内部；未被满足的需求——两家厂商先后推出远程控制即是验证——是「没有厂商居中的跨 agent 监督」。PRINCIPLE §12/§13 已同步更新（2026-07）。
**2026-07-17：** 在控制台 MVP 与 Remember（v2）之间插入 **Artifacts** 近端主题（学习资料/可读产物），仍遵守 §5.11：先做书架与阅读，再做记忆治理。

---

## 3. 概念模型（稳定语义）

即使用户只先看到控制台，下列名词的含义在后续版本中保持稳定。

| 概念 | 含义 |
|------|------|
| **Kin** | 用户拥有的主体；不是某一个模型，也不是某一个聊天窗口 |
| **任务** | 一次有目标的 agent 工作单元（派发、流式输出、确认、结果） |
| **适配器** | 把外部 agent CLI 接到统一的任务 / 事件 / 确认接口 |
| **确认** | 在产生外部影响前的人工决定；记入审计 |
| **费用记录** | 任务与 Provider 上的 token 与花费；本地价格表；每 agent 每日用量上限（仅展示） |
| **Provider 配置** | 端点与能力；密钥在系统密钥体系，不进日志 |
| **Artifact**（近端） | 会话可读交付物（md/html/…）；文件为真源；元数据含来源任务与状态（`proposed|saved|archived`） |
| **Export bundle** | 可版本化的带走包（**不含**密钥；**含** artifacts 目录约定） |
| **Identity / Profile**（v2） | 结构化的「Kin 是谁、如何行事」 |
| **Memory**（v2） | 带类型、来源、置信度、确认态的可治理条目；推断 ≠ 用户事实 |

用户应感知的记忆路径（v2）：**保存 · 建议 · 确认/拒绝 · 编辑/删除**。
用户应感知的产物路径（近端）：**提议入库 · 确认/忽略 · 阅读 ·（P1）陪读 · 可选提炼到 Memory**。

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
| Artifacts（近端） | 捕获、索引、库、阅读器；P1 陪读线程；HTML 沙箱 |
| 远程访问 | §5 的梯子；绝不是必需的 Kin 云 |
| 控制台 UI | 桌面壳与任意设备 Web 共用同一套 UI |
| Identity（v2） | 偏好、边界、跨模型/设备一致性 |
| Memory（v2） | 可治理记忆的全生命周期（含冲突与导出）；可从 Artifacts 提炼 |
| Store / Export | 本地持久化与用户拥有的备份（含 artifacts 文件树） |

用户应感知的主路径：

1. **Dispatch** — 选 agent 与工作目录，提交任务
2. **Watch** — 流式进度与费用
3. **Approve** — 从任意已连接设备处理确认
4. **Review** — 历史、审计、花费
5. **Read / Artifacts**（近端） — 将会话交付物入库、阅读；P1 起就当前文档陪读
6. **Remember**（v2） — 跨 agent、跨模型延续的 Profile + 可治理记忆

---

## 5. 远程访问梯子

目标：用**最低用户成本**到达「在另一台设备上批准与查看」，永不把流量强制送进 Kin 运营的云。

| 层级 | 用户成本 | 机制 |
|------|----------|------|
| 同一局域网 | 零 | 扫码，手机打开局域网 IP + token |
| 内嵌 tailnet + Funnel | 一次设备登录 | 二进制内 tsnet；可选 Funnel 给出可达 URL |
| 用户自己的 tailnet | 已有 Tailscale 的人 | 以节点加入用户的 tailnet |
| 用户自己的隧道 | 高级 | 自备 frp / Cloudflare Tunnel 等；文档化，非必须 |

**明确不做（除非未来 traction 证明必要，且仍保持可选）：** Kin 账号中继、Kin 运营的消息总线作为唯一路径。厂商 remote control 可以继续存在；Kin 提供**不经过该厂商**的那条路径。

Artifacts 的多端阅读走同一梯子：**手机打开的是你的 daemon 上的库**，而不是 Kin 托管的网盘。

---

## 6. 实现快照

当前选择；随证据可变。唯一不变量：**UI 只通过 HTTP/WebSocket 与核心通信** —— 跨语言边界绝不做进程内绑定。

| 层 | 选型 |
|----|------|
| Daemon | Go，单静态二进制；纯 Go SQLite（无 CGO）；内嵌 Web 控制台；内建 tsnet |
| 桌面壳 | Electron；daemon 作为受管 sidecar；托盘、原生通知批确认、自动更新 |
| 本地终端 | 仅 Electron 主窗口；临时 PTY 会话使用同时校验 Kin token 与真实 loopback TCP 对端的 HTTP/WebSocket 路由，绝不经局域网、Tailnet 或 Funnel 暴露 |
| 任务工作区 | 干净 Git 任务默认使用 Kin 自有 worktree；回合 checkpoint 使用可删除的 Kin 私有 Git 对象；非 Git/脏工作区在 auto 模式下仍为 shared |
| UI | React + Tailwind 一套代码，Electron 窗口与手机 Web 共用 |
| API 契约 | OpenAPI 单一来源；代码生成 Go handler 与 TS 类型 |
| 分发 | 桌面 .dmg / .exe 双击；headless 机器 `curl \| sh` 或 brew |
| Artifacts 真源 | 用户数据目录下的文件树 + SQLite 元数据索引（实现阶段再钉路径） |

---

## 7. 对外路线图主题

只谈主题，不排日历。细节会变；价值顺序不应乱。

1. **Watch** — 包住一个 agent，本地控制台看流式进度
2. **Approve** — 桌面与手机批确认，全程审计
3. **Reach** — 远程梯子、扫码上手
4. **Track** — 按任务、按 Provider 的费用
5. **Artifacts**（近端） — 可读产物入库与阅读器；P1 陪读侧栏（[TODO](./docs/TODO.md) · [ADR 0003](./docs/adr/0003-artifacts-and-reader.md)）
6. **Remember**（v2） — 跨 agent、跨模型延续的 Profile + 可治理记忆
7. **Live in it** — 打磨到维护者把每天的 agent 工作都跑在 Kin 里

---

## 8. 开放开发

公开边界与邀请节奏：[docs/OPEN_DEVELOPMENT.md](./docs/OPEN_DEVELOPMENT.md)。

有代码后的开源核心承诺：daemon、适配层、任务引擎、权限与审计、费用记账、控制台 UI、导入导出、本地模式——**不**强迫绑定厂商云。Artifacts 与记忆层落地时同样开源：用户可见的数据面最值得被看到。

---

## 9. 摘要

Kin 是 **self-hosted 的 agent 控制台，并将生长为个人 Agent 核心**：在你自己的网络上，一个地方派发、监控、批准跨厂商的 agent 工作；会话中的可读产物经 Artifacts 留下并可多端阅读；身份与记忆随后跨模型延续。

> Kin should grow with the user, without owning the user.
