# 对标 LODY：UI 与核心产品功能改造计划

> **一句话目标**：让 Kin 的日常主干路径达到或超过 LODY——以**本机实际使用到的** LODY 功能
> 为准，而不是以 LODY 的功能清单为准。
>
> 相关：`PRINCIPLE.md` §5.11 / §14 · `docs/plans/2026-10-22-mvp-milestones.md` ·
> `docs/plans/2026-10-23-hosted-mode.md` · `docs/plans/2026-10-23-docs-audit.md`

**状态**：已审阅，决策已定（§9）。待开工。

---

## 0. 三条前提

**第一，parity 的目标是「本机实际用到的 LODY」，不是「LODY 的全部」。**
LODY 是一个团队协作平台：CRDT 同步、E2EE、跨机器调度、编排状态机。这些是它的**平台**。
本机取证（§1）显示，你每天真正用的是一小撮东西，而 LODY 花最大力气建的编排层
在这台机器上**一次都没跑过**。按「小而美」和「先自己每天用起来」，把 LODY 的平台整个搬过来
是反向的。

**第二，「不确定就去看 LODY 的实现」这条现在能落到文件级。**
本机有 LODY 完整源码（132 篇 spec + 中英双份用户文档）。本文件凡写「参考 LODY」，
都标注具体路径。这条已经是 `PRINCIPLE.md` §14 的成文规则：

> Undecided? Go read a working implementation first. … **Matching it is the default;
> diverging needs a stated reason, not a preference.**

**第三，多设备一直在用，而且是主用法——这一点我第一版判断错了，已更正。**

> **更正记录**：本文件第一版根据本机取证得出「你在 LODY 里是纯单机使用」，**这是错的**。
> 实际情况：**手机端发起对话 → LODY 的托管 Hub → 在那台 Mac 上执行**。
>
> 取证为什么会漏掉：手机是**LODY 云侧的客户端**，不是这台机器上登记的配对设备。
> 本地状态目录里因此看不到任何 pairing / phone 痕迹，"1 个 machine、0 配对"是
> **只做本地取证**的必然盲区。事后看，漏掉的信号其实在数据里——`remote_cursors` 27 条、
> 峰值 38 个并发 session room，那些就是云同步的证据，是我把"本地没有配对记录"
> 过度解读成了"没用多设备"。

这条更正让结论变得更好，而不是更差：**OpenKin 的 Hub/Node 形状是对的**——
它就是 LODY「瘦客户端 → Hub → 执行机」这个形状的自托管版本。M0–M3 没有跑偏。

但有一件事没变，而且它才是重点：**你从手机和从桌面摸到的，是同一个会话体验。**
而这个体验层，恰恰是 Kin 最弱的一层（§2.2–§2.4）。
**多设备是通道，会话体验是通道里跑的东西。通道修好了，里面还是空的。**

---

## 1. 参考基线：本机 LODY 实测

取证来源：`~/.lody/` 的 Loro SQLite 存储、orchestration 库、PR 轮询库、per-turn diff store，
加上日志和三个 Electron profile。**下列数字均为实测。**

### 1.1 高强度使用 —— 必须对齐

| 能力 | 实测 | 含义 |
|---|---|---|
| **会话续接 resume** | **159 / 186 轮** | 续接是**默认路径**，不是边角功能 |
| **subagent 扇出** | **1,763 个 subagent task**，59 次 Agent 调用 | 使用强度最高的单一行为 |
| 思考过程 | 6,252 条 thought | claude 轮次 **100% `effort=high`** |
| 逐轮 diff | 79 轮带 diff，516 文件快照 / 329 路径 | 每轮改动都要看 |
| **PR 自动发现** | 18 个轮询目标 | 「跑完自动关联 PR」真在用 |
| 权限模式 | 4 档全在用（auto 62 / bypass 54 / full-access 28 / auto-review 22） | 需要可选且默认顺手 |
| 会话 + 语义标题 | 27 条，标题 100% 中文、12–33 字 | 标题自动生成 |

### 1.2 用过但零星 —— 对齐，不必做重

附件（15 图 + 3 文件）、会话间消息（3 轮）、dev server 预览 + 隧道（1 会话）、
iOS 模拟器控制（1 次）、消息队列（2 会话，均空）。

### 1.3 装了、一次没用过 —— **不进 parity 目标**

