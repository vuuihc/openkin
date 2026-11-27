# KIN-CONTRACT-001 · 只留四个页面：列表、任务详情、例行任务、设置

状态：covered
优先级：P0
旅程：J1、J2、J4、J6
归属面：`IA.md`「列表层级」「例行任务」「设置与环境」
面：Mac、手机

## 谁、什么时候、为什么

当我每天在 Mac、iPad 和手机上打开 Kin 继续干活，我想只看到四个页面——设备 → 项目 → 任务列表（运行就在列表里）、任务详情、例行任务、设置——以便每个留下的页面都能被真机验收到底，而不是十个页面各好一半。

owner 2026-11-22 的原话：「保留的就是设备-项目-任务列表，任务详情，例行任务列表（不包含运行列表，运行列表放到任务列表就行），设置（agents 安装检测现在不完备可以删除等重做，其他保留）这三个页面」。它取代 2026-11-21 计划里「5–6 个路由、Settings 6→2 tab」的估计。

## 现在

`ui/src/App.tsx:194-219` 有 15 条 `<Route>`，真页面约 10 个。具体缺口：

- 例行任务页面把「例行任务清单」和「按时间倒序的运行」放在同一页（`ui/src/pages/RoutinesPage.tsx:135` 的注释、`:153-157` 的 `runs`/`runsCursor`），于是同一个运行既是列表里的一条，又是这里的一条。
- 运行没有出现在任务列表里，读者要判断「刚才那次跑了没有」得换一个页面。
- 项目封面是一个独立页面（`/projects/:id`），工作说明只在那里可读；集合页 `/projects` 与列表的项目层级重复。
- 设置 6 个 tab（`ui/src/pages/SettingsPage.tsx:809-837`）。owner 说的「agents 安装检测不完备」落在两处：`agents` tab 里逐个 provider 的探测状态与能力徽标（`ui/src/components/settings/LocalAgentSettingsSection.tsx`），以及 operations tab 里「装哪些」的建议块（`ui/src/components/settings/AgentOperationsSection.tsx:347` 的 `installSuggestions` 与 `:528` 的「未安装」行）。问题是：`agents` tab 同时是**导入 provider 会话**与**角色默认（prompt 前缀）**的唯一入口，所以「删 tab」会连带删掉两个别处没有的能力——那是删能力，不是删半成品。
- 没有任何东西阻止下一条 PR 再加一个面：`removed-surfaces` 只保证删掉的路径不复活。

## 范围

- 做：
  - 冻结四个页面：`/sessions`（设备 → 项目 → 任务，运行是任务行）、`/tasks/:id`（详情 + composer + 文件/diff/PR 面板）、`/routines`（只有例行任务清单，不含运行列表）、`/settings`（现有六个 tab 原样：general、agents、operations、providers、routing、advanced）。
  - 运行列表原来在 `/routines`，移到 `/sessions`：每个运行就是一条任务行，带来源标记（例行任务名），可筛选；`/routines` 不再拉运行。
  - 项目封面 `/projects/:id` 退役，工作说明改为在列表里展开项目行可读（只读，编辑仍走「⋯」），`/projects` 集合页同退。
  - 设置这一轮**不改**：安装检测的重做拆成独立 story `R-agents-detect`，因为它要先看着屏分清「探测」与「导入/角色」的边界；在边界分清前删 `agents` tab 会删能力，而本故事的不做清单不允许那样做。
  - `/new` 是任务详情的草稿态（同一 shell），不是第五个页面。
  - `/machines/:device/tasks/:id` 合并进 `/tasks/:id?device=`。
  - 一张退场表（本故事「设计」一节与审阅页的契约板）：每条旧路径 → 落到哪条页面、能力搬进哪里、哪条故事负责；旧路径在能力搬完前保持可用。
  - 一个路由清单测试：`ui/src/App.tsx` 的每条 `<Route path>` 必须在四个页面、`/new` 或退场表里；新增/删除一条而没改表就红，并打印 `KIN-CONTRACT-001`。生产路由与 dev-only 路由分开断言。
  - 检查器的数据表与故事里的退场表逐行一致（同一测试断言），「负责」为空的行不允许从表里删掉。
