# KIN-SETTINGS-001 · 改默认设置

状态：covered
签字：2026-11-17 CEO 代签（用户授权见 rsi/DECISIONS.md 2026-11-15；决定见 rsi/state/decisions-pending.md 2026-11-17 18:05 行）。设计页与 5 张帧已读；登记的可执行测试见 registry。
优先级：P1
旅程：J6
归属面：`IA.md`「设置与环境」
面：Mac、手机

## 谁、什么时候、为什么

当我常用某个 agent、模型或这台机器，我想在设置里一次改好默认值，以便新建对话时不用每次重选，也不想在设置页里翻半天才找到那一项。

## 现在

设置页分组多：provider、本地 agent、角色、路由、价格表各占一块（`ui/src/components/settings/`），改一项要先进对分组。Mac 和手机是同一套排版，手机上挤。改完没有一句话说明"下一次新建对话会用上"，要自己回去试。

截图：`07-settings-1280.png`、`12-settings-390.png`。

## 范围

- 做：打开设置 → 找到分组 → 看当前值和影响 → 改 agent / 模型 / 设备 / 权限默认 → 保存或测试连接 → 返回后新建对话用上新值。
- 不做：新增 provider 类型；账号体系；OAuth scope 变更；推送和手机配对（控制台不再有这两个面，见 `KIN-NOTIFY-001`）；存储 schema 变更。

## P8 结算（2026-11-18）

| 默认 | 今天存在哪 | 新建对话怎么用上 | 证据 |
|---|---|---|---|
| agent | 服务端 settings 键 `agent.default`（设置 → Providers） | `/new` 通过共享机器快照读到被标记为 default 的 agent | `SettingsPage.defaultAgent.dom.test.tsx` 第 3 例；J6 走查：`/settings?tab=providers` 选中含 `(codex)` 的选项 → 保存 → `/new` 的运行设置 `aria-label` 读出 `Codex`（两个宽度），再改回 `claude-code` 并读回 `Claude Code`。红证：把 `NewChatPage.tsx:358` 临时改成 `available[0]`，只有 `/new` 的 Codex 断言变红 |
| 模型 | 客户端 `localStorage` 键 `kin_draft_model`（`ui/src/lib/draftChat.ts`） | `NewChatPage.tsx:168` 播种 | `NewChatPage.dom.test.tsx` 的 “keeps the chosen model when the page is left and opened again” |
| 设备 | 客户端 `localStorage` 键 `kin_draft_machine`（`draftChat.ts`） | `NewChatPage.tsx:170` 播种 | `NewChatPage.dom.test.tsx` 的 “starts a remote run with that machine and its own directory” |
| 权限 | 客户端 `localStorage` 键 `kin_permission_mode`（`ui/src/lib/permissionMode.ts`） | `NewChatPage.tsx:154` 播种 | `permissionMode.test.ts` 的 “keeps the last chosen mode for the next draft” |

后三项今天不是设置页的行，与本故事「范围」和 `IA.md` 设置与环境一行不符。若把它们提升为设置项，最小增量形状是三个服务端 settings 键加三行（Providers / 通用），由 `NewChatPage` 走现有 settings 读取播种——本次不建。

2026-11-19 J6 真机走查补齐 agent 行的「新建对话怎么用上」并按上面的红证转红：故事翻 `covered`。模型 / 设备 / 权限三行仍是客户端草稿键，不因此建设置行。

## 每一步的预期

### 1. 定义 / 打开：我要改一个默认

| 项 | 预期 |
|---|---|
| 起点 | Mac 左栏底部图标，或手机 K 面板的"设置" |
| 动作 | 打开设置 |
| 立刻看到 | 分组的目录：通用、Agents、Providers、路由、高级，加一行运维（`?tab=operations`，归 `KIN-AGENTS-001`）；当前值以摘要形式挂在组名旁边 |
| 慢 / 空 / 失败 / 断线 | 设置加载出骨架；读不到时显示"设置读取失败"和重试，不显示空表单；断线时顶部提示，已加载的值仍可看 |
| 键盘与焦点 | Mac：Tab 进目录，↑/↓ 换组；手机：点组进详情 |
| 离开再回来 | 回到上次停留的分组 |

