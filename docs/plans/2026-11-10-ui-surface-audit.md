# R0 · 面审计与减法

状态：**草案，待签字** · 2026-11-10
配套：[`IA.md`](../product/IA.md)、[`TASTE.md`](../product/TASTE.md)、[`stories/PLAN.md`](../product/stories/PLAN.md)、[`2026-11-08-design-system-middle-layer.md`](2026-11-08-design-system-middle-layer.md)、[`2026-11-09-astryx-spike.md`](2026-11-09-astryx-spike.md)
测量：`python3 scripts/ui_inventory.py`

## 0. 一句话

先决定哪些面还应该存在，再决定控件怎么统一。R0 只做归属、删除、Ionic 清尾和基线；不做视觉定稿，不写新组件，不迁 Astryx。

## 1. 为什么先做 R0

- 整站 UI 重构是 12–16 轮的事：98 个非测试 `.tsx`、313 个裸 `<button>`（71 文件）、14 个产品面、4 个页面超过 900 行。按仓库“一轮 ≤800 行 diff”的规则拆。
- 先删面再做组件层，避免把设计系统的力气花在即将删除的页面上。
- 每个面必须有一条六条故事认领；没有主人的面，要么补故事，要么删，不能靠“好像还有用”留着。

## 2. 已经定下的边界

1. **token 层不换。** `--kin-*` + `tokens.test.ts` + `TASTE.md` 是资产；任何设计系统只买行为和结构，不换视觉语言。
2. **如果采用 Astryx，只放在 `components/ui` façade 后面。** 页面永远 import Kin 自己的 `Button/Dialog/Select`；Astryx 是实现细节，0.7.x 升级只改包装层。
3. **R0 不出一版新 UI。** 人工评审物是“现状截图 + 决策卡”，不是重新设计的稿；目标线框只用于合并/改版提案，且标明“线框，不是定稿”。
4. **Ionic 在 R0 清掉。** 只剩 4 个文件、3 个 `IonActionSheet`；用现有 `Sheet` / `Menu` 替掉，删 `@ionic/*` 依赖。之后再做 React 19（Astryx 的前置）会更干净。
5. **改变用户流程的合并/改版不在 R0 里做。** 那要回到对应故事的签字页，先画 Figma 帧，再动代码。

## 3. 盘点（2026-11-10）

| 指标 | 数值 |
|---|---:|
| 非测试 `.tsx` | 98 |
| 裸 `<button>` | 313 处 / 71 文件 |
| `components/ui/` 共享控件 | 3（SearchSelect、SessionFilters、SheetSelect） |
| `<input>` | 58 处 / 26 文件 |
| 原生 `<select>` | 0（设置页的 27 处已收口，TASTE 第 14 条） |
| `role="dialog"` | 14 处 / 8 文件 |
| `role="menu"` | 7 处 / 6 文件 |
| Ionic | 4 文件 / 3 个 `IonActionSheet` |
| 页面总行数 | 11,655；>900 行的 4 个：TaskDetail 2,269 / Settings 1,596 / Sessions 1,443 / Routines 1,366 |

注意：`2026-11-08-design-system-middle-layer.md` §2 里是 2026-11-08 的旧数字（311 / 61 / 27 个原生 select）。R0 用 2026-11-10 的新数字，并注明测量日期，不要手抄旧表。

粗扫只发现一个完全没被引用的组件：`ui/src/components/chat/AgentModelPicker.tsx`（151 行）。这是文本引用扫描，R0a 要确认它是否真的死代码，再决定删不删。

## 4. 评审物：UI 优先，不是文档优先

R0 的主评审物是 **`2026-11-10-ui-surface-audit.review.html`**，不是下面那张 Markdown 表。Markdown 是审计记录和给 agent 读的；HTML 是给人做决定的。

每张卡片的结构：

```text
[390 截图]  [1100 截图]
路由 / 页面 / 入口
归属故事：CONTINUE / START / RESULT / MANAGE / NOTIFY / SETTINGS / 无主
证据：测试 N 个 · API N 个 · i18n N 键 · 入链 N 处
建议：保留 | 合并到 ___ | 删除 | 补一条故事
理由：一句话
[ ] 保留  [ ] 合并  [ ] 删除  [ ] 待定
```

- 顶部实时汇总“保留 / 合并 / 删除 / 待定”的数量，勾选后立即更新。
- 对“合并/改版”的面，附一张低保真目标线框（现状 vs 目标），只画导航树、入口和页面骨架，不做视觉定稿。
- 390px 可读、深色模式、无 CDN、无横向页面滚动；格式对齐 [`stories/AUTHORING.md`](../product/stories/AUTHORING.md) 的签字页。
- 现状截图用当前真实界面（390 / 1100），不用 AI 重新想象的图。删除决定看的是“它现在占不占地方”，不是“它重新设计后会不会好看”。
- 截图如含真实数据，只放本地 ignored 路径，不入库；仓库里的决策记录不依赖截图。评审页可随时重建。

## 5. R0a · 只读审计

对 14 个产品面逐条收集证据，产出 `review.html` + 一张 `keep / merge / delete / 补故事` 表。每条至少查：

- 入口：侧栏 / ⌘K / 手机 K 面板 / 深层链接，有没有导航入口；
- 入链：`to="/..."`、`navigate("/...")`、文档里的地址；
- 测试：`*.dom.test.tsx`、wiring test、截图基线；
- API：页面调用的 endpoint，以及这些 endpoint 是否还有别的调用方；
- i18n：`en.ts` / `zh.ts` 里属于这个面的键有多少；
- 行为：删除后会不会让某个故事（CONTINUE / NOTIFY / START / RESULT / MANAGE / SETTINGS）缺一个面。

**签核：表先给用户签，签完再动代码。** 删除是产品决定，不是 git 操作。

