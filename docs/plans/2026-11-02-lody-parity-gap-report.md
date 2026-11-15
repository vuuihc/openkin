# OpenKin × Lody 功能与体验差距报告

- 日期：2026-11-02
- OpenKin 基线：`07402786`（`compare-lody-report` 工作树）
- Lody 基线：本机安装版 **0.109.0**（`app.asar`）+ 可读源码 **0.104.0**
- 关联文档：`docs/plans/2026-10-28-lody-common-features-program.md`（第 1–28 轮）、`docs/plans/2026-10-28-phone-parity-with-lody.md`、`docs/plans/2026-10-28-chat-parity-pass-2.md`

一句话定位：**Lody 是面向团队的共享工作台，OpenKin 是面向所有者的自托管控制面。** 两者在“会话主闭环”上已经接近，差距主要在团队化外壳与桌面工作台深度。

## 一页结论

1. **日常主闭环已经基本对齐。** 会话列表 → 打开会话 → 输入/运行配置 → 审批与提问 → 文件/差异 → 例程 → 项目 → 搜索 → 标签页 → 用量 → 分享/通知，这些路径 OpenKin 都有可用实现；按 2026-10-29 的审计口径，没有剩余 S1 阻断项。
2. **Lody 0.109 的领先集中在四块，而不是“到处都强”。** 桌面工作区深度（多标签侧栏、浏览器、iOS 模拟器、富预览、可操作 PR）、输入自动化（队列拖拽/实时引导、会话内定时发送、例程筛选/清理/重试）、Agent 平台管理（MCP 配置与鉴权、记忆、提示快捷键作用域）、移动端与 CLI 的“产品化外壳”。
3. **OpenKin 的优势是所有权与可运维性。** 自托管、无厂商账号依赖、数据留在自己的 Hub/机器、成本/限额/供应商路由透明、artifacts 独立成库、公开只读分享链接、明确的 API 契约，以及已经测量过的较轻 Electron 壳。
4. **最大的 UX 差异不是某个控件，而是入口模型。** Lody 首页是“现在需要我做什么”的 Now 面板；OpenKin 的 `/` 直接回到上次会话，列表才是家。单人多 agent 场景下 OpenKin 更快；多项目、多并发、团队场景下 Lody 的总览更强。
5. **不建议把 Lody 的所有表面都搬过来。** 团队工作区、成员/分享管理、E2EE、订阅计费属于产品方向选择；Lody 0.109 的 E2EE 仍标注为 developer preview，其文案明确说会话、文件、协作与 agent 执行尚未接入，不能当作成熟对标项。
6. **最值得先补的六件事：** 多标签工作区侧栏 + 浏览器面板；PDF/Office/视频预览与可操作 PR；队列拖拽/实时 steer/会话内定时发送；例程筛选/清空已结束/重试；MCP/记忆/提示快捷键管理；移动端原生通知/Live Activities。前四项直接影响每天的编码闭环。

## 等级口径

沿用 `2026-10-28-lody-common-features-program.md` 的 S1/S2/S3：

| 等级 | 含义 |
|---|---|
| S1 | 阻断主闭环，没有替代路径 |
| S2 | 有明显的工作流损失，但有绕行方案 |
| S3 | 打磨、可发现性或特定场景的增强 |

本报告没有发现新的 S1；下面的“差距”默认是 S2/S3。团队协作类单独标为“方向性差异”，不按缺陷计。

## 差异记分卡