| 能力 | 实测 |
|---|---|
| 定时任务 | `schedules.sqlite` **0 条** |
| MCP server 配置 | 185 轮中 `mcpServerIds` 非空 **0 次** |
| Agent Roles | 185 轮中 `agentRoleId` 非空 **0 次** |
| Prompt shortcuts | 全库 **0 命中** |
| 编排 | `operations` / `inbox_results` 均 **0 行** |

> **这条推翻了「照 LODY 功能清单做」的做法。** LODY 最复杂的一层
> （`specs/session-orchestration.md` 的 Operation 状态机、Inbox v2、receipt 唤醒、16 跳委派链）
> 在本机零使用。

### 1.4 关于 LODY 的 spec 本身

**128 篇英文 spec 全部是 `Status: draft`，零篇 approved，零篇 outdated。**
且多篇自述未实现（`local-attachment-references.md`、`quick-tunnel-preview.md`、
`host-identity-keys.md`）；**E2EE 整套没有上线**（其 `packages/e2ee-core` README 与
`.agents/docs/e2ee-migration.md` 自述："The stack adds an inert public core… **E2EE has not shipped**"）。

**所以 LODY 的 spec 是意图，不是契约。** 拿它当 parity 清单会照抄一堆没上线的东西。

### 1.5 手机端（取证看不到，按你的说明补入）

§1.1–1.4 的数字全部来自**本机磁盘**。而你的主用法是
**手机端发起对话 → LODY 的托管 Hub → 在 `<mac-host>` 上执行**——
手机是 LODY 云侧的客户端，本地目录里因此不留痕迹。

补记这一点，是因为它决定了优先级：**手机不是"顺便也支持一下"的第二入口，是主入口。**

| | |
|---|---|
| 手机承担 | 发起对话、看进度、批准权限、看 diff / 结果 |
| Mac 承担 | 真正执行（agent 进程、文件、git） |
| Kin 的等价物 | 手机 → 你自己的 Hub（NAS）→ Node（`<mac-host>`）——**形状已经是对的** |

**待实测**：手机端的响应式控制台在真实机型上的表现（M4 自评"尚不可 dogfood"）。
这一项没有磁盘证据，只能靠实际用。

---

## 2. 现状差距

### 2.1 核心循环断在 diff 之后（最硬的缺口）

LODY 的推荐工作流（`site-docs/content/docs/zh/(guides)/workflow.mdx`）：

```
拆小需求 → 每会话一个 worktree 并行 → 看文件变更 / diff → 建 PR
        → 拉 PR 评论喂回 agent 修 → push → 触发下一轮 AI review → 归档
```

OpenKin 走到 **diff 就断了**。已核实：

- Go 侧**没有任何** GitHub 集成——`grep -rn "github" internal/api/*.go` 的命中全是 module import 路径。
- 没有 PR 创建 / PR 状态 / CI 状态 / PR 评论拉取的任何 endpoint。
- 控制台里唯一的 "PR" 字样是 routines 的一句示例文案。

**「每会话 = 一功能 = 一 PR」这个 LODY 骨架，Kin 缺了后半截。**

### 2.2 UI 结构差距（均已核实）

| | LODY | OpenKin |
|---|---|---|
| 会话多标签 | 有，可拖拽，URL 持有 active tab | **无** |
| Zen 模式 | `Cmd+.`，瞬态、不回写偏好 | **无**（全树 0 命中） |
| 右侧面板 | `files / changes / pr / browser / ios-simulator / side-session` + 动态 viewer | 只有 `changes / files` |
| 消息队列 | 工作期间悬在输入框上方，可拖拽 / 编辑 / Steer | **无 UI** |
| subagent | `SubagentTaskPanel`，进同一套渲染器 | **无渲染** |
| 权限提示 | **顶替输入框**，一次一个，Enter 不会误批 | 审批卡片，与输入框并存 |
| 对话栏宽 | 居中栏 ~800px 上限 | 拉满 |

### 2.3 设计系统差距

LODY 的 `packages/ui/src/tokens/RULES.md`（862 行）定义：**7 档间距**、
**6 档字号全部由一个基准字号推导**（默认 14px，Appearance 可选 12–16）、
6 级 elevation ladder、**「无边框」**（表面靠亮度台阶 + 阴影分离，连 border token 都不存在）、
2 套调色板。

OpenKin：`ui/src/index.css` 有 **89 个手写 CSS 变量** + Tailwind 3，表面靠
`--kin-hairline` 边框区分，没有语义层级。

