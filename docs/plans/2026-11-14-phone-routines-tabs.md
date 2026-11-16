# 手机例行任务读取与四个 Tab

## 现在的位置

- **绿（本轮聚焦回归）**：签字焦点与横滑收口保持 8 文件 151 项通过。分页审查后，RoutinesPage 的真实 DOM 回归增加旧请求拒绝、倒序成功、刷新期间发起的更旧页、401 loading 等场景；正向、反向及 401 共 7 条通过，例程完整编辑与 history 回归继续保留。
- **绿（最终隔离浏览器）**：本轮 embedded bundle 在 390px Chromium 通过 Routines ↔ Chats、继续到 Agent Ops、边界不 wrap、纵向拖动、真实双指与 pointercancel 不切页、真实 Machine Sheet 背景横滑不切页，以及未保存 Settings 的底栏/横滑离开确认。routine 历史和合成失败可见；编辑读回完整 11,000 字符原文，Cancel 不写；归档筛选与草稿返回保留。390px FAB 底边 771px、footer 顶边 787px；1100px 无手机 footer、无横向溢出。新页面验收无 Runtime/console error；早期手工 harness 的错误文件 URL 和错误控件定位不计为通过。该浏览器验收早于复审后的两处非布局修正（审批卡兄弟布局断言、`touch-action: pan-y pinch-zoom`），这两处由聚焦 DOM 用例复验，未再跑一遍嵌入浏览器。
- **绿（后端与最终构建）**：最终源码的 worker/API/store 非缓存测试退出 0（API 455.617s，store 178.221s），分包 race 退出 0；最终 `npm run build` 成功（Vite 8m41s），已生成对应 `web/dist/index.html`。
- **绿（完整 UI 套件）**：最终源码在 `--maxWorkers=2` 下跑完整 UI 套件，238 文件 / 2358 项全部通过（退出 0）。先前默认并发 gate 的 8 文件 / 15 项失败已逐文件串行复跑全部通过（71 项），与 gate 诊断一致是 14 job 并行造成的 CPU 饥饿与 5 秒超时，不是产品回归；`PanelSurface` 的 parse-once 语义不变。Go、vet、desktop、TypeScript、OpenAPI、stories 等其余 jobs 在同一最终源码上通过，`tsc --noEmit` 本轮再次退出 0。默认 `check.sh --all` 在 14 job 并发下仍可能超时，交付证据以上述受限并发完整套件为准，并在 handoff 说明。
- **绿（独立复审已返回）**：冻结树的独立复审结论是**产品行为无 blocker / major**；继承的 1 blocker / 2 major（live push 截断已翻页 feed、旧 cursor 混新搜索、迟到 feed 未与全部已读对账）均被独立确认为真 DOM 时序用例修复，未发现丢行、重复、旧响应覆盖或未读复活。复审另给 1 项 major 测试缺口与 7 项 nit：live-push 用例推入的 id 与首屏末行同 id，走的是原地替换而非插入分支。M1 已把推入 id 改为 "021" 并补 "First page 9" 断言；红证：折叠插入上限改成一页 → 用例变红（此前保持绿）。nit 2（`touchAction` 补 `pinch-zoom`）、nit 5（摘要谓词与响应形状用同一 `explicitPage`，新增 5 个 API 表驱动用例）已修并各自红证；`go test ./internal/api -run Routine` 41 项、导航 35 项、tsc/vet/gofmt 绿。delta 复审结论：**未引入 blocker / major**；M1、nit 2、nit 5 的红证被独立复现为有效。nit 1 被纠正：审批卡是 `<main>` 的兄弟节点，手势事件不会冒泡到横滑监听器，`data-phone-swipe` 属性对当前行为是惰性的，先前的“移除属性 → 用例变红”实际红在取不到元素，不算行为级红证。测试已改为按语义取卡、断言卡片不是 `<main>` 后代，属性保留并注明只是卡片若移入 pane 后的第二道保险；导航 35 项复跑通过。nit 3/4/6/7 延后并记录在 §已知边界。
- **绿（最终完整复跑）**：最终源码（含 delta 修正）的完整 UI 套件在 `--maxWorkers=2` 下 238 文件 / 2360 项全部通过（退出 0）；`go test ./internal/api -count=1` 退出 0（140.181s）。
- **未验证（实时环境）**：Hub 部署、真手机读取/编辑、gap sweep 两次真实连续调度均未做；代码和隔离浏览器通过不能被称为 scheduler 已修好。实时节点只读检查显示 gap sweep 定义当前已禁用，`last_error` 为 `run failed`，21:00 / 22:00 / 23:00 连续三次失败（20:00 成功）；daily LESSONS routine 正常成功。读取修复不改变这一状态。gap-log 保持 Open。
- **未完成（交付）**：功能提交已落在 `fix/phone-routines-tabs`（backend / routines UI / PanelSurface test / 四 root 导航 / docs）；与已前进 primary main 的集成、`web/dist` 重建提交与桌面 rebuild 尚未做。primary 的其他会话改动（KIN-RESULT-002 文档）不纳入本功能；本轮 worktree 与 branch 保留。仓库 smoke 已通过：health、嵌入 console、SPA fallback、鉴权 API、一次 routine 写入与同库重启。
- **已知边界**：摘要保留卡片所需的 title / status / summary，`tldr` 仍由现有写入保证约束；不是任何任意超长 metadata 都能塞进 640 KiB 的数学保证。旧的显式无分页全量导出保留，仍可能被防护上限拒绝，防止静默丢配置。loopback 与 Node 都有同样上限，集成里前一层放宽会被后一层挡住，须分别用 node case 红证。复审延后的四项 nit：①继续会话提示在「表单模型为空、上次 run 有模型」时可能比 daemon 保守（只影响提示，不影响实际调度）；②Create 表单打开时点 Edit 静默无响应（既有交互形态）；③`runs_limit=200` 时 `runs_has_more` 恒为 false（UI 固定 10，不影响当前界面；旧全量导出本就不承诺分页）；④首屏 feed 与 Mark all read 的迟到对账只有纯函数与代码审查、没有专用 DOM 用例。四项都不改变本轮用户可见的读取与导航行为，后续单独收口。