| 领域 | Lody 0.109 | OpenKin 当前 | 等级 | 判断 |
|---|---|---|---|---|
| 入口/总览 | 首页 Now 面板：需要你、运行中、已完成、7 天线条、PR、用量 | `/` 回到上次会话；列表 + 收件箱承担总览 | S3 | OpenKin 的“继续上次”更快；多并发时需要轻量 Now 摘要 |
| 会话列表 | 服务端筛选、项目分组、滑动/多选、未读、归档 | 分桶、置顶、归档、删除、状态/归档筛选、搜索、收件箱、滑动/长按 | S3 | 主路径对齐；缺项目/机器/agent 维度筛选 |
| 会话阅读 | 消息操作、置顶消息、goal/plan/PR 芯片、检查点、子 agent 标签 | 转录投影、工具行、子 agent 嵌套、轮次证据卡、retry/fork | S2/S3 | 阅读与证据已强；goal/plan 芯片、置顶消息、子 agent 独立标签仍缺 |
| Composer/运行配置 | 附件、@ 多类对象、`$` 技能、角色/推理/计划/fast、队列 steer/reorder、定时发送 | 附件、@agent+文件、`/` 提示快捷键（角色）、队列编辑/撤回、打断并立即发送、完整运行配置 | S2 | OpenKin 的打断是“中断后重跑”，不是 Lody 的“运行中引导” |
| 文件/差异/预览 | 多标签侧栏、富预览、每轮差异/变更分组、手机差异抽屉、预览标注 | 工作区文件树、Monaco diff、变更文件、轮次证据卡、图片/CSV/Markdown/代码预览、下载兜底 | S2 | 预览格式与侧栏组织是主要差距 |
| 终端/浏览器/模拟器 | 桌面终端、浏览器面板与标注、iOS 模拟器 | xterm 终端、配置与标签；后端有 browserworker，但控制台无浏览器面板；无模拟器 | S2 | 浏览器/标注影响前端与 QA 闭环；模拟器是细分场景 |
| PR/CI | 会话内 PR 面板：review、CI、评论、合并 | 只读缓存 PR 面板 + 刷新；PublishPanel 可建分支/发 PR | S2 | 创建 PR 已对齐，“审查到合并”仍要离开应用 |
| 项目/机器 | 项目组向导、子模块识别、项目说明、项目设置/技能/MCP | 项目多根数据模型、Overview+Chats、recipes、pulse/heatmap/hot modules、关联 artifacts、机器选择 | S2/S3 | OpenKin 的项目洞察是特色；成员/子模块管理深度落后 |
| 例程/定时 | 按项目/状态筛选、清空已结束、重试、打开会话、运行历史、目的地 | 新建/编辑、重复规则、预览、立即运行、暂停/恢复、删除、搜索、历史、已读 | S2 | 缺筛选/清空/重试与会话内定时发送 |
| 搜索 | 服务端会话搜索、会话内查找、命令面板多类搜索 | 服务端列表搜索、会话内查找、每条列表一个搜索、命令面板动作/recipes | S3 | 核心对齐；命令面板不是“万能搜索” |
| 审批/通知 | 浮动审批、提问、推送、原生 Live Activities、细粒度事件设置 | 浮动审批、提问、Web Push/Bark/ntfy、收件箱 needs-you | S2 | 桌面/网页通知够用；移动端原生体验落后 |
| 分享/协作 | 公开/团队分享、分享管理、E2EE 预览、成员/角色 | 公开、可撤销、只读分享链接；无团队工作区 | 方向性 | 单人/自托管边界；是否做协作层是战略选择 |
| 用量/成本 | 用量浮层、上下文环、限额窗口、重置预测 | 用量面板、成本/token、agent 限额、供应商路由、价格表 | S3 | 两者侧重不同；OpenKin 的成本控制更显式 |
| Agent 平台 | agent 配置/角色、MCP 配置/鉴权/工具发现、记忆、提示快捷键作用域与共享 | agent 状态/鉴权/版本/缓存/成本、角色/提示快捷键、供应商/路由、MCP 审批、记忆整理 recipe | S2 | OpenKin 有零件，缺“管理面” |
| 手机/桌面/CLI | 原生移动端 + Live Activities；桌面命令面板/快捷键；丰富 CLI | 响应式 PWA + Capacitor 壳、手机 dock、Web Push；Electron；键盘重排标签；薄 CLI | S2 | 手机主路径已对齐；原生外壳与 CLI 仍是平台级差距 |

## 已经对齐的部分

这张表的作用是避免把“Lody 有”误判成“OpenKin 没有”。以下能力在当前代码里都有可用实现，且多数经过第 1–28 轮验证：

