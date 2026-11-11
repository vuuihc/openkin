# 四条故事交付 · 2026-11-11

状态：**进行中 · 第 1、2、3 条已交付（KIN-PROJECT-001、KIN-AGENTS-001、KIN-ROUTINE-001），第 4 条未开始（KIN-START-001）**。一次交付一条，每条走完整完成门；本文件是四条故事的唯一进度表。

## 现在的位置

| 顺序 | 故事 | 状态 | 证据 |
|---|---|---|---|
| 1 | `KIN-PROJECT-001` 项目封面 | 已交付（covered） | 6 个测试文件 / 84 例；`check.sh` 14 项绿；13/13 mutant 红；1100 / 390 截图（本地临时文件） |
| 2 | `KIN-AGENTS-001` Agent 运维 | 已交付（covered） | 6 个变更/新增测试文件 / 93 例（注册表共 7 个测试文件）；`check.sh` 14 项绿；38/38 mutant 红；1100 / 390 截图；`9f14406c`；桌面与 Hub 已重建（线上 `index-8Y0FgbFB.js`） |
| 3 | `KIN-ROUTINE-001` 例行任务 | 已交付（covered） | 11 个变更/新增测试文件（新增 4 个）；页面 DOM 19 例、会话规则 8 例、调度器 2/12、store 5 例、API 1 例；`check.sh` 14 项绿；22/22 mutant 红；1100 / 390 截图（本地临时文件）；`c5af44c7` |
| 4 | `KIN-START-001` 新建对话 | 已签字，未开始 | 合同 / 审阅页 / 5 帧已签（2026-11-11） |

- 四条都已 `approved`；交付一条改成 `covered`，同一个提交带代码、测试、故事与 `registry.json`。
- `KIN-SETTINGS-002`（桌面壳一键升级）不在本轮四条内，仍在队列里，等这四条之后单独交付。
- 每条的完成门：`./scripts/check.sh` → 红验证（mutant）→ 同模型复审 → 修 blocker/major → 提交 → 合入 `main` → `./scripts/desktop-rebuild.sh` → Hub 重新部署（手机可见时）。

## 1. KIN-PROJECT-001 · 项目封面

范围（合同 `docs/product/stories/KIN-PROJECT-001.md`）：

- `/projects/:id` 只有概览：一句话摘要（可编辑）、最近活动、两张两周热力图、这个项目的例行任务块（只显示归属，调度归 `/routines`）。
- 没有「对话」tab；最近活动只放最近一段对话的入口，更早的对话回列表按项目找。
- 空项目、加载、概览读不到、项目不存在、离线、摘要编辑中 / 冲突各有文字与下一步。

现在：`ProjectDetailPage.tsx` 单面化完成——去掉「对话」tab 与第二份列表，最近活动只保留一行；摘要编辑 `Current Focus` 并处理 409；pulse 固定两周；例行任务只读并链到 `/routines`；项目记录、One-Pager、pulse、活动、例行任务各自失败、各自保留上次结果；离线时先画缓存。`KIN-PROJECT-001.md` 已置 `covered`。

验证：`ProjectDetailPage.dom.test.tsx`（23，新）、`projectChatsWiring.test.ts`（17）、`projectChats.test.ts`（25）、`onePagerSummary.test.ts`（10，新）、`projectCoverCache.test.ts`（5，新）、`projectScroll.test.ts`（4，新）；`check.sh` 14 项全绿；13/13 mutant 红；1100 / 390 截图对照。复审的 1 blocker / 13 major 全部修复并红验证；剩余风险记在故事「已知限制」（浏览器 Back 未拦截、operatorOnly 写接口）。

落地：`53667935` 已快进 `main`；`./scripts/desktop-rebuild.sh` 重建并重启桌面；Hub 镜像已重新部署到 NAS（线上 entry chunk `index-CWu6gfcA.js` 与本地一致，容器 healthy）。

## 2. KIN-AGENTS-001 · Agent 运维

范围（合同 `docs/product/stories/KIN-AGENTS-001.md`）：

