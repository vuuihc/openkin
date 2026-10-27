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

**四个 agent 的 ACP 入口都是现成命令，不是 Kin 要写的代码。** 逐条核对并钉版本：

| agent | ACP 命令（钉版） | 实测版本 |
|---|---|---|
| claude | `npx -y @zed-industries/claude-agent-acp@0.23.1` | 0.23.1 |
| codex | `npx -y @agentclientprotocol/codex-acp@2.3.0` | 2.3.0 |
| droid | `droid exec --output-format acp` | 0.238.0 |
| pi | `npx -y pi-acp@0.0.30` | pi-acp 0.0.30 / pi 0.80.3 |

两个版本坑（都是实测踩到的）：`@zed-industries/codex-acp@0.12.0` 用当前
`~/.codex/config.toml` 起不来（`service_tier` 只认 fast/flex），维护中的包已迁到
`@agentclientprotocol/codex-acp`；`pi-acp@0.0.34` 对 pi 0.80.3 调
`get_available_thinking_levels` 失败，0.0.30 可以开会话。

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

## 1. 现状（2026-10-27，落地后）

| | 事实 | 出处 |
|---|---|---|
| 已有 | 一个 ACP agent，binary/args 可配，默认 `codex-acp` | `internal/adapter/acp/plugin.go` |
| 已有 | 权限提问 → 审批收件箱（手机卡） | `internal/adapter/acp/bridge.go` |
| 已有 | `session/load`、模型设置、取消、流式 | `protocol.go`、`adapter.go` |
| 已闭合 ① | 四个 ACP agent 各自注册，id `claude-acp` / `codex-acp` / `droid-acp` / `pi-acp`，可用 `KIN_ACP_<NAME>_BIN` / `_ARGS` 单独改 | `internal/server/agents.go` 的 `acpAgents` 表 |
| 已闭合 ② | `session/new` 的 `modes` 解析并在 prompt 前 `session/set_mode`；`current_mode_update` → notice | `adapter.go` 的 session → mode → model → prompt 链 |
| 已闭合 ③ | 四个 agent 的 7 格矩阵实测并记版本（§2 A2） | 裸探针 + daemon 端到端 |
| 已闭合 ④ | claude 的子代理父子字段读进事件（`sidechain` + `parent_tool_use_id`），UI 折叠到父调用下 | `update.go`、`transcriptProjection.ts` |

## 2. 切片

### A1 — 四个 ACP agent 上线（已落地）

- `internal/server/agents.go`：一张 `acpAgents` 表（id / name / binary / args / 模式映射 /
  是否无审批通道），每条注册一个 ACP factory。id 与原生 adapter 的 `claude-code` /
  `codex` / `droid` 不撞，两条路径可以同时装着。
- 探测：`plugin.go` 的 `Status` 照实报「没装 + 原因」；`npx` 型首跑会拉包。
- 环境覆盖：`KIN_ACP_CLAUDE_BIN` / `KIN_ACP_CODEX_ARGS` 这类变量只改那一个 agent。
- 验收（已过）：`/api/agents` 里四条都在且 `available`。

### A2 — 常用功能矩阵（2026-10-27 实测，逐格）

量法：裸 ACP 探针（JSON-RPC over stdio，和 Kin 用同一条线）每格跑一遍，再用 Kin 自己的
daemon/API 各跑一遍端到端（A4）。「通过」= 探针和端到端都看到。

| 功能 | claude-acp 0.23.1 | codex-acp 2.3.0 | droid-acp 0.238.0 | pi-acp 0.0.30 |
|---|---|---|---|---|
| 发起 + 流式文本 | ✅ 逐字 chunk | ✅ | ✅ | ✅ |
| 工具调用可见 | ✅ Read/Bash/Agent；`_meta.claudeCode.toolName` 是真名 | ✅ read/execute | ✅ read/edit/execute | ✅ read/edit（只有标题没有工具名）|
| 权限提问 → 审批卡 | ✅ 写文件触发 1 张，Kin 批准后继续 | ✅ `read-only` 档下 shell 触发 1 张 | ✅ `normal` 档下写文件触发 1 张 | — **没有审批通道**：两轮写文件 0 提问 |
| 续接 `session/load` | ✅ 重放 15–21 条后接着答 | ✅ 13–16 条 | ✅ 18–20 条 | ✅ 14 条（重放里有 thought chunk）|
| 模式 | ✅ `default`/`acceptEdits`/`plan`/`dontAsk`/`bypassPermissions`；同一条写指令在 `default` 下 1 张卡、`acceptEdits` 下 0 张 | ✅ `read-only`/`workspace-write`/`agent`/`agent-full-access`；默认 `agent`（自动审阅，不弹卡）| ✅ `normal`（只自动批准读）/ `spec` / `auto-low`（编辑 + 低风险）/ `auto-medium`（中风险）/ `auto-high`（全部），描述是 agent 自己报的；默认 `auto-high` | — `modes` 是思考等级 `off…xhigh`，不是权限档 |
| 模型 | ✅ `model`（51 项）| ✅ `model`（48）+ `reasoning_effort` + `fast-mode` | ✅ `model`（60）+ `reasoning_effort` | ✅ `model`（49）+ `thought_level` |
| 取消 | ✅ `cancelled`，0.0s | ✅ `cancelled`，0.0–0.1s | ✅ `cancelled`，0.0s | ⚠️ 回 `end_turn` 不是 `cancelled`，取消后仍吐约 150 条 update |
| 子代理归属 | ✅ 子代理的 `tool_call` 带 `_meta.claudeCode.parentToolUseId`，UI 折叠在父 `Agent` 调用下（实测 1 次）；子代理的 message chunk 本轮没出现（它的答复作为父调用的 `tool_result` 回来）| — 协议无此字段 | — | — |