| 能力 | OpenKin 现状 | 证据 |
|---|---|---|
| 会话列表/收件箱 | 分桶、置顶、归档、删除、状态/归档筛选、服务端搜索、滑动/长按、加载更早 | `ui/src/pages/SessionsPage.tsx`、`ui/src/components/ui/SessionFilters.tsx` |
| 打开会话/消息 | 转录投影、工具行、子 agent 嵌套、轮次证据、retry/fork、保存 artifact、keep/discard | `ui/src/components/chat/transcriptProjection.ts`、`ui/src/components/chat/RoundEvidenceCard.tsx`、`ui/src/pages/TaskDetailPage.tsx` |
| Composer/运行配置 | 附件、@agent+文件、`/` 提示快捷键、队列编辑/撤回、打断并立即发送、模型/权限/cwd/repo/branch/machine | `ui/src/components/chat/Composer.tsx`、`ui/src/lib/queuedPrompts.ts`、`ui/src/components/chat/RunConfigSheet.tsx` |
| 审批/提问 | 浮动审批、提问卡、MCP 审批归因、收件箱 needs-you | `ui/src/components/cards/ApprovalCard.tsx`、`internal/api/api.go:431-432`、`ui/src/lib/approvalAttribution.ts` |
| 文件/差异 | 工作区文件树、Monaco 双栏 diff、变更文件、轮次证据卡、手机差异抽屉 | `ui/src/components/workspace/WorkspacePanel.tsx`、`ChangedFilesBar.tsx`、`CodeViewer.tsx` |
| 例程 | 新建/编辑、重复、预览、立即运行、暂停/恢复、删除、搜索、历史、已读 | `ui/src/pages/RoutinesPage.tsx`、`ui/src/components/routine/RoutineScheduleFields.tsx` |
| 项目 | 多根项目、Overview+Chats、recipes、pulse/heatmap/hot modules、关联 artifacts | `ui/src/pages/ProjectDetailPage.tsx`、`internal/store/projects.go` |
| 搜索 | 服务端会话搜索、会话内查找、键盘归属与焦点恢复 | `ui/src/pages/SessionsPage.tsx`、`ui/src/pages/findWiring.test.ts` |
| 标签页 | 桌面会话标签、键盘 Alt+方向重排、未读点、保活预算 | `ui/src/components/layout/SessionTabs.tsx`、`ui/src/lib/sessionTabs.ts` |
| 用量/上下文 | 用量面板、成本/token、上下文、agent 限额、价格表 | `ui/src/pages/TaskDetailPage.tsx`、`ui/src/pages/SettingsPage.tsx` |
| 分享/推送 | 公开只读分享链接、撤销、Web Push、Bark/ntfy、收件箱 | `ui/src/components/task/ShareDialog.tsx`、`internal/api/shares.go`、`ui/src/components/settings/PushSettingsSection.tsx` |
| 手机三主路径 | 列表、打开会话、运行配置；手机 dock、FAB、滑动/长按 | `ui/src/components/mobile/MobileDock.tsx`、`ui/src/pages/NewChatPage.tsx` |

## 真实差距（S2）

### 1. 桌面工作区：一个面板，而不是一套工作台

**Lody。** 侧栏是标签化的：`files`、`changes`、`pr`、`browser`、`ios-simulator`、`session`（side chat）、`file`、`diff` 都能作为标签打开；面板可调整宽度、可最大化/还原，文件和 diff 还能继续开子标签。证据：`packages/components/src/components/sessions/session-side-panel-tab-bar.tsx:26-38`，`desktop-session-detail-layout.tsx`。

**OpenKin。** `WorkspacePanel` 是“全面板文件浏览器 + 预览 + 差异”，PR、Publish、文件快速打开是并列的独立面板；侧轨只在足够宽的桌面出现。没有浏览器面板、没有 iOS 模拟器、没有 side chat。证据：`ui/src/components/workspace/WorkspacePanel.tsx:143`，`ui/src/pages/TaskDetailPage.tsx` 的 desktop bar 与 `WorkspacePanel`/`PublishPanel`/`PullRequestPanel` 分支。

**影响。** 编码会话的验证动作（看文件、看 diff、看网页、看 PR）需要切换面板或离开应用；Lody 把它们放在同一上下文里，来回成本更低。