- 不做（各自去处）：
  - 删除 `/routines` 页面、把例行任务改成卡片 → **不做**，owner 2026-11-22 明确保留页面。
  - Settings 收缩到 2 个 tab、把 providers 搬成 sheet → **不做**，其余 tab 保留；用量界面不动。
  - 删除整个 `agents` tab，或把导入会话/角色默认搬走 → **不做**（那是删能力，不是删半成品检测）；安装检测重做 → 独立 story `R-agents-detect`。
  - 手机底栏改数量 → 不改：四个入口（对话、Agents、例行、设置）都落在保留的页面上；`KIN-` 手机底栏已签故事继续有效。
  - 列表密度、折叠交互 → parked `R-list-scan`。
  - RN 客户端 → 独立 ADR/phase，契约冻结前不写 `mobile/` 代码。
  - 文件/diff/PR 面板的内容与只读 PR 面板 → `KIN-RESULT-002`、`KIN-RESULT-003`。

## 每一步的预期

### 1. 定位：从列表认出设备、项目与要读的那个任务

| 项 | 预期 |
|---|---|
| 起点 | `/sessions`：设备 → 项目 → 任务三层，项目与设备默认折叠；任务包含对话、例行任务的每次运行、远端任务 |
| 动作 | 展开一层；点项目行看工作说明；搜索；点任务标题 |
| 立刻看到 | 任务在同一个 shell 里打开；列表保持滚动与展开；运行行带例行任务名与状态 |
| 慢 / 空 / 失败 / 断线 | 空写「还没有对话」+「新对话」；搜索无结果写清搜索词；列表加载失败一行重试，已加载的行不消失；离线设备的行不可展开，点一次说明原因 |
| 键盘与焦点 | 搜索框可 Tab 到；↑↓ 在行间移动，Enter 打开，Esc 清空搜索并留在列表 |
| 离开再回来 | 搜索词、筛选、滚动位置、展开层级都保留（F4） |

### 2. 执行：读、发、看改动，全部留在同一条任务里

| 项 | 预期 |
|---|---|
| 起点 | `/tasks/:id`，或 `/new` 的草稿发出去；远端任务带 `?device=` 落到同一页 |
| 动作 | 滚动阅读、点 header「文件」打开面板、在 composer 接着问 |
| 立刻看到 | 面板在同一条任务内打开（不换路由）；发出去的消息入流、composer 清空并保持焦点 |
| 慢 / 空 / 失败 / 断线 | 流式时保留已收到的内容；断线时内容不丢、一条重连说明；发送失败把草稿留在 composer 并给原因；远端离线时同一页说明「这台设备现在连不上」 |
| 键盘与焦点 | composer 是唯一输入路径；Esc 关面板并把焦点还给「文件」；⌘Enter 发送 |
| 离开再回来 | 草稿、滚动位置、面板开关按 F4 恢复；不重复发送 |

### 3. 准备：例行任务只住例行任务

| 项 | 预期 |
|---|---|
| 起点 | `/routines`：例行任务清单（名称、计划、上次运行、启停） |
| 动作 | 新建或编辑一个例行任务；点「看运行」跳到 `/sessions` 并带上该任务的筛选 |
| 立刻看到 | 保存后清单里立刻出现；「看运行」落到列表，筛选已就位，运行就是任务行 |
| 慢 / 空 / 失败 / 断线 | 空写「还没有例行任务」+「新建」；保存失败保留表单并说明；断线时清单可读、保存禁用并说明 |
| 键盘与焦点 | 表单 Tab 顺序固定；Esc 关闭新建面板并回「新建」；保存后焦点回到该行 |
| 离开再回来 | 回到清单，展开/滚动的行保留；不重复创建 |

### 4. 确认：设置这一轮不动（六个 tab 与其中的导入、角色默认原样）

| 项 | 预期 |
|---|---|
| 起点 | `/settings`，默认上次的 tab |
| 动作 | 在 general / agents / operations / providers / routing / advanced 之间切换；provider 凭据仍在 providers tab |
| 立刻看到 | 仍是六个 tab；`agents` tab 里的导入会话与角色默认还在；新对话立刻用上新默认 |
| 慢 / 空 / 失败 / 断线 | 打开设置不读 secure store、不调第三方；只有「验证/配置」这一次动作才读；失败只说这一行，不影响别的 tab |
| 键盘与焦点 | tab 之间 ←→；关闭确认框回触发按钮；未连接的 provider 行写明原因 |
| 离开再回来 | 回到上次的 tab；改到一半的 key 输入在离开时清空，不留在内存快照里 |

