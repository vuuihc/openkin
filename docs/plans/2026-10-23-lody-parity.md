# 对标 LODY：UI 与核心产品功能改造计划

> **一句话目标**：让 Kin 的日常主干路径达到或超过 LODY——以**本机实际使用到的** LODY 功能
> 为准，而不是以 LODY 的功能清单为准。
>
> 相关：`PRINCIPLE.md` §5.11 / §14 · `docs/plans/2026-10-22-mvp-milestones.md` ·
> `docs/plans/2026-10-23-hosted-mode.md` · `docs/plans/2026-10-23-docs-audit.md` ·
> `docs/plans/2026-10-23-p0-github-layer.md`（P0 这一层的形状，§10 要求的产物）

**状态**：已审阅，决策已定（§9）。开工中——

- **P0-入口 已实现，本机验收通过**（形状与证据：`2026-10-24-p0-entry.md`）。新增的唯一
  机制是「Hub 向 Node 提问」（一个信封 + 一张封闭的方法表），手机上是两条路径：选机器 →
  浏览文件夹 → 分支，以及 `owner/repo` + 分支的快捷方式。**已验的是本机三进程**（Hub +
  Node + 手机宽度的控制台，配对身份，390×844）；`go test ./...` 与控制台测试全绿
  （唯一一条红是既有的 `internal/adapter/droid` flake，本分支一个文件都没碰它，单独跑是绿的）。
  完成门的两轮评审都是**无 blocker、无 major**；第二轮两片给出的 nit，逐条处置（当场修的
  与明知未修的）都记在 `2026-10-24-p0-entry.md`「复核结论」。**未验的是 NAS 上那个 Hub**——§7「真实验收在手机上」
  指的是它，而 NAS 部署不在本次自动授权里。
- **2026-10-24 重排（依据你口述的手机体验）**：新增 **P0-入口**（手机新开对话：
  选机器 + 选文件夹，以及"选 GitHub 项目 + 分支"的快捷方式），排在 P0 之前；
  **P0c（评论回喂）暂缓**。判据见 §0 第四条，差距核实见 §2.7。
- **P0a 已完成**（§6 P0 下的分步）：只读 PR 观测层 + 两个 endpoint + 只读控制台面板。
  在 1440×900 和 390×844 两个宽度下实测过（含"已知 PR + 本次查询失败"那条路径，
  见 `2026-10-23-p0-github-layer.md` §10 验收第 4 条）。
- **手机首屏体积已修**（见 §P3b 下"开工前已核实的三件事"第 1 条）：
  入口 chunk gzip 1,162.87 kB → 299.59 kB。
- **P0b（publish）多了一个前置条件**：垫片不只挡 `gh`，`git` 也被挡了。见
  `2026-10-23-p0-github-layer.md` §3 F3——不先解决，`git push` 会经过第三方凭据代理。
- P0c（评论回喂）**暂缓**——理由见 §9 决策 4。

---

## 0. 四条前提

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

**第四，取舍判据（2026-10-24 新增）：这个功能替用户删掉了哪一个「必须坐到电脑前才能做的决定」？**

起因是你的一句话，它同时是本次重排的依据和验收口径：

> 我其实一直是在手机上用的 LODY，能感受到的只有在开会话的时候能直接选择 github
> 项目名称和分支，省了自己 clone 到本地然后选择文件夹开始会话，这个确实是有用的，
> 其他的功能到目前都还没用到，所以其他的设计可能要暂缓并思考怎么让用户直观感受到。

这条判据比「LODY 有所以要有」硬，也比「我觉得有用」硬：

- **频率决定感知。** 开工入口每次会话都要付一次；diff / PR / 评论只在特定时刻才付。
  所以你会主动说出前者，想不起后者——**P0-入口 排到最前就是这么来的**。
- **答不出来 = 不做。** 一个机制如果删不掉任何「坐电脑前的决定」，它的收益就只剩
  「少点一次」，那不值得为它维护状态机。
- **「被看见」的最小形态是「这个动作本身能在手机上完成」**，不是给每个不可见机制配一条
  状态条。把后台机制都配上 UI 提示，产品会变成仪表盘。

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