> **这一项可以真正超过 LODY**，因为它自己的 spec 自曝漂移：
> `workspace-visual-hierarchy.md` 统计出 **164 个产品文案字号**（规则明写"产品文案不许用
> Tailwind 工具类字号"）和 **54 个 ink 分数对 3 档语义色**，且自述"什么都没有渲染验证过"。

### 2.4 工程质量差距

| 项 | 现状 | 影响 |
|---|---|---|
| 控制台组件测试 | **0 个**（vitest 跑 node 环境，无 jsdom） | 改 UI 没有回归网 |
| Lint | **完全没有**（无 ESLint / Prettier / lint script） | —— |
| 聊天代码高亮 | **无**，fenced block 渲染成裸 `<pre>` | 旁边就是 Monaco diff，对比刺眼 |
| 首屏 | 4.4 MB / 1.17 MB gzip，单一未分包 chunk | 移动端首屏 |
| 死代码 | 458 行（`Transcript.tsx` 等 4 文件） | —— |
| 桌面壳 | 2,784 行**无测试、无 CI**，未签名未公证 `.dmg` | —— |
| 中文文档 | `PRINCIPLE.zh.md` 里 **0 次「Lody」**；`SYSTEM_DESIGN.zh.md:161` 仍写账号隔离"尚未实现"（实际已上线） | 违反 AGENTS.md 中英对齐要求 |

### 2.5 Kin 已经领先、改造时不要丢

1. **账号隔离**（`store.ScopeForPrincipal` 单一规则、fail-closed，REST / MCP / SSE / WS / A2A 全覆盖）
   —— LODY 的 E2EE 生产里是**关掉的**。
2. **跨设备终端**：LODY 终端是**本地 unix socket**；Kin 的 ADR 0004 已决定做成跨设备会话流。
3. **审批 / 提问人闸**：`approvalbridge` + `approvemcp`，LODY 对等物更重。
4. **50,723 行 Go 测试**，行为式命名（`TestMemberMCPCannotReachAnotherAccountsTask`）。
5. **7 个 adapter + 真 ACP 客户端 + ~60 agent 发现目录**。

### 2.6 LODY 的工程实现：拿它的边界，不拿它的复杂度

你说「代码质量高于原来和 LODY」。后面这半句是有依据的——LODY 公开仓库约 **140 万行 TS**，
而且子系统是**单文件**：

| 文件 | 行数 |
|---|---|
| `packages/acp-extension-claude/src/acp-agent.ts` | 12,349 |
| `apps/cli/src/lib/message-handler.ts` | 10,413 |
| `apps/cli/src/session/session-execution-service.ts` | 8,494 |
| `packages/components/src/components/ai-gui/view.tsx` | 8,480 |
| `session-detail.tsx` | 7,306 |

外加：同一个能力在**三处**表达（ACP 协商的 `configOptions` + `packages/shared/src/ai.ts` 里
约 470 行硬编码的 per-agent 表 + 各扩展自己的定义）；8 个 submodule 停在 8 个不同的
core/SDK 版本；`packages/ignore` 无人引用而同一逻辑在别处被重新实现；5 个死掉的前端依赖。

**但它的「边界」设计得很好，这几条 Kin 应该拿：**

1. **一个进程拥有一台机器，且可发现、可解释**——host lease + `run/` 目录属主校验 +
   冲突时给出描述而不是静默回退。比端口探测或 pid 文件干净得多。
2. **本地通道拆成四条而不是一条多路复用**：control / probe / data plane / host lease。
   其文档的收尾原则是「**Two planes, not one**」——云侧房间状态永不当作本地房间健康上报。
   Kin 目前是一条 HTTP + SSE/WS。
3. **能力协商按特性、按版本**，且 wire name → DTO 在编译期绑定，UI 按能力分叉而不是按 provider 名字分叉。
   这是它 agent 层最好的一个想法。
4. **local-only 是被机器强制的，不是约定**：`null` 端口表示"该功能不存在"（显式请求就在边界处拒绝）、
   入口处清洗掉遗留 env、CI 跑一个脚本对真实 hosted 域名 fail。
5. **用和解（reconciliation）代替命令队列**做磁盘清理——直接消掉 ack 和顺序依赖，并把代价写下来。
6. **内容寻址的 turn-diff store**：FastCDC 分块 + SHA-256 去重 + 引用计数快照 + 单调 head proof
   防止迟到的旧写入把路径头回滚。
