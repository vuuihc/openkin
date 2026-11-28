# KIN-MOBILE-001 证据：RN 客户端的代码复核与历史模拟器画面

**结论：2026-11-28 补齐轮有 7 张当前画面（提交 `c853ac1f`）：390 暗色三张
（列表、审批、用量）与 820 审批 / 用量明暗四张。列表暗色行带待批橙色三角与红
`1` pill；审批卡是「批准」实心 +「拒绝」描边；用量 sheet 在两种宽度与两种外观下
都完整（provider 行、占比条、四格数字与降级说明）。同日复拍轮另有 8 张
（`3156ad74`）：390 与 820 的列表、对话各明暗一张；D4 由其中 820 暗色列表关闭。
配对 / 连接页（帧 01）的视觉仍未拍，它的验收归 #825（owner 持有），本文件不认领。
下方 2026-11-26 与 `14918d30` 的表仍是历史，不证明当前画面或真机表现。**

## 这次运行

| 项 | 值 |
|---|---|
| 日期 | 2026-11-28（主机日期；模拟器系统时钟为美东 2026-11-27 16:17–16:56） |
| 复核提交 | `cc9c2d78`（`rsi/rn-evidence-capture` 分支 HEAD；本文件是紧随其后的仅文档提交） |
| 方式 | Expo Go + Metro 离线（8081）；一次性 `kin serve --port 58028`（`mktemp -d` 状态目录）；`scripts/journeys_seed.py` 以 fake agent 在 `PATH` 首位运行；Maestro 驱动配对与点击；未启动或读取 `:7777`、`~/.kin` |
| 内存门槛 | 可用约 6367 MiB（`vm_stat` 的 free + speculative + inactive），swap free 1261.81 MiB，`rsi/state/.land.lock` 不存在；满足 ≥4096 MB 与 ≥512 MB |
| 设备 | iPhone 17e（390×844 逻辑，截图 1170×2532）与 iPad Air 11-inch (M4)（820×1180 逻辑，截图 1640×2360），iOS 27.2；一次只启动一台 |
| Expo Go | 58.0.7（`~/.expo/ios-simulator-app-cache/Expo-Go-58.0.7.tar.app`），Expo SDK 58 |
| 一次性节点与种子 | `kin serve --port 58028`；种子记录 `created 24, existing 0, skipped 1`；另经 `POST /api/tasks` 建了一条 `[seed] reading`（201，`succeeded`），因为标准种子脚本不建这条阅读夹具 |
| 配对 | `POST /api/pairing/sessions` 铸一次性 secret；链接 `http://127.0.0.1:58028/pair?token=<secret>` 由 Maestro 输入，secret 不入图、不入库 |
| 本轮截图目录 | `rsi/state/shots/rn-evidence-capture/`（本地，不入库；9 张 PNG） |
| 390 五张的来源 | 同日早些时候的上一次尝试（模拟器时钟 16:17–16:24）；本次逐张复看像素、外观与画面 |
| 历史截图 | 2026-11-26 两张在 `rsi/state/shots/rn-evidence-refresh/`；`14918d30` 八张在 `rsi/state/shots/rn-sim-evidence/`，均不作当前证据 |

### 2026-11-28 复拍（D4 修复后）

| 项 | 值 |
|---|---|
| 日期 | 2026-11-28（主机日期；模拟器时钟 07:08–07:13） |
| 复拍提交 | `3156ad74`（`rsi/rn-dark-split-pane` 分支 HEAD；产品修复 `b1770fad`，本文件是紧随其后的仅文档提交） |
| 方式 | Expo Go 58.0.7 + Metro 离线（8081）；一次性 `kin serve --port 58029`（`mktemp` 状态目录）；`scripts/journeys_seed.py` 以 fake agent 在 `PATH` 首位运行（`created 24, existing 0, skipped 1`）；另经 `POST /api/tasks` 建 `[seed] reading`（`succeeded`）。Maestro 驱动配对、`exp://127.0.0.1:8081/--/thread/<id>` 深链与滚动；未启动或读取 `:7777`、`~/.kin` |
| 配对 | `POST /api/pairing/sessions` 铸一次性 secret，换设备令牌后以 `http://127.0.0.1:58030/pair?token=<device token>` 输入；令牌不入图、不入库 |
| 设备 | iPad Air 11-inch (M4)（820×1180 逻辑，1640×2360）；iPhone 17e（390×844 逻辑，1170×2532）；iOS 27.2；一次只启动一台 |
| 内存 | 复拍前 `mem_avail_mb=4907–6157`、`swap_free_mb=1198–1439`；低于本行 brief 的 6144 / 2048 门槛，按 review 要求复拍并逐张复看像素与外观，模拟器未崩溃 |
| 本轮截图目录 | `rsi/state/shots/rn-dark-split-pane/`（本地，不入库；8 张 PNG） |