**你实际感知到的手机价值点只有一个**（2026-10-24 口述）：开会话时直接选 GitHub 项目 + 分支，
省掉「先 clone 到本地、再选文件夹」。其余手机功能「到目前都还没用到」。
这是本节唯一的一手证据，也是 §0 第四条判据的来源、P0-入口 排在最前的直接依据。

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

OpenKin 走到 **diff 就断了**。**本节已按 P0a 的落地修正**（原判断"Go 侧没有任何
GitHub 集成"在 P0a 之后不再成立）：

- Go 侧**已经有只读的 PR 观测层**：`internal/github/`，暴露
  `GET /api/tasks/{id}/pr` 与 `POST /api/tasks/{id}/pr/refresh`
  （见 `2026-10-23-p0-github-layer.md`）。凭证只从本机 `gh` 或匿名公开读取得，
  Kin 自己不持有 token。
- **所以缺口不再是"读不到"，而是"写不了"**：没有 PR 创建（P0b），没有 PR 评论
  拉回会话（P0c）。
- 控制台侧**仍未动**：唯一的 "PR" 字样还是 routines 的一句示例文案，面板待做。

**「每会话 = 一功能 = 一 PR」这个 LODY 骨架，Kin 现在有了读的一半，写的一半还缺。**

还有第三处断点，在链的**入口**：手机上开一个新会话，今天要求你先知道那台机器的
绝对路径（§2.7），而 LODY 的入口是「仓库名 + 分支」。**入口、出口都在手机上，
中间的过程层反而不该做花活**——这是 2026-10-24 重排的结论。

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

### 2.7 手机开工入口：通用路径缺「选文件夹」，快捷路径完全不存在

2026-10-24 核实。你唯一亲测有用的 LODY 手机能力就是这一处（§1.5），所以它单独成节。

| 能力 | 现状 | 证据 |
|---|---|---|
| 选远端机器 | **已有** | `MachinePicker` + `useMachines`（`NewChatPage.tsx:18,45,128`）；契约 `CreateTaskRequest.executing_device_id`：非空则在另一台机器上执行 |
| 选文件夹（桌面 Electron） | **已有** | 原生目录对话框：`pickDirectory`（`CwdPicker.tsx:31,87` → `lib/desktop.ts:52`） |
| 选文件夹（手机 / 浏览器） | **只能手打路径 + 最近目录** | `CwdPicker.tsx:32` 注释："Browser: manual path + recent cwds (web cannot expose absolute paths)" |
| 浏览远端目录树 | **不存在** | `internal/api` 与 `ui/src/api/client.ts` 里 `/api/fs`、`ListDir`、`readdir` 零命中 |
| 选分支 | **有，但要求仓库已在这台机器上** | `BranchPicker`（`NewChatPage.tsx:555`）走 `checkoutGitBranch`，是对已选目录切分支 |
| 从 GitHub 开会话（免 clone） | **不存在** | UI 里 `clone` 零命中；Go 侧只有 `internal/skills/manager.go`；`project_roots` 唯一一行是本机路径 |

**为什么这是手机上的硬缺口**：手机上你无法浏览文件夹，「手打一个绝对路径」等于要求你
先记得那台机器的目录结构——桌面概念漏进了手机流程。而 LODY 的做法更彻底：它把「路径」
从入口里删掉了，你选的是**仓库名 + 分支**。

**正确的形状（两层来源，一个入口）**：

```
新建会话
├── 通用（默认）：机器 → 文件夹 → 分支
│     机器与 cwd 都已有 draft 记忆（getDraftMachine / getDraftCwd）
│     文件夹在手机上要能「浏览」，不是手打
└── 快捷：从 GitHub 开始 → owner/repo → 分支
      远端还没有就先 bare clone，再走既有 workspace 机制切 worktree
```

两者的产物相同：一个 task + 一个隔离 worktree（`internal/workspace` 已有）。
快捷路径只多一步「远端还没有这个仓库」。

**边界**（按 §10：先写清形状再动手）：

- 列目录由 **Node 侧**实现，根限定在该机器上报的 `workspace_roots`
  （`internal/api/devices.go:57,216` 已有此概念）之下，路径按不可信输入做 containment
  校验。**不做「任意路径可读」的通用文件浏览器。**
