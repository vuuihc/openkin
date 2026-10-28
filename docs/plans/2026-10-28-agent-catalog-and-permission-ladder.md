# Agent 目录、权限阶梯与排版系统

> 来源：2026-10-28 用户三点反馈——(1) agent 与模型列表没读全，本机 Claude Code 通过
> magpie 代理有一堆模型，Kin 里只看到 `gpt-6.1-sol`；(2) 权限只有"询问 / 自动编辑"，
> 没有 YOLO，且应该按 agent 适配；(3) 整体 UI 还有系统性优化空间（字体/缩进），
> 并要求用高级别模型做一次审核。
>
> 前一轮移动端重构见 `2026-10-28-mobile-ui-system.md`；本文件只记录这一轮。

## 1. 模型目录：读 CLI 自己的列表，而不是三个别名

### 诊断

`claude-code` 的模型列表此前由三个别名（`opus` / `sonnet` / `haiku`）经
`ANTHROPIC_DEFAULT_*_MODEL` 解析而来。网关（magpie）把这**三个别名都指向同一个模型**，
于是 37 个可选模型塌缩成一行；反过来，没有配置别名时别名又会以字面量出现，
"选 haiku 实际跑别的模型"。

真正的列表在 `~/.claude/settings.json` 的 `modelPicker.options[]`：那正是 CLI 自己
`/model` 菜单渲染的内容，带网关给的 label（如 `DeepSeek V4.1 Flash · volcengine-gw`）。
本机实测 47 项。

### 做法

`internal/adapter/claudecode/models.go`：

- `readClaudeSettings()` 合并 `settings.json` 与 `settings.local.json`（后者逐键覆盖；
  `modelPicker` / `model` 整体替换而非合并——它们是选择，不是映射）。
- `claudeModels(settings)` 的顺序：picker 行（保留 label）→ 显式配置了目标的别名 →
  `settings.model`；按 id 去重；**有 picker 时绝不追加裸别名**；
  完全没有配置时才退回旧的 `claudeModelList`（保留老测试与无网关机器）。
- `plugin.go` 的 `Models` 钩子改用 `claudeModels(readClaudeSettings())`。

测试（`models_test.go`）：`TestClaudeModelsReadsTheCLIsOwnPicker`、
`TestClaudeModelsKeepsAnUnlistedDefaultAndAliasTargets`、`TestClaudeModelsPrefersTheLocalPicker`。
新增 `clearClaudeAliasEnv`，避免开发机导出的网关环境变量污染测试。

### 验证

重建后的 daemon：`GET /api/agents` 的 `claude-code` 返回 47 个模型、`available`，
label 与 CLI 菜单一致。手机侧走 Hub 的设备登记（`worker.Hello.Agents.Models`，
上限 `MaxModels = 64`，47 项不截断），id 原样到达，label 由
`modelPickerLabel` 从 id 推导（`volcengine-gw/deepseek-v4-flash[1m]` → `deepseek-v4-flash[1m]`）。
**遗留**：协议只传 id 不传 label，手机上的名字不如本机好看；要修需要给
`worker.Agent` 加一个附加字段并落库，不在本轮范围。

## 2. 权限阶梯：按 agent 说完，而不是三个名字人人有份

### 诊断

两处不同的谎：

1. 本机 `/api/agents` 不返回任何权限信息，控制台只好对每个 agent 都摆出三个模式——
   一个只有开关的 agent（`grok`、`opencode`）被展示了"自动编辑"和"YOLO"两个名字，
   实际是同一个行为；一个从不询问的 agent（`kin`、`pi-acp`）被展示了"选择"。
2. 派发路径（node）会按 `--allow-yolo` 过滤，但本机安装脚本不写这个 flag，
   于是手机上永远只有前两档。

### 做法

- `internal/server/node.go`：新增 `agentPermissionModes(reg, id)`，把"这个 agent 到底有
  几档"的问题交给 adapter 回答（`adapter.AutoApprovesAll` 是唯一知道某个模式**做什么**
  而不是叫什么的地方）：
  - 从不询问 → 只有 `default`；
  - `accept_edits` 本身即绕过审批 → `default, yolo`（中间的档位是同一个行为的第二个名字）；
  - 否则 → `default, accept_edits, yolo`。
  `nodePermissionModes` 改为在它之上过滤，派发路径的语义不变。
- `internal/api/api.go` + `internal/server/server.go`：`/api/agents` 增加
  `permission_modes`（`omitempty`；缺失 = 说不了，控制台退回分级默认）。
- `ui/src/lib/permissionMode.ts`：`permissionModesForAgent` 先信 agent 自报的阶梯，
  本机与远端一致；缺失时本机给全三档、远端给前两档（保守答案，把"会被拒绝的选择"
  提前拿掉，而不是等第一轮失败）。全是不认识的模式名时退回 `default`。
- `ui/src/pages/TaskDetailPage.tsx`：本机会话的阶梯来自 `/api/agents` 的
  `taskAgentMeta`（本机会话不是派发 turn，`--allow-yolo` 不适用于它，但 agent 自己的
  阶梯适用）。
