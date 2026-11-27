# KIN-AGENTS-002 · 看清安装探测与会话/角色导入的边界

状态：approved
优先级：P0
旅程：J6
归属面：`IA.md`「设置与环境」的 `/settings?tab=agents`
面：Mac、手机

## 谁、什么时候、为什么

当我打开设置 → agents，想弄清这台机器能跑什么、把一段旧会话带进来、或设一个角色默认，我想一眼看出哪一块是自动读的、哪一块只在我按下时发生、哪一块只是保存在本地，以便我不会把「检查安装」当成「导入」，也不会因为以后重做检测而丢掉导入和角色。

这条边界是 `KIN-CONTRACT-001` 在 2026-11-22 留下的前置条件：删 `agents` tab 之前，先分清探测与导入/角色（`docs/product/stories/KIN-CONTRACT-001.md:31`、`:40`、`:139`、`:178`）。

## 现在

- **导入会话**：`?tab=agents` 的第一组。组标题右侧是「刷新检测」（`ui/src/components/settings/LocalAgentSettingsSection.tsx:100-116`），显式按下才重新读本机 provider 与能力；provider 读取的生命周期也归这一组——读取中写「检测中…」、失败保留旧行并说明、首读失败给「重试」、离线只读（`:118-157`）。每行一个「导入」（`:183-195`），组底一个「立即导入会话」（`:200-210`）；它们与侧栏、operations console 的导入按钮是同一个动作——同一个 `useAgentSessionImport`、共享进行中标志（`ui/src/hooks/useAgentSessionImport.ts:39-52`，`ui/src/components/layout/Sidebar.tsx:121`，`ui/src/components/settings/AgentOperationsSection.tsx:1025-1032`）。按下才发生，成功后派发 `kin:agent-sessions-changed` 并带 `skipAutoImport: true`（`ui/src/pages/SettingsPage.tsx:503-543`）。旧的自动导入设置仍被 daemon 接受，但没有任何界面读它（`ui/src/components/settings/LocalAgentSettingsSection.tsx:211-216`）。每行保留「上次检测」时间（`:181`）：失败过一次之后，导入按钮旁边的时间是它唯一的出处。
- **角色默认**：第二组。角色是一段保存的提示词前缀（`ui/src/lib/agentRoles.ts:2`、`:15-21`），在同一个 tab 底部就地编辑（`ui/src/components/settings/LocalAgentSettingsSection.tsx:223-231`），随页面保存，并派发 `AGENT_ROLES_CHANGED_EVENT` 让 composer 立刻可用（`ui/src/pages/SettingsPage.tsx:481`）。

读路径已经分成两半：agent 状态来自本机 presence 扫描（`internal/server/agents.go:36`，目录见 `internal/adapter/detect/skills_catalog.go:29`），版本与登录探测在 management（`internal/adapter/detect/management.go:118`）只服务 operations tab。屏幕上的边界现在是两组：导入组自己拥有 provider 读取的生命周期与刷新入口，角色组只是保存；页面的读取策略不变——打开 tab 读一次、tab 打开时重连再读一次、显式刷新再读一次（`ui/src/pages/SettingsPage.tsx:385-401`、`:465-473`）。2026-11-27 的 `R-agents-probe-removal` 删除了此前的「安装状态（探测）」半成品组：它只读展示状态与能力徽标，却占着唯一的刷新入口和唯一的读失败文案；导入组本来就渲染同一份 `agentProviders`，所以删除后导入与角色两组原地址原按钮不变。

## 范围

