# 四条故事交付 · 2026-11-11

状态：**进行中 · 第 1 条（KIN-PROJECT-001）**。一次交付一条，每条走完整完成门；本文件是四条故事的唯一进度表。

## 现在的位置

| 顺序 | 故事 | 状态 | 证据 |
|---|---|---|---|
| 1 | `KIN-PROJECT-001` 项目封面 | 进行中 | — |
| 2 | `KIN-AGENTS-001` Agent 运维 | 未开始 | 合同 / 审阅页 / 5 帧已签 |
| 3 | `KIN-ROUTINE-001` 例行任务 | 未开始 | 合同 / 审阅页 / 5 帧已签 |
| 4 | `KIN-START-001` 新建对话 | 已签字，未开始 | 合同 / 审阅页 / 5 帧已签（2026-11-11） |

- 四条都已 `approved`；交付一条改成 `covered`，同一个提交带代码、测试、故事与 `registry.json`。
- `KIN-SETTINGS-002`（桌面壳一键升级）不在本轮四条内，仍在队列里，等这四条之后单独交付。
- 每条的完成门：`./scripts/check.sh` → 红验证（mutant）→ 同模型复审 → 修 blocker/major → 提交 → 合入 `main` → `./scripts/desktop-rebuild.sh` → Hub 重新部署（手机可见时）。

## 1. KIN-PROJECT-001 · 项目封面

范围（合同 `docs/product/stories/KIN-PROJECT-001.md`）：

- `/projects/:id` 只有概览：一句话摘要（可编辑）、最近活动、两张两周热力图、这个项目的例行任务块（只显示归属，调度归 `/routines`）。
- 没有「对话」tab；最近活动只放最近一段对话的入口，更早的对话回列表按项目找。
- 空项目、加载、概览读不到、项目不存在、离线、摘要编辑中 / 冲突各有文字与下一步。

现在：`ui/src/pages/ProjectDetailPage.tsx` 与 `ui/src/components/project/` 已有封面骨架；本轮按合同收口，删掉或改掉与「唯一列表」冲突的部分。

验证：`ui/src/lib/projectChats.test.ts`、`ui/src/pages/projectChatsWiring.test.ts` 扩充；1100 / 390 截图对照；`check.sh`；两个状态守卫各一个 mutant。

## 2. KIN-AGENTS-001 · Agent 运维

范围（合同 `docs/product/stories/KIN-AGENTS-001.md`）：

- 目录最多 10 个产品（同一产品的 native / ACP / CLI 算一个）；发现第 11 个时标「已满」并说明先移除或合并。
- 发现新 agent 不自动接入；必须经过「接入确认」对话框，说明会做什么 / 不会做什么。
- 接入不导入历史会话；agent 会话只在用户手动导入时进来。
- 状态：未接入、已满、接入中、接入失败、未登录、额度等待、检查中 / 失败 / 断线。

现在：`internal/adapter/detect/skills_catalog.go` 有 74 个产品条目；`agentCatalog` / `agentLimits` / `agentSessionImport` 的 UI 逻辑已存在，缺的是上限、确认步骤与「不自动接入」。

验证：`agentCatalog.test.ts`、`agentLimits.test.ts`、`agentSessionImport.test.ts`、`usage.test.ts`；1100 / 390 截图；`check.sh`；上限与确认各一个 mutant。

## 3. KIN-ROUTINE-001 · 例行任务

范围（合同 `docs/product/stories/KIN-ROUTINE-001.md`）：

- `/routines` 只保留运行记录（时间、结果、耗时），不内嵌或复制会话；记录链到项目里的那段对话。
- 定时运行的会话默认在同一条里持续；每条任务可选「每次执行在对应项目新建会话」。
- 机器离线、空、加载、调度非法、运行中 / 成功 / 失败、等待批准、未读 / 已读各有文字与下一步。

现在：`RoutinesPage`、`routineDevice` / `routineEdit` / `routineHistory` 已有列表与表单；本轮补会话方式与运行记录到会话的链接，删掉页内会话残留。

验证：`routineDevice.test.ts`、`routineEdit.test.ts`、`routineHistory.test.ts`（新增 `routineConversation.test.ts`）；1100 / 390 截图；`check.sh`；会话方式默认值与「每次新建」各一个 mutant。

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
| PROJECT | — | — | — | — |
| AGENTS | — | — | — | — |
| ROUTINE | — | — | — | — |
| START | — | — | — | — |
