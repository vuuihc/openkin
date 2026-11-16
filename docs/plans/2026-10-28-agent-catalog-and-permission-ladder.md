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

## 4. 模型选择器：可搜索，两端一致

### 诊断

第 1 节把 47 个模型读全了，但控件没有跟上：桌面是原生 `<select>`，47 行只能滚动找；
手机是 Ionic action sheet，同样只能滚。对照 Lody 的运行配置 sheet，它的模型选择是
**带搜索框的列表**，有 Default、当前项勾选，手机与桌面同一个形状。这不是"再多一个
下拉框"，而是目录长度变了之后控件的形状错了。

### 做法

新增 `ui/src/components/ui/SearchSelect.tsx`：一个 chip（与 `SheetSelect` 同一外形、
同一 `label：值` 的 aria-label），两种面板——

- **`>= 640px`：锚定弹层**。`role="combobox"` 搜索框 + `role="listbox"` 选项
  （`aria-selected`），当前项带勾；ArrowUp/Down/Home/End 移动焦点，Escape 关闭并把
  焦点还给 chip，点外面关闭；打开时把当前项 `scrollIntoView({block:"nearest"})`，
  否则 47 行里选中的最后一项恰好被藏在列表顶部之外。
- **`< 640px`：控制台自己的 `Sheet`**（安全区、遮罩、Escape 都已在里面）。列表故意
  **不用 `role="listbox"`**：`Sheet` 的 Escape 处理把面板内任何 `[role="dialog"]` /
  `[role="listbox"]` 当成压在上面的弹层而拒绝关闭，嵌一个 listbox 会让这张 sheet 成为
  控制台里唯一按 Escape 关不掉的那张。手机用普通按钮 + `aria-current`，桌面用
  combobox/listbox，各按各的平台惯例。

搜索同时匹配 label、id、tier——`volcengine` 能找到 label 里没有这个词的
`DeepSeek V4 Flash · volcengine-gw`。两个面板共用同一个 `Chooser`，勾选状态不可能
两边不一致。

调用点：`AgentModelPicker`（composer 的 joined 控件）的 agent 与 model 都换成它
（agent 列表短，`searchable={false}`）；`ModelPicker` 的 compact / 完整两个分支同样
替换。joined 控件去掉了 `overflow-hidden`——它会把弹层裁在控件边缘。i18n 新增
`modelPicker.searchPlaceholder` / `searchEmpty` 与 `common.noResults`，中英同步。

### 审核与修复

同模型只读复审跑了两轮（不走 Codex 网关）。第一轮 1 blocker、3 major、8 nit；
第二轮 0 blocker、1 major、7 nit。全部处理：

| 轮次 | 严重度 | 问题 | 处理 |
|---|---|---|---|
| 一 | blocker | 桌面弹层用 `absolute` 定位，而触发点常在 `overflow-x-auto` 的控件行里（`TaskDetailPage` 的 composer 行就是）。CSS 规定 `overflow-x: auto` 会把 `overflow-y` 也算成 `auto`，弹层被 30px 高的行裁掉；任务页的弹层朝上开，正好落在行的不可滚动上溢出区，等于完全不可见 | 改为 `position: fixed` + 量测锚点（沿用 `BranchPicker` 的方案）：`useLayoutEffect` 量触发点，`resize` 与**捕获阶段** `scroll` 重新定位，`z-50`，宽 288、离边 8px、高上限 `min(360, 真实剩余空间)`；首选方向放不下时翻到另一侧。面板仍是 `hidden sm:block` 的后代，窗口变窄时另有 `matchMedia("(min-width: 640px)")` 关闭并卸载监听 |
| 一 | major | `triggerClass` 里的 `max-w-full` 在产物中排在所有 arbitrary `max-w-[…]` 之后，把调用点的宽度上限全部压掉（长模型 id 会撑开 joined 控件） | 基类不再带宽度上限，调用点各自给（7.5 / 10 / 14rem）。实测 `getComputedStyle(chip).maxWidth` 为 120px，不再是 100% |
| 一 | major | 选中后焦点掉到 `<body>`，下一次 Tab 从页面顶端开始 | 桌面弹层选中后把焦点还给 chip（Escape 路径原本就还） |
| 一 | major | 键盘路径没有测试 | 新增用例：ArrowDown 进列表、ArrowUp 回搜索框、Home/End、Enter 选中并还焦点，以及 Tab 离开时关闭 |
| 一 | nit ×8 | 空结果在 listbox 内、桌面选项占 Tab 序、detail 断言不独立、手机列表顶掉搜索框、哨兵与选项拼装重复、未使用的 `placeholder`、coarse-pointer 注释失真 | 见 `SearchSelect`：常驻 `role="status"`、`tabIndex={-1}`、fixture 拆分、`max-h-[60dvh]`、`lib/agentModels` 四个共享助手、删属性、改注释 |
| 二 | major | **WebKit 下鼠标点行选不中**：Safari 不在鼠标点击时给按钮焦点，行上的 mousedown 先让搜索框 blur，`relatedTarget` 为 `null`；把它当成“焦点离开面板”会在 mousedown 阶段卸掉面板，`click` 没有落点。Chromium/Electron 和手机 sheet 都不受影响，所以测试与日常都看不到 | `relatedTarget` 为 `null` 时不再关闭（真实焦点移动一定带 `relatedTarget`），并给行加 `mousedown` 的 `preventDefault`（combobox 的标准做法：焦点留在输入框，行只是目标）。Playwright 真引擎复验：WebKit 2248 与 Chromium 1208 都能点中并更新 chip |
| 二 | nit | 搜索框里按 Enter 没有反应（必须先按一次 ArrowDown） | Enter 取第一行；同时两个键盘处理器在 IME 组词期间（`isComposing`）直接返回，中文候选词不会再被 ArrowDown 抢走 |
| 二 | nit | 常驻 live region 不存在，`role="status"` 与文案同批挂载，读屏可能不播报 | 状态节点从一开始就在，有结果时 `sr-only`、无结果时换成可见文案 |
| 二 | nit | 触发按钮没有 `aria-controls`；手机端注释谎称“上面没有输入框” | 打开时指向列表 id；注释改为真实取舍：手机行保持可 Tab 是因为 sheet 的焦点陷阱由这些行构成，触控才是那张面板的主路径 |
| 二 | nit | `Sheet` 是 `md:hidden`，但越过断点后仍挂载，Escape/Tab 陷阱继续吃页面按键 | 修在 `Sheet` 本身（所有调用者受益）：`matchMedia("(min-width: 768px)")` 命中即 `onClose`，并加 `Sheet.dom.test.tsx` |
| 二 | nit | `detail: m.tier` 会显式写出 `undefined` 键 | 条件展开 |
| 二 | nit | 模型列表无条件 `searchable`，与“四行不要搜索框”的自述规则冲突 | 保留：同一个控件不该因为网关目录长短而换形状；短目录下搜索框只是多一行，不误导 |