### 5. 监控：契约被破坏时，机器先看见

| 项 | 预期 |
|---|---|
| 起点 | 一条普通 PR，改了 `ui/src/App.tsx` 或新增一个页面 |
| 动作 | 什么都不做，等 `scripts/check.sh` |
| 立刻看到 | 新增路由不在契约里 → 测试失败，输出点名 `KIN-CONTRACT-001` 和那条路径；删掉契约页面同样红；`/routines` 重新拉运行也红 |
| 慢 / 空 / 失败 / 断线 | 测试不联网、不起浏览器；读不到 `App.tsx` 就先红，不静默跳过 |
| 键盘与焦点 | 无（命令行） |
| 离开再回来 | 同一棵树重跑结论一致 |

### 6. 收尾：退场表里的每一条都有主

| 项 | 预期 |
|---|---|
| 起点 | 一条旧路径（如 `/projects/:id`、`/agent-sessions/:id`） |
| 动作 | 打开它 |
| 立刻看到 | 落到保留的页面（工作说明在项目行里、agent 状态在会话动作表里），不是 404 |
| 慢 / 空 / 失败 / 断线 | 能力还没搬完时旧路径保持可用，退场表写「等哪条故事」；不许先删后补 |
| 键盘与焦点 | 落到目标页面的第一个可操作元素 |
| 离开再回来 | 旧书签仍然可用；退场表有一行日期与负责故事 |

## 各面差异

| 面 | 这一面怎么呈现 | 为什么不同 |
|---|---|---|
| Mac | 左列表 + 主区两栏；文件/diff/PR 是主区右侧面板；例行任务与设置各是一个页面 | 屏幕宽，列表与正文可以同时在场；面板不换路由才能保住滚动与草稿 |
| 手机 | 列表、任务详情、例行任务、设置各自占满一屏；底部四个入口分别指向它们（Agents 入口落在设置的 operations tab）；文件/diff 是任务详情上的面板页 | 一屏只有一个页面；四个入口都落在保留的页面上，底栏不需要改数量 |

## 设计

设计稿：`KIN-CONTRACT-001.figma/frames/`（8 张 SVG 源帧）和 `KIN-CONTRACT-001.review.html`（Figma 帧 + 每屏六段用户流程 + 决定记录）。

必须画到的状态：默认、空、加载、失败、断线、运行中、等待批准。

**退场表**（清单测试以同内容的数据表为准，并断言与这里逐行一致）：

| 旧路径 | 落点 | 能力去处 | 负责 |
|---|---|---|---|
| `/projects` | `/sessions` | 列表的项目层级 | `R-delete-pages` |
| `/projects/:id` | `/sessions` | 项目行展开可读工作说明（只读，编辑走「⋯」） | `R-delete-pages` |
| `/inbox`、`/approvals` | `/sessions` | 列表每行写「等你处理」 | 已落地 |
| `/agents` | `/settings?tab=operations` | Agent Ops 留在 operations tab | 已落地 |
| `/usage` | `/settings?tab=operations` | 用量界面不动（composer footer 的 popover 仍是入口） | 已落地 |
| `/routines` 里的运行列表 | `/sessions` | 每个运行是一条任务行，带例行任务名；「看运行」带筛选跳转 | 本条 |
| `/agent-sessions/:id` | `/sessions?agent=<id>` | 旧整页 URL 落到列表，该会话的 sheet 开在列表上方；继续即落到 `/tasks/<id>` | `已落地` |
| `/machines/:device/tasks/:id` | `/tasks/:id?device=` | 同一份任务详情 | 本条 |
| Settings 的 `agents` 安装检测（探测状态与能力徽标） | `/settings?tab=agents` | 导入会话与角色默认**保留**；探测重做后再决定展示什么 | `R-agents-detect`（独立 story） |
| `/` | `/sessions` | 入口 redirect（手机回列表，桌面回上次任务或 `/new`），不是页面 | 已落地 |
| `*` | `/new` | 已登记的兜底 redirect：未匹配路径回新对话，不是页面 | 已落地 |
| `/dev/components` | 不在生产路由 | 仅 dev build | 本条 |

## Do not

