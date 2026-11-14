# 暂缓的 UI 工作：跨重载视图恢复与 Tab 式文件工作区

状态：**2026-11-14 与用户确定。** 两个功能当时要、以后也要；但两条已完成的实现与
main 的分叉太深，合入等于按旧图纸在新地基上重写一遍，所以不合入。分支保留作参考，
将来按当时的地基重做成新故事。今天的 KIN-RESULT-002（手机读文件与 HTML 预览）定位为
**临时修复**，不是文件区的长期方案；长期方案由本文记录，后续另开故事。

配套：[`2026-11-14-ux-unification.md`](2026-11-14-ux-unification.md)——四区重构的
五个 Batch 不含文件区 Tab 板，两条暂缓项都不在那个计划里。

## 现在的位置

| 项 | 状态 | 证据 / 下一步 |
|---|---|---|
| 决定：不合入，将来重做 | 🟢 2026-11-14 | 本文；两条分支与工作树保留不删 |
| session-persistence-investigation | 🟡 保留参考 | 11 个提交未吸收；merge-base `5369df62`（2026-10-23） |
| workspace-tabs | 🟡 保留参考 | 3 个提交未吸收；merge-base `b63dcfb4`（2026-10-28） |
| KIN-RESULT-002（当前草稿） | 🟡 临时方案，照常交付 | 只解决「手机上打开文件、看 HTML 设计、能原路返回」；文件区的长期形态由将来的故事定 |
| 跨重载视图恢复的需求 | ⚪ 无故事认领 | 认领时并入文件区故事或单开小故事 |

## 为什么不合入（2026-11-14 实测）

分叉不是「改了几个文件」，是集成点在 main 上被整块重写：

| 文件 | session-persistence 改 / main 此后改 | workspace-tabs 改 / main 此后改 |
|---|---|---|
| `ui/src/pages/TaskDetailPage.tsx` | 92 / 1744 | 1113 / 1171 |
| `ui/src/components/workspace/WorkspacePanel.tsx` | 40 / 621 | 499 / 268 |
| `ui/src/components/layout/AppShell.tsx` | 26 / 725 | — |
| `internal/api/workspace.go` | 152 / 68 | — |
| `WorkspaceTabStrip.tsx`（分支新增） | — | main 上不存在 |

rebase 解决不了这种比例的冲突——那等于照旧设计在新地基上重新实现一遍，还要捎带两处
设计冲突（见下）。所以结论是**重做而不是合入**；将来动手时先重新测量，本文的分叉
数字到那天必然过时。

## 怎么读这两条分支（2026-11-14 实测，很重要）

`workspace-tabs` 按 SHA 领先 main 198 个提交，但用 `git cherry` 按补丁比对只有 3 个
未吸收——它带着一条与 main 补丁等价、SHA 不同的平行谱系（本地 lody 仓库整合时的
历史）。因此 **`git diff main...workspace-tabs` 会显示约 460 文件 / 8.6 万行的假 diffs**，
不能用来读这条分支的工作。真正要看的是这三个提交：

```
14dafe89 feat(workspace): add tabbed workspace side panel
98a6b9b9 fix(workspace): keep clicked files and reconcile panel state
aeaa20f0 fix(workspace): apply phone file opens once per page
```

`session-persistence-investigation` 是干净谱系：11 个提交全部未吸收，`git log
main..session-persistence-investigation` 直接可读。

## 功能一：控制台视图状态跨重载恢复

**需求（仍然成立）：** 打开过的面板、滚动位置、展开状态，刷新后不丢。

**参考实现：** 分支 `session-persistence-investigation`。功能完整——实现、1135 行
store 与测试、经三轮复审、ADR、web/dist 都齐，停在没整合。史料可读：
`git show session-persistence-investigation:docs/plans/2026-10-24-console-view-state.md`
与同分支的 `docs/adr/0025-console-view-state.md`。

**重做时怎么定基线：**

- 恢复的合同按 **URL** 走（`?panel=files&file=…`），不再做「localStorage 重放上次
  面板」——现行 KIN-RESULT-002 草稿已明确「普通打开 Files 不重放旧文件」，这是产品
  决定，重做时别从后门带回来。