- `scripts/install-node-service.sh`：新增 `--allow-yolo` / `--no-allow-yolo` 与
  `--lan` / `--no-lan`；**刷新时从现有 plist 读回**，否则一次无参 refresh 会静默
  丢掉 `--lan`（本机 plist 里本来就有）或 `--allow-yolo`，而屏幕上没有任何解释。
  `--help` 改为打印脚本头部注释，不再写死行号区间。

### 验证

`GET /api/agents` 实测：

| agent | permission_modes |
|---|---|
| `kin`, `pi-acp` | `default` |
| `grok`, `opencode`, `droid-acp`, `aider-desk` … | `default, yolo` |
| `claude-code`, `codex`, `droid`, `claude-acp`, `codex-acp` | `default, accept_edits, yolo` |

UI：选 `kin` 时权限表只有"询问"；切到 Claude Code 后是"询问 / 自动编辑 / YOLO"（390 宽实测）。

安装脚本用假 HOME + `launchctl` stub 跑了四轮：无参刷新保留 `--lan`；`--allow-yolo`
加上；再次无参刷新两者都保留；`--no-lan` 只去掉 `--lan`。真机 plist 现为
`… --root ~/Workspace --lan --allow-yolo`。

测试：`TestAgentPermissionLadderIsTheAgentsOwn`（新增）、
`TestNodeAdvertisesOnlyModesItWillRun`（改为断言"从不询问的 agent 只有一档"）、
`ui/src/lib/agentFamilies.test.ts` 的五个用例。Go 与 UI 两侧都做了反向验证
（把实现改回"永远三档"，新测试必须失败）。

## 3. 排版与间距：高级别模型审核

### 审核方式

用与主会话同等级的模型跑了两轮只读审核（同模型，不走 Codex 网关）：第一轮给出
10 条（按严重度排序），修完后第二轮复审整个 diff，结论 **0 blocker、2 major、
11 nit**。两条 major 已修；nit 修了 5 条，其余按下述理由保留。

两轮的审核范围都包含 Go 侧（目录发现、权限阶梯、node hello）与 UI 侧，并明确要求
检查公开仓库的脱敏（真实域名 / 内网地址 / 设备 id / 账号）：两轮均未发现真实基础设施
字符串，`web/dist/assets/` 未被跟踪。

### 第一轮：10 条与处理

| # | 问题 | 处理 |
|---|---|---|
| 1 | 字号阶梯没有自带行高，浏览器按 1.5 渲染，13/14px 的行距和 11px 的一样"松" | `ui/src/design/type.ts` 每个 role 以元组形式自带 `line-height: 1.375`；`LEADING.prose`(1.625) / `flush`(1) 供长文和贴边场景，显式 `leading-*` 仍后置生效。`tailwind.test.ts` 增加两条守护用例（有行盒、显式 leading 能覆盖） |
| 2 | 为了在手机上压高度，工作区/发布面板用了 `!min-h-0 !py-*`，`!` 同时压过 `.kin-btn` 和 `.touch-lg` 的 44px 底线，10 个操作在手机上只有 29px | 全部改成 `md:min-h-0 md:py-*`：桌面保持密度，手机保留触控目标。`mobileLayout.test.ts` 新增守护，禁止 `ui/src` 出现 important 类 |
| 3 | Agents 在手机上把桌面表格硬塞进 390px：动作列被挤出屏幕，四个链接竖着堆 | 手机改为 `MobileCard`/`MobileRow` 列表 + `…` 打开 action sheet；桌面表格与手机 sheet 共用同一个 `agentActions(a)`，两个布局无法各说一套 |
| 4 | 分区标题在桌面是 micro-caps、在手机也是 11px 大写，读起来像标签而不是标题；页面 `<h1>` 与 shell 的 `MobileHeader` 在 `sm`–`md` 之间重复 | 桌面保持 micro-caps，手机用 `max-md:text-subtitle` 正常大小写；页面标题统一 `text-hero font-bold`；手机上由 shell 的 h1 承载页面名，页面自己的 h1 `hidden md:block` |
| 5 | 中文排版细节：`<html lang>` 恒为 `en`、中英文冒号混用、文案里用 `...` 而不是 `…` | `i18n/index.ts` 维护 `lang`（`zh-Hans`/`en`）并在 `setLocale` 同步；新增 `common.labelSeparator`（`：`/`: `），7 处调用点改用它；两本语料里的 `...` 全部换成 `…`；`locales.test.ts` + 新增 jsdom 测试 `documentLang.dom.test.ts` 守护 |
| 6 | 手机上模型/权限选择仍是原生 `<select>`（iOS 弹系统滚轮，关闭态是灰盒子，绕过设计 token） | 抽出 `SheetSelect`（Ionic action sheet），`sm:hidden` 与原生 select 并存；新增 `bordered` 属性用于 composer 里的拼接控件；宽度上限移到调用点，避免两个 arbitrary 值互相抢顺序 |
| 7 | 页面标题字重不统一（18px semibold / 24px semibold 混用） | 所有页面 `<h1>` 统一 `text-hero font-bold`；Agents 的指标数字刻意保留 semibold（数字不是标题） |
| 8 | 加载骨架和真实布局不一致，数据到达时整页跳动 | `TaskTableSkeleton` 按真实表格行高画；Agents 骨架改成 4 个统计块 + 图表块 + 列表块 |
| 9 | 长 id / 长 URL 撑破容器（`break-all` 会把中文也拆开，`break-words` 不收缩固有宽度） | 设置页 5 处 `break-all` → `[overflow-wrap:anywhere]`；任务标题链接同理，实测 390 宽时状态 chip 回到卡内（此前被一个 ULID 顶出 23px）；agent 列 `whitespace-nowrap` |
| 10 | 桌面表格列宽 / 手机表格列显隐的零散问题 | 状态列 `max-md:w-[1%]`、agent 列 `nowrap`、表头在手机上隐藏 |

