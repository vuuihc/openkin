# KIN-CONTRACT-001 · 只留五个面：一份会被检查器执行的最小契约

状态：draft
优先级：P0
旅程：J1、J2、J4、J6
归属面：`IA.md`「一条用户路径」与「列表层级」
面：Mac、手机

## 谁、什么时候、为什么

当我每天在 Mac、iPad 和手机上打开 Kin 继续干活，我想只看到五个面——列表、对话、新建、项目封面、设置——其余能力收进对话里的卡片或 sheet，以便每个留下的面都能被真机验收到底，而不是十个页面各好一半。

这条来自 owner 2026-11-21 的决定：先删到最小契约，再用 RN 重建手机端；删面不删能力（`docs/adr/0035-mobile-rn-client-and-surface-reduction.md`、`docs/plans/2026-11-21-surface-reduction.md`）。

## 现在

今天 `ui/src/App.tsx:194-219` 有 15 条 `<Route>`：4 条已是 redirect（`/inbox`、`/approvals`、`/agents`、`/usage`），真页面约 10 个；Settings 有 6 个 tab（`ui/src/pages/SettingsPage.tsx:807`）；手机底栏 4 个入口（`ui/src/components/layout/PhoneFooter.tsx`）。五个路线各有故事且已验收（列表、对话、新建、项目、设置），但没有任何东西阻止下一条 PR 再加一个面：`removed-surfaces` 只保证删掉的路径不复活，不保证新增的面经过一次签字。结果是每个面只做完一半，手机端每个 tab 都留着一个桌面时代的页面。

## 范围

- 做：
  - 冻结五个面：`/sessions`、`/tasks/:id`、`/new`、`/projects/:id`、`/settings`；文件/diff/PR 是 `/tasks/:id` 内的面板，不是第六个面。
  - 一张退场表（本故事「设计」一节与审阅页的契约板）：每条旧路径 → 落到哪条面、能力搬进哪个卡片/工具、哪条故事负责。旧路径在能力搬完前保持可用。
  - 一个路由清单测试：`ui/src/App.tsx` 的每条 `<Route path>` 必须在契约面或退场表里；新增/删除一条而没改表就红，并打印 `KIN-CONTRACT-001`。生产路由与 dev-only 路由分开断言。
  - 退场表直接驱动测试：某行「负责」为空时，测试不允许把那条路径从退场表删掉。
  - 这份契约与审阅页（`KIN-CONTRACT-001.review.html`、7 张 SVG 帧）由 owner 签字后才开始交付。
- 不做（各自去处）：
  - 真正删除 routines / settings tab / usage / agent-sessions / projects 集合页 → 计划队列 `R-routine-tool`、`R-provider-sheet`、`R-usage-surface`、`R-delete-pages`；本条只冻结目标与顺序。
  - 死代码清理 → 已由 #547（`b4bc72f7`）完成，`removed-surfaces` 在 `scripts/check.sh` 里点名执行。
  - 手机端 RN 实现 → 独立 ADR/phase（`R-rn-spike`）；契约冻结前不写 `mobile/` 代码。
  - 列表密度与默认折叠的交互细节 → parked `R-list-scan`。
  - 设置里具体某一项的搬迁 → `KIN-SETTINGS-002` 与 `R-provider-sheet`。
  - 文件/diff/PR 面板的内容与只读 PR 面板 → `KIN-RESULT-002`、`KIN-RESULT-003`。
  - `/machines/:device/tasks/:id` 的读取实现 → 若 D5 选择合并，由本条交付；若选择保留，它作为第六个面写进契约。

## 每一步的预期

### 1. 定义 / 定位：打开 Kin，先认出自己在哪一个面