**建议。** 不重写布局，先把现有 `WorkspacePanel`、`PullRequestPanel`、`PublishPanel` 提升为同一侧栏的标签页，复用 `PanelSurface` 与 `ui/src/lib/panels.ts` 的面板记忆；再增加 `browser` 标签。浏览器面板需要独立的进程/权限边界（Electron `webview` 或受控 iframe），先写 ADR，不要用主窗口直接加载任意 URL。

### 2. 富预览与 PR：从“看到”到“处理完”

**Lody。** 文件面板能直接预览 PDF、Office、视频等；PR 面板带 review、CI、评论、合并；预览还能做标注。**OpenKin。** `workspacePreview.ts` 把 `pdf`、`docx`、`xlsx`、`pptx` 等列为“浏览器画不出的格式”，`FilePreview` 对它们只提供下载；`PullRequestPanel` 明确是 read-only 的缓存读取，唯一花钱的动作是刷新。证据：`ui/src/components/workspace/workspacePreview.ts:23-58`、`ui/src/components/workspace/FilePreview.tsx:31-69`、`ui/src/components/pr/PullRequestPanel.tsx:43-52`。

**影响。** 报告、表格、演示文稿、设计稿、PR 审查都要离开会话；这是“会话即工作台”与“会话即对话”的分界。

**建议。** 预览走懒加载 + 沙箱渲染，保留现有“下载兜底”作为失败路径；PR 先补 CI 状态与 review 评论的只读聚合，再做 merge 等写操作。写操作必须有明确确认、审计事件和权限检查，不要复用 PublishPanel 的“发布”语义。

### 3. 队列与定时发送：OpenKin 是“打断重跑”，Lody 是“持续引导”

**Lody 0.109。** 队列项可拖拽重排（`sessions.messageQueue.dragToReorder`）、可“Steer”当前回复（`guideAction`）、可编辑定时发送时间（`editScheduledTime`）、可移到队首（`moveToTop`）；会话内还有待执行任务的倒计时（`sessions.scheduledTasks.*`）。

**OpenKin。** 运行中发消息会进入队列，队列项可编辑/撤回；Composer 有“打断本轮并立即发送”（`interruptSend`）。后端 `FollowUpWith` 在 `Interrupt: true` 时中断当前轮、结束待审批/提问，再把新消息作为下一轮执行；它没有 Lody 那种“把消息注入当前运行中的 agent”的原生 steer。证据：`ui/src/components/chat/Composer.tsx:219-220`、`ui/src/lib/queuedPrompts.ts`、`internal/task/approvals.go:708-779`。

**影响。** 发现 agent 跑偏时，OpenKin 只能“停掉重来”，会丢失当前轮的半成品；多步任务越到后面越贵。队列不能排序也让“先插一句”变得笨重。

**建议。** 先做队列拖拽排序与会话内定时发送（纯前端 + 现有队列 API 的扩展）；再按 agent 能力探测原生 steer，支持就注入、不支持就明确降级为 interrupt + requeue，并在 UI 上说清两种语义。不要在未确认 ACP/agent 支持前假装“实时引导”。

### 4. 例程运维：能跑，但不好管理

**Lody 0.109。** 例程列表有项目/状态筛选（`schedules.filter.project`、`schedules.filter.status`、`running`、`ended`）、清空已结束（`clearEnded`）、打开会话（`openChat`）、运行历史；0.109 还补了“按项目筛选”和“清空已结束”的确认流程。

**OpenKin。** `RoutinesPage` 已有搜索、历史、已读、立即运行、暂停/恢复；列表把运行分成 noteworthy 与 terminal 两段，但没有项目/状态筛选，也没有“清空已结束”和失败重试。证据：`ui/src/pages/RoutinesPage.tsx:250-265`。

**影响。** 例程一多，找“哪个项目在跑、哪个失败了”只能翻列表；失败后要回会话手动重跑。

**建议。** 这是低成本高收益项：先加项目/状态筛选与“清空已结束”，再补失败重试（复用现有 run-now 路径并记录重试来源）。不要新增调度引擎，复用现有 routine run API。