## 根因与修改边界

实时只读聚合得到：3 个 routines、80 个 runs、routine JSON 13,006 bytes、run JSON 684,170 bytes，合计 697,231 bytes；原错误精确为 `the machine declined to answer: the routine answer is 655361 bytes, over the 655360-byte limit`。响应超限，不是模型 token 超限的证据。

显式 console UI 改读摘要；编辑读 `GET /api/routines/{id}`，运行正文由所属对话详情读。新 `runs_cursor` 与定义的 `next_cursor` 分开。单例编辑的完整原文是 PATCH 比较基准；列表刷新不能覆盖它。不放宽 640 KiB relay frame 防护，不删真实任务。

手机改为对话列表、例行任务、Agent 运维、设置四个同级 root。共享底栏只在四 root，详情/草稿仍返回。横滑认空白内容，避让按钮、输入框、sheet、横滚和会话行；无永久整页 transform。

## 验收及实际执行

1. 摘要读取只省列表正文，DB 原文及非摘要读取不变；带状态的保存测试实际完成。
2. 全局和单 routine 的远程历史可加载下一页且不重复；设备竞态/读失败/延迟详情有断言。
3. 四 root 底栏确切四个入口；已归档仍为对话筛选；详情返回、列表筛选与滚动、根 Tab、scroll ownership、leave guard 都保留。
4. 本轮文件/测试多于 800 行门槛；最终实际量用 `git diff --stat` 记录，按可独立落地层或关联小故事拆分评审，不在红灯时提交。
5. 完成整个 Verification 和 Feature completion gate。临时检测脚本与 mutant manifest 放 `/tmp`，不入库。同一 worktree `fix/phone-routines-tabs`；保留 worktree/branch。
6. 更新 gap-log 并验证实时页面/必要时同一 Hub 部署；不把列表读取修复混称为实际引擎调度修复。

## 后续顺序

先保持当前窄语义增量，跑 PhoneNavigation / SessionsPage / Routines 三个真实 DOM 套件；再后端输入范围与全量检查；再 docs、mutants、review、commit/integration/rebuild。完整源码在独立 worktree，primary 工作区未改。