`current_mode_update`：droid 在 daemon 端到端里发了（"mode changed: normal" notice），
其余三个一声不响。`session/set_mode` 回包四个都是 `{}`。

**这轮实测改掉了四处实现：**

1. **pi 没有权限通道**（第 3 格那个破折号）。它的 `modes` 是思考等级，把它当权限档映射
   等于「用关掉推理冒充收紧权限」。pi 标成 `Unattended`：任何模式都绕过，每轮开头一条
   警告说「这个 agent 不会问人」。
2. **droid 默认 `auto-high`、codex 默认 `agent`**，都不弹卡。光注册两个 agent 会让审批卡
   永远不出现，所以每个 agent 带一张 Kin 三档 → 该 agent 自己档位 id 的表，prompt 前先
   `session/set_mode`。**agent 报了档位表、但里面没有我们映射的那一档 → 这一轮直接拒跑**
   （「Kin 放不进去的档位不跑」）；agent 压根不报档位表 → 一条 notice 说没应用、按它自己
   的默认跑；`set_mode` 本身被拒也一样拒跑，并在错误里点名是哪一档。
3. **droid 的 `auto-low` 名不副实**：它自称「编辑 + 低风险」，实测把一次工作区外写入和一条
   `sudo -n true`（都被 droid 判为 low）直接放行、0 张卡。所以 droid 的 `accept_edits` 在
   Kin 这边记为 **bypass**（`AcceptEditsBypasses`），节点执行器按 YOLO 处理，不会假装它有闸。
4. **claude 拒收没有 `clientInfo.version` 的 `initialize`**（-32602）。另外三个都收，
   所以这个洞只有端到端才露出来；现在握手一律带版本，假 agent 也会拒。
5. **claude 的 `title` 是一句话，`_meta.claudeCode.toolName` 才是工具名**。原先按 title
   命名，一行会显示成「Read /tmp/x」，后续只带状态的 update 还会把行名改成 `tool`。
   现在优先 `toolName`、title 进 summary，update 不带上名字就不改名。

### A3 — 把协商结果端到 UI（已落地）

- **模式**：`session/new` 的 `modes` 进 `sessionResult`；三档映射表命中就 `session/set_mode`，
  agent 只把档位报成 `category:"mode"` 的 config option 时走 `session/set_config_option`；
  两样都没有就一条 notice 说没应用；报了但没有这一档就拒跑（见 A2 第 2 条）。
  `current_mode_update` 不再丢，变成 "mode changed" notice。
- **模型**：仍只设 `model`；其余 `configOptions` 照实记进 notice（droid 的
  `reasoning_effort`、codex 的 `fast-mode` 之类），不臆造控件。
- **无审批通道的 agent**（pi）：`Unattended` → `AutoApprovesAll` 恒真（节点执行器据此
  不放行 YOLO 之外的假设），每轮开头一条警告。
- **子代理**：`_meta.claudeCode.parentToolUseId` → 事件上的
  `parent_tool_use_id` + `sidechain`；assistant chunk 强制进 process box（`phase:progress`）；
  UI 把子代理的调用折叠到父调用下（缩进 + 「子代理」标签），轮次结束后一起收尾。
- 每个 agent 的行为差异写进矩阵，**不写进代码分支**。

### A4 — 端到端（daemon/API 已过；手机待用户）

2026-10-27 用隔离 daemon（`KIN_STATE_DIR` + 独立端口）当手机，走 `/api/tasks` →
`/api/tasks/{id}/events` → `/api/approvals/{id}/decision`，四个 agent 各一条写文件任务：

| agent | 结果 | 审批卡 | copy.txt |
|---|---|---|---|
| claude-acp | succeeded | 1 张，批准后继续 | ✅ |
| codex-acp | succeeded | 1 张 | ✅ |
| droid-acp | succeeded | 1 张 | ✅ |
| pi-acp | succeeded | 0 张（"agent does not ask" 警告）| ✅ |

外加一条 claude 子代理任务：父调用 `Agent`，子调用 `Read` 带 `parent_tool_use_id`，
在投影里落在父行下。

