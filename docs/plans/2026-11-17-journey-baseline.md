# 旅程基线：J1–J7 在今天 main 上的实测

## 现在的位置

- 日期：2026-11-17 08:52 +08；基线提交 `efdbf03a4d2b`（本页在它之上只加文档与 gap-log）。
- 命令：`bash scripts/journeys-smoke.sh --out rsi/state/ux/journey-baseline/run`（一次性 state 目录、空闲端口、fake agent 在 `PATH` 首位；未触碰 `:7777` 与 `~/.kin`）。
- 结果：**14 个「旅程 × 视口」= 11 绿 · 1 红 · 2 跳过**；89 张截图，0 横向溢出，0 原生 `<select>`，0 个缺失的必选选择器。种子 10 项全部创建，`seed.log` 只有两个已知 fake-agent 缺口（权限请求、例行任务运行）。
- 三条优先项：
  1. **红 · J3 手机 · 44px**：新建页每屏有 1 个 <44px 触控目标，唯一锚点是项目卡上的「打开封面」chip → 新条目。
  2. **跳过 · J7 手机 + Mac · harness**：`/tasks/demo-task` 404；页面正确显示「任务不存在」，`blank page` 是 `bodyText < 20` 在中文短文案上的误报 → 种子/夹具缺口，不入 gap-log。
  3. **跳过 · J2 双视口 · spec**：最后的「变更/文件」步骤在 `/new` 上执行（`J2-mac-12` 的 URL 仍是 `/new`），没有回到对话页；对话页本身有「文件」按钮 → spec 缺口，不入 gap-log。

证据目录 `rsi/state/ux/journey-baseline/run/`（`rsi/state/` 被 ignore，路径只是指针）：`walk.json`、`walk.log`、`seed.log`、每步的 `.png` + `.aria.txt`。

## 14 行

判定按 harness：有屏、无 `hardFail`、无横向溢出为绿；`hardFail` 属产品可修缺陷为红；夹具/种子缺 state 为跳过。`smallTapTargets` 只在手机宽度统计。

| 旅程 | 视口 | 结果 | 看到了什么（一句） | 截图（相对 run/） | hardFail 原文 |
|---|---|---|---|---|---|
| J1 | phone | 绿（批准子步骤跳过） | 列表 → 失败对话 → 搜索「week」0 命中（唯一含 week 的对话已归档）→ 筛选面板打开；批准卡不存在 | `J1-phone-06-filters.png` | — |
| J2 | mac | 绿（变更面板跳过） | 搜索 / 筛选 / 对话 / 新建；运行设置三层键盘走通；最后的「变更/文件」步骤跳过——spec 在 `/new` 上点它（`J2-mac-12` 的 URL 仍是 `/new`），而对话页本身有「文件」按钮 | `J2-mac-12-workspace-panel.png` | — |
| J2 | mac-wide | 绿（变更面板跳过） | 同上，1280px 下选择器与焦点回到触发按钮一致 | `J2-mac-wide-12-workspace-panel.png` | — |
| J3 | phone | **红（产品 · 44px）** | 草稿、目录选择（`[seed] Project Gamma`）、开始可用、权限切到「自动编辑」、模型 / Agent 面板可开可关；但 12 屏每屏 1 个 <44px 触控目标（「打开封面」chip） | `J3-phone-12-run-config-closed-focus.png` | 无 hardFail；summary `smallTapTargets=12` |
| J3 | mac | 绿 | 同一流程；手机宽度才统计触控目标，桌面为 0 | `J3-mac-12-run-config-closed-focus.png` | — |
| J4 | phone | 绿 | 项目集合 → Gamma 封面（真名、路径、最近活动）；例行任务 → 新建 → 工作目录浏览器（开、Tab、改手动输入 `/tmp`、选定） | `J4-phone-07-cwd-chosen.png` | — |
| J4 | mac | 绿 | 同上，7 屏 | `J4-mac-07-cwd-chosen.png` | — |
| J4 | mac-wide | 绿 | 同上，7 屏 | `J4-mac-wide-07-cwd-chosen.png` | — |
| J5 | phone | 绿 | hover 行 → 「⋯」以 dialog 打开行菜单：置顶 / 归档 / 删除 | `J5-phone-02-row-actions.png` | — |
| J5 | mac | 绿 | 同上 | `J5-mac-02-row-actions.png` | — |
| J6 | phone | 绿 | 设置根、`?tab=operations`、旧 `/agents` 落到同一运维分区 | `J6-phone-03-legacy-agents-redirect.png` | — |
| J6 | mac | 绿 | 同上 | `J6-mac-03-legacy-agents-redirect.png` | — |
| J7 | phone | 跳过（harness） | `/tasks/demo-task` 404，正文 `alert: 任务不存在` + 「← 首页」；不是空白，`bodyText=10` 触发 walk 的 <20 判定 | `J7-phone-02-back.png` | `J7-phone-01-landing: blank page` · `J7-phone-02-back: blank page` · `J7/phone: 4xx/5xx: 404 /api/tasks/demo-task` |
| J7 | mac | 跳过（harness） | 同上，侧栏外壳仍在，主区显示「任务不存在」 | `J7-mac-02-back.png` | `J7/mac: 4xx/5xx: 404 /api/tasks/demo-task` |

