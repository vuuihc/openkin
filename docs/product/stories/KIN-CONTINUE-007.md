# KIN-CONTINUE-007 · 在 820 的列表里一屏扫到那条对话

状态：covered
优先级：P0
旅程：J1、J2
归属面：`IA.md`「列表层级」
面：Mac、手机

## 谁、什么时候、为什么

当我坐在竖着的 iPad 前（820×1180，手指操作），或把 Mac 窗口收窄到只剩 304px 左栏，想接着问昨天那段对话，我想一屏就扫到十条对话——每条只有一行标题、一行元数据，设备和项目默认不再把对话挤到折叠线以下——以便不用先滚动、先折叠、先猜被截断的标题。

这是 `R-list-scan` 的合同。`KIN-CONTINUE-004.md:38` 的「不做」把它写成「下一条故事」；`ui/src/index.css:263-266` 记录本故事 item 5 / D4 对粗指针地板的要求，本条就是那一条。

## 现在

2026-11-24 在 820×1180、`pointer: coarse` 下重跑 `node rsi/runtime/ux/measure-list-shell.mjs --viewports 820x1180 --shots …`：列表列 304px，项目名可读宽度 126.5px，对话标题 97.7px（行宽 216px），与 `ui/src/index.css:270-271` 记录的 2026-11-23 值一致。同一次运行的 shipped 截图里默认列表只露出 **8 条对话**（Alpha 2 条、Beta 5 条、Gamma 1 条），而设备标题写「此设备 10」——另外 2 条在折叠线以下。

- **一行塞了标题和全部尾巴**：`ui/src/components/sessions/SessionRow.tsx:399` 的标题是单行 `truncate`，`:422-431` 把设备名、例行标记、相对时间放在同一行尾部；304px 下标题只剩 97.7px，截图里读作 `[seed] A…`、`[seed] Mornin…`。
- **项目默认全开**：`ui/src/components/sessions/SessionList.tsx:853` 是 `folds[stateKey] ?? !imported`——只有「导入的会话」默认收起，项目一律展开。
- **每个展开的项目都带一块工作方式**：`SessionList.tsx:2499-2512` 在展开项目里渲染 `ProjectInstructionsRow`；标题行 `:2071` 是 44px，正文 `:2136-2137` 是 `line-clamp-2`。截图里 Alpha 这块约 95px、Beta 约 80px，三个项目就吃掉约 260px（2026-11-24 截图逐块量得）。
- **44px 地板停在 md（D4 落地前的状态）**：`ui/src/index.css:287` 的 `.touch-lg` 当时只在 `max-width: 767.98px` 或粗指针且不超过 767.98px 时生效，同一次测量里 820 的 `shippedFloorMatches` 是 false；item 5 / D4 已把粗指针臂扩到 1023.98px（宽度臂仍是 639.98px），落地后 820 复测 `shippedFloorMatches: true`，项目名与行标题仍是 126.5px / 97.7px。行本身有 `min-h-11`（`SessionRow.tsx:296`，820 粗指针下 `dense` 为 false，见 `:178`），所以行量得 44px；但这来自行自己的类，不是全局地板——一个没写 44px 的控件在 820 上没有保证。
- **没有「一屏几条」的合同**：今天没有任何测试数过 820 一屏能放几条对话；8 这个数字只存在于这次截图里。

## 范围

- 做：
  1. 820 粗指针（768–1023.98 且 `pointer: coarse`）沿用同一个 304px `SessionList`，但行改成扫读密度：一行标题（单行截断）+ 一行元数据。
  2. 元数据行固定为「agent 名 · 相对时间 · 一个状态标记（运行中 / 待批准 N / 例行 / 已完成）」；去掉行尾的设备名和单独的例行标记，设备已是分组标题。
  3. 折叠默认：设备保持展开；项目默认折叠，只有「最近一条对话所在的项目」首次打开；本机存过的折叠状态优先。
  4. 展开项目的「工作方式」收成一行可展开的披露行，默认收起；展开状态按项目记住。
  5. 44px 地板按 AGENTS.md 规则 16 扩到 768–1023.98：只扩粗指针那一条臂，不动宽度臂。
  6. 契约：820×1180 粗指针、一个项目展开且工作方式收起时，一屏至少 10 条对话行完整可见。
  7. Mac 1100 的 304px 左栏与手机 390 用同一个组件、同一条行式；820 是这两端之间的粗指针状态，不是第三张皮。