### 2026-11-28 补齐（视觉验收剩余格）

| 项 | 值 |
|---|---|
| 日期 | 2026-11-28（主机日期；模拟器时钟为美东 2026-11-27 18:28–18:57） |
| 拍摄提交 | `c853ac1f`（`rsi/rn-evidence-cells` 分支 HEAD；本文件是紧随其后的仅文档提交） |
| 方式 | Expo Go 58.0.7 + Metro 离线（8081）；一次性 `kin serve`（`mktemp -d` 状态目录，绑 `127.0.0.1:0` 选端口）；`scripts/journeys_seed.py` 以 fake agent 在 `PATH` 首位运行（`created 24, existing 0, skipped 1`）；另经 `POST /api/tasks` 建 `[seed] reading` 与两条审批夹具，审批行走 loopback 的 `POST /internal/approvals`。Maestro 驱动配对与点击；未启动或读取 `:7777`、`~/.kin` |
| 配对 | `POST /api/pairing/sessions` 铸一次性 secret；链接带 `pairing=1` 与 token，由 Maestro 一次 `inputText` + Enter 输入；secret 不入图、不入库。第一张链接漏了 `pairing=1`，被当成设备令牌，界面报「链接已过期」；补上后两台设备一次配上 |
| 设备 | iPhone 17e（390×844 逻辑，截图 1170×2532）与 iPad Air 11-inch (M4)（820×1180 逻辑，1640×2360），iOS 27.2；一次只启动一台 |
| 内存门槛 | 启动前 `vm_stat` 的 free + speculative + inactive ≈ 6040 MiB，swap free 1266.62 MiB；满足 ≥4096 MB 与 ≥512 MB |
| 本轮截图目录 | `rsi/state/shots/rn-evidence-cells/`（本地，不入库；7 张 PNG） |

审批夹具的有效期是本轮的新经验：`/internal/approvals` 造的卡在 fake agent 的保持
超时（约 12 分钟）后变为 `expired`（`decided_via: interrupt`），卡片从对话里消失。
390 与 820 的审批画面各用一张新铸的卡拍摄；拍完未再回答它。列表在深链进入对话后
不会立刻刷新，820 的第二张卡是先返回列表、下拉刷新后再点行才对齐选中行与阅读栏。

以下命令来自 2026-11-26 的基线复核，不是本次 820 走查的重跑结果；本行不改产品
代码，只更新证据文档与截图。`--no-install` 使用已有依赖，Jest 串行运行，避免与
其他 lane 争抢 worker。测试名称与代码锚点见「已修」和「已知」。

```bash
npx --no-install jest src/screens/ConversationView.table.test.tsx --ci --runInBand
# Test Suites: 1 passed, 1 total
# Tests:       3 passed, 3 total
npx --no-install jest src/providers/providersModel.test.ts -t "a rejected provider list keeps the usage numbers" --ci --runInBand
# Test Suites: 1 passed, 1 total
# Tests:       20 skipped, 1 passed, 21 total
npx --no-install jest src/list/listModel.test.ts -t "a project record names the heading" --ci --runInBand
# Test Suites: 1 passed, 1 total
# Tests:       22 skipped, 1 passed, 23 total
npx --no-install jest src/screens/Conversation.safearea.test.tsx --ci --runInBand
# Test Suites: 1 passed, 1 total
# Tests:       3 passed, 3 total
npx --no-install tsc --noEmit
# 无输出，退出 0
npx --no-install jest --ci --runInBand
# Test Suites: 46 passed, 46 total
# Tests:       409 passed, 409 total
```

全量 Jest 在断言通过后打印 `Jest did not exit one second after the test run has completed.`，
随后自行退出 0；那一轮未定位未停止的异步操作，不把它记作已解决。

