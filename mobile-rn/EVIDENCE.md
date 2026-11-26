# KIN-MOBILE-001 证据：RN 客户端的代码复核与历史模拟器画面

**结论：本轮有两张 390 截图（列表 10:55、对话 11:08，文件时间均晚于基线
`6cd5f5cd` 的 10:11），显示项目记录标题与 GFM 表格已按修复后的样子绘制；820 未
重拍，完整四面对走查按内存门槛跳过。`6cd5f5cd` 已包含 D1 表格、D2 用量降级、
项目标题和键盘避让的修复；对应回归与类型检查通过。下方八张历史图仍是
`14918d30` 的记录，不能证明当前 820 画面或真机表现。**

## 这次运行

| 项 | 值 |
|---|---|
| 日期 | 2026-11-26（证据刷新；历史截图也在同日拍摄） |
| 复核提交 | `6cd5f5cd`（本轮开始时的 `origin/main`，也是分支基线） |
| 方式 | Phase B：复核代码与测试，并保存两张 390 截图；未启动 Metro 或节点，未操作 `:7777` 或节点状态目录 |
| 内存门槛 | `vm_stat`：每页 16384 bytes，`Pages free: 4421`，约 69 MiB，低于 4 GB；`vm.swapusage`：total 8192.00M / used 7200.50M / free 991.50M |
| 模拟器条件 | `xcrun simctl list devices available` 有 iOS 27.2；内存门槛已触发，未进行完整四面对走查；390 的两张当前画面见 §截图 |
| 新截图 | 390 列表（10:55）与 390 对话（11:08）各一张；820 未拍，不以测试通过代替视觉验收 |
| 本轮截图目录 | `rsi/state/shots/rn-evidence-refresh/`（本地，不入库；`390-list.png`、`390-conversation.png`） |
| 历史截图提交 | `14918d30`；此后 main 已合入下方「已修」的改动 |
| 历史设备 | iPhone 17e，390×844 逻辑，截图 1170×2532；iPad Air 11-inch (M4)，820×1180 逻辑，截图 1640×2360 |
| 历史环境 | iOS 27.2 (24B8117)，Expo Go 58.0.7，Expo 58.0.26；Metro 离线运行在 8081 |
| 历史节点与种子 | 一次性 `kin serve --port 50346`，临时状态目录；`scripts/journeys_seed.py` 记录 `created 24, existing 0, skipped 1`；非本轮重跑结果 |
| 历史阅读夹具 | `[seed] reading`：长回答 + 5 行 GFM 表格，来源 `scripts/journeys_fake_agent/claude:308` |
| 历史配对 | 一次性 secret 链接 `http://127.0.0.1:50346/pair?token=<secret>&pairing=1`；`src/auth/pairingLink.ts:82` 区分 secret 与 device token |
| 历史截图目录 | `rsi/state/shots/rn-sim-evidence/`（本地，不入库；本轮未复查这些历史图像文件） |