- 做，**探测（安装状态）**：只读本机 provider 的状态、来源、能力徽标与上次检测时间。打开 tab 只读 daemon 的元数据与时间戳，不读 secure store、不调第三方、不启动导入；只有显式按下「刷新检测」才重新探测，探测中该组标「检测中…」，完成后更新时间戳，失败保留上次结果并说明。探测永远不改目录、不改默认 agent、不导入。（2026-11-27 随探测组删除退役：能力徽标与状态行删除，读取生命周期与刷新入口并入「导入会话」组，见变更记录。）
- 做，**导入会话**：agents tab 的行内「导入」按 provider 导入这一台机器；侧栏菜单也有按 provider 的快捷入口（`ui/src/components/layout/Sidebar.tsx:113-129`），组底「立即导入会话」与 operations 的按钮导入所有已配对机器。它们是同一个动作（同一个 hook、同一个进行中标志），归各自宿主；侧栏与 operations 的按钮归 `KIN-AGENTS-001`，本故事不改。导入只写会话索引，不改源历史、不改安装状态、不改角色；失败不删已有索引。
- 做，**角色默认**：保存在 daemon 设置键 `agent_roles` 里的提示词前缀，同一 daemon 的设备共享（`ui/src/lib/agentRoles.ts:10-11`，`ui/src/pages/SettingsPage.tsx:465`）。打开 tab 只显示已保存的角色；编辑随页面的保存动作落盘，半写的行在保存时丢弃（已有 `ui/src/lib/agentRoles.test.ts:95-108`）；它不探测、不导入、不改变模型或权限，只把文字放进草稿。
- 做，**删探测不删能力**：导入组自己读它需要的 provider 与能力元数据（同一个 `/api/agent-providers`），不依赖探测组的渲染；以后重做或移除探测半时，导入与角色两组保留原地址 `/settings?tab=agents`、原按钮与原测试。
- 做，**一个列表**：完整的 agent 列表仍归 operations console（`KIN-AGENTS-001`）。这里的状态行只保留解释「为什么这一行不能导入」所需的最小信息，不能长成第二张 agent 管理表。

## 每一步的预期

### 1. 定义：一屏回答三个不同的问题

| 项 | 预期 |
|---|---|
| 起点 | `/settings?tab=agents`，三个组按「安装状态 → 导入会话 → 角色默认」排列 |
| 动作 | 读屏，先分清哪组自动读、哪组只在按下时发生、哪组只是保存 |
| 立刻看到 | 每组标题下一句规则：状态「自动读取，不改变任何东西」；导入「只在按下时发生，只写会话索引」；角色「保存后在新对话里用，不改变安装」 |
| 慢 / 空 / 失败 / 断线 | 空组各自写「还没有检测结果」「还没有可导入的会话」「还没有角色」；一组失败不把整页变空；断线时三组都标离线，探测与导入禁用并写原因，角色只读 |
| 键盘与焦点 | Tab 顺序按组；禁用的按钮保留在 Tab 序里并带原因；焦点不自动落进导入按钮 |
| 离开再回来 | 回到同一 tab；组的顺序与展开状态不变 |

### 2. 定位：找到要按的那一下

| 项 | 预期 |
|---|---|
| 起点 | 三个组都在 |
| 动作 | 找「刷新检测」「导入」「添加角色」 |
| 立刻看到 | 探测按钮在状态组标题右侧；行内「导入」只在 `session_list` 可用的行出现；「立即导入会话」在导入组底部；「添加角色」在角色组标题右侧 |
| 慢 / 空 / 失败 / 断线 | 能力不支持时该行没有导入按钮并写原因；还没有 provider 时导入组写「先检测到 Agent 才能导入」，角色组仍可用 |
| 键盘与焦点 | 主动作都可 Tab 到；行内导入的无障碍名写「导入（provider 名）的会话」，不是一排同样的「导入」 |
| 离开再回来 | 回 tab 时焦点在页首标题，不自动落到任何会写数据的按钮 |

### 3. 准备：打开时读到什么，不读什么

| 项 | 预期 |
|---|---|
| 起点 | 打开 `?tab=agents`，或从别的 tab 切回来 |
| 动作 | 什么都不按，先读 |
| 立刻看到 | 每行有状态、原因、能力徽标与「上次检测：（时间或「从未」）」；导入按钮的可用性直接由这份元数据决定 |
| 慢 / 空 / 失败 / 断线 | 打开只读本机 daemon 元数据（`/api/agent-providers`、`/api/agents`），不读 secure store、不调第三方、不启动导入；首读失败写「还没读到检测结果」并给重试，不用上次的猜测冒充新结果 |
| 键盘与焦点 | 读屏期间骨架不抢焦点；读完后焦点仍在页首 |
| 离开再回来 | 上次结果与时间戳保留；离开不触发重新探测 |

### 4. 确认：按下导入前，屏幕说清会发生什么