- 桌面已有原生目录对话框，这条只补手机/浏览器那一半，**不要动桌面已有的行为**。
- 快捷路径 v1 **不依赖「列出你的 GitHub 仓库」**：手输 `owner/repo` + 远端分支即可开工。
  列表是增强，需要账号级凭据；而本机当前没有可用的 GitHub 凭据（见 P0 的实测）。
  公开仓库可匿名 clone，私有仓库复用本机 `gh` / git 凭据（§9 决策 3）。

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
| Worktree / branch | `task_workspaces` generation | 已有，需在 UI 显式化（**开工时**显式，见 P0-入口） |
| 开工入口（项目 / 分支） | 新建会话页：机器 + 文件夹 | **补**：手机能选文件夹、能按 `owner/repo` + 分支开工（§2.7） |
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
| **控制台表现层** | **形状不对，重做** | 76 行手写变量（19 token 抄四遍）+ 三套颜色词汇 + 边框分离 + 单页无标签，撑不起 §4 的屏幕地图；质量也是最弱处（§2.3 / §2.4） |
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

### P0-入口 — 手机新开对话：选机器 / 选文件夹 / 选仓库 + 分支

| | |
|---|---|
| 交付 | 新建会话页的两条路径：**通用**（机器 → 文件夹 → 分支；文件夹在手机上可浏览，根限定在该机器上报的 `workspace_roots` 之下）与**快捷**（`owner/repo` + 分支 → bare clone + worktree 开工）。形状、证据与边界见 §2.7 |
| 验收 | **只用手机开两个新会话**：一个换到远端机器、进到一个你不能凭记忆打出路径的目录；一个是从没 clone 过的仓库。全程不碰电脑 |
| 依赖 | 无（不依赖账号级凭据：公开仓库可匿名 clone，私有仓库复用本机 `gh` / git 凭据） |
| 大小 | M |

> 排在最前的理由：这是**你唯一亲测有用的 LODY 手机能力**（§1.5，2026-10-24 口述），
> 且属于「每次会话都要付一次」的那一类（§0 第四条）。它同时把「会话 → worktree」
> 这段在**开工那一刻**显式化（§3 表："已有，需在 UI 显式化"），
> 而不是事后补一条状态栏去提醒你它存在。

### P0 — 核心循环闭合：会话 → diff → PR

| | |
|---|---|
| 交付 | GitHub 集成：PR 创建（带完整描述与实现方案）、PR 状态、CI 状态、「自动发现本会话的 PR」、归档联动。**P0c（评论拉取 + 评论回喂）暂缓**（§9 决策 4） |
| 验收 | 会话里改完代码，**在手机上点一下建出 PR，并在会话里一眼看到 PR 号与状态**；全程不碰电脑。不再包含「拉 PR 评论、判断对错、对的修掉」（P0c） |
| 依赖 | P0-入口（"全程不碰电脑"这条验收要求手机能开工） |
| 大小 | M |

> 为什么紧跟 P0-入口：§2.1 是唯一一个「不做就永远只是半个产品」的缺口。
> 两者是同一条链的两端——**入口在手机上，出口也得在手机上**，只补一端等于把人送到半路。
> 参考 LODY：`specs/local-github-pr-observation.md`（无账号也能看 PR + CI）、
> `specs/github-command-credentials.md`（凭据选择顺序）。
>
> **分步与形状**：见 `2026-10-23-p0-github-layer.md`。P0a（只读）/ P0b（publish）/
> P0c（评论回喂，暂缓）三步，形状一次定清。实测发现两个改变设计的事实：本机 PATH 上的
> `gh` 是 LODY 的会话垫片（且被注入 Kin daemon 的 PATH），以及本机当前没有可用的
> GitHub 凭据——后者意味着「读不到」必须是正常状态，不是报错。

### P1 — 设计系统重建

> **分步与形状**：见 `2026-10-24-p1-design-system.md`。实测把三处估计改了：
> 手写变量是 **76 行**（19 token × 4 个主题块）而不是 89；颜色其实是**三套词汇并存**
> （CSS 变量 19 个 / className 裸值 42 个 / Tailwind 默认调色板 131 处），后两套不随明暗切换；
> 表面阶梯本身是对的（亮色每个槽位与 base 差 6.5–13.6 L\*），问题是同一套值抄了四遍、
> 带两组同义词，且没有任何检查。