7. **进程 spawn 边界由脚本强制**（只允许一个模块 import `child_process`，CI 校验）。

**明确不拿的**：单文件子系统、三处表达的能力表、八个 submodule 各自 fork、
一个 3,000 行客户端里堆积的 per-provider 特例。

**落到哪个里程碑：**

| 拿过来的边界 | 落到 |
|---|---|
| 能力协商按特性按版本（替代按 provider 名分叉） | P4 |
| 内容寻址的 turn-diff store（支撑逐轮 diff 证据卡） | P2 |
| 「一个进程拥有一台机器」可发现可解释 | P5（Hub/Node 已有雏形，补冲突描述） |
| local-only 由 CI 强制（真实 hosted 域名 / 私有路径 fail） | P6 |
| 进程 spawn 边界由脚本强制 | P6 |

---

## 3. 目标对象模型

LODY 的心智模型（`site-docs/content/docs/zh/(core-concepts)/concepts.mdx`）：

```
工作区
├── 项目 / 仓库
│   └── 会话 = 一个任务 = 一段对话 = 一个分支 = 一个 worktree
│       ├── 轮次 = 一次 Agent 回复 + 它产生的 diff
│       ├── 侧边对话 / Fork
│       └── Pull Request
├── Agent Config   运行时 + 认证 + 执行机器
└── Agent Role     保存的预设（本机零使用，见 §1.3）
```

**Kin 不新增实体。** `docs/plans/2026-10-22-multi-device-session-architecture.md:32` 已拍板且结论正确：

> 要不要新增"会话"实体？——**不要。** Kin session = Task。

要做的是**对齐命名、补齐缺项**：

| LODY | Kin 对应 | 动作 |
|---|---|---|
| Session | `tasks` | 模型不动；**补 PR 关联** |
| Round | 一轮 adapter 进程 + events | 控制台按轮次聚合（`transcriptProjection` 已有基础） |
| Agent Config | `agent_providers` + 机器 | 已有 |
| Agent Role | routing profiles | **已有等价物，不照抄**（LODY 零使用） |
| Worktree / branch | `task_workspaces` generation | 已有，需在 UI 显式化 |
| Pull Request | **无** | **新增**（§2.1） |

**唯一的模型债**：`tasks.session_ref` 是单列全局原生 session id，只能在产生它的机器上续接。
计划里已列改成 `(device_id, agent_id, external_ref)` 三元组，`internal/task/engine.go:1521`
已在双写。**在「resume 是主路径」（159/186）的前提下，这件事的优先级高于原计划**——
续接错了每天都会踩。

---

## 4. UI 设计目标

### 4.1 屏幕地图

```
侧栏：新建会话 · 搜索（复用命令面板，不另造） · 收件箱
      └ Pinned → 本地项目（按机器分组）→ GitHub worktrees → Chats
      └ 页脚：工作区 / 帮助 / 归档 / 设置

会话视图：
  ┌──────────────────────────────────┬───────────────┐
  │ 顶栏：侧栏开关 │ 会话标签… │ 工具栏  │               │
  │ 对话（居中栏 ~800px，虚拟化）        │  右侧面板      │
  │   · 用户气泡 / agent 回复（无头像）  │  files        │
  │   · 活动分组：思考 + 工具调用        │  changes      │
  │   · 证据层：改动文件 / diff / PR     │  pr     ← 新  │
  │   · subagent 面板           ← 新  │  browser← 新  │
  │ 消息队列                    ← 新  │  terminal     │
  │ 权限提示（顶替输入框）         ← 改 │               │
  │ 输入框：运行配置 / @提及 / 附件     │               │
  └──────────────────────────────────┴───────────────┘
```

### 4.2 值得照抄的具体规格（均有 LODY 出处）

1. **一个关注点只有一个写者**。滚动只有一个引擎；权限提示**顶替**输入框而非叠加；
   信息条只有一个 stage。（`specs/conversation-scroll.md`）
2. **权限提示契约**（`specs/permission-requests.md`）：用 provider 原话，不改写选项名；
   标出建议项，且 **"always" 永远不作为建议**；**Enter 在提示本身上不批准任何事**
   （防止本该发给消息的 Enter 误批）；Escape 只拒绝一次；提示里保留 **Stop 出口**。