再加一条 `permission_mode=accept_edits` 的 claude 任务，验证模式不是只在探针里通：agent 端
回报 `Mode=acceptEdits`，0 张审批卡，3 次 `Write`，`mode-check.txt` 落盘。也就是
`session/set_mode` 在 daemon 链路里真的改掉了 agent 的档位。

手机上的 dogfood（真机、Hub 转发）留给用户跑。

## 3. 未量与风险

- **适配器都是第三方的**：`pi-acp` 是社区包（钉 0.0.30）、`claude-agent-acp` 是 Zed 的
  （0.23.1）、`codex-acp` 已迁到 `@agentclientprotocol/codex-acp`（2.3.0）。行为随版本漂
  → 钉版本、矩阵里记版本号；升版要重跑 A2。
- **pi 不认取消**：`session/cancel` 之后它回 `end_turn` 并继续吐 update。Kin 的取消阶梯
  仍会在宽限期后杀进程，但「停止」在 pi 上不是协议级的优雅停止，记为风险。
- **`npx` 首次会拉包**（慢、要网）：节点上第一次开任务可能卡十几秒；要么预装到全局，
  要么接受这一次延迟。`npx -y` 的包缓存在用户目录，升级不会自动发生（钉了版本）。
- **droid 的 ACP 是 `exec` 子命令**（非交互）：自治档已经实测（`normal` 会问），但它自己的
  worktree 开关与 Kin 工作区升格怎么配合，未量。
- **droid 偶发挂起**：探针里出现过一次首个 prompt 无响应（`TimeoutError`），立刻重跑就正常；
  记为已知抖动，dogfood 时若遇到先重试。
- **claude 那条的权限语义由适配器决定**：Kin 原生那套 `--permission-prompt-tool` 不适用，
  审批卡的选项名按 provider 原话（`allow_once` / `allow_always` / `reject_once`），不改写。
- **子代理**：ACP 协议没有父子字段；claude 适配器在 `_meta.claudeCode.parentToolUseId` 里
  给了，Kin 读它并折叠。实测到的是 `tool_call` 带标记；子代理的 `agent_message_chunk`
  本轮没出现（适配器源码里同一字段也加在 chunk 上，但没实测到）。codex/droid/pi 没有这个
  字段，子代理（若有）会和主 agent 平铺——记为该 agent 没有这一项。
- **认证**：ACP agent 自己认证（ADR 0022 D7），Kin 不路由 provider 凭据——
  四个 agent 各自的登录态得先在终端里弄好。
- **手机派活前先看节点的 `--allow-yolo`**：节点执行器把「这一轮 Kin 拦不住」当成 YOLO
  上限问题，没开 `--allow-yolo` 就拒跑。pi 每一档都拦不住（`Unattended`），droid 的
  `accept_edits` 实测也拦不住（`AcceptEditsBypasses`），所以这两个 agent 的这类任务在
  现在这台 launchd 节点（没有 `--allow-yolo`）上会被 Hub 派活拒掉；claude / codex 的
  `accept_edits` 有真闸，不受影响。本地 `/api/tasks` 不走节点执行器，所以上面的 E2E 没
  撞到这个门。dogfood 想跑 pi 就先给节点加 `--allow-yolo`（或只用本地任务）。
- **agent id `acp` 没了**（有意破坏）：原来那条含糊的 `acp` 换成了四个具名 id。存着
  `agent=acp` 的旧任务/重试会找不到 agent，这是有意不做兼容——按 YOLO 原则改就改干净。
- **没量的地方**：droid 的 `spec` 档（只读规划）没映射、也没测；各 agent 的
  `configOptions`（effort / fast-mode）只记录不驱动；子代理在 codex/droid/pi 上没有父子
  字段。

## 4. 明确不做（这一轮）

- 不写四份 Kin 原生适配器（每个 agent 一份档位/flag 表）——ACP 已经在协商这件事。
- 不删原生 `claude-code` / `codex` / `droid` 适配器（等 dogfood 绿了再说；
  真删的时候把 ACP 那条的 id 改成 `claude-code` 这类正式名字）。
- 不做子代理折叠**之外的**任何扇出机制；没有父子字段的三个 agent 保持平铺。
- 不搬 Lody 的编排状态机（parity §1.3：本机 0 使用）。
- 不碰 schema / 迁移（这轮没有存储改动）。
- 不给 `configOptions` 里的 effort / fast-mode 造 Kin 自己的控件：先把 agent 报的原样记下来。

## 5. 验收

1. `/api/agents` 里四个 ACP agent 都在；没装的会说明原因而不是消失。（已过）
2. 28 格矩阵填满，外加子代理那一格，红格有归属（A3 修掉 / 记为该 agent 没有 / 记为风险）。（已过，见 §2）
3. 端到端：发起 → 批准 → 落盘，四个 agent 各一次。（daemon/API 已过；手机真机待用户）
4. `go test ./internal/adapter/acp/... ./internal/server/...`、`go test ./...` 与
   `cd ui && npm run build` 绿。