- 不许删 `/routines` 页面或把例行任务改成卡片；运行列表搬走、页面留下。
- 不许把 Settings 收缩到 2 个 tab，也不许搬走 providers 凭据；不许删 `agents` tab 或搬走导入会话/角色默认；安装检测重做归 `R-agents-detect`；其余五个 tab 与 providers 凭据位置不动。
- 不许改手机底栏的数量或顺序（四个入口都有效）。
- 不许把「删面」做成「删能力」：被退役路径的能力必须已经在新位置可读且测试绿。
- 不许改 HTTP/事件契约、数据模型、权限或安全语义；这条只动前端路由、页面拆分与文档。
- 不许在契约冻结前写 `mobile/` 的 RN 代码。
- 不许用通配路由（`*`）吞掉未登记的路径来让清单测试变绿；`*` 只允许是退场表里那条回 `/new` 的兜底 redirect，也不许放宽断言。

## 验收

| Given | When | Then |
|---|---|---|
| 一条新增的 `<Route path="/x">` 不在契约表 | 跑 `scripts/check.sh` | `ui/src/lib/routes.contract.test.ts` 失败，输出含 `KIN-CONTRACT-001` 与 `/x` |
| 四个页面之一被删，或 `/new` 被当成第五个页面 | 跑同一个测试 | 失败并报出缺的/多出的那条 |
| `/routines` 重新拉取运行列表，或运行不再出现在列表里 | 跑同一个测试 | 失败（`RoutinesPage` 不再引用 `listRoutineRuns`；列表有运行行） |
| 设置少了 `agents` tab，或少了其中的导入会话/角色默认 | 打开 `/settings` | 失败（判「删面变成了删能力」）；六个 tab 的集合由 `KIN-CONTRACT-001` 那一行固定 |
| 旧路径 `/projects/:id`、`/agent-sessions/:id`、`/machines/:device/tasks/:id` | 打开 | 落到退场表写的页面，`replace` 进历史；工作说明在项目行里可读 |
| 故事里的退场表与测试数据不一致，或某行「负责」为空 | 跑同一个测试 | 失败并打印不一致的那一行 |
| 变异体：把 `/routines` 改回带运行列表的页面 | 跑测试 | 必须红 |

## 证据

### 逐行证据

七行 `## 验收` 逐行对应；`状态` 只写今天在 `main` 上真跑红的用例，行号即该用例的 `it(` 行。汇总：**7 covered**，状态转为 `covered`。

| 验收行 | 测试文件:行 | 用例名 | 状态 |
|---|---|---|---|
| 1. 新增 `<Route path="/x">` 不在契约表 | `ui/src/lib/routes.contract.test.ts:99`（manifest `ui/src/lib/routes.contract.mutants.json`「rogue route」也红） | `every route in App.tsx is registered`；失败文案由 `:149` 的 `the unregistered-route failure names the contract and the fix` 固定为含 `KIN-CONTRACT-001` 与路径 | covered |
| 2. 四个页面之一被删，或 `/new` 被当成第五页 | `ui/src/lib/routes.contract.test.ts:105`；`ui/src/lib/surfacesContract.KIN-CONTRACT-001.test.ts:84` | `every contract page and the draft route is still registered`；`the contract is four pages plus /new, and /new is not a page` | covered |
| 3. `/routines` 重新拉运行，或运行不在列表里 | `ui/src/pages/RoutinesPage.dom.test.tsx:397`；`ui/src/components/sessions/SessionList.routineRuns.dom.test.tsx:117` | `never asks for a run feed`（另 `:380` 的 `stops reading a routine's own run history on /routines`）；`marks a routine run and leaves a conversation unmarked`。这两条不在路由清单测试里：那一套只固定路径集合 | covered |
| 4. 设置少了 `agents` tab，或少了其中的导入会话/角色默认 | `ui/src/pages/settingsTabsWiring.test.ts:35`；`ui/src/pages/SettingsPage.leaveGuard.dom.test.tsx:309,363,370` | 前者 `offers exactly the six settings that are still used` 固定六个 tab id 与顺序；`:309` 的 `treats a half-written role row as a draft` 从 `/settings?tab=agents` 证明角色默认还在；`:363` 的 `keeps the import-sessions action inside the agents tab` 从同一 tab 断言导入会话动作与「Add role」仍在，`:370` 的 `does not offer the agents tab's import action from another tab` 断言别的 tab 不暴露该动作。两条的红证是 `ui/src/pages/SettingsPage.agentsImport.mutants.json` 的两个变异体（删掉导入按钮、让 agents 面板响应每个 tab） | covered |
| 5. 旧路径落地并 `replace`，工作说明在项目行可读 | `ui/src/App.areaRoutes.test.ts:116,134`；`ui/src/App.machineTaskRedirect.test.ts:107`；`ui/src/components/sessions/SessionList.projectFace.dom.test.tsx:239` | `redirects /projects/:id … replacing the entry`；`redirects /agent-sessions/:id … replacing the entry`；`replaces rather than pushes`（`history.state.idx` 不变）；`shows the work instructions when a project row is expanded, and reads them only then` | covered |
| 6. 退场表与测试数据不一致，或某行「负责」为空 | `ui/src/lib/surfacesContract.KIN-CONTRACT-001.test.ts:72,78` | `the story's exit table and EXIT_ROWS are the same rows, in order`；`every exit row names an owner` | covered |
| 7. 变异体：把 `/routines` 改回带运行列表 | `scripts/routines-feed-out.mutants.json`（label `a run-feed read returns to page load, so /routines duplicates the one run list`） | 该变异体在页面加载时注入 `listRoutineRuns` 读，跑 `RoutinesPage.dom.test.tsx -t 'never asks for a run feed'`，必须红 | covered |

