# dogfood 反馈：第一个会话就失败、手机端整修、agent/模型/权限收口

> 来源：2026-10-27 用户 dogfood 反馈（三条）。范围是一次「一类问题」的修复，不是单个补丁：
> 同一个根因（界面把机器执行不了的选择递给了机器）在 agent、模型、权限、工作目录四处分别出现。
> 交付：远端机器的首次会话不再必然失败；手机端每个列表页只有一个标题、主要按钮 44px、
> 表格不再横向裁切；agent 列表一个产品一条；模型列表来自目标机器；权限只列目标机器会执行的档位。

## 1. 第一个会话为什么失败

`kin-dogfood-smoke` 的第一次会话报 `this machine does not run dispatched turns ...`。

链路（Hub 任务 `01M5YM8FCWKXHMK28DARB5ZP7E`）：

1. Hub 把 turn 派给 Mac 节点，`agent=claude-acp`、`permission_mode=yolo`。
2. Mac 节点是 `supervise --hub` 启动的，没有 `--allow-yolo`。
3. `internal/node/executor.go` 的规则：适配器在该模式下会绕过全部审批、而节点没被允许时，
   拒收整个 turn —— 因为对没有审批通道的 agent 来说 `accept_edits` 和 `yolo` 是同一件事
   （`adapter.AutoApprovesAll`）。

为什么界面会选出这个组合：

- **远端机器没有默认 agent。** hello 里只有 `available`，没有 `is_default`；UI 在
  「可用的里面取第一个」，按 id 字母序正好是 `claude-acp`。
- **界面不知道远端能执行哪些权限档位。** 权限是会话级偏好，存在 localStorage，跨机器沿用；
  节点也从没说过自己会不会拒。
- **agent 列表把同一个产品的两种接法当成两个条目。** `claude-code`（原生）和 `claude-acp`
  并列，用户看不出区别，更看不出哪个有模型列表。

三处一起修，缺一处都还会以别的形式复现。

## 2. 改了什么

### 2.1 节点把自己的能力说全（backend）

| 改动 | 位置 |
|---|---|
| hello 的 `agents[]` 增加 `name` / `kind` / `family` / `transport` / `permission_modes` | `internal/remote/worker/protocol.go` |
| `family` / `transport` 的归类规则（`claude-code`+`claude-acp` → `claude`，依此类推） | `internal/agent/catalog.go`（新） |
| 节点按执行器同一条规则裁剪权限档位：会绕过审批且没 `--allow-yolo` 的档位不广告；**每个模式都绕过的 agent 直接标为不可用**并给出原因 | `internal/server/node.go` |
| 每台机器一个 `is_default`：按注册表优先级取第一个真正能接单的 | 同上 |
| `device_agents` 增加 `name/kind/family/transport/permission_modes`，走 `ensureCurrentSchema` 幂等补列（对空库和已有库都测过迁移） | `internal/store/migrate.go`、`device_registry.go` |
| `/api/devices`、`/api/machines` 原样透出 | `internal/api/node.go`、`internal/api/devices.go` |

协议校验：元数据长度上限、`permission_modes ≤ 3` 且只允许 `default|accept_edits|yolo`。

### 2.2 界面不再递出执行不了的选择（UI）

- **家族折叠** `ui/src/lib/agentFamilies.ts`：一个产品一条；可用优先，其次 原生 > ACP > CLI。
  `/agents` 仍显示原始列表用于诊断。
- **模型列表来自目标机器**：`catalogFor` 把 `models[]` 变成选择器条目；任务详情页用任务
  所在机器的模型，而不是本机注册表。
- **权限按机器广告裁剪** `permissionModesForAgent`：本机全开；远端只留对方声明的档位；
  对方没说（旧节点 / 解析不到的 agent）只给 `default` + `accept_edits`，不给 yolo。
  任务带了 device id 但列表里查不到（被撤销，或列表还没加载）按远端处理——「看不到」不等于
  「就是本机」。`NewChatPage` 和任务详情 composer 都会把不合法档位夹回 `default`，且不覆盖
  用户存下的偏好（只有用户主动改档才写回 localStorage）。
- **工作目录与机器对账** `cwdOnMachine`：草稿把目录和机器分开存，reload 后会出现
  「本机路径 + 远端机器」——git 分支请求 409，真发出去会被节点拒。现在远端机器已知且声明了
  roots 时，不在 roots 内的目录换成第一个 root；只在**换机器时**对账一次，否则输入到一半的
  路径会被弹回，输入框也没法清空。
- **权限选择器 `flex-none`**：composer 底行本来允许横向滚动，但可收缩的项会先被压成一个字，
  和旁边 chip 的文本叠在一起。

### 2.3 手机端基础整修

页面共 14 个（`/new`、`/sessions`、`/inbox`、`/tasks`、`/tasks/:id`、`/artifacts`、
`/artifacts/:id`、`/projects`、`/projects/:id`、`/agents`、`/routines`、`/settings`、
`/agent-sessions/:id`、`/design` 内部页），另有托盘页与 4 条重定向。