### 5. @ 与 / 的可组合性：OpenKin 只覆盖两类对象

**Lody。** `@` 菜单按类别列出文件、issue、PR、skill、agent command、session、agent role、prompt shortcut；`$` 引用 skill。Prompt shortcut 还能限定 agent/project/machine 作用域并共享。证据：`locales/en.json:4373-4445`、`settings.promptShortcuts.*`。

**OpenKin。** `@` 只有 agent 与文件两类；`/` 是保存的提示快捷键（角色）。后端有 skills 包，但控制台没有面向用户的 skill 清单或 `$` 引用。证据：`ui/src/components/chat/Composer.tsx:300-350`、`ui/src/lib/agentMention.ts`。

**影响。** 复杂任务里，用户无法把“另一个会话”“某个角色”“某个 PR/issue”“某个技能”直接放进当前上下文，只能复制粘贴或重新描述。

**建议。** 按“对象已有来源”分批扩展：先 session/role/prompt shortcut（都在本地数据里），再 issue/PR（复用 GitHub 读取），最后 skill（需要先定义用户可见的技能模型）。每类都要有搜索、键盘导航、空/错/加载状态，并遵守 TASTE 的“一个搜索”规则。

### 6. Agent 平台管理：OpenKin 是“审批入口”，Lody 是“配置中心”

**Lody 0.109。** 设置里有 MCP（stdio/URL、headers/env、OAuth、工具发现、默认启用）、记忆（新建/编辑/关联角色/导入/状态）、提示快捷键（作用域/共享）、agent roles、project groups。0.109 的 `settings.mcp.authentication.*` 明确覆盖 authorize/check/expired/signout 等完整流程。

**OpenKin。** MCP 能力主要是本地宿主/外部 MCP 客户端的桥接与审批（`kin mcp`、`kin approve-mcp`、审批归因 `mcp:<client>`）；不是管理 agent 要连接的第三方 MCP 服务器。记忆整理目前是项目 recipe（`project.memory.tidy`），不是记忆清单。角色/提示快捷键已有基础，但没有 Lody 那种按 agent/project/machine 的作用域与共享。证据：`cmd/kin/main.go:68-80`、`ui/src/lib/approvalAttribution.ts`、`ui/src/pages/ProjectDetailPage.tsx:300`、`ui/src/pages/SettingsPage.tsx:838-868`。

**影响。** 想给 agent 接数据库、浏览器、内部 API 的用户，在 OpenKin 里没有“在控制台配置并验证”的路径；这会把它限制在“自带工具的编码 agent”而不是“可扩展的 agent 平台”。

**建议。** 先做一个薄的 MCP 配置面（读写现有配置文件，不新建表），包含连接测试/工具发现/密钥引用；OAuth 流程单独做安全评审。记忆和提示快捷键优先保持 prompt-first：如果现有 recipe/角色已经能表达，就不要为了“有设置页”而造 schema。若要做，按 PRINCIPLE §5.5 先证明它不能由提示词完成。

### 7. 项目组与子模块：数据模型够用，管理面不够

**Lody。** 项目组向导支持多仓库/文件夹、子模块识别（`.gitmodules`）、目录放置、每个项目的 instructions，并在新会话开始时发给 agent。证据：`packages/components/src/components/settings/project-group-form.tsx`、`locales/en.json:5431-5463`。

**OpenKin。** `Project` 已有 `Roots []string` 与 `project_roots` 表，API 支持多根；但 `ProjectDetailPage` 只有 Overview/Chats 两个标签，没有根成员管理、子模块识别或项目说明编辑。证据：`internal/store/projects.go:37-47`、`internal/api/projects.go:106-169`、`ui/src/pages/ProjectDetailPage.tsx:741-746`。

**影响。** 多仓库项目能用，但配置要靠 API/手工；agent 不知道“这些目录为什么在一起”。

**建议。** 复用现有 roots 数据模型，加一个项目设置标签：成员列表、目录/子模块放置、项目说明。不要新建“项目组”实体，除非现有 Project 的语义确实不够。