## 截图

### 复拍画面（2026-11-28，`3156ad74`）

| 面 | 设备 | 外观 | 提交 | 文件（仓库相对路径） | 像素 宽×高 | 当前判定 |
|---|---|---|---|---|---|---|
| 列表 | 820 | 亮 | `3156ad74` | `rsi/state/shots/rn-dark-split-pane/820-list-light.png` | 1640×2360 | 左列设备 → 项目 → 对话，右侧空阅读栏为亮色主题页背景（暗色的对照） |
| 列表 | 820 | 暗 | `3156ad74` | `rsi/state/shots/rn-dark-split-pane/820-list-dark.png` | 1640×2360 | 左右两栏同为暗色；「在左侧选一条对话，在这里阅读。」为浅色字——D4 修复后的复核画面 |
| 对话 | 820 | 亮 | `3156ad74` | `rsi/state/shots/rn-dark-split-pane/820-conversation-light.png` | 1640×2360 | `[seed] reading` 长回答、五行 GFM 表格；末行句子 `Final row: … must be fully readable at the bottom of the pane.` 可见 |
| 对话 | 820 | 暗 | `3156ad74` | `rsi/state/shots/rn-dark-split-pane/820-conversation-dark.png` | 1640×2360 | 同一条长回答与五行表格，暗色主题，末行句子可见 |
| 列表 | 390 | 亮 | `3156ad74` | `rsi/state/shots/rn-dark-split-pane/390-list-light.png` | 1170×2532 | 手机栈列表；设备 → 项目 → 对话行与待输入 / 失败 / 已完成状态 |
| 列表 | 390 | 暗 | `3156ad74` | `rsi/state/shots/rn-dark-split-pane/390-list-dark.png` | 1170×2532 | 同上，暗色主题 |
| 对话 | 390 | 亮 | `3156ad74` | `rsi/state/shots/rn-dark-split-pane/390-conversation-light.png` | 1170×2532 | `[seed] reading` 长回答；表格首行在首屏底部（390 是滚动阅读，表格完整画面见 820 两图） |
| 对话 | 390 | 暗 | `3156ad74` | `rsi/state/shots/rn-dark-split-pane/390-conversation-dark.png` | 1170×2532 | 同上，暗色主题 |

**宽度说明：** 1100×760 是 Web 控制台的宽度，RN 客户端没有该宽度的画面；
分栏边界在 768（`mobile-rn/src/layout/split.ts`），所以本轮用 820 覆盖分栏两侧、
390 覆盖手机栈。复拍未拍 820 的审批与用量、390 的审批与用量，原因与同日早先一轮
相同（时间优先给 D4 的空阅读栏与阅读态表格）；这些缺口已由下一节的补齐轮覆盖。

### 补齐画面（2026-11-28，`c853ac1f`）

| 面 | 设备 | 外观 | 提交 | 文件（本地，不入库） | 像素 宽×高 | 当前判定 |
|---|---|---|---|---|---|---|
| 列表 | 390 | 暗 | `c853ac1f` | `rsi/state/shots/rn-evidence-cells/390-list-dark.png` | 1170×2532 | 设备 → 项目 → 对话行；`[seed] Approve the migration` 有待批橙色三角与红 `1` pill，已完成行是灰点；暗色底、浅色字，无亮色缝隙。大标题压住状态栏时钟——缺陷 D5 |
| 审批 | 390 | 暗 | `c853ac1f` | `rsi/state/shots/rn-evidence-cells/390-approvals-dark.png` | 1170×2532 | 待批卡：`需要权限` / `Bash` / `git status --short`；`批准` 是唯一实心蓝按钮，`拒绝` 描边；卡片与对话都是暗色，无文字裁切 |
| 用量 | 390 | 暗 | `c853ac1f` | `rsi/state/shots/rn-evidence-cells/390-usage-dark.png` | 1170×2532 | 用量 sheet：本周 / 30 天 / 90 天，30 天选中；claude-code 身份色圆点与占比条、`$0.0029`；费用 / TOKEN / 缓存命中率（`—`，夹具无缓存数）/ 对话四格；provider 降级说明完整 |
| 审批 | 820 | 亮 | `c853ac1f` | `rsi/state/shots/rn-evidence-cells/820-approvals-light.png` | 1640×2360 | 分栏；左列选中待批行，右侧阅读栏是同一张待批卡（批准实心 / 拒绝描边）；亮色 |
| 审批 | 820 | 暗 | `c853ac1f` | `rsi/state/shots/rn-evidence-cells/820-approvals-dark.png` | 1640×2360 | 暗色；`批准` 二字在实心蓝按钮上可见，`拒绝` 为描边红字；左右两栏、卡片与 composer 都是暗色，D4 的修复保持 |
| 用量 | 820 | 亮 | `c853ac1f` | `rsi/state/shots/rn-evidence-cells/820-usage-light.png` | 1640×2360 | 用量 sheet 浮在分栏上，背后是 `[seed] reading` 的读取态（标题与用户气泡可见）；亮色玻璃底 |
| 用量 | 820 | 暗 | `c853ac1f` | `rsi/state/shots/rn-evidence-cells/820-usage-dark.png` | 1640×2360 | 同上，暗色；sheet、分段控件、provider 行与占比条都取暗色 token |