- 不做：
  - 扁平化设备层或项目层：`IA.md:22-30` 的三级不变；要改先另写故事。
  - 行的悬停动作、多选、滑动、长按（`KIN-MANAGE-001`）。
  - 搜索、筛选、归档范围、例行筛选（`KIN-CONTINUE-002`、`003`、`004`）。
  - 新建入口与每设备新建（`KIN-CONTINUE-004`、`KIN-START-001`）。
  - 项目封面、摘要与工作目录编辑（`KIN-PROJECT-001`、`002`、`003`）。
  - 行内 diff 统计、模型名、筛选 chips：今天没有故事，不做；要就另开一条「看它改了什么」的故事。
  - 小于 44px 的触控目标（`TASTE.md` 11）；`docs/product/IA.md` 本身（两条在开 PR 拥有它）。

## 每一步的预期

### 1. 定义：打开 820，先看清哪些项目里有对话

| 项 | 预期 |
|---|---|
| 起点 | 820×1180 粗指针，落在 `/sessions`，左栏 304px，有 2 台设备和 4 个项目 |
| 动作 | 不点任何东西，先扫设备标题和项目标题 |
| 立刻看到 | 设备标题一行；其下项目标题各一行，只有最近有对话的那一个展开并露出行；展开项目的「工作方式」是一行披露行（`▸ 工作方式`），不是两块正文 |
| 慢 / 空 / 失败 / 断线 | 首次载入出设备标题骨架；项目头读失败保留设备标题并给该组「重试」；断线时顶部横幅、已加载的项目与行不清空；没有项目时说「还没有对话」并指向头部新建 |
| 键盘与焦点 | 不自动聚焦；Tab 顺序：头部新建 → 搜索 → 设备新建 → 每个项目折叠箭头 → 打开项目的行；项目标题不是停点，箭头才是 |
| 离开再回来 | 项目折叠状态按项目记住；上次展开的项目仍是展开的；滚动锚点保留 |

### 2. 定位：在一屏里扫到那条对话

| 项 | 预期 |
|---|---|
| 起点 | 一个项目展开，工作方式收起，列表有 10 条以上对话 |
| 动作 | 眼睛沿标题列往下扫，不滚动 |
| 立刻看到 | 一屏至少 10 条完整对话行；每条第一行是标题，第二行是 agent · 时间 · 状态；长标题在第一行末尾截断，第二行不被标题挤压 |
| 慢 / 空 / 失败 / 断线 | 行数据未到时不占位、不显示空行；本组读失败只在该项目下给一行「读取失败，重试」；断线保留已加载行 |
| 键盘与焦点 | 每行是一个停点；上下方向键在本项目内移动（沿用今天的行导航）；焦点行有可见焦点环 |
| 离开再回来 | 滚动位置保留；从对话返回时停在那一条行上，不跳回顶部（`TASTE` 15） |

### 3. 准备：展开另一个项目，不丢当前项目

| 项 | 预期 |
|---|---|
| 起点 | 项目 A 展开，想看的对话在项目 B |
| 动作 | 点项目 B 的折叠箭头 |
| 立刻看到 | B 在原地展开露出行；A 保持展开还是收起，按用户上一次的选择执行，默认同时只开一个项目（打开 B 收起 A） |
| 慢 / 空 / 失败 / 断线 | B 的工作方式读失败不影响行；断线时行仍可打开；B 没有行时显示「还没有对话」而不是空白 |
| 键盘与焦点 | 箭头可 Enter/Space；展开后焦点留在箭头上，下一次 Tab 进入 B 的第一行；Esc 不收起项目 |
| 离开再回来 | 打开的是哪个项目被记住；刷新后仍是它 |