| 项 | 预期 |
|---|---|
| 起点 | 一个可导入的 provider 行，或「立即导入会话」 |
| 动作 | 读按钮的范围与后果，然后按下或不按 |
| 立刻看到 | 按下前就写明：一次性把会话索引进 Kin、不改源历史、不自动重复；行内写「这台机器的（provider 名）」，组底写「所有已配对机器」 |
| 慢 / 空 / 失败 / 断线 | 能力不满足时按钮不存在，而不是灰着不解释；离线时按钮禁用并写「离线，连上再导入」；一次导入进行中时其余导入按钮一起禁用 |
| 键盘与焦点 | 按下就是确认，没有第二步对话框；Esc 不触发导入 |
| 离开再回来 | 没按就不发生导入；提示文案不因离开而改变 |

### 5. 执行：三种动作各自只做自己的事

| 项 | 预期 |
|---|---|
| 起点 | 按下了探测、导入或保存角色之一 |
| 动作 | 等它完成 |
| 立刻看到 | 探测 → 该组「检测中…」，完成后状态与时间更新；导入 → 按钮「导入中…」，完成后提示索引了几个会话，部分失败点名来源与原因；角色保存 → 一次保存把角色与会话设置落盘，composer 的 `/` 菜单立即可用 |
| 慢 / 空 / 失败 / 断线 | 每种动作失败只说自己的组：探测失败保留上次结果；导入失败不删已有索引并给重试；角色保存失败保留草稿并说明；一个动作进行中不阻塞另外两组 |
| 键盘与焦点 | 进行中的按钮禁用但保持焦点；完成后焦点回到触发按钮 |
| 离开再回来 | 进行中的动作离开后不假装完成；已完成的结果与时间戳保留 |

### 6. 监控：迟到的回答不覆盖新的屏幕

| 项 | 预期 |
|---|---|
| 起点 | 探测或导入还在进行，人切走或又按了一次 |
| 动作 | 切回 tab，或再按一次 |
| 立刻看到 | 只有最新一次读或导入的结果上屏；旧回答被丢弃，不把旧状态盖在新状态上 |
| 慢 / 空 / 失败 / 断线 | 每次读带代际序号（设置页已有 `loadSeq` 与 `agentCatalogSeq` 模式，`ui/src/pages/SettingsPage.tsx:370-410`）；超时写「没有结果」而不是猜成功；断线保留上次结果并标时间 |
| 键盘与焦点 | 迟到的结果不抢焦点，不用 live region 反复播报 |
| 离开再回来 | 同一屏重进不重复发起导入；探测结果按时间戳而不是按到达顺序 |

### 7. 修改：改的是角色和重新检测，不是历史

| 项 | 预期 |
|---|---|
| 起点 | 角色组或状态组 |
| 动作 | 改一个角色的名字或提示词、删一个角色、再按一次「刷新检测」，或对同一 provider 再导入一次 |
| 立刻看到 | 角色行就地编辑，保存后生效；删除后 composer 的 `/` 菜单少一项；重新检测只更新状态与时间；再次导入仍只在按下时发生，不是自动同步 |
| 慢 / 空 / 失败 / 断线 | 保存失败保留编辑并说明；断线时只读；导入失败时角色编辑器仍可用 |
| 键盘与焦点 | 角色行可 Tab 进入；删除按钮有名字；Esc 退出编辑但不回滚已保存的值 |
| 离开再回来 | 已保存的角色与状态保留；未保存的编辑不落盘 |

### 8. 收尾：离开这一屏，三样东西各自留下什么

| 项 | 预期 |
|---|---|
| 起点 | 任意状态 |
| 动作 | 去新建对话、换 tab 或关闭设置 |
| 立刻看到 | 新建对话能用刚保存的角色；会话列表出现刚导入的会话；下次打开设置仍看到上次检测时间 |
| 慢 / 空 / 失败 / 断线 | 导入还在跑时离开，回来仍能看到它完成或失败的结果；断线时三组都标离线，不假装新数据 |
| 键盘与焦点 | 离开后回到触发入口（Mac 左栏、手机底栏），不落在隐藏控件上 |
| 离开再回来 | 状态与时间戳保留；未保存的角色编辑不保留；不重复导入 |