- 恢复滚动 / 展开 / 每任务选中页签各自要不要，由那条故事自己切范围。
- HTML 预览的相对资源问题（文档里的 `./style.css` 解析）当时用「token 进 URL 路径段
  的 raw 路由」解决；现行设计选了 srcdoc 沙盒、不新增后端接口。长期方案若要支持相对
  资源，重新评估这两条路线，别默认旧结论。

**要带走的经验教训：**

1. **恢复可能先于内容到达。** 静默症状是「位置再也没回来」；恢复逻辑必须等内容
   存在。旧计划 manual checks 14/15/20 是三条修复的回归点。
2. **视图状态的清理要按流程覆盖。** 三个删除流程（任务页、对话列表、侧栏菜单）里
   两个漏了 `clearTaskViewState`，重载会在已删任务上重开旧面板。
3. **视图 / token 放 URL 路径段而不是查询参数。** 文档按自身 URL 解析 `./style.css`，
   查询串在子资源解析里不存活，路径段才让子资源落在同一根——这是旧 raw 路由里
   最耐久的一条结论。

## 功能二：Tab 式文件工作区（桌面）

**需求（仍然成立）：** 文件 / 改动 / PR / 发布四块并排面板折进一个带页签条的侧板；
diff 与 PR 对照不用先关一个再开另一个；各页签滚动不丢。

**参考实现：** 分支 `workspace-tabs`。三轮打磨（初版 → 复审缺陷修复 → 手机打开修复），
约 +1600 行，含页面级测试与 ADR。史料可读：
`git show workspace-tabs:docs/adr/0030-workspace-browser-tab-boundary.md`。

**重做时怎么定基线：**

- 以**当时的** `shownPanel` / `panelForView` 地基重做；若四区重构已落地，先看
  Batch C/D 改过哪些集成点，再量一次。
- 认领时挂 RESULT 系意图（大概率排在 KIN-RESULT-002 交付之后），作为一条独立故事，
  不进 KIN-CONTINUE-003 的五个 Batch。
- 分支上有第一版 KIN-RESULT-002 故事文件（133 行），**分支独有**——merge-base 和
  main 上都没有。它与现行草稿**同名不同物**：旧的是桌面 Tab 板，新的是手机三态导航 +
  srcdoc 预览。旧的只当史料（`git show workspace-tabs:docs/product/stories/
  KIN-RESULT-002.md`），别混入 registry。

**要带走的经验教训（复审缺陷清单，重做时先写成红灯测试）：**

1. 打开路径本身就是「显示该面板」的请求；changed-file 行先开 diff 页签、再被文件
   面板回调顶掉，是典型竞态。
2. 重复点击同一文件要能重读：桌面点击与手机打开各要自己的 nonce，一次性命令不能
   共用一个脉冲。
3. 活动页签与 `shownPanel` 要**双向对账**；StrictMode 会把 ref 消费的命令按更新前的
   状态重放一遍——命令归页面级 ref 所有，家族对账在 effect 时读 store。
4. 隐藏页签不得发请求：PR 隐式查询、files 面板都等页签在前台才挂载 / 请求。
5. 关闭页签必须把焦点交给继任页签，最后一个页签还给打开它的按钮，不能落到 `<body>`。
6. 页面级测试要在真实宽度跑（1600px 才显示 changed-file rail，390px 根本跑不到）。
7. publish 页签永不持久化（依赖活机器）。
8. **任意 URL 不进主渲染器**：浏览器页签只做占位；两条可接受路线（专用 Electron
   视图 / daemon 中介的流）记录在分支 ADR，重做时重新评估。

## 记录上的两件小事

- 分支 ADR 编号（0025-console-view-state、0030-workspace-browser-tab-boundary）与
  main 现有的 0025-hub-build-boundary、0030-routine-phone-notifications **撞号**；
  重录时改号，内容归属不改。
- 两条分支与各自工作树**保留**（AGENTS.md 第 5 条）。将来做分支清理时不要把它们当
  被遗忘的死分支误删——先读本文。