### 2. 定位：找到对应的那一组

| 项 | 预期 |
|---|---|
| 起点 | 设置目录 |
| 动作 | 点一组 |
| 立刻看到 | 组内是若干行：名称、当前值、一句说明它影响什么（例如"新建对话默认用这个 agent"） |
| 慢 / 空 / 失败 / 断线 | 某组加载失败只影响这一组 |
| 键盘与焦点 | Mac：点组后焦点进组内第一行；手机：返回回到目录，目录位置不变 |
| 离开再回来 | 分组和滚动位置保留 |

### 3. 准备：先看清当前值和影响

| 项 | 预期 |
|---|---|
| 起点 | 某一组 |
| 动作 | 看一行，不点开 |
| 立刻看到 | 当前值、来源（用户设的 / 默认 / 从环境读到）、以及"影响下一次新建对话"之类的说明 |
| 慢 / 空 / 失败 / 断线 | 来源不明时写"未知"，不猜；密钥类只显示"已配置 / 未配置"，不显示值 |
| 键盘与焦点 | 说明文字和控件关联，读屏能读到一起 |
| 离开再回来 | 不变 |

### 4. 执行：改一个默认值

| 项 | 预期 |
|---|---|
| 起点 | 某一组的一行 |
| 动作 | 选新的 agent / 模型 / 设备 / 权限；或填一个地址、密钥 |
| 立刻看到 | 选择器贴着这一行外弹（不撑高页面）；选中后这一行的当前值立刻变，页面顶部不跳 |
| 慢 / 空 / 失败 / 断线 | 选项加载中显示"加载中"；保存失败恢复旧值并说明；密钥缺失时指出缺哪一个，不回显 |
| 键盘与焦点 | Mac：↑/↓、Enter、Esc 关闭并把焦点还给这一行；手机：选择器盖在当前页上，选完关闭 |
| 离开再回来 | 已保存的值还在；没保存的改动在离开时提示或丢弃，不静默保留 |

### 5. 修改：测试连接、刷新、改回来

| 项 | 预期 |
|---|---|
| 起点 | 改完 provider 或设备相关的一项 |
| 动作 | 点"测试连接"或"刷新"；或改回原值 |
| 立刻看到 | 测试中按钮显示进行中；成功写"连接正常"，失败写提供方自己的话（不是 HTML 页面，见 `fff2c11d`） |
| 慢 / 空 / 失败 / 断线 | 测试超时说"超时，稍后再试"，不一直转；断线时测试不可用并说明 |
| 键盘与焦点 | 测试结果出现后焦点留在按钮上，读屏能读到结果 |
| 离开再回来 | 测试结果不持久化成"已连接"状态；只有保存的值才影响新建对话 |

### 6. 监控：保存、密钥、断线

| 项 | 预期 |
|---|---|
| 起点 | 改动之后离开或继续改 |
| 动作 | 看页面反馈 |
| 立刻看到 | 保存成功是一条轻提示"已保存"；失败是这一行下面的一行红字，不是整页弹窗 |
| 慢 / 空 / 失败 / 断线 | 断线时改动进本地队列或禁用保存，二者取一并说明；恢复后不重复提交 |
| 键盘与焦点 | 轻提示不抢焦点；红字和输入框关联 |
| 离开再回来 | 没保存成功的改动能看出来是未保存，不假装成功 |

### 7. 收尾：新建对话用上新默认

| 项 | 预期 |
|---|---|
| 起点 | 改完默认值 |
| 动作 | 返回，打开新建对话 |
| 立刻看到 | 新建页的运行设置已经是新默认值；旧的对话不受影响，仍用各自的值 |
| 慢 / 空 / 失败 / 断线 | 新默认值加载慢时显示"加载中"，不悄悄退回旧值 |
| 键盘与焦点 | 返回后焦点回到打开设置前的那个控件或列表行 |
| 离开再回来 | 重开应用，新默认值还在 |