| | |
|---|---|
| 交付 | 令牌层（间距阶梯 / 由基准推导的字号阶梯 / elevation ladder / 语义色）；「无边框」表面分离；token gallery + 缺口测试；ESLint + Prettier 接入 CI |
| 验收 | **删掉 `ui/src/index.css` 里全部 76 个手写变量**（每个 token 只写一次），控制台视觉不回退；gallery 测试能报出未被呈现的 token |
| 依赖 | 无 |
| 大小 | M |
| 进展 | **S0–S5 已落地**：Prettier 全树格式化、令牌层只写一次（`index.css` 里 76 行手写变量 → 0）、字号 7 级（862 处尺寸全部落到阶梯，268 处真的变了）、圆角/控制件高度/字距/行高/阴影/焦点环六轴全部落阶梯（`--kin-focus-ring` 替掉 21 处各写各的蓝色焦点指示，其中 10 处在亮色主题只有 2.57:1）、语义色三档（`theme.css` 成为全仓唯一写颜色字面量的文件；4 族 × 填充/墨两档 + 每个填充一个指定的前景；**43 处 `/NN` 死类**与 5 个死 token 名修掉——它们此前渲染成空白）、无边框分离（DOM 审计里"两个层级之间画线"从 180 处降到 106 处，剩下的每一种都是输入框的边、well、虚线投放区或选中态；顺带把高度阴影的颜色从 config 搬进令牌层，亮色不再用暗色那对 70% 的黑，而是按"压暗同样的 L\*"解出的 0.03 / 0.06 / 0.08；画廊第一次把高度令牌直接当 `box-shadow` 设，而令牌是颜色、这条声明还要 geometry，浏览器整条丢掉、三块面的计算值全是 `none`——已改成走 step class 并补上配对守卫）。每一片的提交号、验证与证据见 `2026-10-24-p1-design-system.md` §8。**S5 的复查**（同模型子代理）又抓出两条 major，都是同一类错——该留的边被删了：进度卡的头与第一条 step 行是同一层级（中间那条线是唯一的分离），两个浮层的 `shadow-e2` 上方和两侧什么都不画（阴影不是它们与身后的分离）；三条边已补回并在真实构建里逐个量过。**S6 已落地**：ESLint 10 flat config，两条项目规则 + 一条"颜色字面量只许住在 `src/design/`"的目录限制（没有例外清单，所以三个从来不是令牌的调色板搬了进去，各自写明为什么不是令牌），规则自带 19 条失败用例，CI 加 `npm run lint`；0 error / 15 条既有 warning，546 测试全绿，零视觉变化。**S6 的复查**（第三次高级模型复查）报 1 blocker + 1 major，两条是同一个病——**守卫读错了东西**：两条项目规则遍历 token，于是 `className="…"` 这种拼法（1654 处，树里的绝大多数）整个看不见，只有带花括号的少数拼法被读到；颜色字面量那条又漏了模板 quasi，"算出来的颜色"是唯一没被任何守卫看见的拼法。已改成读节点并补第二条 selector，规则自测从 19 条到 32 条，两条规则 × 三种拼法各一条失败用例；武装之后全树仍是 0 error，说明树本来就干净、是守卫没在看。gate 全走完：四次复查（三次全面 + 一次定点）的 blocker/major 全修 → 合并 `main`（`10db60e`）→ 重建桌面（`./scripts/desktop-rebuild.sh`）。重建这一步第一次是**失败**的，值得记一笔：S6 给 `ui` 加了 `@types/node`，而合并后的主检出没有跑过 `npm install`，于是第 1 步的 `tsc --noEmit` 报`Cannot find module 'node:fs'`——看着像类型错误，实际是依赖陈旧。脚本原先只在 `node_modules` **完全不存在**时装依赖，已补上「声明比已装的树新」这一条，并把这一步写进脚本头的步骤说明。手动补 `npm install` 后重建通过。 |
| 开工前已量到的现状 | 字号是 18 个任意值（`text-[11px]`…`text-[13.5px]`，含 11/11.5/12/12.5/13/13.5 这种差 1px 的相邻档，违反 §4.2 第 5 条）；`index.css` 里 19 个颜色 token 在四个主题块（dark / light / system→light / system→dark）里手抄了四遍，共 76 行；status 色（`blue`/`orange`/`green`/`red`）写死在 `tailwind.config.js` 里，不随明暗切换；`ChatStream.tsx:1030` 的 `accent-[var(--kin-blue)]` 引用了**从未定义**的 token（`kin-blue` 是 Tailwind 颜色，不是 CSS 变量）——正是缺口测试该抓的那类 |