## 6. 产品面初稿（待 R0a 补证据）

| 面 | 页面 | 归属 | 初判 |
|---|---|---|---|
| `/` `/new` | StartRoute / NewChatPage | START | keep |
| `/sessions` | SessionsRoute（手机列表 / Mac 草稿） | CONTINUE / MANAGE | keep |
| `/tasks/:id` | TaskSessionHost / TaskDetailPage | CONTINUE / RESULT | keep |
| `/inbox` | ApprovalsPage | NOTIFY / CONTINUE | keep |
| `/artifacts` `/artifacts/:id` | ArtifactsPage / ArtifactDetailPage | RESULT | keep |
| `/projects` `/projects/:id` | ProjectsPage / ProjectDetailPage | MANAGE？ | **待定**：`IA.md` 已标 Hub 侧遗留 |
| `/agents` | AgentsPage | 无明确故事 | **待定**：补运维故事或并入设置 |
| `/routines` | RoutinesPage | `IA.md` 2026-11-09 已定机器维度 | 保留，但缺故事合同 |
| `/settings` | SettingsPage | SETTINGS | keep |
| `/agent-sessions/:id` | AgentSessionDetailPage | CONTINUE（导入会话） | keep |
| `/design` | DesignSystemPage | 非产品面 | 移出生产或 dev-only |

另有 `/approvals`、`/usage` 两条重定向和 `*` 兜底，已收口。

## 7. R0b · 执行

只执行表上签过字的行：

1. 删路由、导航入口、页面、测试、i18n 键、API 调用；同步清理 `web/dist` 的构建（只提交 `index.html`，不提交 `assets/`）。
2. Ionic 清尾：`main.tsx`、`Sidebar.tsx`、`SheetSelect.tsx`、`TaskDetailPage.tsx` 里的 `@ionic/react`；3 个 `IonActionSheet` 用现有 `Sheet` / `Menu` 替掉；删 `@ionic/core` / `@ionic/react` 依赖。
3. 文档同步：
   - 本文件补上签过字的表、证据和删除清单；
   - 更新 `docs/product/IA.md` 对应行；
   - 更新 `docs/product/stories/PLAN.md`（新增/收掉的面）；
   - 更新 `docs/product/components/README.md`（如果删了共享控件）；
   - 更新 `docs/plans/2026-11-08-design-system-middle-layer.md` §8 状态表。
4. 重新跑 `python3 scripts/ui_inventory.py`，把删除前后的数字写进本文件。

## 8. R0c · 收口

- `./scripts/check.sh`
- `cd ui && npm run build`
- `./scripts/smoke.sh`
- 390 / 1100 各一组存活面的截图（存 ignored 路径，不入库；作为 R1 的 before 基线）
- 高模型 review（按 `docs/product/LESSONS.md` 的协议：冻结树、mutants、一份报告、一次修复）
- Conventional Commit（`refactor(ui): ...` 或 `chore(ui): ...`），合入 `main`
- `./scripts/desktop-rebuild.sh`（UI 改了，必须重建；该脚本会重启 `:7777` 节点）

## 9. 开放问题（R0a 要给出答案）

1. `/projects` 和 `/projects/:id`：保留还是收进对话列表的设备→项目→对话？`IA.md` 说项目是 Hub 侧按 cwd 建立的遗留记录。
2. `/agents`：它是 Agent 运维/费用面，但六条故事里没有主人；补一条故事，还是并入 `/settings`？
3. `/routines`：`IA.md` 已定“属于机器”，但六条故事没覆盖；补合同还是保留为运维面？
4. `/design`：只在 dev 构建存在，还是生产也保留？它现在是“不在导航里的 token 画廊”。
5. `AgentModelPicker`：确认无引用后删除，还是还有隐藏入口？
6. 任何删除如果改变了用户流程（不只是删死面），就不是 R0 能决定的，要回到对应故事签字页，先画 Figma 帧。

## 10. 不要做

- 不要在 R0 签核前删任何页面或路由。
- 不要在 R0 里开始 G0.5 / Astryx 迁移；那是下一轮。
- 不要把“整理 UI”做成一次整站重写；diff >800 行就拆轮次。
- 不要用通用设计系统的整页模板替代 Kin 的 IA（设备 → 项目 → 对话；Mac/手机两种形态）。
- 不要让页面直接 import Astryx（如果以后采用）；只允许 `components/ui` 内部 import。
- 不要提交 `web/dist/assets/`。
- 不要凭印象删面；一切以 R0a 的证据表为准。

## 11. 现在的位置

| 项 | 状态 | 证据 |
|---|---|---|
| R0a 只读审计 | ⚪ 未开始 | 下一步：14 个产品面逐条查入口 / 测试 / API / i18n，出 `review.html` |
| R0b 删除 + Ionic | ⚪ 未开始 | 等 R0a 表签字 |
| R0c 收口 | ⚪ 未开始 | 等 R0b |

## 12. 下一会话

新会话从 **R0a** 开始，只读，不删代码。先读本文件和相关文档，产出 `2026-11-10-ui-surface-audit.review.html` 和归属表，给用户签；签完再进 R0b。

## 13. 阅读顺序

1. `AGENTS.md`（工作流、round 规则、完成门禁）
2. `docs/product/IA.md`（面归属和已签字决定）
3. `docs/product/TASTE.md`（16 条界面规则）
4. `docs/product/stories/PLAN.md`（六条故事）
5. `docs/plans/2026-11-08-design-system-middle-layer.md`（G0–G18、G0.5 决策门）
6. `docs/plans/2026-11-09-astryx-spike.md`（Astryx 实测，别重复调研）
7. `docs/product/components/README.md`（共享控件文档格式）
8. `scripts/ui_inventory.py`（测量口径）
