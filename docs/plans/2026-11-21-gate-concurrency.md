# Gate 并发测量 — 三条并行验证到底贵多少

## 现在的位置

**已测量。** 数据来自控制树的 `rsi/state/merge/cycles.log`，测量时刻
2026-11-21 04:18，机器 `uptime` 负载 `7.04 7.92 7.46`（其它车道正在跑，这正是被测
场景）。`merge.sh` 未改，本交付只增加测量与文档。

| 项目 | 状态 |
|---|---|
| `pace.py --concurrency` | green — `concurrency_split()`，新 flag，默认输出逐字节不变 |
| 六个用例 | green — `bash rsi/runtime/tests/test-pace.sh` 全部 PASS |
| 三个 mutant | green — `python3 scripts/mutants.py rsi/runtime/tests/pace-concurrency.mutants.json`，3/3 red |
| 24h / 7d 实测表 | green — 下面两张表，命令见 `## 方法` |
| `merge.sh` / `gate.sh` | 未改 — 建议只写在这里，由 CEO 决定 |

**一句话结论：并发 ≥3 确实更贵（24h p50 从 5m 升到 12m，p90 从 8m 升到 22m），
但 7d 内所有完成的验证运行最大只有 33m；记录里的“75 分钟”没有出现在任何
`verify=` 行上，所以现有数据支持“第三条槽用约 2 倍 p50 换队列深度”，不支持
“三条并行把单条 gate 拖到 75 分钟”。**

### 24h（runs=142 bucketed=107 cached=35）

| level | n | p50 | p90 | max | small | medium | large | unknown |
|---|---|---|---|---|---|---|---|---|
| 1 | 41 | 5m | 8m | 11m | 22 | 9 | 10 | 0 |
| 2 | 26 | 10m | 16m | 28m | 11 | 5 | 10 | 0 |
| 3 | 32 | 12m | 22m | 32m | 13 | 4 | 15 | 0 |
| 4 | 7 | 20m | 25m | 25m | 2 | 3 | 2 | 0 |
| 6 | 1 | 23m | 23m | 23m | 1 | 0 | 0 | 0 |

### 7d（runs=812 bucketed=632 cached=180）

| level | n | p50 | p90 | max | small | medium | large | unknown |
|---|---|---|---|---|---|---|---|---|
| 1 | 295 | 4m | 7m | 20m | 106 | 77 | 106 | 6 |
| 2 | 220 | 5m | 14m | 29m | 79 | 59 | 77 | 5 |
| 3 | 90 | 9m | 17m | 32m | 31 | 22 | 37 | 0 |
| 4 | 22 | 17m | 27m | 33m | 8 | 6 | 8 | 0 |
| 5 | 3 | 16m | 26m | 26m | 1 | 1 | 1 | 0 |
| 6 | 2 | 23m | 23m | 23m | 2 | 0 | 0 | 0 |

来源记录（2026-11-20 10:45）说的是“同时开三条验证时，单条 gate 从 5–9 分钟变成
75 分钟”。本次测量复现了前半段（level 1 p50 5m，level 3 p50 12m），没有复现
75 分钟；见 `## 局限` 的 PASS-only 偏差。

## 方法

对 `cycles.log` 里每条 `verify=NNm`：

- 该运行结束于行首分钟 `T`，占据区间 `[T - NN, T]`。区间来自 verify 行，所以包含
  gate 锁等待、review、sync 和 CI，而不只是 gate 那一段。
- **level** = 1 + 其它 `gate=ran` 且 `NN > 0` 的运行中，区间与本运行**完整区间**
  相交的条数。相交判定是 `start2 < end and end2 > start`；端点相接（前一条结束的
  同一分钟里后一条开始）不算重叠。
- `gate=cached` 与 `verify=0m` 的运行不进入时长桶，计入 `cached`；因此
  `bucketed` 只数 `gate=ran` 且 `NN > 0`，`runs = bucketed + cached`。
- 每个运行的 tier 取自**同一 PR、日志顺序上位于该 verify 行之前**的最后一条
  `verifier_started`；没有就记 `unknown`。按日志顺序而不是只按时间戳配对，是因为
  同一分钟里既有上一条 verify 行又有下一条 start 行；这是分钟分辨率下的取舍。
- 窗口与 `--latency` 相同：24h 与 7d，按 verify 行所在分钟过滤；每个 level 按升序
  输出，空 level 省略。

命令（只读本地日志，不联网）：

```bash
python3 rsi/runtime/pace.py --state <control tree>/rsi/state --concurrency
python3 rsi/runtime/pace.py --state <control tree>/rsi/state --concurrency --json
```