### P2 — 会话视图升级

| | |
|---|---|
| 交付 | 居中对话栏（含显式宽度档位）；活动分组（思考 + 工具调用折叠为一行摘要）；subagent 面板；逐轮 diff 证据卡；聊天内代码高亮；消息队列；权限提示顶替输入框 |
| 验收 | **连续用一周**，不再需要打开终端看 diff；subagent 跑起来时不用猜它在干什么 |
| 依赖 | P1 |
| 大小 | L |
| 进展 | **开工**。形状、顺序、清点与已定的决策见 `2026-10-24-p2-session-view.md`。顺序按「手机上不做会怎样」排，不按实现难度：消息队列第一，因为今天运行中补一句话的代价是打断当前轮 + 拒掉所有待批审批 + 代答所有待回问题（唯一一条今天就在损坏用户数据的） |

### P3 — 会话外壳：多标签 + 右侧面板

| | |
|---|---|
| 交付 | 会话多标签（可拖拽、URL 持有 active tab）；右侧面板扩到 `files / changes / pr / terminal`；zen 模式（`Cmd+.`）；命令面板补全 |
| 验收 | **同时开 3 个会话**，各自标签之间切换不丢状态；`Cmd+.` 能一键清屏 |
| 依赖 | P0（pr 面板）、P2 |
| 大小 | M |
| 进展 | **开工**。形状、切片、守卫与现状实测见 `2026-10-25-p3-shell.md`。开工前的结论有两条改变了这一片的大小：keep-alive 多会话**已经在树里**（`TaskSessionHost` 挂 8 个 pane 并 CSS 隐藏非活动者），所以多标签缺的只是「标签栏 + 顺序持久化」；终端也**已经全套建好**（UI + Go + WS），所以「面板扩到 terminal」是收编而不是新建 |

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

#### 开工前已核实的三件事（2026-10-23，免得重新推一遍）

**1. 首屏体积已修掉——这一条不再是问题。**
`CodeViewer` 静态 import 了 `@monaco-editor/react` + `monacoSetup`（内含
`monaco-editor` 与 5 个 `?worker`），把整个编辑器塞进了入口 chunk。
改成 `React.lazy` + `Suspense` 后实测：

| | 入口 chunk (raw) | 入口 chunk (gzip) |
|---|---|---|
| 之前 | 4,428.71 kB | 1,162.87 kB |
| `ea0c3f3`（拆分 monaco） | 1,063.10 kB | 297.11 kB |
| 加上 PR 面板（当前树） | 1,074.55 kB | **299.95 kB** |

中间那行是 `ea0c3f3` 自己的构建数；末行是当前树的数（PR 面板约 11 kB raw / 2.8 kB gzip）。
数字会随每次改动漂，所以记的是"哪次构建量出来的"，不是"大概多少"。

monaco 移到按需加载的 `CodeViewer-*.js`（3,359 kB）。而且**不是打开面板就下**：
`WorkspacePanel` 在 `selectedPath` 为空时渲染的是空状态，不是 `Suspense` 里的
`CodeViewer`；而 `selectedPath` 只在点开某个文件时才被赋值——`TaskDetailPage` 的
"文件"按钮（`openFilesPanel`）不设路径。所以**首次打开文件面板不会下那个 chunk**，
只有真的点了一个文件才会。理由写在 `WorkspacePanel.tsx:42` 的注释里。

**2. 审批卡片"钉在底部"是可以修成原位的，数据够用。**
`Approval` 本身**没有** `seq`（只有 `id` / `created_at`），但
`approval_requested` 事件同时带 `approval_id` 和 `ev.seq`，而
`transcriptProjection.ts` 已经在 `ar-${ev.seq}` 处生成了一个 `meta` 标记。
所以按 `approval_id` 关联即可把卡片渲染到它发生的位置。
**要一起想清楚的两件事**（这是它至今没做的原因，不是没想到）：
- 审批来自 `/api/approvals`，事件来自已加载的事件窗口。**窗口外的审批没有锚点**，
  必须留一个兜底位置，否则会静默消失——比钉在底部更糟。