### 第二轮：2 条 major（已修，均反向验证）

1. **`node.go` 的模型数没有上限**（`internal/server/node.go`）。Hub 的 hello 校验
   拒绝 `Models > worker.MaxModels`（64）的 agent，而节点只会记一行日志然后无限重试——
   一个大目录网关会让这台机器在所有手机上彻底消失，且屏幕上没有任何解释。现在在
   `nodeAgents` 里按 CLI 自己的顺序截断到 64；不抬高协议上限，因为那只会把拒绝推给
   旧版 Hub。新增 `TestNodeHelloClampsALargeModelCatalog`。
2. **`claudeModels` 的回退条件错了**（`internal/adapter/claudecode/models.go`）。别名阶梯
   原本是"列表为空"时的回退，而 `settings.model` 先一步入列——于是一个在
   `settings.json` 里钉了默认模型的普通安装只剩一行，正好又是本轮要修的
   "目录不全"。改为按"有没有 picker"分支：没有 picker 时三档别名是真实可选值，
   钉默认不应把它们挤掉。新增
   `TestClaudeModelsKeepsTheAliasLadderWhenOnlyADefaultIsPinned`。

两条都做了红验：把实现改回旧行为，新测试分别报 `ids = [sonnet]` 与
`has too many models`；恢复后全绿。

### 第二轮：nit 的处理

已修：

- 删掉重复的 `claudeEnvLookup`/`claudeSettingsEnv`，统一为 `claudeLookup(env)`，环境变量
  优先级只剩一处实现。
- important 守护的正则漏掉了 `!hidden`（无连字符）、`!-mt-4`（以连字符开头）、
  `![min-height:0px]`（以方括号开头）。改为先取字符串字面量、再按 token 形状过滤，
  并把这三种写法写进自测；用探针文件反向验证会失败。
- `SheetSelect` 的 `aria-label` 用了写死的 ASCII 冒号，改为 `common.labelSeparator`。
- Agents 的 `…` 按钮补 `aria-haspopup="dialog"` / `aria-expanded`。
- 手机 Agents 列表去掉了与 shell 标题重复的 `MobileSection` 标题。

保留（附理由）：

- **`SheetSelect` 不再自带 `max-w`**：两个 arbitrary 宽度值谁生效取决于生成顺序，
  之前 120px 只是碰巧。宽度属于调用点，基类只留形状；已在属性注释里写清契约。
- **单档权限仍渲染成选择器**（如 `pi-acp` 只有"询问"）：控件同时承担"当前模式"的
  展示职责，改成静态文字会丢掉这层信息；单档 agent 本来也不会弹出有意义的选项，
  留作后续。
- **`agentActions` 没有单测**：它已是手机 sheet 与桌面表格的唯一来源，页内不可能
  漂移；要测需要把页面内部函数导出，收益不抵暴露面。
- **`overflow-wrap: anywhere` 需要 Safari 15.4+**：iOS 壳跑在现代 WebView 上，
  不为更老版本保留 `break-all`（那会拆开中文）。
- **Agents 桌面表格在 984px 卡片里仍横向滚动**：这是仓库对数据表的既有取舍
  （低于最小宽度时滚动而不是压碎列），本轮不改。

### 验证

- `npx tsc --noEmit` 干净；`npx vitest run` 900/900（89 个文件）；`npm run lint`
  0 error（16 条既有 warning）；`npm run build` 成功并更新 `web/dist/index.html`；
  `npm run check:api` 干净。
- `go vet ./...` 干净；`go test ./...` 全通过（`internal/remote` 有一次端口竞态导致的
  偶发失败，单包重跑通过）。
- 浏览器实测（390 与 1280）：`/tasks` 状态 chip 回到卡内；Agents 手机列表 + sheet
  （Claude Code → 设为默认 / 复制安装命令 / 复制更新命令 / 取消）；composer 的
  权限 / 会话主持 / 模型三个 chip 都打开 sheet，Claude Code 的模型表 47 项 + 默认 +
  自定义；桌面表格动作不变；设置页手机分区标题 16px 正常大小写、桌面仍 micro-caps，
  h1 为 28px/700。