不带 flag 时的输出与旧版逐字节相同；`--latency` 的输出也逐字节相同（两者都在
真实日志上用 `HEAD` 版本对拍过）。JSON 只在带 flag 时增加一个顶层
`concurrency` 键：`resolution_min`、`24h` 与 `7d`，每个窗口含
`runs` / `bucketed` / `cached` / `levels[]`。

本文的中心句，也是 PR body claim-check 的那一句：

> `pace.py --concurrency` buckets each completed gate run by how many other runs
> overlapped its whole interval, excludes cached runs from the duration table,
> and reports the tier mix.

它对应的实现符号是 `rsi/runtime/pace.py` 里的 `concurrency_split()`，由
`bash rsi/runtime/tests/test-pace.sh` 的六个 `concurrency-*` 用例证明。

一个容易误读的点：**level 不是“几个槽在跑”**。一个 30 分钟的长运行，被两个先后
开始的 5 分钟短运行各覆盖一次，它的 level 就是 3，即使任意时刻最多只有两条在跑。
这也是 level 3 里 large 占 15/32 的原因。level 度量的是区间重叠，不是槽占用。

## 局限

- **分钟分辨率。** 时间戳只有分钟，同一分钟内的先后无法区分；端点相接按不重叠
  处理，可能把真实的 1 分钟重叠算成 0。
- **`verify=` 只在 PASS 后写入。** FAIL、锁超时、被取消的运行完全不可见。所以
  “75 分钟”事件要么落在失败/超时路径上，要么不是一个完成的 verifier；本测量对
  它没有证据。同理，正在飞的运行也不在表里。
- **区间不是 gate 单独耗时。** `[T-NN, T]` 包含 gate 锁等待、gate、review、sync
  与 CI；level 之间的 p50 差不能解释成“锁本身慢了 7 分钟”。
- **重叠是相关性，不是对照实验。** 没有随机分配、没有同一批 PR 的 A/B；测量时
  机器负载 7.04，且三个 level 的 tier 组合不同。level 3 更慢可能部分来自“当时
  本来就有大 PR”。
- **cached 运行不参与时长。** 24h 的 35/142、7d 的 180/812 条 verify 行只计入
  `cached`；它们会让 `runs` 大于 `bucketed`，这是设计而非丢数据。
- **level 4–6 超出当前 3 槽配置。** 24h 有 8 条、7d 有 27 条落在 level ≥4。区间
  重叠不等于槽计数，可能是分钟取整、槽释放与 verify 写入不同步，或窗口内配置
  变过；本测量不区分这些原因。
- **窗口边缘。** 只按 verify 行所在分钟过滤，区间起点可以早于窗口边界；跨边界的
  另一半不参与重叠计算。

## 建议

**保持现状：`MERGE_WORKERS=2` + `SMALL_SLOTS=1`（最多三条）。**

理由是数据而非偏好：level 3 的 p50 只比单跑贵 7 分钟（5m → 12m），远小于记录里的
75 分钟；gate 是机器级单锁，第三条槽买到的是 sync/review 与队列深度，不是 gate
吞吐；而 small 槽正是为了避免小改动排在两个大 review 后面。代价是真实的：level 3
的 p90 是 22m（单跑 8m），24h 里 32/107（30%）的完成运行落在 level ≥3，尾部会继续
存在。

如果 CEO 更在意尾部而不是队列深度，一行 follow-up 是
`RSI_MERGE_SMALL_SLOTS=0`（纯配置，不改 `merge.sh`），然后用同一条命令复测。注意
它只能减少、不能消除 level 3：两个先后开始的短运行覆盖一个长运行同样会记 level 3。

本交付不改 `merge.sh` / `gate.sh`；上面的建议和 follow-up 留给 CEO 决定。

## 不证明什么

- **改配置之后的线上行为。** 没有做 before/after，也没有在真实调度里关掉第三条槽
  复测；`RSI_MERGE_SMALL_SLOTS=0` 的效果是预测，不是测量。
- **失败路径。** FAIL、锁超时、rework 等待没有 `verify=` 行；它们的时间成本不在
  任何一张表里，包括那条 75 分钟的记录。
- **队列深度与吞吐。** 表里只有单条运行的完成时长，没有“每天多合几个 PR”的证据；
  去掉一条槽是让队列更短还是更长，本测量不回答。
- **按 agent / 模型拆分。** 日志只记 tier（small/medium/large），不记执行者；不能
  说某个 agent 的 gate 更慢。
- **因果。** 重叠与更慢同时出现，但本测量没有做随机化，不能断言重叠单独造成了
  全部差值。