## 各面差异

| 面 | 这一面怎么呈现 | 为什么不同 |
|---|---|---|
| Mac | 设置页单列里三组自上而下；状态行紧凑，导入按钮在行尾；角色组在底部；组标题右侧是各自唯一的主动作 | 宽度够，三组同屏可读；边界靠顺序与标题，不靠折叠 |
| 手机 | 同样顺序单列堆叠；行内导入按钮保持至少 44px；三句规则常显不截断；角色编辑全宽 | 一屏一件事；顺序和规则句是唯一能防误按的东西，不能收进提示或省略号 |

## 设计

设计稿：审阅页 `docs/product/stories/KIN-AGENTS-002.review.html`（Figma-first，每屏六个用户流程）与 6 张 Figma 帧 `docs/product/stories/KIN-AGENTS-002.figma/frames/`（`01-mac-default` … `06-late-answer`）已由 #629 `b0d46372` 交付；状态保持 `draft`，直到有人读过审阅页并签字。必须画到的状态：默认、三组各自空、加载、探测失败、导入部分失败、断线、导入中、角色半写、删除探测半之后。

## Do not

- 不做：删掉 `agents` tab，或把导入会话、角色默认搬去别的 tab 或页面；它们留在 `/settings?tab=agents`（`docs/product/stories/KIN-CONTRACT-001.md:40`）。删 tab 是删能力，不是删半成品。
- 不做：自动导入、自动接入，或让探测发现的新 agent 直接进目录；导入只在手动按下时发生，接入确认与目录 ≤10 归 `KIN-AGENTS-001`（`docs/product/stories/KIN-AGENTS-001.md:24`、`:26`、`:125`）。
- 不做：在本故事里改 provider 的密钥、端点或运行默认值；那是 `KIN-SETTINGS-001`。
- 不做：改新建对话的 agent、模型或权限选择；那是 `KIN-START-001`。
- 不做：把安装、更新、卸载、登录、smoke 或用量搬进这一屏；完整 agent 管理与用量归 `KIN-AGENTS-001` 的 operations console。
- 不做：为表达边界新增数据表、后端接口或状态机；用现有的 `/api/agent-providers`、`/api/agents`、设置保存与导入接口（PRINCIPLE §5.5）。
- 不做：删掉或重命名侧栏与 operations console 的导入按钮；它们归 `KIN-AGENTS-001`，本故事只要求它们与 agents tab 的导入共享同一个动作与进行中标志。
- 不做：为角色新增表、后端设置键或跨机器同步机制；它已经是 daemon 设置键 `agent_roles`（`internal/api/api.go:1788-1792`），本故事只画边界，不迁移存储。

## 验收

