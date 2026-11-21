# KIN-QUALITY-001 · 读完整条回答，再接着问（820 优先）

状态：covered
优先级：P0
旅程：J1、J2
归属面：`IA.md`「Mac 上接着问 / 手机上接着问」
面：Mac、手机（平板 820×1180 触摸是宽度/输入变体，不是第三个注册面）

## 谁、什么时候、为什么

当我回到一段已经有回答的对话，想从头读完那条回答和它的表格，我想在同一处顺手接着问，以便不用先关掉一层状态、也不用在读到一半时被浮层挡住。

## 现在

今天在 820×1180 的实机上：侧栏展开后对话列约 520 CSS px，正文上方叠着 tabs、header、用量、改动文件四条常驻条（报告实测约 170 CSS px，加通知与 daemon banner 约 270；`docs/plans/2026-11-21-t3-parity-quality-reset.md:20`、`docs/plans/gap-log.md:37`）；header 的桌面动作栏把 Pull Request、项目名压成半个字形和 24–30 px 的窄条；「有新进展」药丸用 `absolute bottom-3` 盖住表格最后两行；长表格被挤成逐字换行。手机已经做过正确决定：用量条消失、收进输入框 footer 的 popover（`ui/src/pages/TaskDetailPage.tsx:2575-2582` 的注释），平板没有沿用。当前桌面动作栏在 `ui/src/components/task/TaskHeader.tsx:235`，活动药丸外层在 `ui/src/pages/TaskDetailPage.tsx:2725`，审批条的根容器与按钮用 `flex-none` 占布局在 `ui/src/components/task/TaskComposerDock.tsx:146,167,175`。

本行已于 2026-11-21 由 CEO 代签（`approved`），实现与签字同一次交付。以上是签字时 `origin/main` 的现状；并行平板基线 lane 的测量文档 `docs/plans/2026-11-21-tablet-reading-baseline.md` 是同一批缺陷的独立复测，交付时以本行的三宽度走查为准。

## 范围

- 做：一条阅读交付——常驻 header ≤44 CSS px、正文、一个占布局的 composer；表格在自身容器内可读；用量/改动文件/会话动作收进既有 header 入口或其 popover/面板，最多一个动作可达；新进展走非内容通道；失败/断线一条 transient 说明且内容保留；390/820/1100 三宽度成立，820 先行。
不做的事及其去处：
  - 列表重排、筛选或默认折叠、T3 的「一屏 ≥10 条」目标 → parked：`docs/plans/2026-11-21-t3-parity-quality-reset.md` 的 `R-list-scan`，邻接 `KIN-CONTINUE-004` / `KIN-CONTINUE-003`，不在本条。
  - 模型、权限、agent 选择与运行配置 → `KIN-CONTINUE-001`。
  - diff、文件工作区与只读 PR 面板 → `KIN-RESULT-002`（PR 面板在同一个右侧容器里，从「文件」入口进入）；结果摘要与分享 → `KIN-RESULT-001`；逐行评论 → `KIN-RESULT-003`。
  - 用量统计口径、agent 安装与机器状态页 → `KIN-AGENTS-001`。
  - 新建对话、整理/归档对话、通知、例行任务 → `KIN-START-001`、`KIN-MANAGE-001`、`KIN-NOTIFY-001`、`KIN-ROUTINE-001`。
  - 把 820 接进 journeys / MANDATE / ux-gate 的公共走查基础设施 → parked：并行 `R-tablet-walk` lane；本条不接公共走查、不改这些 gate 文件，实现自带 820 fixture 与真浏览器验收，并按验收接入 check.sh。
  - F1 handoff 的协议本身 → parked：保持现状，没有故事拥有它，本条不改；分享 → `KIN-RESULT-001`。

## 每一步的预期

### 1. 定义 / 定位：从列表回到那段对话，认出要读的那条回答

| 项 | 预期 |
|---|---|
| 起点 | 对话列表（390 / 820 / 1100），这段对话可能刚跑完、正在跑或被归档筛选排除 |
| 动作 | 点那段对话的标题 |
| 立刻看到 | 对话占满主区；正文上方只有一条 ≤44 CSS px 的 header；已有回答直接出现，回来时回到上次位置 |
| 慢 / 空 / 失败 / 断线 | 加载时保留已有内容并给局部等待面，不整页骨架；空对话写「这段对话还没有回答」并保留 composer；加载失败给一条可重试说明；断线时内容保留，状态说明在 header 下占一条 transient 行 |
| 键盘与焦点 | 打开后焦点进入正文阅读起点而不是 composer；Tab 依次到 header 入口、表格容器、composer；Mac 上 Esc 回到列表搜索，手机系统返回回列表 |
| 离开再回来 | 滚动位置、草稿与未发送内容按对话恢复；不重复播报加载完成 |