### 4. 确认：读一行的第二行，确认是不是那一条

| 项 | 预期 |
|---|---|
| 起点 | 10 条以上行同屏，标题相近 |
| 动作 | 读某一行的第二行 |
| 立刻看到 | 第二行依次是 agent 名、相对时间、一个状态标记；待批准带数字（如「待批准 2」）；例行运行写「例行」，不另起一枚 chip |
| 慢 / 空 / 失败 / 断线 | 时间读不到时留空而不写假时间；状态未知时不画绿点；断线不改写相对时间 |
| 键盘与焦点 | 第二行并进行的可访问名称，读屏一次读出「标题 · agent · 时间 · 状态」；状态标记不只靠颜色 |
| 离开再回来 | 相对时间按当前时钟刷新，但不改变行顺序、不抢焦点 |

### 5. 执行：打开那条对话

| 项 | 预期 |
|---|---|
| 起点 | 找到了那一行，鼠标或手指在行上 |
| 动作 | 点行（或在焦点行按 Enter） |
| 立刻看到 | 右侧（Mac/820）或整页（手机）打开该对话；列表保持挂载，行显示当前态 |
| 慢 / 空 / 失败 / 断线 | 详情未到时列表仍可见、行有局部等待提示；打开失败留在列表并提示重试；断线时允许打开已缓存的那一条 |
| 键盘与焦点 | Enter 打开；打开后焦点进入对话输入框；返回时焦点回到这一行 |
| 离开再回来 | 列表滚动、折叠、展开的工作方式都保留；不重新加载整页（`TASTE` 15） |

### 6. 监控：10 条、空、离线、断线

| 项 | 预期 |
|---|---|
| 起点 | 列表处于默认、空、离线设备或断线之一 |
| 动作 | 等一次刷新，或切到另一台设备 |
| 立刻看到 | 默认：一屏 ≥10 条；空：项目头仍在 + 「还没有对话」；离线设备：标题与行仍在，行可读，新建入口禁用；断线：顶部横幅，行不清空 |
| 慢 / 空 / 失败 / 断线 | 加载中不显示空态；重试保留折叠与滚动；离线设备的行照常打开；断线恢复后新行按现有顺序插入，不把正在读的行顶走 |
| 键盘与焦点 | 重试可 Tab 到；失败不抢焦点；断线横幅 `role=status`；禁用入口读得到原因 |
| 离开再回来 | 重试后回到同一位置；折叠状态不因一次刷新改变 |

### 7. 修改：长标题、重命名、收起工作方式

| 项 | 预期 |
|---|---|
| 起点 | 一条标题很长、或工作方式正展开着 |
| 动作 | 看截断；重命名；点「工作方式」披露行收起 |
| 立刻看到 | 标题在标题行末尾省略号截断，元数据行完整；重命名后就地重画、仍保持两行；工作方式收起后行数不跳、滚动锚点不动 |
| 慢 / 空 / 失败 / 断线 | 重命名失败就地提示并还原标题；工作方式读失败时披露行写「读取失败，重试」；断线时工作方式收起不报错 |
| 键盘与焦点 | 重命名由 `KIN-MANAGE-001` 负责；披露行可 Enter/Space，`aria-expanded` 正确，焦点留在披露行 |
| 离开再回来 | 工作方式的展开状态按项目记住；重命名后的标题在两行内截断 |

### 8. 收尾：离开列表再回来