**用量取证限制：** 三张用量图都仍显示未翻译的 `progress.input` / `progress.output` 键；这是本轮观察到的界面限制，取证表如实记录，不在本取证行修产品。

**判定锚点：** 列表 `mobile-rn/src/screens/ConversationList.visual.test.tsx:187`
（状态点形状 + 颜色）、`:212`（待批三角与计数）、`:308`（行与分区头按明暗取 token），
`mobile-rn/src/theme/theme.test.ts:222` / `:233`（列表暗 / 亮）；审批
`mobile-rn/src/screens/Approvals.visual.test.tsx:172`（批准是唯一实心主按钮，拒绝
描边）；用量 `mobile-rn/src/screens/ProviderUsage.visual.test.tsx:130`（身份圆点、
右对齐金额、占比条）、`:254`（明暗两套取自 token）。判定是像素结论，不是这些测试
的通过记录。

### 同日早先的 390 / 820 画面（2026-11-28，`cc9c2d78`；历史）

| 面 | 设备 | 外观 | 提交 | 文件（仓库相对路径） | 像素 宽×高 | 当前判定 |
|---|---|---|---|---|---|---|
| 列表 | 390 | 亮 | `cc9c2d78` | `rsi/state/shots/rn-evidence-capture/390-list-light.png` | 1170×2532 | 设备 → 项目 → 对话行；`[seed] Project Beta/Alpha/Gamma` 记录名与待输入 / 失败 / 已完成状态可见 |
| 对话 | 390 | 亮 | `cc9c2d78` | `rsi/state/shots/rn-evidence-capture/390-conversation-light.png` | 1170×2532 | `[seed] Phone review`：用户气泡、工具行与 `[seed] reading` 长回答；表格在首屏下方，本图未含表格 |
| 审批 | 390 | 亮 | `cc9c2d78` | `rsi/state/shots/rn-evidence-capture/390-approvals-light.png` | 1170×2532 | 需要权限 · Bash · `git status --short` · 批准 / 拒绝；同屏有 fake agent 的 `process exited without result` 失败行 |
| 用量 | 390 | 亮 | `cc9c2d78` | `rsi/state/shots/rn-evidence-capture/390-usage-light.png` | 1170×2532 | 本周 / 30 天 / 90 天；`$0.0029`、Token 343、对话 11；provider 列表降级为一行说明，数字保留 |
| 对话 | 390 | 暗 | `cc9c2d78` | `rsi/state/shots/rn-evidence-capture/390-conversation-dark.png` | 1170×2532 | 暗色主题；`[seed] Phone review` 与同一条 `[seed] reading` 长回答；表格在首屏下方 |
| 列表 | 820 | 亮 | `cc9c2d78` | `rsi/state/shots/rn-evidence-capture/820-list-light.png` | 1640×2360 | 左侧设备 → 项目 → 对话列表，右侧「在左侧选一条对话，在这里阅读。」 |
| 对话 | 820 | 亮 | `cc9c2d78` | `rsi/state/shots/rn-evidence-capture/820-conversation-light.png` | 1640×2360 | `[seed] reading` 长回答与五行 GFM 表格；末行句子 `Final row: … must be fully readable at the bottom of the pane.` 可见 |
| 列表 | 820 | 暗 | `cc9c2d78` | `rsi/state/shots/rn-evidence-capture/820-list-dark.png` | 1640×2360 | 左侧列表暗色；右侧空阅读栏仍是亮色（缺陷 D4 的修复前证据，见 §已知） |
| 对话 | 820 | 暗 | `cc9c2d78` | `rsi/state/shots/rn-evidence-capture/820-conversation-dark.png` | 1640×2360 | 暗色主题；同一条 `[seed] reading` 长回答与五行表格，末行句子可见 |