| 层级 | 位置 | Given / When / Then |
|---|---|---|
| 组件 | `ui/src/components/settings/LocalAgentSettingsSection.KIN-AGENTS-002.dom.test.tsx` | Given 打开 `?tab=agents` When 不按任何按钮 Then 没有导入请求、没有 secure-store 读；探测按钮可见但未运行（2026-11-27 随探测组删除退役） |
| 组件 | `ui/src/components/settings/LocalAgentSettingsSection.KIN-AGENTS-002.dom.test.tsx` | Given 状态组 When 按「刷新检测」 Then 该组标「检测中…」，provider 读只发一次，完成后状态与时间更新；没有导入请求，也没有改默认 agent（2026-11-27 随探测组删除退役） |
| 组件 | `ui/src/components/settings/LocalAgentSettingsSection.KIN-AGENTS-002.dom.test.tsx` | Given 一个 provider 的 `session_list` 不支持 When 看该行 Then 没有导入按钮，并写「不支持列出会话」的原因 |
| 组件 | `ui/src/components/settings/LocalAgentSettingsSection.KIN-AGENTS-002.dom.test.tsx` | Given 一个可导入的 provider When 按行内「导入」 Then 只请求这一台机器的这个 provider，完成后提示索引数 |
| 组件 | `ui/src/components/settings/LocalAgentSettingsSection.KIN-AGENTS-002.dom.test.tsx` | Given 导入进行中 When 看其余导入按钮 Then 一起禁用；完成后恢复 |
| 页面 | `ui/src/pages/SettingsPage.KIN-AGENTS-002.dom.test.tsx` | Given 一次导入失败 When 完成 Then 已有会话索引与列表保留，错误点名来源并可重试 |
| 页面 | `ui/src/pages/SettingsPage.KIN-AGENTS-002.dom.test.tsx` | Given 可导入的 provider When 按组底「立即导入会话」 Then 请求所有已配对机器，不只是本机 |
| 页面 | `ui/src/pages/SettingsPage.KIN-AGENTS-002.dom.test.tsx` | Given 侧栏的导入在进行 When 渲染 agents tab Then 本页所有导入按钮一起禁用（同一个进行中标志） |
| 页面 | `ui/src/pages/SettingsPage.KIN-AGENTS-002.dom.test.tsx` | Given 一个角色，名字和提示词都填好 When 保存 Then 保存请求含该角色，composer 收到 `AGENT_ROLES_CHANGED_EVENT`，且没有探测或导入请求 |
| 组件 | `ui/src/components/settings/LocalAgentSettingsSection.KIN-AGENTS-002.dom.test.tsx` | Given 已保存的角色 When 打开 tab Then 角色行渲染出来，且角色组本身不触发探测或导入 |
| 页面 | `ui/src/pages/SettingsPage.KIN-AGENTS-002.dom.test.tsx` | Given 两个读并发、其中一个迟到 When 它们返回 Then 只有最新一次上屏，旧回答被丢弃 |
| 组件 | `ui/src/components/settings/LocalAgentSettingsSection.KIN-AGENTS-002.dom.test.tsx` | Given 断线 When 打开 tab Then 两组都标离线，导入组禁用并写原因，角色只读（2026-11-27 起为两组：导入与角色；探测组已删除） |
| 组件 | `ui/src/components/settings/LocalAgentSettingsSection.KIN-AGENTS-002.dom.test.tsx` | Given 探测失败 When 完成 Then 保留上次结果并写失败原因，不清空行 |
| 页面 | `ui/src/pages/SettingsPage.KIN-AGENTS-002.dom.test.tsx` | Given 探测组被移除或用替身替掉 When 打开 agents tab Then 导入组自己拿到 provider 与能力，行内导入与角色保存仍发出各自的请求 |
| 结构 | `ui/src/components/settings/LocalAgentSettingsSection.KIN-AGENTS-002.dom.test.tsx` | Given agents tab When 渲染 Then 没有安装、更新、卸载、登录、smoke 或用量控件；完整列表只在 operations console |

## 证据

- 合同依据：`docs/product/stories/KIN-CONTRACT-001.md:31`、`:40`、`:139`、`:178`；兄弟姐妹：`docs/product/stories/KIN-AGENTS-001.md:17`（74 条目录）、`:24`、`:26`、`:125`（手动导入）；角色半写行已有 `ui/src/lib/agentRoles.test.ts:95-108` 覆盖。本条失败先红证据写在 PR body；`python3 scripts/stories.py` 输出 `ok`；part b 的审阅页与 6 张帧已交付（#629 `b0d46372`），代码 lane 的测试与 390 / 1100 截图仍待补。

## 变更记录

- 2026-11-23 创建（R-agents-detect，合同 only；不写代码、审阅页或帧）。
- 2026-11-25（+08）· 对齐：part b 的审阅页与 6 张帧已由 #629 b0d46372 交付；状态保持 draft，等待人签字。
- 2026-11-27 · CEO 受托签字（approved）：D1–D3 按审阅页推荐；审阅页已读（MECE、6 帧、六段流程、状态板）。见 rsi/DECISIONS.md 同日条。
- 2026-11-27 · `R-agents-probe-removal`：探测组（安装状态）删除，agents tab 只剩「导入会话」与「角色默认」两组；导入组自己拥有 provider 读取的生命周期（读取中 / 失败保留旧行 / 首读失败给重试 / 离线）并保留自己的「刷新检测」入口，每行保留「上次检测」时间，角色组不变；无 API、路由、存储或新增 locale 目录，两个 locale 只删除探测组独占键并把 `detectionFailed` 的「上面」改成「下面」。
