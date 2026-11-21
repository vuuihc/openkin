# T3 对照与 RSI 质量重置

2026-11-21 · owner 问：T3 的质感很好，我们的自进化 RSI 到底在跑什么？CEO 为什么不从第一性原理做到最好？

## 现在的位置

- **绿**：合并吞吐 113/24h、453/7d（`python3 rsi/runtime/pace.py`）；390/1100(/1280) 的 walk、UX gate、mutant 证据、claim check 都在跑；今天 48 次合并里有 9 次是用户可见的 UX 修复；820 的两处遮挡和一个验收缺口已经写进 `docs/plans/gap-log.md`（2026-11-21 三条高）。
- **红**：owner 的 iPad 820×1180 不在任何旅程、合并门或 UX gate 的宽度里；`rsi/GOAL.md:3` 的 north star 是 T3，但 `pace.py` 的判决是 **NO-PHASE**；今天 48 次合并里约 27 次是 loop 自身的守卫/记账，9 次是产品 UX，10 次是测量/dogfood/journey，2 次是 gap-log 收尾；5 个开放 PR 里 3 个是 loop（#534 claims block、#535 dream phone line、#533 phone gap repro），2 个是 gap 修复（#528、#532）。
- **未验证**：T3 与 Kin 的差距没有分数；“质感”没有验收定义；820 的 long-answer/table 场景没有 walk；阅读面上常驻 chrome 的高度没有上限。

一句话：**RSI 不是没有在工作，它在高速维护自己；它把“合并”当成了产出，把“没有硬失败”当成了健康，把 owner 每天拿在手里的那块 820 屏留在了测量之外。**

## 证据 A：同一块 820×1180 屏幕

两张截图都是 1640×2360 = 820×1180 @2×，左栏约 295 CSS px，右栏约 520 CSS px。同一块屏幕，两个产品：

| 维度 | T3 | Kin（2026-11-21 截图） |
|---|---|---|
| 右栏头部 | 标题 + 副标题 + 5 个 44px 图标，一行 | 会话 tabs（~27px）+ 标题 + 7 个被压成 24–30px 的竖条 chips（`C [ 8 P… c τ l kin…`） |
| 阅读面上的常驻 chrome | 只有头部（~44px），下面是正文 | tabs + header + 用量条 + 改动文件条 ≈ 170 CSS px；再叠通知与 daemon banner 时约 270px |
| 正文 | “Worked for 1m 22s >” 折叠过程，然后 outcome → 拿到了什么 → 还需要改进的 → 现在的状态 → 记录链接 | 一张 5 行状态表；第一列窄到汉字逐字换行，最后两行被「有新进展」药丸压住，表格底边被 composer 截断 |
| 阅读面上的浮层 | 无 | 「有新进展」药丸漂在表格中段；composer 是浮层，正文在它后面被裁 |
| 列表 | 扁平线程列表 + 环境/项目过滤；一行标题 + 一行元数据；彩色 provider 徽标 + Done 状态 | 设备 → 项目 → 对话三层树 + 计数 + 每行 ⋯ + 两个「展开全部」+ 导入的会话（100）+ 加载更早 |
| 输入 | 一条 “Ask anything” + 加号 + 模型 chip + 麦克风 + 发送 | Claude Code · deepseek-v4.1-fl… · YOLO + 发送；上方还有 $921.819（账单）与 ±4522/−2570 的批量动作 |
| 颜色/字 | 一个选中底色、一个 accent；元数据弱化；正文 16–17px，行高松 | 多套状态色（绿/红/橙/蓝）、红色 banner、表格正文 14px 且对比度低；大量同权重的计数 |
| 触摸 | 图标 44px、行 ~47px、composer ~56px | 头部 chips 宽 24–30px，低于 44px 地板 |

T3 的具体线程/工作区名称不抄进仓库；这里只比较结构。

结论不是“T3 是浅色、Kin 是深色”。结论是 **T3 只保留当前这一件事需要的东西**：列表用来选，右栏用来读和发；其余状态按需出现。Kin 把“系统里存在什么”都铺在了阅读面上：用量、账单、改动文件、daemon 状态、队列、子代理、导入的会话。于是它看起来像一个监控台，而不是一个对话。

