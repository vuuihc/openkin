# 表面收缩与 T3 split

2026-11-21 · owner 决策：先删到最小产品面，再用 RN/native 重建移动端

## 现在的位置

- **绿**：方向已定——T3 split。桌面继续 Electron + React/Vite；手机转 Expo/RN + 本地 Swift/Kotlin modules；Go daemon 和共享 TS 不重写。产品代码未改。
- **黄**：RSI 正在跑 820 阅读面的 lane（`R-quality-reading-surface`、tablet-walk）；建议的 P17 尚未开，story 尚未写，review page 尚未签。
- **红**：15 个 `<Route>`（实际页面约 10 个）、6 个 Settings tab 仍在；死代码 1,090 行（`ApprovalsPage` 345 + `RunningTaskCard` 77 + `inboxFocus` 36 + `inboxKeyboard` 172 + 测试 460）仍在；`/usage` 仍 redirect 到 `/settings?tab=operations`（`ui/src/App.tsx:214`）。

## 决定

1. **先删后重构**：先把 UI 面收到最小契约，再开始 RN/native。删 UI，不删能力；删页面，不删协议。
2. **T3 split**：桌面 = Electron + React/Vite；手机 = Expo/RN + 本地 native modules；Go daemon 不动；共享 TS（`transcriptProjection`、API types、card schema、i18n）先抽出来复用。
3. **替换先行**：低频页面只有在对应 tool/card 合并、能力测试绿了之后才删；唯一例外是真正无引用的死代码。
4. **一事一 story**：删除 story 不夹带 RN 重构；RN 是独立 phase/ADR。

## 最小契约（建议，由 story 的 review page 签）

| 层 | 保留 | 理由 |
|---|---|---|
| 固定面 1 | 会话列表（设备 → 项目 → 对话，层级默认折叠） | 导航不能只靠模型 |
| 固定面 2 | 对话 + composer + 流式/打断/排队 | 产品核心 |
| 固定面 3 | Provider 凭据 sheet | API key 不能进模型上下文 |
| 固定面 4 | 用量 sheet | 数字/账单要稳定、可审计 |
| 卡片 | provider / usage / routine / agent-status / project / diff / error | 低频配置和状态 |
| 已有卡片 | approval / question / limit / floating approval | 安全边界，保留 |
| 对话内配置 | routines、agent ops、routing、account、push、roles | 工具 + 卡片，不再做独立页 |

目标：15 个路由 → 5–6 个；6 个 Settings tab → 2 个（providers + general）。不是字面上只剩一个聊天框；T3 也是列表 + 阅读面 + 输入框。

## 删除清单（按文件归属粗算）

| 类别 | 源码 | 测试 | 处理 |
|---|---:|---:|---|
| 死代码：`ApprovalsPage` + `RunningTaskCard` + `inboxFocus` + `inboxKeyboard` | 630 | 460 | 立即删 + `removed-surfaces` 守卫 |
| routines 页面 + components | 2,907 | 4,642 | 先加 routine 工具 + `RoutineCard`，再删页面；Go 引擎 1,162 + 1,197 保留 |
| Settings 非 provider（含 agent ops 1,963、routing 796、account/local/push/roles 701、settings shell 1,176） | 4,636 | 5,889 | 先抽 `ProviderSheet`，再删其余 tab |
| `AgentSessionDetailPage` | 562 | 426 | 改成 `agent-status` card |
| `DesignSystemPage` | 448 | 216 | 移出生产 import 或删 |
| Projects（未点名，可选） | 2,691 | 1,864 | 先保留层级，后删独立页面 |
| **小计** | **9,183** | **11,633** | 毛删约 2.1 万行；净减约 1.6–1.8 万 |

不能删：Go core 102k（store/adapter/api/task/node）、`transcriptProjection` 2,148、`api` 16.2k、`lib` 14.6k、i18n 4.3k、routine 引擎、provider/routing 后端、projects 数据模型。这些是 RN 客户端的共享底座。

## RSI 交接

**Phase（建议）**：`P17-surface-reduction`，由 CEO 在当前 820 阅读面的 lane 收口后开；不要和它混在一起。

**Story 切法**：按意图切，不写一条“大重构”：

- 阅读面：`KIN-CONTINUE-00x`（820 阅读面 + 状态按需）
- 设置：`KIN-SETTINGS-00x`（provider sheet + 用量）
- 定时任务：`KIN-ROUTINE-00x`（工具 + card）
- 代理运维：`KIN-AGENTS-00x`（status card + 诊断）
- 死代码：纯 chore，不是 story
- RN：独立 ADR + phase，契约冻结后做

**Queue seeds（一次一行）**：

1. `R-dead-paths`：删 1,090 行死代码 + `removed-surfaces` 守卫。无产品决策，可先插。
2. `R-contract`：写最小契约 + 路由清单测试 + review page；owner 签。
3. `R-routine-tool`：routine 工具 + `RoutineCard`；隐藏 `/routines`；引擎保留。
4. `R-provider-sheet`：抽 `ProviderSheet`；Settings 只留 providers + general；删 agent ops/routing 等。
5. `R-usage-surface`：`UsageCard` + `UsageSheet`；修 `/usage` 的 redirect。
6. `R-delete-pages`：删退役页面/测试 + 守卫。
7. `R-rn-spike`：独立 story/ADR，抽共享 TS + RN 壳。

**Gate 要补**：

- `removed-surfaces` 始终运行：计划说删掉的路径必须在 `main` 上不存在。这次 `ApprovalsPage` 被合并带回、计划还绿着，就是缺这条。
- 路由清单测试：只允许契约里的 5–6 个路由；新增路由必须有 story。
- 替换先行：每个被删页面的能力仍有 tool/card 测试；页面删除前该测试必须绿。
- 390/820/1100 截图、UX rubric、UI inventory 不增长；沿用现有门。

## RN/native 的分工

- 桌面不动：Electron + React/Vite；手机新建 Expo/RN 客户端。
- 共享 TS 先抽：`transcriptProjection`、API client/types、card schema、i18n、任务标题逻辑。RN 直接 import，不重写。
- RN MVP 顺序：配对/登录 → 会话列表 → 对话读/发/流式 → 审批/提问 → provider/usage sheet → routine card。Settings 页面不进 MVP。
- native modules 只补 RN 弱项：玻璃/导航栏、滚动边缘、推送、后台重连、secure storage。
- 不做全原生重写；除非某个面明确要求。T3 的移动端就是 RN + native modules，不是 SwiftUI 重写。

## 待定

- 最小契约的 4 个固定面是否完整（files/diff/PR 是否算第五个面）。
- projects 是保留独立页面，还是只保留列表层级。
- 桌面是否永远保留 web 控制台；还是 RN 成为唯一客户端。
- RN spike 的启动时间：契约冻结后，不跟删除 story 并行。

## 回退

- 本文件只记录方向；产品代码未改。方向变了就删本文件与 `rsi/DECISIONS.md` 的对应行。
- 死代码删除是独立 chore，可单独 revert；不影响本方向。