- 契约与退场表：本文件「设计」一节；审阅页 `KIN-CONTRACT-001.review.html` 的契约板。
- 现状：路由 `ui/src/App.tsx:194-219`；例行页的运行 feed `ui/src/pages/RoutinesPage.tsx:135,153-157`；设置 tab `ui/src/pages/SettingsPage.tsx:809-837`；agents 安装检测 `ui/src/components/settings/LocalAgentSettingsSection.tsx` 与 `ui/src/components/settings/AgentOperationsSection.tsx:347`。
- owner 原话与决定：`rsi/DECISIONS.md` 2026-11-22 那条；`docs/plans/2026-11-21-surface-reduction.md` 的最小契约表按本条订正。
- 已完成的死代码清理：#547 `b4bc72f7`，`removed-surfaces` 在 `scripts/check.sh` 里点名执行。

## 变更记录

- 2026-11-22（+08）· 初稿：五个面 + 退场表（含把 routines 改成卡片），等 owner 签字。
- 2026-11-22 · 按 owner 原话订正为四个页面：`/routines` 保留、运行搬进任务列表、设置只删 `agents` 安装检测、其余 tab 保留、项目封面退役且工作说明进列表项目行。这四条不再是待决项。
- 2026-11-22 · **受托签字（approved）**：owner 当天把签字权交给「找 advisor 签」（`rsi/DECISIONS.md` 同日那条）；顾问 Kimi K3.1 Pro 只读复核建议签，本 PR 同时落退场表数据与逐行一致测试（`ui/src/lib/surfacesContract.KIN-CONTRACT-001.test.ts`）——机器规则要求 `approved` 至少有一条点名本故事的测试。路由清单测试随删面交付落地，不放进签字这一条。
- 2026-11-22 · **设置一处改签：这一轮不动 `agents` tab**。签字前核代码时发现矛盾：安装检测确实半成品，但那个 tab 同时是导入 provider 会话与角色默认的唯一入口（`LocalAgentSettingsSection.tsx`），删 tab 会删能力，撞上本故事自己的不做条款。改为拆独立 story `R-agents-detect`（先看着屏分清探测与导入/角色的边界），本故事只冻结「设置仍是一个页面、六个 tab 不变」。
- 2026-11-25 · 加 `### 逐行证据`：七行验收各自点名今天钉住它的用例（6 covered），第 4 行因「导入会话仍挂在 `agents` tab」没有页级用例而保留 `planned`，故状态仍是 `approved`；不改合同正文、退场表与四页决定。
- 2026-11-25 · 第 4 行补齐页级用例：`SettingsPage.leaveGuard.dom.test.tsx` 从 `/settings?tab=agents` 断言导入会话动作与「Add role」在场，并从 `general` 断言该动作不在别处；七个验收行全部 `covered`，状态转 `covered`。行为未变，红证是 `ui/src/pages/SettingsPage.agentsImport.mutants.json` 的两个变异体。