3. **发送时为回复预留空白，用户一旦上滚就永久放弃那块空白**。极小的实现，极好的手感。
4. **「滚动到底」按钮兼任工作指示器**：下方有实时输出时转圈，等待 / 空闲是箭头，hover 露出箭头。
5. **排版纪律**：每个字号必须是一个语义角色；**相邻层级必须差两档**（差 1px 就必须同时差
   ink 或字重）；**每行只花一次强调**。（`specs/workspace-visual-hierarchy.md`）
6. **表现状态是推导的，不回写偏好**（zen / compact 从偏好算出，不存）。

### 4.3 能明显做得比 LODY 好的地方

- **会话栏宽**：LODY 硬卡 ~800px 且没有宽度控制（`conversationWideModeAtom` 是藏着的）。Kin 直接给显式档位。
- **一套设计系统**：LODY 两套并行迁移中，Kin 一开始就只有一套。
- **令牌不漂移**：像 LODY 的 token gallery 那样，用测试断言「没有被任何样例呈现的 token 就是缺口」。
- **布局家族**：LODY 有独立 Capacitor 应用 **加上** 桌面端的 "compact desktop"，**三套**要一致。
  Kin 只保留**两套**（桌面 / 移动）。

---

## 5. 技术决定：先问正确形状，再决定复用

**判断的单位是「这一层的第一性原理形状是什么」，不是「现有代码好不好」。**
现有实现只在**碰巧就是正确形状**时才复用——不是因为它已经在那里。
完整的施工原则见 §10，那里有你 2026-10-23 的原话。

按这个标准过一遍现有的每一层：

| 层 | 判断 | 依据 |
|---|---|---|
| Go 核心（store / task / adapter / auth / hub / node / workspace） | **形状正确，复用 + 加固** | 单写者 Hub + 追加日志 + 游标，正是 append-only 会话的正确形状；45 包全绿、真机 dogfood 过 |
| **控制台表现层** | **形状不对，重做** | 89 个手写变量 + 边框分离 + 单页无标签，撑不起 §4 的屏幕地图；质量也是最弱处（§2.3 / §2.4） |
| 控制台数据层（`liveResources` / `transcriptProjection`） | **形状正确，复用 + 补测试** | 「游标是真相、实时只是加速器」是对的；`transcriptProjection` 有 1,939 行测试 |
| `tasks.session_ref` 单列原生 id | **形状不对，换掉** | 原生 session id 是设备本地的，单列全局存储本身就错；换成 `(device_id, agent_id, external_ref)`（P4） |
| 桌面壳 | 形状正确，**补齐**（测试 / CI / 签名） | 2,784 行真实工程，只是没有网 |
| `web/dist` 嵌入流程 | 复用 | —— |

**注意最后两条的差别**：Go 核心是「因为正确所以复用」，`session_ref` 是「因为错误所以换掉」——
两者都不是「因为已经写了所以留着」。这就是 §10 那条原则的可操作形式。

**支撑"重做表现层"的实测数据**（不是保守估计）：
`go build ./...` + `go test ./...` —— **45 个包全绿、0 失败、exit 0**；1,170 个测试函数、
50,723 行测试；全树**只有 1 处** TODO（且是被显式拒绝的 eval 分支）；控制台 44k 行里
0 个 TODO / 占位符。**这些是复用的理由，不是不重做的理由**——重做的是表现层，不是它们。

---

## 6. 里程碑

每个里程碑以**一句话真实验收场景**结束（与 `2026-10-22-mvp-milestones.md` 一致）。

### P0 — 核心循环闭合：会话 → diff → PR

| | |
|---|---|
| 交付 | GitHub 集成：PR 创建（带完整描述与实现方案）、PR 状态、CI 状态、PR 评论拉取、评论回喂 agent、「自动发现本会话的 PR」、归档联动 |
| 验收 | 会话里改完代码，**点一下建出 PR；然后说「拉 PR 评论、判断对错、对的修掉」**，agent 拉取评论并 push 修复 commit |
| 依赖 | 无 |
| 大小 | M |

> 排第一的理由：这是唯一一个「不做就永远只是半个产品」的缺口（§2.1）。
> 参考 LODY：`specs/local-github-pr-observation.md`（无账号也能看 PR + CI）、
> `specs/github-command-credentials.md`（凭据选择顺序）。

### P1 — 设计系统重建