保留：`ModelPicker` 不可达的非 compact 分支（删它属于另一件事）；`common.noResults`
作为 `emptyLabel` 的兜底文案；手机行保持 Tab 可达（见上表）。

### 验证

- `npx tsc --noEmit` 干净；`npx vitest run` 915/915（91 文件）；`npm run lint`
  0 error（16 条既有 warning）；`npm run build` 成功且两次构建产物哈希一致。
- `SearchSelect.dom.test.tsx`（11 条）：按 label / id / detail 三种来源过滤、空结果
  用 `role="status"`、`aria-controls` 指向列表、当前项标记、选中后回调并还焦点、
  Escape 关闭并还焦点、方向键 / Home / End / Enter、Enter 在搜索框取第一行、Tab 离开
  即关闭、**WebKit 的 `null` 失焦不关面板**、手机 sheet 内**没有** listbox 且 Escape
  能关、短列表不出现搜索框。`agentModels.test.ts` 新增 3 条哨兵用例，
  `Sheet.dom.test.tsx` 新增 2 条断点关闭用例。
- 反向验证（每条都确认新测试会红）：去掉“选中后还焦点”→ 断言变成 `<body>`；
  去掉 `focusout` 监听 → Tab 用例留下关不掉的 listbox；把 `null` 失焦改回“关闭” →
  WebKit 用例在点击前就丢了列表；删掉 Enter 分支 → Enter 用例无回调；把 `Sheet` 的
  断点判断改成恒假 → 断点用例失败。
- 浏览器实测（独立临时 daemon，真实 47 项目录 + 该机全部 agent）：
  - 1280 桌面：弹层 288×360 开在 chip 上方，全在视口内；`position: fixed`。
  - **blocker 复现**：用 JS 把 chip 包进一个 30px 高、`overflow-x:auto` 的 div（与
    `TaskDetailPage` 的控件行同构），弹层底边 806 位于该行顶边 807.5 之上，
    `elementFromPoint` 命中弹层内的搜索框——即真的画出来了，而不是被裁掉。
  - 390 手机：「模型」sheet 49 行（默认 + 47 + 自定义），列表自身 506px
    （60dvh）滚动，滚到底后搜索框仍在原位；搜索 `kimi` 收敛到 2 行；选中
    `Kimi K3 · volcengine-gw` 后只关内层 sheet、chip 更新，Escape 把焦点还给 chip
    且外层「这次怎么跑」仍在。
  - 键盘（1280 实机）：Enter 打开并把焦点放进搜索框，方向键落到选项，Enter 选中、
    chip 更新、焦点回到 chip。
  - **WebKit 2248 / Chromium 1208 真引擎**：打开弹层（`pointer: fine`，搜索框自动
    聚焦）→ 鼠标点 `Kimi K3 · volcengine-gw` → chip 更新、面板关闭，两端一致。
  - 控制台 0 error / 0 warning。


### 遗留（下一轮）

- **手机上的模型名仍是 id**：Hub 的 `device_agents.models` 只存字符串数组
  （`worker.Agent.Models []string`），label 在本机 `/api/agents` 有、过 Hub 就丢了，
  手机上显示 `deepseek-v4-flash[1m]` 而不是 `DeepSeek V4 Flash · volcengine-gw`。
  要修需要给 worker 协议加 label 字段 + `device_agents` 加列 + Hub API 透传，属于
  跨层改动，单独一轮做。
- **推理档位与角色**：Lody 的 sheet 还有「推理」（ACP `configOptions` 的
  reasoning effort）与「角色」（带提示词的运行配置预设）。Kin 的 adapter 契约目前
  没有这两个概念，按 PRINCIPLE §5.5 先不硬编码。
- **最近使用**：Lody 有「最近使用」分组；本轮先做搜索，等模型 id→label 的传输修好
  后再加，否则最近使用记的也是 id。