### 8. 子 agent 与后台任务：有嵌套展示，没有独立工作面

**Lody 0.109。** 子 agent 任务有独立标签/背景计数（`sessions.subagentTasks.tasksTab`、`subagentsTab`、`backgroundCount`），可停止、看活动、看结果；适合并行委派。

**OpenKin。** 转录投影会把子 agent 的调用嵌套在发起它的调用下，并标注 `chat.progress.subagent`；`WorkerTimeline` 展示 worker 计划行与 token/状态。证据：`ui/src/components/chat/transcriptProjection.ts:30-74`、`ui/src/components/task/WorkerTimeline.tsx`。

**影响。** 串行阅读没问题；并行子 agent 一多，用户很难一眼看到“还有几个在跑、哪个卡住了”。

**建议。** 先把子 agent 的实时状态聚合成一个轻量面板/标签（复用现有事件流），不要另起一套任务系统。背景计数与停止操作优先于完整“子会话”UI。

## 移动端、CLI 与协作层

### 移动端

OpenKin 的 iOS 是 Capacitor 壳，加载 Hub 自己的控制台（`mobile/README.md:3`、`README.md:40`）；手机主路径（列表、打开会话、运行配置）已经做过对齐。Lody 是原生移动端 + Live Activities + 更细的通知设置。差距不在“能不能用”，而在锁屏/通知栏/后台场景的“一眼看到、一步处理”。

**建议。** 不要为了对标重写原生 UI；先把推送载荷、深链、通知分组、锁屏可操作项做扎实，再评估 Live Activities 是否值得平台投入。

### CLI

OpenKin 的 `kin` 是守护进程/运维入口：`serve`、`supervise`、`token`、`approve-mcp`、`mcp`、`notify`、`export`、`hub`（`cmd/kin/main.go:51-99`）。Lody CLI 覆盖 session/project/schedule/machine/review/operation 等资源，并支持 `--json`。OpenKin 有 OpenAPI 契约，补 CLI 是“把已有 API 产品化”，不是新后端。

**建议。** 先加 `kin session list/show/send`、`kin project list`、`kin schedule list/run` 与 `--json`，让脚本和外部 agent 能无头操作；写操作沿用现有权限与审批。

### 协作层（方向性差异）

Lody 有团队工作区、成员/角色、分享管理、订阅计费与 E2EE 预览。OpenKin 的定位是 owner-operated、自托管；Hub 有账号/邀请与 owner/member 边界，但没有 Lody 那一整套协作产品。E2EE 在 Lody 0.109 仍是 developer preview，其自身文案说明会话、文件、协作与 agent 执行尚未接入，因此不适合作为“现在落后”的论据。

**建议。** 把团队协作视为战略选择，而不是 parity backlog。若方向不变，明确写进非目标，避免每个版本都被“Lody 有团队”拉动。

## 用户体验对比

### 1. 入口：继续上次 vs 现在需要我

OpenKin 的 `/` 由 `StartRoute` 直接重定向到上次会话或 `/new`（`ui/src/pages/StartRoute.tsx:9-11`）。这是“回到工作”的最短路径，符合单人多 agent 的日常。Lody 的首页是 Now 面板，先回答“哪个需要我、哪个在跑、哪个刚完成”。

**判断。** 不要复制完整 dashboard。可以在会话列表顶部加一条可折叠的 Now 摘要（需要你 / 运行中 / 今日完成），点击仍回到同一个列表，保持 TASTE 的“一个列表”。这比新增一个首页更符合 OpenKin 的 IA。

### 2. 工作区：单面板 vs 多标签

OpenKin 的面板是“一个表面、一个记忆”（`ui/src/lib/panels.ts` 的注释也明确这个取舍），好处是不会同时开一堆互相遮挡的窗；代价是验证时要来回切。Lody 的多标签侧栏更适合“文件、diff、网页、PR 同时看”的编码会话。

**判断。** 不需要变成 Lody 的密度；把最常用的三个表面（文件、diff、PR）做成同一侧栏的标签，浏览器作为可选标签，就能拿到大部分收益。