## 证据 B：RSI 今天在做什么

`rsi/state/STATUS.md`（15:12 FILL）与 `merged.log`：

- 今天 48 次合并。按 slug 粗分：**loop 守卫/记账 27**（18 条 lane/merge/rework/claim/gate/CI 守卫 + 9 条 phase/story 记账）、**用户可见 UX 10**、**测量/dogfood 9**、**gap-log 收尾 2**。
- 开放 PR 5 个：**loop 3**（#534、#535、#533）、**产品 2**（#528 两个同名项目标题、#532 `/new` composer 停靠）；两个都是 gap 修复，不是设计推进。
- 队列已空；三条 lane 全 idle；下一次 unblock 是 18:35 的 dogfood walk（§3b throttle）。CEO 的回答是 “no dispatch”，等下一次观察。
- `pace.py`：**NO-PHASE**；release HOLD（unshipped 1 < 5）。
- `decisions-pending.md` 今天 30+ 条：内存地板、claim 冲突、waiver、review shape、lane leftovers。CEO 的一天是调度，不是产品。

这不是说 loop 守卫没有价值。问题是比例和方向：**一条 25 分钟 / ≤$5 / ≲400 行的切片流水线，产出的是局部修复；它没有一条工作项叫“把 820 的阅读面做到 T3 那样”**。而 GOAL 的 north star 原文就是 “feels at least as good as T3 Code”。

## 为什么这不是能力问题，是适应度函数

CEO 不是不知道 T3。`GOAL.md` 写着 T3；`UX-RUBRIC.md` 写着 5 = T3。它做不到，是因为它每天被奖励的东西不是 T3：

1. **它测量 loop，不测量产品。** STATUS 的 Current position 先写 merges/rounds/rate；产品 delta 是最后一行。48 次合并是成绩，820 的截图不是。
2. **它把设计切成 25 分钟。** 一个有观点的阅读面需要一次连贯的取舍（删哪些 bar、哪些状态按需、列表要不要三层树）；切片契约把它拆成局部修复，每片都过门，整体不收敛。
3. **门是“可接受”，不是“最好”。** Rubric 的 3 = “fine at the default size, one awkward spot”，mean ≥3.5 就过；5 才是 T3。iPad 的压碎正好是 “one awkward spot”，而 820 不在 walk 里，所以它连被扣分的机会都没有。
4. **它看 390/1100(/1280)，不看 820。** `rsi/runtime/ux/journeys.json:3`、`rsi/MANDATE.md:19`、`rsi/runtime/ux-gate.sh:7` 都没有 820；owner 每天拿在手里的那块屏是盲区。
5. **它是反应式的。** 队列由 gap log 和 ledger shape 喂养；队列一空就等下一次 dogfood。它不生成“下一个产品命题”。
6. **它没有 phase。** `pace.py` 判 NO-PHASE。CEO 自己的 watch #58 说 “A phase with nothing queued is not a plan”；今天 48 次合并没有 phase，这是管理事故，不是 deliberate。

一句话：**它被优化成了一个高吞吐的调度器，而不是一个有品味的产品负责人。** 一个第一性原理的 CEO 会先问“这块屏上的人在做哪一件事，最好的产品长什么样，我们在哪个宽度上量它”，再问“今天能 dispatch 什么”。

## 重置：P16「T3 质感的阅读面」

建议在 `GOAL.md` 开一个新 phase（当前没有 phase，正是开的时候）：

```html
<!-- phase: P16-t3-reading target=2026-11-28T20:00 -->
```

**一个句子**：在 390 / 820 / 1100 三个宽度上，把“读一条真实回答并继续”做到 T3 的清晰与克制；820 是 owner 的日常设备，先过。

**五个场景（一个 story，一次交付）**：