**未拍与原因（已更新）：** 820 的审批与用量、390 的列表 / 审批 / 用量暗色已由
2026-11-28 补齐轮（`c853ac1f`）覆盖，见上一节的补齐画面表。仍未拍的只有配对 /
连接页（帧 01）：它的视觉验收归 #825（owner 持有），本文件不认领。1100 宽度属于
Web 控制台，不在 RN 客户端此行范围。820 配对沿用模拟器里已有的设备会话（旧节点
已失效，列表先报「对话列表读不出来」），本轮用 `exp://127.0.0.1:8081/--/pair`
深链回到配对页后重新配对；这是方法，不是缺口。补齐轮的两台设备都先清 Keychain，
再用带 `pairing=1` 的一次性链接配对。

### 上一轮 390 画面（2026-11-26，基线 `6cd5f5cd` 之后；历史）

| 面 | 设备 | 文件 | 文件时间 | 当前判定 |
|---|---|---|---|---|
| 列表 | 390 | `rsi/state/shots/rn-evidence-refresh/390-list.png` | 10:55 | D3 的修复可见：标题为 `[seed] Project Beta` / `[seed] Project Alpha` / `[seed] Project Gamma`，不再是目录名；未认领的 `reading-cwd` 仍按目录名回退 |
| 对话 | 390 | `rsi/state/shots/rn-evidence-refresh/390-conversation.png` | 11:08 | D1 的修复可见：`Surface` / `Before` 表头与行边框按单元格绘制，右侧列在 390 下横向滚动；长回答与 5 行表格仍是同一条 `[seed] reading` 夹具 |

这两张只覆盖 390 的列表与对话，不是完整四面对走查：820 未重拍，审批与用量那一轮
没有新画面。它们证明 390 上 D1/D3 的渲染，不证明 820、真机表现或玻璃体感。

**历史截图表：以下均拍摄于 `14918d30`（目录 `rsi/state/shots/rn-sim-evidence/`，与 2026-11-26 的两张同名不同目录），判定仅描述当时记录；不是 `6cd5f5cd` 的视觉验收。**

| 面 | 设备 | 文件 | 当时判定 | 当时画面 |
|---|---|---|---|---|
| 列表 | 390 | `390-list.png` | 历史通过 | 设备（此设备，11 条）→ 项目（alpha / beta / gamma / reading-cwd）→ 对话行；项目标题尚取目录名，现状见已修 D3 |
| 对话 | 390 | `390-conversation.png` | 历史缺陷 D1 | `[seed] reading` 长回答里的表格以原文竖线出现 |
| 审批 | 390 | `390-approvals.png` | 历史通过 | 顶部待批卡片：需要权限 / Bash / `git status --short` / 批准 · 拒绝；下方历史失败工具行 |
| 用量 | 390 | `390-usage.png` | 历史缺陷 D2 | 本周 / 30 天 / 90 天可见，整张显示「链接无效或已被拒绝 · 重试」 |
| 列表 | 820 | `820-list.png` | 历史通过 | 左侧设备→项目→对话列表，右侧「在左侧选一条对话，在这里阅读。」 |
| 对话 | 820 | `820-conversation.png` | 历史缺陷 D1 | 左侧列表 + 右侧 `[seed] reading` 长回答与原文竖线表格 |
| 审批 | 820 | `820-approvals.png` | 历史通过 | 左侧列表 + 右侧待批卡片（批准 · 拒绝） |
| 用量 | 820 | `820-usage.png` | 历史缺陷 D2 | 左侧列表 + 右侧用量 sheet，同样「链接无效或已被拒绝」 |

原记录里的 820 会话图是长回答与 5 行表格的阅读态，不能用空白分栏或占位页代替；
2026-11-28 的 820 亮色对话已按这条夹具重拍（见上表），那一轮（2026-11-26）只对
390 的表格布局作了视觉判断，820 未拍。