### 2. 准备 / 确认：把长回答和表格读完，需要时看一眼状态

准备没有独立的设置动作（打开即读，必要时用页内查找），并入确认。

| 项 | 预期 |
|---|---|
| 起点 | 已回答的对话，正文里有长段落和 ≥4 行表格 |
| 动作 | 纵向阅读；表格在自己的容器里横向滚动；需要时点 header 的「文件」、footer 的「用量」或「⋯」中的一处 |
| 立刻看到 | 正文 measure 不因表格变窄；表格列保持可读，页面本身不横滚；每个入口各自最多一个动作可达：用量在 composer footer 的 popover，改动文件在 header 的文件入口，会话动作在「⋯」；不要求三者在同一面板 |
| 慢 / 空 / 失败 / 断线 | 状态加载时就地写「正在读取」；读取失败保留上次值并说明；没有用量时写「还没有用量」而不是画 0；被动打开不查 GitHub、不读 secure-store secret；断线时入口禁用并说明原因 |
| 键盘与焦点 | 表格容器可 Tab 聚焦并用方向键滚动；状态入口是按钮/菜单，Esc 关闭并把焦点还给入口 |
| 离开再回来 | 正文与表格滚动位置保留；状态面板默认关闭，不记住上一次展开 |

### 3. 执行：在同一个 composer 接着问

| 项 | 预期 |
|---|---|
| 起点 | 回答末尾，composer 在布局中占位，不是浮层 |
| 动作 | 在 composer 写一句话并发送（Mac ⌘Enter / 手机发送按钮） |
| 立刻看到 | 消息立刻进入流；composer 清空并保持焦点；屏幕上只有一个输入路径 |
| 慢 / 空 / 失败 / 断线 | 空内容不能发；发送失败时草稿留在 composer 并说明原因；断线进入本地队列，队列可见，重连后发出 |
| 键盘与焦点 | 发送后焦点留在 composer；表格容器不抢焦点；手机软键盘不收起，composer 不被键盘盖住 |
| 离开再回来 | 草稿按对话保存，切走再切回还在 |

### 4. 监控：跑动中、等待批准与新进展

| 项 | 预期 |
|---|---|
| 起点 | 一轮正在跑，或等待批准/回答；读者停在回答中段 |
| 动作 | 继续读上面的内容；新内容落到下方时点「有新进展」 |
| 立刻看到 | composer 上方出现一条 transient 非内容通道（新进展或审批定位条），不覆盖任何可见表格单元格；点它滚到最新并自行消失；批准仍在批准条或卡片上完成 |
| 慢 / 空 / 失败 / 断线 | 运行中状态可见但不新增常驻 bar；没有新内容时这条通道不出现；失败终态用一条消息说明且内容不消失；断线时保留内容与批准/回答 affordance |
| 键盘与焦点 | 新进展是有可见名字的按钮，Enter/Space 触发；live region 礼貌播报新增但不抢焦点；批准按钮顺序不变 |
| 离开再回来 | 回来时不在末尾则通道再次出现，已在末尾则不出现；不重复播报旧内容 |

### 5. 修改：失败或断线后的恢复

| 项 | 预期 |
|---|---|
| 起点 | 加载失败、发送失败或连接断开 |
| 动作 | 读一条诚实说明；点重试或等待恢复 |
| 立刻看到 | 一条 transient 消息（不是永久红块），正文和表格仍在；恢复后消息自己走 |
| 慢 / 空 / 失败 / 断线 | 断线写「连接已断 · 恢复后继续」，草稿保留；失败给原因与重试；重试成功回到原滚动位置 |
| 键盘与焦点 | 消息以 role=alert/status 播报一次；焦点不跳走；重试按钮可 Tab |
| 离开再回来 | 恢复后不重复播报；内容、草稿、滚动位置都在 |

### 6. 收尾：离开阅读去别处，再回来