- 目录最多 10 个产品（同一产品的 native / ACP / CLI 算一个）；发现第 11 个时标「已满」并说明先移除或合并。
- 发现新 agent 不自动接入；必须经过「接入确认」对话框，说明会做什么 / 不会做什么。
- 接入不导入历史会话；agent 会话只在用户手动导入时进来。
- 状态：未接入、已满、接入中、接入失败、未登录、额度等待、检查中 / 失败 / 断线。

现在：目录收敛为 10 个产品（`agentCatalog.planAgentCatalog`，产品 = 带 permission ladder 的 registry 行，sighting 不播种、不进发现）；首次访问从可托管产品播种，之后按浏览器保存（`agentPageState`），空目录不会被重新播种；发现区只列可托管、已安装、未接入的产品，接入必须经过确认面板（会做什么 / 不会做什么、满员与断线禁用、失败回滚）；会话导入只在「导入会话」按钮上发生，且只问这一台机器；区间切换保留旧数字（「更新中」），失败回退并说明；额度等待显示本控制台观察到的时长与恢复时间；Mac 表格对齐帧的 9 列（去缓存命中 / 成本每任务 / token 每任务，保留额度列），1280 内不横向滚动；手机卡片 + 动作面板与桌面共用同一份动作清单。

验证：`AgentsPage.dom.test.tsx`（33，新）、`agentPageState.test.ts`（8，新）、`agentCatalog.test.ts`（+8）、`agentFamilies.test.ts`（+1）、`agentLimits.test.ts`（+4）、`usage.test.ts`（+3），共 6 个变更/新增测试文件 / 93 例（注册表另有 `agentSessionImport.test.ts`）；`check.sh` 14 项全绿；`.tmp/agents.mutants.json` 38/38 红；1100 / 390 截图对照（目录、发现区、居中确认框、动作面板）。

复审：首轮 0 blocker / 7 major / 10 nit；7 个 major 全部修复（缺失发布名额、变体合并按已安装、按产品归并用量、首读失败不武装区间回退、重连读所选区间、重检重读额度、`agentPageState` 补测）。二审 0 blocker / 7 major / 12 nit；7 个 major 全部修复（取消接入回滚且迟到回答不提交、居中确认框标题、所有读共用代际、表头与名额同数、默认按产品标记与移除保护、smoke 结果不被刷新失败覆盖、44px 触达），并修掉探测失败沿用旧登录态、重连测试空断言、history.back 串测、首次额度等待无测试、Sheet 依赖、重连重复读、未安装提示与文档计数；剩余 nit（批量排序无直接断言、接入后焦点落 body、空目录 CTA 文案）已记在交接说明。三审 0 blocker / 2 major / 5 nit；2 个 major 修复（接入读也取代际、旧的行级重检不清新行的忙碌态），并修掉接入确认时产品已消失仍记为成功、smoke 刷新失败的代际、两处测试释放函数可能为空、证据里的 mutant 数与导入验收行指向。四审 0 blocker / 0 major / 6 nit：其中两个是陈旧接入回答误判「本机不再报告」与缺产品判定后不刷新列表，已修为只有最新读才裁决并先提交新列表；另修 smoke 忙碌态补测、状态行与计数措辞。

落地：`9f14406c` 已快进 `main`；`./scripts/desktop-rebuild.sh` 重建并重启桌面（`:7777` 与 `web/dist/index.html` 同为 `index-8Y0FgbFB.js`）；Hub 镜像已重新部署到 NAS（公网 entry chunk 与本地一致，容器 healthy）。

## 3. KIN-ROUTINE-001 · 例行任务

范围（合同 `docs/product/stories/KIN-ROUTINE-001.md`）：

- `/routines` 只保留运行记录（时间、结果、耗时），不内嵌或复制会话；记录链到项目里的那段对话。
- 定时运行的会话默认在同一条里持续；每条任务可选「每次执行在对应项目新建会话」。
- 机器离线、空、加载、调度非法、运行中 / 成功 / 失败、等待批准、未读 / 已读各有文字与下一步。

