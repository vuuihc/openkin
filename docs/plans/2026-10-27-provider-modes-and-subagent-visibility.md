# 四个 agent 走 Kin 的 ACP：做到可 dogfood 为止

> 上游：`docs/plans/2026-10-23-lody-parity.md` §1.1（权限模式 / subagent 扇出两行）。
> **2026-10-27 范围收缩**（用户原话）：「不需要特别细，我只需要 Claude Code / droid / pi / codex
> 这几个 agent 的常用功能能通过 Kin 的 ACP 用上，尽早开始 dogfood 就行。」
> 交付：四个 agent 在 Kin 里以 ACP 跑通常用功能，矩阵逐格实测，手机 dogfood 一轮。
> 验收：`/api/agents` 里四个 ACP agent 都在；28 格矩阵填满、红格有归属；手机走完
> 发起 → 批准 → 看 diff。

## 0. 为什么这版能这么小

**Kin 已经有一个 ACP 客户端，这一轮不是新建协议层。** `internal/adapter/acp/` 里已有：
binary / args / id 可配（`plugin.go:120-150`）、权限提问桥到审批收件箱（`bridge.go`）、
`session/load` 续接（`protocol.go:129`）、`configOptions` 解析（目前只用于模型，
`adapter.go:532+`）、取消与流式。

**四个 agent 的 ACP 入口都是现成命令，不是 Kin 要写的代码。** 逐条核对过：

| agent | ACP 命令 | 核对方式 |
|---|---|---|
| codex | `codex-acp` | 本机已装 `@zed-industries/codex-acp@0.12.0` |
| droid | `droid exec --output-format acp` | `droid exec --help` 的 `--output-format` 里有 `acp` |
| claude | `npx -y @zed-industries/claude-agent-acp@^0.21.0` | npm 上存在（最新 0.23.1）|
| pi | `npx pi-acp@^0.0.22` | npm 上存在（最新 0.0.34）|

（这四条来自本机 `acpx` 的 `AGENT_REGISTRY`；同一张表里还有 gemini `gemini --acp`、
cursor `cursor-agent acp`、copilot `copilot --acp --stdio`、kimi `kimi acp`、qwen `qwen --acp`、
opencode `npx -y opencode-ai acp`，将来加 agent 是往表里加一行。）

**所以 Kin 侧真正的改动只有三类**：注册（四个 ACP agent 而不是一个）、把 ACP 已经协商出来的
东西端到 UI（模式；模型已经能设）、把矩阵跑满。

**上一版计划的「provider 档位阶梯」不做了。** ACP 自己就有 `availableModes` + `set-mode`，
为四个 agent 各写一份 Kin 原生档位表，等于把 Lody「同一能力写在三处」那个毛病请回来
（parity §2.6）。背景仍然成立、记在这里备查：Claude CLI 自己有六档
（`acceptEdits` / `auto` / `bypassPermissions` / `manual` / `dontAsk` / `plan`），
Kin 的原生适配器只做了三档——**但那是原生路径的问题；走 ACP 就不该由 Kin 来枚举。**

## 1. 现状（2026-10-27 实查）

| | 事实 | 出处 |
|---|---|---|
| 已有 | 一个 ACP agent，binary/args 可配，默认 `codex-acp` | `internal/adapter/acp/plugin.go:120-150` |
| 已有 | 权限提问 → 审批收件箱（手机卡） | `internal/adapter/acp/bridge.go` |
| 已有 | `session/load`、模型设置、取消、流式 | `protocol.go:129`、`adapter.go:532+` |
| 缺口 ① | 只能注册**一个** ACP agent（id 固定 `acp`） | `internal/server/agents.go:228` |
| 缺口 ② | `availableModes` 没解析；`current_mode_update` 收到后只当一条 notice | `internal/adapter/acp/update.go:149-151` |
| 缺口 ③ | 四个 agent 的真实行为没人量过（矩阵是空的） | 本文 §2 |
| 缺口 ④ | ACP 线上没有子代理的父子字段 | 见 §3 |

## 2. 切片

### A1 — 四个 ACP agent 上线（先做，做完就能点）

- `internal/server/agents.go`：把单个 acp factory 换成一张表（id / name / binary / args），
  四条按 §0 的表；id 用 `claude-acp` / `codex-acp` / `droid-acp` / `pi-acp`，
  显示名带括号（如 `Claude Code (ACP)`），**不与原生 adapter 的 id 相撞**。