以下命令在本分支 `mobile-rn/` 执行，均退出 0。`--no-install` 使用已有依赖，Jest
串行运行，避免与其他 lane 争抢 worker。测试名称与代码锚点见「已修」和「已知」。

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
# Tests:       408 passed, 408 total
```

全量 Jest 在断言通过后打印 `Jest did not exit one second after the test run has completed.`，
随后自行退出 0；本轮未定位未停止的异步操作，不把它记作已解决。

## 截图

### 本轮 390 画面（2026-11-26，基线 `6cd5f5cd` 之后）

| 面 | 设备 | 文件 | 文件时间 | 当前判定 |
|---|---|---|---|---|
| 列表 | 390 | `rsi/state/shots/rn-evidence-refresh/390-list.png` | 10:55 | D3 的修复可见：标题为 `[seed] Project Beta` / `[seed] Project Alpha` / `[seed] Project Gamma`，不再是目录名；未认领的 `reading-cwd` 仍按目录名回退 |
| 对话 | 390 | `rsi/state/shots/rn-evidence-refresh/390-conversation.png` | 11:08 | D1 的修复可见：`Surface` / `Before` 表头与行边框按单元格绘制，右侧列在 390 下横向滚动；长回答与 5 行表格仍是同一条 `[seed] reading` 夹具 |

这两张只覆盖 390 的列表与对话，不是完整四面对走查：820 未重拍，审批与用量本轮
没有新画面。它们证明 390 上 D1/D3 的渲染，不证明 820、真机表现或玻璃体感。

**历史截图表：以下均拍摄于 `14918d30`（目录 `rsi/state/shots/rn-sim-evidence/`，与本轮两张同名不同目录），判定仅描述当时记录；不是 `6cd5f5cd` 的视觉验收。**

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

原记录里的 820 会话图是长回答与 5 行表格的阅读态。820 下一次重拍仍须使用这条夹具，
不能用空白分栏或占位页代替；本轮只对 390 的表格布局作了视觉判断，820 未拍。

## 缺陷

### 已修

#### D1 对话把 GFM 表格当普通文本渲染

- 历史症状：`390-conversation.png`、`820-conversation.png` 逐字显示
  `| Surface | Before | After | Owner |` 和 `| --- | --- | --- | --- |`。
- 已合入：#750，`6b1419a2`。`mobile-rn/src/screens/ConversationView.tsx:64`
  导入 `MessageBody`，`:370` 将消息交给它绘制表格；不是复制 DOM 侧 markdown 组件。
- 回归：`mobile-rn/src/screens/ConversationView.table.test.tsx:89`，
  `KIN-MOBILE-001 R4: an agent answer draws its table and the paragraphs around it`。
  本轮该套件 3 项通过，覆盖消息表格、邻接工具/meta 行及含竖线的错误文本。
- 边界：代码与回归已核对；390 已重拍（`390-conversation.png`，11:08，表格按
  单元格绘制，右侧列横向滚动），820 当前画面未重拍。

#### D2 用量 sheet 在配对设备上整张失败

- 历史症状：两张用量图都显示「链接无效或已被拒绝 · 重试」。原走查记录是 device
  请求 providers 为 403、usage 为 200，master 两项均为 200；本轮未重新请求这些端点。
- 已合入：#746，`5bee6ad6`。`mobile-rn/src/providers/providersModel.ts:229`
  在用量成功、provider 列表失败且不是 token 过期时，只降级 provider 区块，保留数字。
  `/api/providers` 仍是 operator-only（`internal/api/api.go:528`），没有放宽权限。
- 回归：`mobile-rn/src/providers/providersModel.test.ts:493`，
  `KIN-MOBILE-001 R6: a rejected provider list keeps the usage numbers (device token)`。
  本轮该用例通过；断言 ready、保留用量、没有整张错误，并带 provider 局部错误。
- 边界：本轮证明的是模型的 403/200 降级行为，没有新的设备配对或 sheet 截图。

#### D3 列表项目标题只取工作目录名

- 历史症状：图里是 `alpha` / `beta` / `gamma` / `reading-cwd`，没有使用项目记录的名字。
- 已合入：#758，`2316a815`。`mobile-rn/src/api/transport.ts:49` 声明
  `/api/projects`，`mobile-rn/src/list/listModel.ts:505` 读取记录，`:298` 将各 root
  交给共享分组；有记录的项目按记录命名，多 root 归一组，未认领目录仍显示目录名。
- 回归：`mobile-rn/src/list/listModel.test.ts:716`，
  `KIN-MOBILE-001 R3: a project record names the heading and all its roots file under it`。
  本轮该用例通过；390 列表已重拍（`390-list.png`，10:55，标题为 `[seed] Project …`
  记录名），820 列表当前画面未重拍。

## 已知（不要再报）

- **键盘避让代码已落地，真机未验。** #733，`445dffab`；
  `mobile-rn/src/screens/ConversationView.tsx:772` 用 `KeyboardAvoidingView` 包住正文与
  composer。`mobile-rn/src/screens/Conversation.safearea.test.tsx:98` 的
  `KIN-MOBILE-001 R4: the composer sits above the keyboard` 本轮通过，所在套件 3 项通过。
  这证明组件配置，不证明真机键盘动画、遮挡或玻璃 blur 体感；这些仍需人验，不记作 done。
- 推送注册尚未接入；`mobile-rn/package.json` 没有 `expo-notifications`，
  `mobile-rn/src/push/route.ts` 是点开通知后的路由逻辑，不是注册与投递的真机证据。
- 玻璃层尚未接入本轮基线；`mobile-rn/package.json` 没有 `expo-blur`。
  用量 **sheet** 由 #768 跟进（本轮查询仍 open），不能据此宣布玻璃头部完成；头部仍待接入。
- 扫码未实现；`mobile-rn/app/pair.tsx` 当前配对表单只有链接输入与提交，本轮没有扫码验收。
- 手机上还没有「新建对话」入口；`docs/product/stories/KIN-MOBILE-001.md` §2
  的空态行与 §「变更记录」将该入口留给另立的 start 故事，不把本轮列表图当入口交付。

## 运行经验（给下一个人）

- **先量内存再决定是否启动模拟器。** 本轮空闲约 69 MiB，swap 已用 7200.50M，
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
  testID `conversation:usage`。本轮没有新的交互经验。