## 这意味着什么

- **J1–J6 的路由级流程今天全部能走完**（J1 的批准与 J2 的 diff 没有走，见下）。搜索框、筛选、新建、目录选择、运行设置三层、例行任务的工作目录浏览器、行菜单、设置重定向都真实操作过；缺口集中在**未验证的半边**，不是坏掉的页面。
- **唯一的红是新条目（产品）**：手机新建页「打开封面」chip <44px，见 gap-log `2026-11-17 · 中`。J3 的 12 个计数是 12 块屏上的同一个控件，不是 12 个控件。
- **J7 的红是夹具缺口，不是页面回归。** `journeys.json` 走 `/tasks/demo-task?focus=demo-item`，而 task id 是 ULID，种子不产生 `demo-task`；页面本身给了可读的「任务不存在」。`blank page` 是 `bodyText < 20` 的拉丁文阈值在 10 个汉字上的误报。修法是让 J7 用一条真实种子会话的深链（种子里已有三条 `[seed]` 会话），不在本 PR 的范围。
- **跳过的子步骤（不是红）**：J1「批准」（fake agent 不产生权限请求）、J7「返回」（页面用「← 首页」）是种子缺口；J2「变更/文件」是 **spec 缺口**——`journeys.json` 在 `goto /new` 之后直接点它，`J2-mac-12` 的 URL 仍是 `/new`，而对话页（`J2-mac-04`）有可点的「文件」按钮。`seed.log` 的 `waiting-approval` / `routine-failed` 两个 skip 与 J1 同因。修 spec 与修种子都不在本 PR 的范围，已记入 `rsi/state/followups.md`。
- **新观察（已入 gap-log 第二条，中）**：同一个项目在列表里有两个名字——有对话的桶用 cwd 末段（`alpha` / `beta`），当前范围里没有对话的项目用项目名（`[seed] Project Gamma`）。`J1-phone-01-list.png` 与 J7 Mac 侧栏同屏可见。
- **与既有工作不重叠**：三条 Open 条目（iPad 多选退出 #170、拖动排序、结束后一条摘要 #171）都不在这 14 行里；#172/#174/#175 是控件门面与故事合同，也不对应本次任何红。
- **下轮可直接取用的证据**：`walk.json` 的 `hardFail` 为空即为绿；任何未来的红都先看对应 `<pair>-<step>.aria.txt`，再看 `.png`。harness 的两个盲点（J7 夹具、`bodyText<20` 对中文）已在这里记录，改 harness 时一并处理。