| | |
|---|---|
| 交付 | 令牌层（间距阶梯 / 由基准推导的字号阶梯 / elevation ladder / 语义色）；「无边框」表面分离；token gallery + 缺口测试；ESLint + Prettier 接入 CI |
| 验收 | **删掉 `ui/src/index.css` 里全部 89 个手写变量**，控制台视觉不回退；gallery 测试能报出未被呈现的 token |
| 依赖 | 无 |
| 大小 | M |

### P2 — 会话视图升级

| | |
|---|---|
| 交付 | 居中对话栏（含显式宽度档位）；活动分组（思考 + 工具调用折叠为一行摘要）；subagent 面板；逐轮 diff 证据卡；聊天内代码高亮；消息队列；权限提示顶替输入框 |
| 验收 | **连续用一周**，不再需要打开终端看 diff；subagent 跑起来时不用猜它在干什么 |
| 依赖 | P1 |
| 大小 | L |

### P3 — 会话外壳：多标签 + 右侧面板

| | |
|---|---|
| 交付 | 会话多标签（可拖拽、URL 持有 active tab）；右侧面板扩到 `files / changes / pr / terminal`；zen 模式（`Cmd+.`）；命令面板补全 |
| 验收 | **同时开 3 个会话**，各自标签之间切换不丢状态；`Cmd+.` 能一键清屏 |
| 依赖 | P0（pr 面板）、P2 |
| 大小 | M |

### P3b — 手机端（你的主入口）

| | |
|---|---|
| 交付 | 会话列表按 Today / This week / Older 聚合（现在是"一堵 100 行的墙"）；会话视图的手机布局；审批收件箱空状态；推送通知 + 从通知直接进会话；设置页收口 |
| 验收 | **一整天只用手机**：从通知进会话 → 发指令 → Mac 上跑起来 → 手机上批准权限 → 看到 diff → 建 PR。全程不碰电脑 |
| 依赖 | P0、P2、P3 |
| 大小 | L |

> 为什么单独列：你的日常就是「手机发起 → Mac 执行」（§0 第三条），
> 而 `docs/plans/2026-10-23-m4-handoff.md` 里 M4 的自评是"手机控制台尚不可 dogfood"。
> **这是当前离你最近、却最不可用的一块。**
> 参考 LODY：`specs/mobile-workspace-dock.md`（滚动方向最小化导航、14px 方向阈值、
> 44×44 触摸目标）、`specs/message-queue-touch-actions.md`。

### P4 — 续接正确性（模型债）

| | |
|---|---|
| 交付 | `tasks.session_ref` → `(device_id, agent_id, external_ref)` 三元组；7 个 adapter 一次性改到位；跨设备续接语义明确 |
| 验收 | **在 A 机开始的会话，从 B 机继续**，不会静默重开上下文 |
| 依赖 | P0 |
| 大小 | M |

> 为什么提到这里：resume 占 159/186 轮（§1.1）。参考 LODY：
> `specs/acp-startup-model.md`（会话自己的 model 优先于全局配置）、
> `specs/imported-acp-session-identity.md`。

### P5 — 托管模式收口

| | |
|---|---|
| 交付 | 注册入口；member 的 `cwd` 收口（白名单 / 只能选已有 project）；跨设备会话同步点亮 |
| 验收 | **第二个人能自己注册并登录**，且看不到、也读不到持有人的任何东西 |
| 依赖 | P0–P4 |
| 大小 | M |

### P6 — 工程质量补齐

| | |
|---|---|
| 交付 | jsdom + Testing Library，表现层关键路径有渲染测试；首屏分包（目标 < 1 MB gzip）；删 458 行死代码；桌面壳接入 CI；中英文档对齐 |
| 验收 | **改坏一个组件，测试会红** |
| 依赖 | P1 |
| 大小 | M |

---

## 7. 明确不做

按 §1.3 的实测 + §0 的原则，以下**不做 parity**：