| 项 | 预期 |
|---|---|
| 起点 | 冷启动，或从通知、书签、旧深链进来；地址可能是契约内路径，也可能是退场表里的旧路径 |
| 动作 | 不点任何东西，等首屏 |
| 立刻看到 | 落到五个面之一；旧路径落到退场表指向的那条面，地址栏换成契约路径（`replace`，不新增一条可后退的假历史） |
| 慢 / 空 / 失败 / 断线 | 首屏慢时保留 shell 与上一个面（F4）；daemon 不可达时一条 transient 说明加重试，不整页空白；深链里的对话不在这台设备上时落到列表并说明 |
| 键盘与焦点 | 落在目标面的第一个可操作元素（列表搜索框 / composer / 设置首个控件），不停在被重定向的旧地址上 |
| 离开再回来 | 回到同一个面，不重复重定向、不重复弹权限 |

### 2. 准备 / 确认：从列表认出要读的那一段

| 项 | 预期 |
|---|---|
| 起点 | `/sessions`：设备 → 项目 → 对话三层，项目与设备默认折叠 |
| 动作 | 展开一层、搜索、点标题 |
| 立刻看到 | 对话在同一个 shell 里打开；列表保持滚动与展开状态 |
| 慢 / 空 / 失败 / 断线 | 空列表写「还没有对话」并给一个「新对话」；搜索无结果写清搜索词；列表加载失败一行重试，已加载的行不消失；离线设备的行不可展开，点一次说明原因 |
| 键盘与焦点 | 搜索框可 Tab 到；↑↓ 在行间移动，Enter 打开，Esc 清空搜索并留在列表 |
| 离开再回来 | 搜索词、筛选、滚动位置、展开层级都保留（F4） |

### 3. 执行：读、发、看改动，全部留在同一条对话里

| 项 | 预期 |
|---|---|
| 起点 | `/tasks/:id`，或 `/new` 的草稿发出去 |
| 动作 | 滚动阅读、点 header「文件」打开面板、在 composer 接着问 |
| 立刻看到 | 面板在同一条对话内打开（不换路由）；发出去的消息入流、composer 清空并保持焦点 |
| 慢 / 空 / 失败 / 断线 | 流式时保留已收到的内容；断线时内容不丢、一条重连说明；发送失败把草稿留在 composer 并给原因 |
| 键盘与焦点 | composer 是唯一输入路径；Esc 关面板并把焦点还给「文件」；⌘Enter 发送 |
| 离开再回来 | 草稿、滚动位置、面板开关按 F4 恢复；不重复发送 |

### 4. 监控：契约被破坏时，机器先看见

| 项 | 预期 |
|---|---|
| 起点 | 一条普通 PR，改了 `ui/src/App.tsx` 或新增一个页面 |
| 动作 | 什么都不做，等 `scripts/check.sh` |
| 立刻看到 | 新增路由不在契约里 → 测试失败，输出点名 `KIN-CONTRACT-001` 和那条路径；删掉契约路由同样红；退场表里的「负责」为空也红 |
| 慢 / 空 / 失败 / 断线 | 测试不联网、不起浏览器；读不到 `App.tsx` 就先红，不静默跳过 |
| 键盘与焦点 | 无（命令行） |
| 离开再回来 | 同一棵树重跑结论一致 |

### 5. 收尾：退场表里的每一条都有主

| 项 | 预期 |
|---|---|
| 起点 | 一条旧路径（如 `/routines`） |
| 动作 | 打开它 |
| 立刻看到 | 落到契约面，并且它的能力在对话里可达（工具或卡片），不是消失 |
| 慢 / 空 / 失败 / 断线 | 能力还没搬完时旧路径保持可用，退场表写「等哪条故事」；不许先删后补 |
| 键盘与焦点 | 落到目标面的第一个可操作元素 |
| 离开再回来 | 旧书签仍然可用；退场表有一行日期与负责故事 |

## 各面差异

| 面 | 这一面怎么呈现 | 为什么不同 |
|---|---|---|
| Mac | 左列表 + 主区两栏；文件/diff/PR 是主区右侧面板；设置在同一个面里两个 tab | 屏幕宽，列表与正文可以同时在场；面板不换路由才能保住滚动与草稿 |
| 手机 | 列表、对话、新建、设置各自占满一屏；文件/diff 是对话上的面板页，返回先关面板；底栏只指向契约路由 | 一屏只有一个面；底栏多一个入口就多一个要维护的面 |