| 项 | 预期 |
|---|---|
| 起点 | 从对话返回、或从别的区域切回列表 |
| 动作 | 直接回来，不做任何操作 |
| 立刻看到 | 列表外壳还在，只有变化的那一块更新；项目折叠、工作方式展开、滚动位置与焦点行都还在 |
| 慢 / 空 / 失败 / 断线 | 回来后一次后台刷新失败不清空列表；断线横幅在位；没有整页骨架（`TASTE` 15） |
| 键盘与焦点 | 焦点回到离开前的那一行；若那行已被删除，焦点落到项目箭头并读出项目名 |
| 离开再回来 | 本条自己的状态：折叠、工作方式、滚动、焦点；搜索与归档范围仍归 `KIN-CONTINUE-002`/`003` |

## 各面差异

| 面 | 这一面怎么呈现 | 为什么不同 |
|---|---|---|
| Mac | 1100×760 的 304px 左栏：同一条两行行式；鼠标指针下项目与行保持紧凑密度，但两行行高不低于 44px；悬停动作仍浮在行尾；项目默认折叠（最近项目展开），工作方式折叠成一行 | 指针精确、垂直空间也贵；两行换来标题不被截成 97.7px，行数用折叠补回来 |
| 手机 | 390×844 整页列表：同一条两行行式；设备标题是大写小标；每设备新建保留；宽度足够，标题很少截断；820 粗指针走这一套行的规则，只换容器为 304px 左栏 | 手指需要 44px 与更宽的行距；手机没有第二列，行是唯一内容 |

## 设计

设计稿：`KIN-CONTINUE-007.figma/frames/`（5 张 SVG 源帧，Figma 可导入）和 `KIN-CONTINUE-007.review.html`（Figma 帧为主体，每屏六段用户流程；签字前两样都必须有）。

必须画到的状态：默认（820 折叠）、一个项目展开、Mac 1100 左栏、手机 390、行状态板（纯标题 / 标题+元数据 / 长标题截断 / 当前行 / 未读·归档 / 离线设备）。

## Do not

- 不许出现第二份对话列表，也不许把设备层或项目层拍平。
- 不许改 `docs/product/IA.md` 或别的故事的 registry 行。
- 不许改搜索参数、归档范围、例行筛选或新建入口的行为。
- 不许引入模型名、diff 计数或新的筛选 chips；元数据只放本故事写明的四项。
- 不许用宽度断点冒充粗指针（AGENTS.md 16）；44px 地板只扩 `pointer: coarse` 那条臂。
- 不许把触控目标缩到 44px 以下，也不许用颜色单独表达状态。
- 不许在帧里放真实数据、截图、主机名或设备 id。
- 不许新增接口、存储键或依赖；折叠沿用现有的 `readSessionFolds` / `setSessionFold`。

## 验收

| 层级 | 位置 | Given / When / Then |
|---|---|---|
| 单元 | `ui/src/lib/sessionListFolds.test.ts`（新） | Given 本机没有任何折叠记录 When 计算默认折叠 Then 只有最近一条对话所在的项目展开、其余项目收起；Given 存过「B 展开」When 再进列表 Then B 展开且 A 收起；Given 导入分组 Then 仍默认收起（`SessionList.tsx:853` 的旧规则不回归） |
| 组件 | `ui/src/components/sessions/SessionList.listScan.dom.test.tsx`（新） | Given 820 粗指针、一个项目展开 When 渲染 Then 每行是一个标题行 + 一个元数据行，元数据含 agent、时间、状态（「renders one title line and one metadata line at 820」）；Given 长标题 Then 标题行 `truncate`、元数据行不被截断（「keeps the metadata line whole while the title truncates」）；Given 行属于某台设备 Then 行内不再重复设备名（「drops the per-row device label under a device heading」）；Given 10 条对话 When 在 820 数完整可见行 Then ≥10（「fits ten conversations in one 820 screenful」）；Given 项目折叠默认 Then 只有最近项目展开（「opens only the most recent project by default」）；Given 工作方式 Then 默认是一行披露行、Enter 展开且状态被记住（「folds the project's working style to one disclosure line」） |
| 组件 | `ui/src/components/sessions/SessionRow.coarse.dom.test.tsx`（新） | Given 820 粗指针 When 渲染一行 Then 行高与行内动作都 ≥44px（「keeps a 44px row and actions at 820 coarse」）；Given 细指针 1100 When 渲染 Then 仍是紧凑密度但行高 ≥44px（「keeps the compact pointer density without going under 44px」） |
| 回归 | `ui/src/components/layout/Sidebar.dom.test.tsx` | Given 1100 左栏 When 渲染 Then 没有第二份列表、没有搜索框变化，行式与组件仍是同一个 `SessionList`（「keeps the one sidebar list」） |
| 真浏览器 | 820×1180 粗指针 / 1100×760 / 390×844，`/sessions` | 820：种子后数一屏完整行 ≥10，展开另一个项目，长标题省略；1100：左栏同样两行、项目默认折叠；390：同一行式不溢出 |
| 视觉 | 820 / 1100 / 390 截图 | 820 对照 `01-820-list-default.svg`、`02-820-project-expanded.svg`；1100 对照 `03-mac-1100-list.svg`；390 对照 `04-phone-390-list.svg`；行状态对照 `05-row-states.svg` |