| 不做 | 理由 |
|---|---|
| LODY 的编排层（Operation 状态机 / Inbox v2 / 16 跳委派链 / receipt 唤醒） | 本机零使用；Kin 已有 `@mention` 扇出（`internal/task/orchestrate.go`）覆盖实际需求 |
| Agent Roles | 本机 185 轮零使用；Kin 的 routing profiles 是等价物 |
| Prompt shortcuts | 本机零命中 |
| CRDT / Loro / E2EE | 与 Kin 的单写者 Hub 设计冲突；LODY 自己也没上线（§1.4） |
| 定时任务 parity 扩展 | 本机 0 条；Kin 已有 routines，保留但不投入 |
| MCP server 配置界面的 parity | 本机 185 轮零使用；Kin 的 connectors 保留但不投入 |
| 团队 / 多人协作（共享会话、邀请、成员可见性） | 按 `PRINCIPLE.md` §5.11：日常主干路径还没做完，不预支 |
| LODY 特有的浏览器面板 + 元素级标注 | 本机只用过 1 次（§1.2）；Kin 已有 `internal/browserworker` 保留待用，不进本轮 |
| iOS 模拟器控制 | 本机 1 次，且是 LODY 特有形态 |

---

## 8. 风险与未验证项

| 风险 | 说明 | 应对 |
|---|---|---|
| **P2 是大头** | 会话视图升级是本次最大的一块，容易做成"改到一半两种风格并存" | 按 LODY 的做法先立设计系统（P1），P2 只在新区建组件，旧组件逐个替换而非并存 |
| **GitHub 集成有外部依赖** | 需要 OAuth App / token，验证成本高 | 先做**只读**（PR 状态 + CI + 评论拉取，参考 LODY 的 `local-github-pr-observation.md`：无账号也能看），再做创建 |
| **PR 评论回喂需要 prompt 而非硬编码** | 按 `PRINCIPLE.md` §5.5，这是"prompt 能表达的事" | **不做**专用状态机；做成"把评论作为上下文注入当前会话" |
| **手机是主入口，但手机体验最差** | 你的日常是「手机发起 → Mac 执行」。而 `docs/plans/2026-10-23-m4-handoff.md` 里 M4 的自评是「sessions 列表是一堵 100 行的墙、settings 看着没做完、inbox 空状态撑不住」 | 并入 P2/P3：会话视图与外壳**按手机优先重做**，桌面是放大版而不是反过来 |
| **中文文档欠账会持续** | `PRINCIPLE.zh.md` 零次「Lody」等 | 归入 P6，但期间新增文档必须中英同步 |

**未验证项（不要当成已解决）**：
- LODY 的 `specs/` 全部 draft，其中若干自述未实现——**本文件引用它们时只当作设计参考，不当作行为保证**。
- 本机取证对**云侧行为不可见**（§0 第三条已因此错判过一次）。凡涉及"LODY 在手机上怎么表现"的
  结论，本文件都没有实测支撑，只引用了它的文档与源码。

---

## 9. 已定的决策

| # | 问题 | 决定 |
|---|---|---|
| 1 | 多设备在产品里的位置 | **保持一等公民**。它在 LODY 里是主用法（§0 第三条），Kin 的 Hub/Node 就是它的自托管版本。排期上会话体验优先，但不再讨论"要不要多设备" |
| 2 | P3 右侧面板要不要 `browser` | **本轮不做**。只做 `files / changes / pr / terminal`；`internal/browserworker` 保留待用 |
| 3 | P0 的 GitHub 集成用哪种凭据 | **复用本机已有的 `gh` / git 凭据**，不引入 OAuth App。与 LODY 的 `specs/github-command-credentials.md` 一致（本地项目及其 worktree 保留原生认证，不装托管包装器） |

---

## 10. 施工原则（你 2026-10-23 的原话）

> 不要被已经实现的东西束缚去做兼容。能够复用的当然尽量复用，但是我的要求是
> **不要被之前的实现束缚，从第一性原理出发**。

这条比"改还是重写"更准确，所以它替代了原本的二选一框架：

- **判断单位是"这一层的第一性原理形状是什么"，不是"现有代码好不好"。**
  现有实现只在**碰巧就是正确形状**时才复用——不是因为它在那里。
- **"不能破坏已有行为"不是约束。** `tasks.session_ref` 这类兼容投影可以直接换掉
  （已是既定前提，见 `2026-10-22-mvp-milestones.md` §0）。
- **做得对的要留住**，但留住它的理由是它正确，不是它已存在（§2.5 那五条）。
- 落到每个里程碑：动手前先写清"这一层正确的形状是什么"，
  再决定复用哪些、替换哪些。**写不出来就说明还没想清楚，不要开工。**

---

## 11. 下一步

按 P0 → P6 顺序开工，每个里程碑走完整的 Feature completion gate（高模型 review →
修 blocker/major → 提交 → 合入 main → 桌面重建），并且**每个里程碑结束时给一个可安装的版本**。