### 3. 中断：安全但昂贵 vs 流畅但危险

OpenKin 的 `interrupt + requeue` 语义清楚、可控，且会处理待审批/提问；缺点是丢失当前轮。Lody 的 “Steer” 更像“边说边改”，体验更顺，但对 agent/传输层要求更高。

**判断。** 保留 interrupt 作为兜底，把“是否支持原生 steer”做成能力探测；UI 必须区分“引导当前轮”和“中断后重跑”，不要让用户以为只是补一句话。

### 4. 透明度：OpenKin 更强

OpenKin 把成本、token、限额、供应商路由、价格表、审批归因都放在明面上；Lody 也有 usage/rate limit，但整体更偏订阅配额与团队账户。对自托管用户，OpenKin 的“我知道它花了多少、为什么被拒”是优势，不应为了追求 Lody 的简洁而藏起来。

### 5. 手机：同一套控制台 vs 原生外壳

OpenKin 的手机是“Hub 控制台的响应式版本”，好处是行为一致、维护一份 UI；代价是原生手势、通知、锁屏、后台体验的上限。Lody 的原生外壳在这些场景更强。

**判断。** 继续维持“一份 UI”的架构，优先补通知/深链/锁屏动作；只有在数据证明原生收益足够大时，才考虑局部原生模块。

### 6. 信息密度与可发现性

Lody 的功能更多、入口更密，熟练用户更快，但新用户更容易迷路；OpenKin 的表面更少、命名更统一，符合 TASTE 的“一个名字、一个列表、一个主按钮”。这也是为什么“差距”不能简单等同于“功能数量”。

## 建议路线

### P1：直接影响每天编码闭环

| 项目 | 为什么现在做 | 大致工作量 | 依赖/风险 |
|---|---|---|---|
| 侧栏标签化：文件/差异/PR/浏览器 | 把验证动作留在会话内，减少切窗 | M | 浏览器需要安全边界与 ADR |
| 富预览 + PR 读操作 | PDF/Office/视频不再只能下载；PR 能看到 CI/review | M–L | 沙箱渲染、GitHub 权限与速率限制 |
| 队列拖拽 + 原生 steer + 会话内定时发送 | 跑偏时不用“停掉重来”；排队可控 | M | 需要 agent 能力探测与后端队列扩展 |
| 例程筛选/清空已结束/重试 | 例程一多就难管理；失败恢复成本高 | S–M | 复用现有 routine run API |
| @ 扩展到 session/role/prompt shortcut | 复杂任务的上下文组装立刻变强 | M | 需要统一 mention 类别与搜索 |
| 移动端通知/深链/锁屏动作 | 手机主路径已通，差在“离开应用后” | M | 平台配置与推送载荷设计 |

### P2：平台能力与规模化

| 项目 | 为什么 | 工作量 | 依赖/风险 |
|---|---|---|---|
| MCP 配置/鉴权/工具发现 | 从“自带工具”走向“可扩展 agent 平台” | L | OAuth/密钥存储/安全评审 |
| 项目设置：根成员、子模块、项目说明 | 多仓库项目从“能跑”到“好配” | M | 复用现有 roots 模型 |
| 子 agent 状态面板/后台计数 | 并行委派时看得见、停得掉 | M | 复用现有事件流 |
| CLI session/project/schedule + `--json` | 自托管自动化与外部 agent 的入口 | M | 基于 OpenAPI，不新增后端 |
| 记忆/提示快捷键作用域 | 减少重复描述，支持团队/多项目 | M | 先证明 prompt-first 不够 |

### P3：打磨与可选增强

- 会话列表增加项目/机器/agent 维度筛选（当前只有状态 + 归档）。
- 命令面板从“动作/recipes”扩展到会话/转录搜索（注意与“每条列表一个搜索”的规则协调）。
- 标签页指针拖拽重排（现在只有键盘重排）。
- goal/plan/PR 芯片、置顶消息、检查点分隔符。
- 会话列表顶部可折叠 Now 摘要（不要新增首页）。

## 明确不做 / 暂不做