现在：每条例行任务可选会话方式（默认同一条持续，fresh 可选），从列迁移（v48）、API、调度器贯通到表单；daemon 与表单共用一条延续规则——只看最新一轮，且须同 agent / 目录 / 模型、已结束、本机来源。运行记录移到列表旁的独立面板（手机在行内），只写时间、结果、耗时并链回项目会话，不渲染会话正文。记住的离线机器不静默换机、全部写入禁用；脏表单、切换机器、保存中关闭都要确认或说明；表单提示跟随表单里的目录与模型。

验证：`RoutinesPage.dom.test.tsx`（19，新）、`routineConversation.test.ts`（8，新）、`scheduler_conversation_test.go`（2 个测试 / 12 子例，新）、`routines_conversation_test.go`（5，新）、`routineEdit.test.ts`（+1）、`routineDevice.test.ts`（+1）、`routines_test.go`（+1）、两处 wiring（改）；`check.sh` 14 项全绿；`.tmp/routine-conversation.mutants.json` 22/22 红；1100 / 390 截图对照。

复审：3 轮同模型复审；首轮 1 blocker（延续规则未检查 agent / 目录 / 模型 / 来源）+ 若干 major，二轮修掉提示比较存储值而非表单值等 major，三轮 0 blocker / 0 major；nit（fresh 提示优先于「正在读取」、迁移注释、`aria-controls`）同轮修掉。

落地：`c5af44c7` 已快进 `main`；`./scripts/desktop-rebuild.sh` 重建并重启桌面（`:7777` 与 `web/dist/index.html` 同为 `index-DYC7SM2h.js`）；Hub 镜像已重新部署到 NAS（公网 entry chunk 与本地一致，容器 healthy，回滚镜像 `openkin:dogfood-prev` 已保留）。

## 4. KIN-START-001 · 新建对话

范围（合同 `docs/product/stories/KIN-START-001.md`，2026-11-11 签字版）：

- 居中一张输入卡：卡内写提示词，卡底一行是权限、agent · 模型与「开始」；设备 · 项目在卡下单独一条，点开先选机器再选项目。
- 手机同一构图占满宽度；运行设置是底部面板，和对话页同一个。
- 草稿保留到开始或清空；开始后进入对话页；空、加载、模型失败、断线、没有 agent、机器离线、项目不在了、创建失败都有文字与下一步。

现在：`ui/src/pages/NewChatPage.tsx` 是 576px 窄栏 + 输入框下方一行；本轮重排成居中输入卡 + 卡下项目条，新增 `PlacePicker`，复用 `RunConfigSheet`。

验证：新建 `NewChatPage.dom.test.tsx`、`PlacePicker.dom.test.tsx`，扩充 `RunConfigSheet.dom.test.tsx`；1100 / 390 截图；`check.sh`；空内容禁用、离线禁用、项目记忆回退各一个 mutant。

## 不做

- 不新增设置项、权限模式、模板库或推荐提示词。
- 不改后端接口；会话与调度的存储沿用现有表。
- 不按设备拆故事；四条都同时交付 Mac 与手机。
- 不把四条混成一个提交；一条一个落地。

## 实际花费（每条交付后补）

| 故事 | 文件 / 净行 | 测试 | 提交 | 复审 |
|---|---|---|---|---|
| PROJECT | 18 文件，+2571 / −842（含文档与 `web/dist/index.html`） | 6 文件 / 84 例；新增 3 个测试文件 | 1（`53667935`） | 1 blocker + 13 major + 17 nit；全部 blocker/major 修复，13/13 mutant 红 |
| AGENTS | 21 文件，+3696 / −642（含文档与 `web/dist/index.html`） | 6 文件 / 93 例；新增 3 个测试文件 | 1（`9f14406c`） | 4 轮：0/7/10 → 0/7/12 → 0/2/5 → 0/0/6；38/38 mutant 红 |
| ROUTINE | 27 文件，+2316 / −276（含文档与 `web/dist/index.html`） | 11 文件（新增 4）/ 19 + 8 + 2 + 5 + 3 例 | 1（`c5af44c7`） | 3 轮：1 blocker + 若干 major → major → 0/0；22/22 mutant 红 |
| START | — | — | — | — |