## 缺陷

### 已修

#### D1 对话把 GFM 表格当普通文本渲染

- 历史症状：`390-conversation.png`、`820-conversation.png` 逐字显示
  `| Surface | Before | After | Owner |` 和 `| --- | --- | --- | --- |`。
- 已合入：#750，`6b1419a2`。`mobile-rn/src/screens/ConversationView.tsx:78` 从
  `./MarkdownBody` 导入 `MessageBody`（KIN-MOBILE-002 R4a 起 block markdown 与表格
  都由它绘制），`:433` 将消息交给它；不是复制 DOM 侧 markdown 组件。
- 回归：`mobile-rn/src/screens/ConversationView.table.test.tsx:89`，
  `KIN-MOBILE-001 R4: an agent answer draws its table and the paragraphs around it`。
  那一轮该套件 3 项通过，覆盖消息表格、邻接工具/meta 行及含竖线的错误文本。
- 边界：代码与回归已核对；390 与 820 都已重拍（2026-11-28），820 亮色图显示
  同一条长回答与五行表格按单元格绘制、`Owner` 列在横向滚动区；仍是模拟器，不是
  真机。

#### D2 用量 sheet 在配对设备上整张失败

- 历史症状：两张用量图都显示「链接无效或已被拒绝 · 重试」。原走查记录是 device
  请求 providers 为 403、usage 为 200，master 两项均为 200；那一轮未重新请求这些端点。
- 已合入：#746，`5bee6ad6`。`mobile-rn/src/providers/providersModel.ts:229`
  在用量成功、provider 列表失败且不是 token 过期时，只降级 provider 区块，保留数字。
  `/api/providers` 仍是 operator-only（`internal/api/api.go:528`），没有放宽权限。
- 回归：`mobile-rn/src/providers/providersModel.test.ts:493`，
  `KIN-MOBILE-001 R6: a rejected provider list keeps the usage numbers (device token)`。
  那一轮该用例通过；断言 ready、保留用量、没有整张错误，并带 provider 局部错误。
- 边界：模型层的 403/200 降级由回归证明；2026-11-28 的 390 用量图（16:24，
  配对设备）显示同一降级的画面：数字保留，只多一行「这台设备读不到 provider
  列表；用量数字不受影响」。820 用量未拍。

#### D3 列表项目标题只取工作目录名

- 历史症状：图里是 `alpha` / `beta` / `gamma` / `reading-cwd`，没有使用项目记录的名字。
- 已合入：#758，`2316a815`。`mobile-rn/src/api/transport.ts:49` 声明
  `/api/projects`，`mobile-rn/src/list/listModel.ts:505` 读取记录，`:298` 将各 root
  交给共享分组；有记录的项目按记录命名，多 root 归一组，未认领目录仍显示目录名。
- 回归：`mobile-rn/src/list/listModel.test.ts:716`，
  `KIN-MOBILE-001 R3: a project record names the heading and all its roots file under it`。
  该用例在 2026-11-26 通过；2026-11-28 的 390 与 820 列表图都显示记录名
  `[seed] Project …`（820 列表见 §截图 的 `820-list-light.png`）。

## 已知（不要再报）

- **D4 · 820 空阅读栏在暗色下仍是亮色（2026-11-28 发现；同日复拍复核为已修复）。**
  原证据：`rsi/state/shots/rn-evidence-capture/820-list-dark.png`（iPad Air 11-inch
  (M4)，暗色，修复前）。左侧列表已暗，右侧「在左侧选一条对话，在这里阅读。」的空栏
  保持亮色背景与深色文字；亮 → 暗切换后复现，排除单次重绘。选中一条对话后右侧阅读栏
  在暗色下正常（`820-conversation-dark.png`），因为 `ConversationView` 自己画了容器
  （`mobile-rn/src/screens/ConversationView.tsx:1358` 的 `container`，在 `:1071` 使用）。
- 读法与修复：`SplitListLayout` 的根节点原本只有 `flex: 1`，空栏没有任何一层画背景，
  于是露出导航屏的白色。现在根节点用调色板画主题页背景
  （`mobile-rn/src/layout/SplitListLayout.tsx:113` 的 `backgroundColor: colors.bg`），
  亮暗两套外观都由 `useTheme()` 决定，没有颜色字面量。