| 项 | 预期 |
|---|---|
| 起点 | 读完或发完，去列表、项目或设置 |
| 动作 | 返回或切换区域 |
| 立刻看到 | 对话保留位置；列表行显示最新状态；F1 handoff 仍可用 |
| 慢 / 空 / 失败 / 断线 | 后台跑完时列表行更新；断线时列表保留缓存并标断线 |
| 键盘与焦点 | 返回后焦点回到列表里刚才那一行（Mac）或列表顶部（手机），不落到隐藏元素 |
| 离开再回来 | 滚动、草稿与状态入口按上面各步保留；不重复播报 |

## 各面差异

| 面 | 这一面怎么呈现 | 为什么不同 |
|---|---|---|
| Mac | 1100×760：区域栏 + 对话列表 + 主区；header 的动作完整显示，空间不足时收进既有 `⋯` 动作表；表格在自己的容器内滚动；状态入口在 header 与 composer footer 的既有触发器 | 鼠标与宽屏允许完整动词；仍不允许用常驻 bar 换阅读空间 |
| 手机 | 390×844：一条 header、正文、一个底部 composer；用量经 composer footer 的既有 popover；表格容器可横向滑动；新进展在 composer 上方占一条 transient 行 | 拇指与窄屏要求 44×44 和更少的常驻 chrome；与手机既有用量 popover 保持一致 |
| 平板（820×1180，触摸变体） | 分栏后对话列约 520：与手机相同的阅读结构，但保留桌面分栏；动作按 `useCoarsePointer()` 取 44×44；空间不足时会话动作进既有 `⋯` 动作表、文件与 PR 进「文件」入口，而不是压成半个字形 | iPad 是桌面宽度 + 手指（LESSONS 2026-11-10），不能拿 390 或 1100 任一端代替 |

## 设计

设计稿：`KIN-QUALITY-001.figma/frames/`（六帧 SVG：390、820 分栏、1100、展开状态、新进展、失败/断线）和 `KIN-QUALITY-001.review.html`（Figma 帧为主体，每屏六段用户流程；状态改成 `approved` 前两样都必须有）。

必须覆盖的状态：默认、加载、空、失败、断线、运行中、等待批准。06 画失败/断线的样子，其余在审阅页用文字检查表逐条列出，不另画状态板。锁定不适用：本条没有需要锁定的控件，发送/打断只有可用与不可用两态。被动打开不显示状态面板；状态只在人点入口后出现。

## Do not

- 不许新增常驻 bar、badge、banner 或第二份状态面板；先用既有 header 入口与 composer footer。
- 不许缩小字号、加 `overflow:hidden`、半透明或「滚到底就消失」来掩盖表格被遮挡。
- 不许把表格拆成卡片或删列来避免横向滚动。
- 不许删除用量、改动文件或会话动作；只能收进最多一个动作可达的既有入口。
- 不许改审批语义、运行控制、F1 handoff、草稿/滚动/焦点恢复；这些只做回归保护。
- 不许顺手做列表重排、筛选、默认折叠或 ≥10 条目标。
- 不许改 API、事件契约、schema、IA 的面归属或导航结构、registry schema；实现交付时只按 AGENTS.md 更新本条触及的那一行 IA。
- 不许出现第二个 composer 或第二条输入路径。

## 验收

本行已签字，实现与签字同一次交付；以下验收描述本次交付必须满足的行为。测试已随本次实现新增，文件或测试名都含 `KIN-QUALITY-001`。jsdom 没有布局：组件行只证明结构与交互状态，任何像素几何只在真浏览器行证明；真浏览器几何由 `scripts/journeys-smoke.sh --spec rsi/runtime/ux/KIN-QUALITY-001-reading.json` 一条命令证明，`scripts/check.sh` 接入同一判定规则的 hermetic 合同，不新增无人执行的套件。`R-tablet-walk` 只提供公共 820 viewport；本条实现自带 fixture，不能把 820 验收留给后续 lane。