- `TaskDetailPage` 的 `j/k/a/d` 键盘焦点（`focusIdx`）现在按 `needsYou` 数组下标走。
  改成原位渲染后，焦点顺序要改成按 seq，否则键盘跳转会与视觉位置不符。

**3. 触摸下限不能简单地加一个 `a` 选择器——而且仓库里已经有约定，只是没写成一条规则。**
`ui/src/index.css` 的 44px 下限挂在 `.touch-lg` 上，而 `.touch-lg` 在
`AppShell` 根节点，**是全站生效的**。所以 `.touch-lg a` 会把每一个 `<a>` 都顶到
44px，包括塞在紧凑行里的那些（`ChatStream.tsx:787` 是 `flex-none max-w-[40%] truncate`
的等宽链接，`CwdPicker.tsx:212` 是 11px 的行内动作），把行高和截断都挤坏。
真正该顶的是**行级 tap target**（`ApprovalsPage.tsx:219` 的 `className="block"`、
`TasksPage.tsx:157`、`ArtifactsPage.tsx:188`），以及面板自己的按钮。

**已有的约定**：需要触摸下限的地方，元素自己写 `min-h-[44px] ... sm:min-h-0`
（`ProviderSettingsSection.tsx:486`、`SettingsPage.tsx:1429`、
`NewChatPage.tsx:632`）。也就是说 opt-in 已经存在，只是靠人手写、没有名字。
要做的不是发明选择器，而是给它一个名字（例如 `data-touch-target`，与现有
`data-touch-mini` 的 opt-out 风格对称），再把上面几处收敛过去。

**P0a 面板的实测现状**（390×844）：刷新与关闭按钮都是 44×44；卡片里的 PR 链接是
318×20——这一条正是给它们准备的。"更早的分支"里的外链原本是 12×12，已按上面这条既有
约定就地补上 `min-h-[44px] min-w-[44px] sm:min-h-0 sm:min-w-0`，所以它不再计入欠账。

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
| 4 | 手机开工入口与 P0c | **两条路径并列**，不分主次：通用（选机器 + 选文件夹）与快捷（GitHub 项目 + 分支）。**P0c 评论回喂暂缓**——依据是你 2026-10-24 的判断："其他的功能到目前都还没用到，所以其他的设计可能要暂缓并思考怎么让用户直观感受到"。恢复条件：你在手机 dogfood 里真的收到过别人（或 AI reviewer）对 PR 的评论 |
| 5 | 功能的取舍判据 | **这个功能替用户删掉了哪一个「必须坐到电脑前才能做的决定」？答不出来就不做**（§0 第四条）。**第一个案例已判**：PR 面板自动跟随后台查询的那套轮询循环——按判据**砍掉**，改成「GET 只读缓存 + 打开面板时若从未观测过就刷新一次」（2026-10-24 你点头） |
| 6 | 测试与 dogfood 里可撤销的动作 | **自动允许，不再逐次问**：推分支、开 / 关 PR、删自己建的分支、建 / 删 worktree、重启本地 daemon 与桌面。仍然先问的是**不可撤销**的那一类：强推、重写历史、删不是你建的分支或数据、发布产物、schema 重置、改别人的系统。你 2026-10-24 的原话："后面这类测试，凡是可撤销的行为，都自动允许" |
| 7 | 配对手机能不能花节点的 GitHub 配额 | **能（放开查询）**。你 2026-10-24 选的"放开查询"。落在一条新 gate `githubQueryOnly` 上，只挂 `/pr/refresh` 一条路由；`operatorOnly` 其余 51 条不动。理由沿用仓库已有的前提（`task_scope.go:23-26`：设备不受作用域限制**因为**配对本身是 operatorOnly），边界是**成员仍被拒**，且这条路的额度由"人的点击 + GitHub 拒绝后的退避"兜底，不占后台巡检的小时预算。**只覆盖读**：P0b 的 push / 开 PR 是另一道门，另行决定 |

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

按 **P0-入口 → P0b → P1 → P2 → P3 → P3b → P4 → P5 → P6** 顺序开工
（P0c 暂缓，见 §9 决策 4；两端都在手机上，中间的过程层不做花活），
每个里程碑走完整的 Feature completion gate（高模型 review →
修 blocker/major → 提交 → 合入 main → 桌面重建），并且**每个里程碑结束时给一个可安装的版本**。