- **团队工作区、成员/角色分享、订阅计费**：与 OpenKin 的 owner-operated/自托管定位冲突；除非产品方向改变，不进入 parity backlog。
- **E2EE**：Lody 0.109 仍是 developer preview，且其文案明确说核心协作/执行尚未接入；现在做只能得到一个不可用的安全外壳。
- **为对标而重写原生移动端**：Capacitor 壳 + 一份 UI 是当前架构优势，先补原生能力缺口，不要先换壳。
- **复制 Lody 的每一个表面**：TASTE 的“一个列表、一个名字、一个主按钮”要求 OpenKin 保持更少的表面；差距应按用户任务排序，不按 Lody 的功能清单排序。

## 验证与限制

- Lody 可读源码是 **0.104.0**，安装应用是 **0.109.0**。0.109 的新增能力通过 `app.asar` 的 i18n 键与渲染 bundle 识别（新增键集中在 E2EE、settings、schedules、session/chat、notifications），**没有逐项点击验证**；个别交互细节可能与本报告描述有出入。
- OpenKin 结论来自当前工作树代码与既有 parity 文档；本报告是文档变更，**没有重跑** Go/UI 测试。若据此排期，相关改动仍需按仓库规则补测试与验证。
- 报告没有使用任何真实账号、会话内容或基础设施信息；Lody 证据只引用产品源码/安装包中的界面文案与组件。
- 未做 Lody 与 OpenKin 的同条件性能对比。OpenKin 的桌面 footprint 数据来自 `docs/plans/2026-11-01-client-contract/W3-footprint-report.md`（idle 197.0 MB footprint，session 266.0 MB），不能直接推导 Lody 更重或更轻。

## 证据索引

| 主题 | 证据 |
|---|---|
| Lody 首页 Now 面板 | `packages/components/src/components/chat/home/home-dashboard.tsx:228`、`now-board.tsx:549` |
| Lody 侧栏标签种类 | `packages/components/src/components/sessions/session-side-panel-tab-bar.tsx:26-38` |
| Lody 队列 steer/reorder/定时 | `locales/en.json:2283-2293`；0.109 bundle 的 `sessions.messageQueue.*` |
| Lody 例程筛选/清空/打开会话 | 0.109 bundle 的 `schedules.filter.*`、`schedules.clearEnded`、`schedules.openChat` |
| Lody @ 类别 | `locales/en.json:4373-4445` |
| Lody MCP/记忆/提示快捷键 | 0.109 bundle 的 `settings.mcp.*`、`settings.memory.*`、`settings.promptShortcuts.*` |
| Lody 项目组/子模块 | `packages/components/src/components/settings/project-group-form.tsx`、`locales/en.json:5431-5463` |
| OpenKin 入口 | `ui/src/pages/StartRoute.tsx:9-11` |
| OpenKin 列表筛选 | `ui/src/components/ui/SessionFilters.tsx:19-27` |
| OpenKin 设置标签 | `ui/src/pages/SettingsPage.tsx:838-868` |
| OpenKin 项目标签 | `ui/src/pages/ProjectDetailPage.tsx:741-746` |
| OpenKin 工作区面板 | `ui/src/components/workspace/WorkspacePanel.tsx:143` |
| OpenKin 预览格式 | `ui/src/components/workspace/workspacePreview.ts:23-58` |
| OpenKin PR 只读 | `ui/src/components/pr/PullRequestPanel.tsx:43-52` |
| OpenKin 发布 PR | `ui/src/components/pr/PublishPanel.tsx` |
| OpenKin 队列/打断 | `ui/src/components/chat/Composer.tsx:219-220`、`ui/src/lib/queuedPrompts.ts`、`internal/task/approvals.go:708-779` |
| OpenKin 例程 | `ui/src/pages/RoutinesPage.tsx:250-265` |
| OpenKin 项目多根 | `internal/store/projects.go:37-47`、`internal/api/projects.go:106-169` |
| OpenKin CLI | `cmd/kin/main.go:51-99` |
| OpenKin 移动端 | `mobile/README.md:3`、`README.md:40` |
| OpenKin footprint | `docs/plans/2026-11-01-client-contract/W3-footprint-report.md` |