测试文件里必须出现 `KIN-CONTINUE-007`；组件测试的 mutants manifest 是 `ui/src/components/sessions/SessionList.listScan.dom.test.tsx.mutants.json`，`SessionRow.coarse.dom.test.tsx.mutants.json` 覆盖行高那条。测试文件在本条签字后的实现故事里创建，本 PR 不创建。

## 证据

- 之前：2026-11-24 的 820 测量与 shipped 截图（`/tmp/shots-list-820/820x1180.png`，逐行数得 8 条；`measure-list-shell.mjs` JSON 记录列 304px、项目名 126.5px、标题 97.7px、行高 44px）。
- 实现：三片已落 `main`；本条只结算台账，不改产品代码。
  - #705 `7c5f81f7`：项目默认折叠、只有最近项目展开、工作方式收成一行披露、10 行扫读面，以及折叠与行式的测试。
  - #716 `6c6e7aee`：820 的两行行式——标题行 + 元数据行（agent · 时间 · 一个状态槽），状态永远是词，不只靠颜色。
  - #712 `a61194a8`：item 5 / D4，`.touch-lg` 的粗指针臂扩到 1023.98px（宽度臂仍是 639.98px）。
- 验收逐行（五个测试文件都登记在 `registry.json`，都提到 `KIN-CONTINUE-007`）：
  - 单元 `ui/src/lib/sessionListFolds.test.ts`（6 例）：`opens only the most recent project by default`、`keeps a remembered open project and closes the others`、`keeps the imported group folded by default`、`does not let an empty project carry the open fold`、`never opens the pinned bucket in place of a project`、`honours a remembered closed latest project`。
  - 组件 `ui/src/components/sessions/SessionList.listScan.dom.test.tsx`（6 例，`:165` / `:187` / `:206` / `:223` / `:238` / `:253`）：`renders one title line and one metadata line at 820`、`keeps the metadata line whole while the title truncates`、`drops the per-row device label under a device heading`、`fits ten conversations in one 820 screenful`、`opens only the most recent project by default`、`folds the project's working style to one disclosure line`。
  - 组件 `ui/src/components/sessions/SessionRow.coarse.dom.test.tsx`：`keeps a 44px row and actions at 820 coarse`（`:88`）、`keeps the compact pointer density without going under 44px`（`:109`）；mutants manifest 是同目录的 `SessionRow.coarse.dom.test.tsx.mutants.json`。
  - 回归 `ui/src/components/layout/Sidebar.dom.test.tsx:182`：`keeps the one sidebar list`。