| 层级 | 位置 | Given / When / Then |
|---|---|---|
| 组件（jsdom） | `ui/src/components/task/TaskHeader.KIN-QUALITY-001.dom.test.tsx`（已随本次实现新增） | Given 820×1180、`hasTouch`、侧栏展开、长标题，When 渲染对话头，Then header 只含标题、省略号项目名（纯标签，不是动作）和既有入口；每个动作是可聚焦控件；像素尺寸由真浏览器行证明 |
| 组件（jsdom） | `ui/src/pages/TaskDetailPage.KIN-QUALITY-001.dom.test.tsx`（已随本次实现新增） | Given 长回答 + ≥4 行表格，When 渲染，Then 表格在自身的横向滚动容器内，页面外壳声明不横滚，表头与单元格有语义关系；像素命中由真浏览器行证明 |
| 组件（jsdom） | 同上 | Given 表格行，Then 每行每列都是语义单元格，最后一行有可滚入的引用；几何清理由真浏览器行证明 |
| 组件（jsdom） | 同上 | Given 阅读面，When 找用量/改动文件/会话动作，Then 三个既有入口各自存在，各自最多一个动作可达；被动打开不发起 GitHub 请求、不读 secure-store secret |
| 组件（jsdom） | 同上 | Given 一段对话，Then 布局中只有一个 composer，没有第二条输入路径 |
| 组件（jsdom） | `ui/src/pages/TaskDetailPage.KIN-QUALITY-001.activity.dom.test.tsx`（已随本次实现新增） | Given `unseen > 0`，When 新进展出现，Then 它是非内容通道中的具名按钮，键盘 Tab 可达，live region 礼貌播报；不覆盖单元格的几何由真浏览器行证明 |
| 组件（jsdom） | 同上 | Given 加载失败/发送失败/断线，Then 只有一条 transient 诚实说明，正文与批准/回答 affordance 保留；恢复后说明自行消失 |
| 组件（jsdom） | 同上 | Given 草稿、滚动位置与焦点，When 离开再回来，Then 状态按对话恢复；既有审批、运行控制与 F1 handoff 测试保持绿色 |
| 真浏览器（像素几何只在这里证明） | `rsi/runtime/ux/KIN-QUALITY-001-reading.json`（本条 fixture，经 shipped `rsi/runtime/ux/walk.mjs` 的 `reading` op 执行；不另写 `.mjs`） | Given 长回答 + 4 行表格 fixture，When 在 820×1180（触摸）、390×844、1100×760 阅读并接着问，Then 常驻 chrome ≤44 CSS px（transient 失败 banner 除外），每个动作 ≥44×44，每个可见单元格中心 `document.elementFromPoint` 命中该单元格或后代，`scrollWidth ≤ innerWidth`，字号未缩小，最后一行完整位于 composer 上沿之上 |
| 视觉 | 390×844、820×1180、1100×760 截图 | 看常驻 chrome、表格、状态入口、新进展通道与失败说明；交付时附前后各一组 |

## 证据

- 之前：`docs/plans/2026-11-21-t3-parity-quality-reset.md:20` 与 `docs/plans/gap-log.md:37` 的 170/270 CSS px 报告数字；`docs/plans/2026-11-21-tablet-reading-baseline.md` 是并行 lane 的独立复测，尚未落到 `origin/main`，本轮不复制或预判。
- 本轮设计审阅：`rsi/state/shots/reading-story-design/`（本机忽略路径，390 明/暗与 1100 静态页截图）。
- 之后：交付时补 390/820/1100 前后截图与测试结果。

## 变更记录

- 2026-11-21 创建（draft，未实现、未签字；等 CEO 读完审阅页后签字）
- 2026-11-21 交付：三宽度 reading 走查 + 四个 KIN-QUALITY-001 测试文件；实现把用量移入 composer footer、改动文件移入 header、表格改自然宽度、新进展改非内容行、会话 tabs 在 <1600 隐藏
- 2026-11-21 17:43 CEO 代签（`approved`），D6 按推荐：平板的次要动作复用既有会话动作表，挂载条件按对话列宽度 + `useCoarsePointer()` 判断；实现与签字同一次交付
- 2026-11-21 真浏览器行改为 `rsi/runtime/ux/KIN-QUALITY-001-reading.json` + shipped `walk.mjs` 的 `reading` op（不新建 `KIN-QUALITY-001-reading.mjs`）：一条几何规则，不 fork；走查经 `scripts/journeys-smoke.sh --spec` 执行
- 2026-11-21 「接入 scripts/check.sh」指 hermetic 的 verdict/spec 合同（`scripts/quality_001_reading_test.py`）进 gate；会起 daemon 的真浏览器行作为一条命令的交付证据，输出进 PR，避免把约 20 分钟的浏览器构建塞进每次 gate