- 回归：`mobile-rn/src/layout/SplitListLayout.dark.test.tsx:67`
  （暗色空栏；同时钉住空栏与对话容器不自画背景）、`:88`（亮色跟随）、
  `:96`（选中对话仍暗 + 767 手机栈几何不变），
  三个用例名都含 `KIN-MOBILE-001 R3`；对应的四个变体在
  `mobile-rn/src/layout/splitPane.mutants.json`（暗色空栏两个，亮色与选中对话各一个）。
  本轮结果：`npx --no-install jest src/layout/SplitListLayout.dark.test.tsx` 3 项通过；
  `python3 scripts/mutants.py mobile-rn/src/layout/splitPane.mutants.json`
  `4/4 mutants red; 0 problem(s)`。
- 复拍与观察结果：`rsi/state/shots/rn-dark-split-pane/820-list-dark.png`（iPad Air
  11-inch (M4)，暗色，1640×2360，提交 `3156ad74`）里左右两栏同为暗色，空阅读栏
  的句子为浅色；同目录 `820-list-light.png` 是亮色对照，两栏同为亮色；
  `820-conversation-{light,dark}.png` 是选中 `[seed] reading` 后的阅读态。之前那台
  主机 `mem_avail_mb=5088–5554`、`swap_free_mb=885` 未启动模拟器；本轮读数
  `4907–6157` / `1198–1439` 仍低于本行 brief 的 6144 / 2048，改为按 review 要求
  复拍并逐张复看，未出现内存压力崩溃。D4 由此关闭。
- **D5 · 列表导航头画在 iOS 状态栏下面（2026-11-28 发现；本行只取证，不修）。**
  当前证据：`rsi/state/shots/rn-evidence-cells/390-list-dark.png`（iPhone 17e，暗色，
  1170×2532，提交 `c853ac1f`）里大标题「对话」压在状态栏时钟上——图里只剩分钟数
  贴在标题右侧；`820-approvals-light.png` / `820-usage-light.png`（iPad Air 11-inch
  (M4)，1640×2360，同提交）里标题与搜索框压在 iPad 状态栏的日期与应用名下面。
  对话页头部没有这个问题：返回键与标题都落在状态栏下方。此前的列表取证图也有同样
  的重叠，只是当时按测试锚点判读、没有按像素核对头部；不是本轮引入。
  读法与修复假设：`mobile-rn/src/screens/ConversationList.tsx:737` 的 `screen` 只有
  `backgroundColor` / `flex`，`:839` 的 `navBar` 只有 `paddingVertical: 6`，两处都
  没有读 `useSafeAreaInsets()`；分栏壳的根节点
  `mobile-rn/src/layout/SplitListLayout.tsx:113` 也只画背景。
  `mobile-rn/app/_layout.tsx:39` 已挂 `SafeAreaProvider`，所以缺的是列表壳读取顶部
  inset，不是 provider。修复应由列表壳（或 `SplitListLayout`）加
  `paddingTop: insets.top`，对话页已有的头部内边距保持不动。
  回归：在 `mobile-rn/src/screens/ConversationList.visual.test.tsx`（或新套件）把
  `useSafeAreaInsets` mock 成非零（如 47 / 24），断言 `list-nav` 的 `paddingTop`
  或标题矩形在 inset 之下；再按 390 与 820 各拍一张对照图。修复另立一行，不在本行。
- **键盘避让代码已落地，真机未验。** #733，`445dffab`；
  `mobile-rn/src/screens/ConversationView.tsx:772` 用 `KeyboardAvoidingView` 包住正文与
  composer。`mobile-rn/src/screens/Conversation.safearea.test.tsx:98` 的
  `KIN-MOBILE-001 R4: the composer sits above the keyboard` 复核时通过，所在套件 3 项通过。
  这证明组件配置，不证明真机键盘动画、遮挡或玻璃 blur 体感；这些仍需人验，不记作 done。
- 推送注册尚未接入；`mobile-rn/package.json` 没有 `expo-notifications`，
  `mobile-rn/src/push/route.ts` 是点开通知后的路由逻辑，不是注册与投递的真机证据。