- 真浏览器（`rsi/state/shots/list-scan-b/measure.json`，2026-11-25T08:48:50Z 抓取；throwaway daemon + 种子数据，截图在同目录）：
  - 820×1180 粗指针：`completeRows = 10`、`rowsInDom = 10`，列 304px，行高 54.4px；`820x1180.png`。
  - 1100×760 细指针：`completeRows = 10`、`rowsInDom = 10`，列 304px，行高 46.4px；`1100x760.png`。
  - 390×844 粗指针：`completeRows = 9`、`rowsInDom = 10`（第 10 行落到折叠线以下；本条只要求 820 一屏 ≥10）；`390x844.png`。
  - 行状态：`820x1180-failed.png` 里失败行的第二行是 `Claude… · 27秒钟前 · 失败`——红点旁有「失败」这个词，不是只有颜色。
  - 折叠切片自己的复测（`rsi/state/shots/list-scan-a/measure.json`）：820 / 1100 / 390 都是 `completeRows = 10`、`rowsInDom = 10`，Alpha 展开、Beta / Gamma 收起、工作方式收起。
- 视觉：逐张对过 `KIN-CONTINUE-007.figma/frames/` 的 5 张帧。
  - `820x1180.png` ↔ `01-820-list-default.svg`：设备标题 + 计数、只有一个项目展开、工作方式一行披露、每行标题 + 元数据、一屏 10 行。实拍里 agent 名在 304px 下先省略（`Claude…`），元数据行的时间与状态完整——这是 #716 记录的选择，帧上画的是完整 agent 名。
  - `820x1180.png` ↔ `02-820-project-expanded.svg`：一个项目展开、其余折叠、行仍然扫得动的组成一致；02 独有的「工作方式展开成两句正文」没有实拍。
  - `1100x760.png` ↔ `03-mac-1100-list.svg`：同一个 304px 左栏、同一条两行行式、工作方式收成一行；实测行高 46.4px（不低于 44px），帧底部的 Beta / Gamma 折叠条在 760 高度下落到折叠线以下。
  - `390x844.png` ↔ `04-phone-390-list.svg`：同一行式、工作方式默认收起，放大镜 / 每设备新建 / 底栏都保持 KIN-CONTINUE-004 / 005 的样子；帧上的「此设备 · 在线」在实拍里是「此设备」+ 计数。
  - `820x1180-failed.png` ↔ `05-row-states.svg`：第二行固定 agent · 时间 · 一个状态，状态不只靠颜色；失败态是 05 板子四态之外的第五个词，规则一致。
- `unverified: 真浏览器一行差两处 —（a）820 的「展开另一个项目」：capture.mjs 不点项目折叠，measure.json 与 820 截图只有 Alpha 默认展开态；折叠交互由 J11 手机走查第 49 步点「展开项目 [seed] Project Beta」守住（rsi/state/shots/list-scan-b/journeys/walk.json 的 step 49；同目录 J11-phone-01-list.aria.txt 显示 Beta「收起项目 … [expanded]」且 Alpha「展开项目」），DOM 层另有 SessionList.projectFace.dom.test.tsx:296 的 Expand project Project Beta 与 Sidebar.dom.test.tsx:496 的 remembers a project fold by machine and project。（b）02-820-project-expanded 的「工作方式展开成两句正文」实拍 — 抓图只有收起态；展开、收起与按项目记忆由 SessionList.listScan.dom.test.tsx 的 folds the project's working style to one disclosure line 在 DOM 层守住，但没有 820 展开态截图。`

## 变更记录

- 2026-11-24 创建（draft）。把 `KIN-CONTINUE-004` 的「下一条故事」与 `ui/src/index.css:273-276` 的待决交给本页；CEO 签字前不改产品代码。
- 2026-11-24 · CEO 代签 `approved`（D4–D6 按审阅页推荐；记录见 `rsi/DECISIONS.md`）。实现这条故事的 PR 建三份测试、跑 820/1100/390 截图，并把本条翻 `covered`。
- 2026-11-25 · 结算：三片（#705 / #712 / #716）已落 `main`，五行验收逐行对上证据、真浏览器一行带着写明的缺口（820 的「展开另一个项目」折叠交互只有手机走查与 DOM 层证据），`registry.json` 补四个实现测试文件，状态翻 `covered`（docs-only）。
