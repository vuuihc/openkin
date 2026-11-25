# KIN-MOBILE-001 证据：RN 客户端在 iOS 模拟器里的四个面

**结论：8 张截图全部拿到（四面对 × 手机/平板）。两个真实缺陷：对话里的 GFM 表格
按原文竖线渲染；用量 sheet 在配对设备上整张失败（`/api/providers` 对 device token
是 403）。** 运行时间 2026-11-26，本机模拟器，Expo Go，一次性节点。

## 这次运行

| 项 | 值 |
|---|---|
| 日期 | 2026-11-26（本机） |
| 提交 | `14918d30`（`git rev-parse --short HEAD`） |
| 手机 | iPhone 17e，**390×844** 逻辑（截图 1170×2532，@3x） |
| 平板 | iPad Air 11-inch (M4)，**820×1180** 逻辑（截图 1640×2360，@2x） |
| 模拟器运行时 | iOS 27.2 (24B8117) |
| Expo Go | 58.0.7；`mobile-rn/package.json` 的 `expo` 是 58.0.26 |
| Metro | `npx expo start --offline --port 8081`（离线，仅本机） |
| 节点 | 一次性 `kin serve --port 50346`，`KIN_STATE_DIR` 是 `mktemp -d` 目录；未触碰 `:7777` 或 `~/.kin` |
| 种子 | `KIN_BASE=http://127.0.0.1:50346 KIN_TOKEN=<token> python3 scripts/journeys_seed.py`，`scripts/journeys_fake_agent` 固定在 `PATH` 首位并设 `KIN_CLAUDE_BIN`；结果 `created 24, existing 0, skipped 1` |
| 阅读夹具 | 通过同一个公开 API 新建一条 prompt 为 `[seed] reading` 的对话，fake agent 回一段长文 + 5 行 GFM 表格（`scripts/journeys_fake_agent/claude:308-311`） |
| 配对 | 节点 mint 一次性 secret，链接 `http://127.0.0.1:50346/pair?token=<secret>&pairing=1`；`pairing=1` 是必需的（`src/auth/pairingLink.ts:82`），少了它 app 把 secret 当 device token 而显示「链接已过期」 |
| 截图 | `rsi/state/shots/rn-sim-evidence/`（本地，不入库） |

检查命令与结果（在本分支 `mobile-rn/` 下）：

```
npx tsc --noEmit        # 无输出，退出 0
npx jest --ci --runInBand
# Test Suites: 29 passed, 29 total
# Tests:       284 passed, 284 total
```

（默认并行跑时 5 个用例在 5s 上超时——同一台机器上还有别的 lane 在跑；`--runInBand`
全绿，失败都是超时而非断言。）

## 截图

| 面 | 设备 | 文件 | 判定 | 画面 |
|---|---|---|---|---|
| 列表 | 390 | `390-list.png` | 通过 | 设备（此设备，11 条）→ 项目（alpha / beta / gamma / reading-cwd，beta 与 reading-cwd 展开）→ 对话行，行上带 `claude-code · 状态 · N 项待你处理` |
| 对话 | 390 | `390-conversation.png` | 缺陷 | 打开 `[seed] reading` 的长回答；表格以 `\| Surface \| Before \| …` 原文出现（见 D1） |
| 审批 | 390 | `390-approvals.png` | 通过 | 对话顶部一张待批卡片：需要权限 / Bash / `git status --short` / 批准 · 拒绝；下方是历史里的失败工具行 |
| 用量 | 390 | `390-usage.png` | 缺陷 | 用量 sheet 打开，本周 / 30 天 / 90 天在，但整张显示「链接无效或已被拒绝 · 重试」（见 D2） |
| 列表 | 820 | `820-list.png` | 通过 | 分栏：左侧列表列（与手机同一套设备→项目→对话），右侧「在左侧选一条对话，在这里阅读。」 |
| 对话 | 820 | `820-conversation.png` | 缺陷 | 左侧列表 + 右侧 `[seed] reading` 长回答（分栏已随 #721 落地）；表格同样是原文竖线（D1） |
| 审批 | 820 | `820-approvals.png` | 通过 | 左侧列表 + 右侧待批卡片（批准 · 拒绝） |
| 用量 | 820 | `820-usage.png` | 缺陷 | 左侧列表 + 右侧用量 sheet，同样「链接无效或已被拒绝」（D2） |