- **玻璃层已接入 2026-11-26 基线之后。** `mobile-rn/package.json:15` 有 `"expo-blur": "58.0.6"`；
  `mobile-rn/src/native/GlassSurface.tsx:26` 从 `expo-blur` 引入 `BlurView`，`:77-90` 渲染该面
  （`glass.test.ts:16` 钉住普通手机走 blur，不是平白卡片）。两处调用点都用它：
  用量 **sheet** 在 `mobile-rn/src/screens/ProviderUsageSheet.tsx:176`（#768，`f80acc50`），
  对话头部在 `mobile-rn/src/screens/ConversationView.tsx:963`（#785，`8dda1e69`）；对应
  `ProviderUsageSheet.glass.test.tsx:159`、`Conversation.glass.test.tsx:162`。
  这证明代码与测试，不证明真机玻璃 blur 的手感——真机体感仍未验，不记作 done。
- `2026-11-27 · 复核：玻璃层已落地（#768 用量 sheet、#785 对话头部）；真机体感仍未验。`
- 扫码未实现；`mobile-rn/app/pair.tsx` 当前配对表单只有链接输入与提交，当时没有扫码验收。
- 手机上还没有「新建对话」入口；`docs/product/stories/KIN-MOBILE-001.md` §2
  的空态行与 §「变更记录」将该入口留给另立的 start 故事，不把列表图当入口交付。

## 运行经验（给下一个人）

- **先量内存再决定是否启动模拟器。** 2026-11-26 那一轮空闲约 69 MiB，swap 已用 7200.50M，
  完整四面对走查跳过，只保存了 390 的两张当前画面；820 未重拍，保留历史日期、
  提交和判定，测试通过不改写旧图。
- 按 `README.md` 一次只走一个设备：先 iPhone 17e 390×844，关闭后再走
  iPad Air 11-inch (M4) 820×1180；不要同时启动两个模拟器。
- 沿用历史走查的隔离方式：临时 `KIN_STATE_DIR`、绑定 `127.0.0.1:0` 选择端口，
  `scripts/journeys_fake_agent` 放 `PATH` 首位并设 `KIN_CLAUDE_BIN`，再运行
  `scripts/journeys_seed.py`。不使用正在工作的节点；配对链接必须带 `&pairing=1`。
- **Expo Go 的悬浮 dev 按钮会盖住「用量」入口**，这是历史走查在两个宽度上的经验。
  先把按钮拖到屏幕中部，再点 `conversation:usage`；不是产品控件的遮挡结论。
- 配对框用 **一次 `inputText` + `pressKey: Enter`**，避免分段输入或点击坐标提交。
  单行框会横向滚动，尾部可见不表示整串缺失；用 `maestro hierarchy` 的 `value` 核对。
  Enter 的代码入口是 `mobile-rn/app/pair.tsx` 的 `onSubmitEditing`。
- 「用量」的可访问名是「打开用量详情」，文本选择器匹配完整串，或用
  testID `conversation:usage`。
- 2026-11-28 的新经验：配对框上方的提示文字与输入框共享可访问名
  「粘贴节点打印的链接」，按文本点会点到提示而不是输入框；用只属于输入框的占位符
  「粘贴配对链接」定位。已有设备会话指向已删的一次性节点时，列表只显示
  「对话列表读不出来 · 重试」，不会自动回配对页；用
  `xcrun simctl openurl booted "exp://127.0.0.1:8081/--/pair"` 深链过去。
  820 空阅读栏的暗色缺陷见 §已知 D4（复拍后已关闭），不是截图错误。
- 2026-11-28 复拍的新经验：**别用兄弟 worktree 的 `node_modules` 软链跑 Metro。**
  软链下 Expo 的动态 `import("expo-secure-store")` 生成的分包 URL 会变成
  `http://127.0.0.1:8081/../../<别的-worktree>/...`，Expo Go 取不到，配对在写
  Keychain 时抛错、界面停在「链接无效或已被拒绝」。在 `mobile-rn/` 里做一次真目录
  `npm install --no-package-lock --no-audit --no-fund` 后同一操作成功。另一个坑：
  配对输入框会保留上一次文本，重试前先 `simctl terminate` 再打开，或
  `xcrun simctl keychain <udid> reset` 清掉旧会话；本轮的干净配对是重置 Keychain
  后一次输入设备令牌链接完成的。