1. **列表**：820 打开时，一屏能扫到 ≥10 条对话；一行标题 + 一行元数据；设备/项目层级保留但默认折叠；没有两个「展开全部」同权。
2. **阅读**：长回答 + 4 行表格；正文上方只保留 ≤44px 的 header；表格第一列不逐字换行；最后一行完整可读；没有浮层压字。
3. **输入**：composer 固定在底部并占布局；跑动中发送/打断/排队都在一个 composer 里完成；不再有第二条输入路径。
4. **状态按需**：用量/账单、改动文件、daemon 状态、子代理计数都从常驻 bar 收进 header 的一个入口或按需面板；阅读面默认不出现。
5. **失败/离线**：一条 banner 说明状态，内容不消失；恢复后 banner 自己走；没有红色块永久占位。

**验收（可写成测试）**：

- `journeys.json` 增加 `tablet: 820x1180`（`hasTouch`）；新增 J-tablet walk，固定 seed 一段长回答 + 表格；截图存 `rsi/state/shots/<slug>/`。
- 820 下：header 动作 ≥44×44 且无半个字形；`document.elementFromPoint` 命中表格每个可见单元格中心都返回单元格；正文上方常驻 chrome ≤44px（不含只在失败时出现的 banner）。
- UX 评分在 clarity / density / consistency 三维 ≥4（5 = T3），不是 mean ≥3.5；820 的截图必须在 PR body 里。
- `rsi/MANDATE.md:19` 的合并门从 390/1100 改为 390/820/1100；`ux-gate.sh` 同步。

**Queue seeds（按顺序，一次一行）**：

1. `R-tablet-walk`：820 viewport + J-tablet + 截图/断言接线（测量先行）。
2. `R-reading-chrome`：用量/改动文件/daemon 收进 header 入口，阅读面只剩 header + 正文 + composer。
3. `R-header-cluster`：820 动作区 `flex-none` / 动作表，44px 地板（gap 2026-11-21 第一条）。
4. `R-new-activity-lane`：药丸占一条非内容通道，不压表格（gap 第二条）。
5. `R-table-measure`：表格首列 `nowrap` 或最小宽度，正文 measure 上限；长表格可横向滚动。
6. `R-list-scan`：820 列表一行一条、层级默认折叠、去掉重复的「展开全部」。

**流程改动**：

- STATUS 增加一行 **product delta**：今天用户能看到的一个变化 + 390/820/1100 的前后截图；merges 降为成本行。
- CEO 每周一次 **T3 teardown**：一个面，写“他们怎么做 / 我们怎么做 / 为什么”，产出一个 story，而不是 25 分钟切片。
- 允许 **coherent design pass** 用满 800 行（MANDATE 的合并上限），不再拆成三片 400 行。
- **NO-PHASE 不许连任**：队列空时，CEO 的下一个动作是开 phase / 写 story，不是等 18:35。

## 不做的事

- 不再加 bar、badge、banner 来解决“状态看不见”；先删后加（TASTE 7）。
- 不把 820 的缺陷用 fade、ellipsis、`overflow:hidden` 盖住；截图里能看见的，测试要能命中。
- 不用 `mac-wide: 1280` 冒充平板；820 是 820。
- 不把 “48 merges today” 当成绩写进对外汇报；它是成本。
- 不在没有 story / 没有 820 前后截图的情况下改阅读面。

## 下一步（按顺序）

1. **Owner**：确认是否按 P16 的五个场景重置；如果只想先修 820 的三处，回复“先修 820”，按第 3/4/5 条先做。
2. **CEO**：在下一个 pulse 把 `<!-- phase: P16-t3-reading ... -->` 写进 `GOAL.md`，把 `R-tablet-walk` 作为第一行；在此之前不再 dispatch loop 基础设施。
3. **本文件**：作为 story 的 brief 底稿；下一步用 `python3 scripts/stories.py new QUALITY "T3 质感的阅读面（820 先行）"` 起 story，按 AUTHORING 写 review page；签字前不写产品代码。

## 验收与回退

- 本文件是 docs-only；不改产品代码、不改 GOAL 的 phase marker（等 owner/CEO 确认）。
- 如果 P16 的方向被否，回退是删掉本文件与对应的 gap 条目；已修的 820 缺陷不受影响。
- 下一次对照用同一块 820×1180 截图与同一张表；分数和截图一起进 PR，不从记忆里引用。