820 的会话截图是真实阅读态：右栏是一段必须滚动的长回答，末尾就是那张 5 行表格。

## 缺陷

### D1 对话把 GFM 表格当普通文本渲染

- 证据：`390-conversation.png`、`820-conversation.png`。屏幕上逐字出现
  `| Surface | Before | After | Owner |` 和 `| --- | --- | --- | --- |`。
- 期望行为（可写成测试）：一段含 `| a | b |` + `| --- | --- |` 的回答在
  `ConversationView` 里渲染成表格（与 web 控制台一致），或至少不把分隔行当正文。
  测试可放进 `src/screens/ConversationView.reading.test.tsx`：给一个表格 turn，断言
  表头/单元格文本各自成节点，且不出现 `\| --- \|`。
- 不要的做法：直接把 `ui/src/components/Markdown.tsx` 搬进 RN——它按 ADR 0036 属于
  DOM 侧，含 `react-dom` 依赖；也不要在 projection 里把表格拍平成一行。
- 照抄的同类：web 端用 `ui/src/components/Markdown.tsx:11` 渲染 markdown；RN 端
  `mobile-rn/src/screens/ConversationView.tsx:312` 用纯 `<Text>` 输出 `itemBody(item)`。

### D2 用量 sheet 在配对设备上整张失败

- 证据：`390-usage.png`、`820-usage.png` 都显示「链接无效或已被拒绝 · 重试」。
- 根因（本次实测）：`createProvidersModel.load()` 同时读 `/api/providers` 和
  `/api/usage/summary`（`mobile-rn/src/providers/providersModel.ts:205-208`），任一失败
  就把整张 sheet 置为 failed；而 `/api/providers` 是 operator-only
  （`internal/api/api.go:528` 的 `operatorOnly`），配对设备拿的是 device token。用两个
  token 直接打这两个路由：

  ```
  device  /api/providers            -> 403
  device  /api/usage/summary?days=30 -> 200
  master  /api/providers            -> 200
  master  /api/usage/summary?days=30 -> 200
  ```

- 期望行为（可写成测试）：device token 打开用量 sheet 时，能读到的数字照常显示；
  provider 列表被拒只让 provider 一行降级，不把整张 sheet 变成拒绝态。测试放进
  `src/providers/providersModel.test.ts`：providers 403 + usage 200 → 状态不是
  `failed`，`usage` 行仍返回。
- 不要的做法：把 `/api/providers` 的 `operatorOnly` 放宽给 device token（同一组路由里
  还有创建/修改/删除 provider，权限模型会一起松动）；也不要把 403 当成 token 过期去
  清空会话（`providersModel.ts:217-230` 只对 401 这么做，是对的）。
- 照抄的同类：手机端已有只读 usage 的路径 `usageSummaryPath`
  （`mobile-rn/src/providers/providersModel.ts:81`），它对 device token 是 200；缺的是
  provider 列表这一半的降级。

## 已知（不要再报）

- 输入框尚不避让键盘（`#733` 在飞）；键盘盖住发送键，点稿件区可收起键盘。
- 推送注册与玻璃栏未接（ADR 0036 依赖未落地，parked）。
- 扫码未实现（parked）。
- 手机上还没有「新建对话」入口。
- 列表里的项目标题是工作目录名（`alpha` / `beta` / `gamma` / `reading-cwd`），不是
  项目名（种子里的 `[seed] Project Alpha`）。本次只记录，未定性：标签来自设备目录的
  bucket（`mobile-rn/src/list/listModel.ts:302` 直接取 `bucket.label`），是否该由服务端
  换成项目名，留给下一轮决定。

## 运行经验（给下一个人）

- **Expo Go 的悬浮 dev 按钮会盖住会话头部右上角的「用量」入口**（390 和 820 都是）。
  它的点击热区比图标大，点头部右上角只会打开 dev menu；先把按钮拖到屏幕中部再点
  `conversation:usage`。这是 Expo Go 的壳，不是产品控件。
- Maestro 的 `inputText` 对受控 `TextInput` 一次输入长串时只留最后一截；配对框要
  **一次 `inputText` + `pressKey: Enter`**。输入框是单行、会横向滚动，**看起来只剩尾部
  字符是正常的**——用 `maestro hierarchy` 读 `value` 才能确认整串在不在。
- 会话头的 `用量` 可访问名是「打开用量详情」，文本选择器要匹配完整串（或直接用
  testID `conversation:usage`）。