- 探测：`plugin.go` 的 `Status` 已经会报「没装 + 原因」；`npx` 型的两条要允许首跑拉包，
  探不到就**如实说原因**，不假装可用。
- 原生 `claude-code` / `codex` / `droid` 适配器**这轮先留着**（见 §4），别让 dogfood 卡在删除上。
- 验收：四个 agent 出现在 `/api/agents`，各自能选中并跑起一轮。

### A2 — 常用功能矩阵（逐格实测，一格都不许猜）

| 功能 | 怎么算通过 |
|---|---|
| 发起会话 + 流式文本 | 手机上看到逐字输出 |
| 工具调用可见 | Read / Edit / Bash 各出现一行，参数可展开 |
| 权限提问 → 审批卡 | 写文件时手机出现卡片，批准后继续 |
| 续接（`session/load`）| 关掉再打开，同一会话接着跑，不重头 |
| 模式 | 会话报出的 modes 能在 UI 里切，切完 agent 行为真的变 |
| 模型 | 选定的模型就是那一轮实际用的 |
| 取消 | 停止能停住，不留悬挂的权限请求 |

四个 agent × 七格 = 28 格，逐格记「通过 / 失败 / 该 agent 没有这一项」，并记下适配器版本号。
**矩阵本身就是这一轮的交付物。**

### A3 — 把协商结果端到 UI（按矩阵的红格做，不预先设计）

- **模式**：解析 `session/new` 报出的 modes，用 `session/set_mode` 切换；`update.go:149-151`
  已经收到 `current_mode_update`，现在丢了，接上即可。picker 按会话报的档位渲染——
  这就是「档位由 provider 声明」的 ACP 版本，代码量比原生那版小得多。
- **模型**：`configOptions` 里除 model 之外还有别的项（thinking/effort 之类）就照端；
  没有就只留 model。
- 每个 agent 的行为差异写进矩阵，**不写进代码分支**。

### A4 — 手机 dogfood

- 四条真实任务（四个 agent 各一条），全程只碰手机：发起 → 批准 → 看 diff → 结束。
- 通过的写进 parity 计划；没通过的回到 A2 / A3。

## 3. 未量与风险

- **适配器都是第三方的**：`pi-acp` 是社区包（0.0.34）、`claude-agent-acp` 是 Zed 的（0.23.1）、
  `codex-acp` 也是 Zed 的。行为随版本漂 → 钉版本、矩阵里记版本号。
- **`npx` 首次会拉包**（慢、要网）：节点上第一次开任务可能卡十几秒；要么预装到全局，
  要么接受这一次延迟。
- **droid 的 ACP 是 `exec` 子命令**（非交互）：它自己的自治档、worktree 开关与 Kin 的工作区
  升格怎么配合，未量。
- **claude 那条的权限语义由适配器决定**：Kin 原生那套 `--permission-prompt-tool` 不适用，
  审批卡的选项名可能与原生路径不同——按 Lody 的规矩办：**用 provider 原话，不改写选项名**
  （parity 引用的 `specs/permission-requests.md`）。
- **子代理**：ACP 线上没有父子字段。先量 claude 那条在 ACP 流里到底出不出 `Task` 工具调用；
  不出，「折叠可见」要么不做，要么只在原生 claude 路径上做（那条这轮不动）。这一格是矩阵
  之外的加测，量完写回这里。
- **认证**：ACP agent 自己认证（ADR 0022 D7），Kin 不路由 provider 凭据——
  四个 agent 各自的登录态得先在终端里弄好。

## 4. 明确不做（这一轮）

- 不写四份 Kin 原生适配器（每个 agent 一份档位/flag 表）——ACP 已经在协商这件事。
- 不删原生 `claude-code` / `codex` / `droid` 适配器（等 A1 矩阵绿了再说；
  真删的时候把 ACP 那条的 id 改成 `claude-code` 这类正式名字）。
- 不做子代理折叠（先量后定，见 §3）。
- 不搬 Lody 的编排状态机（parity §1.3：本机 0 使用）。
- 不碰 schema / 迁移（这轮没有存储改动）。

## 5. 验收

1. `/api/agents` 里四个 ACP agent 都在；没装的会说明原因而不是消失。
2. 28 格矩阵填满，红格有归属（A3 修掉 / 记为该 agent 没有 / 记为风险）。
3. 手机上一轮真实任务走完（发起 → 批准 → 看 diff），四个 agent 至少各一次。
4. `go test ./internal/adapter/acp/... ./internal/server/...` 与 `cd ui && npm run build` 绿。