## 各面差异

| 面 | 这一面怎么呈现 | 为什么不同 |
|---|---|---|
| Mac | 左目录右内容，一屏能改多项；选择器贴行外弹；保存就地生效 | 窗口宽，适合并排 |
| 手机 | 目录 → 详情两级；选择器盖在详情上；改动在返回时统一保存或提示 | 一屏只能放一件事；手指没有悬停 |

## 设计

设计页：`KIN-SETTINGS-001.review.html`（Figma-first，2026-11-17 已读并签字），5 张帧：

- `KIN-SETTINGS-001.figma/frames/01-mac-directory.svg`（Mac 目录与通用组）
- `KIN-SETTINGS-001.figma/frames/02-mac-picker.svg`（Mac 选择器与未保存）
- `KIN-SETTINGS-001.figma/frames/03-phone-directory.svg`（手机通用即目录）
- `KIN-SETTINGS-001.figma/frames/04-phone-group.svg`（手机组详情与选择器）
- `KIN-SETTINGS-001.figma/frames/05-state-board.svg`（七种状态与文案检查表）

必须画到的状态：默认、空（没有 provider）、加载、失败、断线、未保存、测试连接中。

## Do not

- 打开设置时不读安全存储里的密钥、不调用第三方接口；只显示"已配置 / 未配置"（`AGENTS.md` 外部集成 UX 门）。
- 不新增 provider 类型，不改 OAuth scope；要改先对照提供方文档并加 scope 回归测试。
- 不改 schema；不改 `kin_permission_mode`。
- 不把选择器做成内嵌展开或原生 select（`TASTE.md` 第 14 条）。
- 不在设置页里加账号、订阅、团队这类新功能。

## 验收

| 层级 | 位置 | Given / When / Then |
|---|---|---|
| 组件 | `ui/src/components/settings/SettingsPrimitives.test.ts`、`ui/src/pages/SettingsPage.facade.dom.test.tsx`（已有，扩充） | Given 1100 宽 When 打开设置 Then 左目录右内容、当前值摘要可见；Given 手机宽度 Then 是 目录 → 详情 两级；打开设置时没有读取密钥的请求 |
| 回归 | `ui/src/components/settings/ProviderSettingsSection.test.ts`（已有） | Given 已配置的 provider When 渲染 Then 只显示已配置，不回显密钥 |
| 组件 | `ui/src/components/settings/LocalAgentSettingsSection.dom.test.tsx`（已有，扩充） | Given 改模型 When 选择器打开 Then 贴行外弹、页面高度不变；选完值更新 |
| 真浏览器 | 1100 和 390，`/browse` | 改一个默认值，返回新建页看到新值；设置页打开时网络面板没有第三方请求 |
| 视觉 | 390 / 1100 截图 | 1100 对照 `07-settings-1280.png`；390 对照 `12-settings-390.png` |

## 证据

- 之前：`07-settings-1280.png`、`12-settings-390.png`
- 之后：`J6` 真机走查（`bash rsi/runtime/ux-walk.sh <worktree> <out> J6`，phone 390×844 / mac 1100×760）：`J6-{phone,mac}-04-default-agent-row`、`J6-{phone,mac}-05-new-chat-host`，`walk.json` 的 `hardFail` 为空

## 变更记录

- 2026-10-30 从"设置与环境"意图写成第一条故事
- 2026-11-11 R0b-3 删掉远程与通知两个 tab；本合同的目录与验收随之只覆盖保留下来的五组
- 2026-11-17 CEO 代签（D1–D8 已定）；设计页 5 帧；验收改指真实套件
- 2026-11-18 P8 结算：四个默认各自的落点入档；模型 / 设备 / 权限仍是客户端草稿键，不建设置行
- 2026-11-19 J6 补 agent 默认的保存 → `/new` 走查（含改回 `claude-code` 的还原步骤），红证只红 `/new` 断言；故事翻 `covered`