## 设计

设计稿：`KIN-CONTRACT-001.figma/frames/`（7 张 SVG 源帧）和 `KIN-CONTRACT-001.review.html`（Figma 帧 + 每屏六段用户流程 + 决定）。

必须画到的状态：默认、空列表、加载、失败、断线、锁定（能力还没搬完的旧路径）。

**退场表**（也是清单测试读的那张表）：

| 旧路径 | 落点 | 能力去处 | 负责 |
|---|---|---|---|
| `/inbox`、`/approvals` | `/sessions` | 列表每行写「等你处理」 | 已落地 |
| `/usage` | 对话内 | composer footer 的「用量 ▾」sheet | `R-usage-surface` |
| `/routines` | 对话内 | routine 工具 + `RoutineCard` | `R-routine-tool` |
| `/agents` | 对话内 | agent-status card | `R-agent-status` |
| `/agent-sessions/:id` | 对话内 | agent-status card 的展开 | `R-agent-status` |
| Settings 的 agents / operations / account / push / roles | `/settings` | Provider sheet 与对话内卡片 | `R-provider-sheet` |
| `/projects` | `/sessions` | 列表层级 + `/projects/:id` 封面 | `R-delete-pages` |
| `/machines/:device/tasks/:id` | `/tasks/:id?device=` | 同一份阅读面 | 本条（D5） |
| `design-system` | 不在生产路由 | 仅 dev build | 本条 |

## Do not

- 不许新增第六个面；新面必须先有 story，再改契约与清单测试。
- 不许把「删面」做成「删能力」：被删路径的能力必须已有 tool/card 且测试绿。
- 不许改 HTTP/事件契约、数据模型、权限或安全语义；这条只动前端路由与文档。
- 不许在契约冻结前写 `mobile/` 的 RN 代码，也不许把 RN 重写夹进删除 PR。
- 不许用通配路由（`*`）吞掉未登记的路径来让清单测试变绿。
- 不许用放宽断言（前缀匹配、允许列表留空）代替清单。

## 验收

| Given | When | Then |
|---|---|---|
| 一条新增的 `<Route path="/x">` 不在契约表 | 跑 `scripts/check.sh` | `ui/src/lib/routes.contract.test.ts` 失败，输出含 `KIN-CONTRACT-001` 与 `/x` |
| 契约五条面路由之一被删 | 跑同一个测试 | 失败并报出缺的那条 |
| 退场表某行「负责」为空 | 跑同一个测试 | 失败，不允许把那条路径从表里去掉 |
| `/inbox`、`/approvals`、`/agents`、`/usage` 这类退场路径 | 打开 | 落到退场表写的面，`replace` 进历史，不产生可后退的假记录 |
| 一条计划删除的页面（如 `/routines`） | 能力还没搬完时打开 | 仍可用；清单测试不允许提前删 |
| 变异体：把一条契约面路由塞进退场表当 redirect | 跑测试 | 必须红（退场表不能当后门） |
| 手机底栏 | 在 390 打开 | 每个 tab 的目标都在契约表里，没有指向退场路径的 tab |

## 证据

- 契约与退场表：本文件「设计」一节；审阅页 `KIN-CONTRACT-001.review.html` 的契约板。
- 现状：路由 `ui/src/App.tsx:194-219`；Settings tab `ui/src/pages/SettingsPage.tsx:807`；手机底栏 `ui/src/components/layout/PhoneFooter.tsx`。
- 方向来源：`docs/adr/0035-mobile-rn-client-and-surface-reduction.md`、`docs/plans/2026-11-21-surface-reduction.md`。
- 已完成的第一步：#547 `b4bc72f7` 删除 1,090 行死代码，`removed-surfaces` 已在 `scripts/check.sh` 里点名执行。

## 变更记录

- 2026-11-22（+08）· 初稿：五个面 + 退场表 + 路由清单测试；等 owner 在审阅页签字。