| 问题 | 修法 |
|---|---|
| 列表页手机端两个标题（shell 栏 + 页面 h1） | shell 栏接管 `/agents /tasks /artifacts /projects /routines` 的标题；页面 h1 只在 `md+` 出现 |
| 类型梯子偏小（正文 12–13px） | `ui/src/design/type.ts` 整体上调：micro 11 / caption 12 / body 13 / strong 14 / subtitle 16 / title 18 / hero 24 |
| 触控目标低于 44px | 筛选 chip（任务、产物）、例行任务卡片操作、搜索框等按 `min-h-11 sm:min-h-9/8` 统一 |
| 任务表在 390px 下状态 chip 竖排、费用列被裁 | 手机只留 任务/状态；费用与删除列 `sm+`，删除在详情页仍有；chip `whitespace-nowrap` |
| Agents 表在 390px 下横向滚动、操作列在屏外 | 手机只留 Agent/状态/操作，费用列 `md+`；名称列 `md:min-w-cell`；实测 358px = 容器宽，无横向滚动 |
| 例行任务卡片头挤压 | 卡片头竖排到 `sm`，状态徽章 `shrink-0 whitespace-nowrap` |
| 路由切换生硬 | 140ms 仅透明度的 `.kin-main > *` 入场；不用 transform（会让 fixed 浮层改挂 containing block）；`prefers-reduced-motion` 下关闭 |
| 任务状态英文原样透出 | 补齐 `tasks.statusRunning/Queued/Failed/Canceled` 中英文案与失败红色样式 |

## 3. 验证

- `go test ./...`（一次 `internal/github` 的时序用例在全量并发下超时，单跑通过；与本改动无关）、
  `go vet ./...`、改动包 `gofmt`。新增的迁移测试做过反向验证：注释掉补列调用后，测试以
  `no such column: name` 失败。
- UI：`vitest run` 87 文件 / 882 用例；`npm run build`（tsc + vite）；lint 0 error；
  prettier 已对改动文件执行。
- 真机尺寸走查（fixture daemon + Vite，390×844 与 1280×900）：
  `/new` 控制面板切到远端机器后——agent 只剩 Claude Code / Codex（`claude-acp` 折叠），
  Claude Code 的权限只有 询问/自动编辑，切到 Codex 才出现 YOLO；模型列表跟随 agent；
  草稿里的本机路径 reload 后自动换成该机器的 root。
  列表页逐个截图核对（任务、产物、Agents、例行任务、会话、收件箱、设置、项目、任务详情）。

## 4. 留到后面

- 设置页 tab 条在 390px 下横向滚动，最后一项半露，可加渐变遮罩提示。
- `ApprovalsPage` 空态同时出现「没有待审批项」小字与空态卡片，语义重复。
- 消息内「重试/分叉/复制」是文字链大小（约 22px），手机端常显；若要满足 44px 需重排转录操作区。

## 5. 第二轮：手机端改用 Ionic 作为设计语言

> 用户反馈：上一轮仍是逐个按钮调尺寸，最后和截图一样难看；问能否直接用开源的移动设计语言。
> Lody 的做法是 Ionic + Tailwind，这里取同一半：**交互用 Ionic，视觉仍由 console 的 token 决定**。

- **为什么是 Ionic**：选择器/操作表在 iOS 上的正确形态（动作表、安全区、44pt 行高、
  点外部关闭、返回焦点）是平台行为，不是配色；自己画等于每次都在重学这些细节。
  只引 `@ionic/react/css/core.css`，`setupIonicReact({ mode: "ios" })`，全平台统一 iOS 观感。
- **不引 `structure.css`**：它带 `body{position:fixed;height:100%;overflow:hidden}` 的全局重置，
  会把 `ConnectScreen` / `AccountScreen`（渲染在 AppShell 之外、依赖文档滚动）在矮屏上裁掉。
  实测 390×500 下移除后文档可滚动（scrollHeight 618 > 500），body 为 `static`。
- **`SheetSelect`**（`ui/src/components/ui/SheetSelect.tsx`）：一个紧凑 chip + `IonActionSheet`，
  手机端的模型/权限选择都换成它；选中项由 `.kin-sheet-selected` + `aria-current` 标记
  （Ionic 只为 radio 角色画选中态，而 radio 点完不关面板）。
- **会话页头部溢出菜单**：文件 / PR / 停止 / 删除会话在 <md 收进 `...` 动作表，md+ 仍是原来的 chip。
- **composer 底行**：手机只留权限 + 模型，cwd / 仓库 / 分支 / 机器名用 `hidden md:contents` 包起来，
  桌面布局不变；机器名没有别处可看，所以会话操作表的 `subHeader` 会写明「运行在 …」。
- **评审修掉的两处**：Ionic 的破坏性行用自带的 `#c5000f`，在暗色面板上只有 2.24:1——改为
  `--ion-color-danger: rgb(var(--kin-red-ink-rgb))`（6.10:1 / 5.26:1）；自定义模型时 sheet 收到的是
  原始 id，匹配不到任何条目（选「自定义」时 `""` 还会点亮「默认」行），改为与桌面 `<select>`
  相同的 `__custom__` 哨兵，并加了 `ModelPicker.dom.test.tsx` 钉住这个契约（旧代码上确认为红）。
- **代价**：`@ionic/react` 的 barrel 会把所有自定义元素一起注册，入口 chunk 约 2.0 MB / 506 KB gzip
  （增加约 855 KB 原始 / 181 KB gzip）。后续若要瘦身，可只手写这一个动作表，但会失去平台的
  关闭/安全区行为——先记在这里，不作为本轮范围。
