# 共享控件文档

`ui/src/components/ui/` 里的控件是跨页面复用的。页面能自己拼的，不算共享控件；
进了这个目录，就要有一份文档说明**它替谁做决定**。

格式借自 Astryx 的 `*.doc.mjs`（`packages/core/src/*/*.doc.mjs`，MIT）：每个
控件回答同样几个问题，顺序固定。这样人和 agent 读第二个的时候就知道该往哪看。

| 小节 | 回答什么 |
|---|---|
| 一句话 | 它是什么，什么时候用它 |
| 用它 / 别用它 | 具体到能照着做的判断 |
| 行为 | 宽度、弹出方向、关闭、焦点 |
| 键盘 | 每个键归谁 |
| 无障碍 | WCAG 条款 + 要求值 + 适用状态 |
| 平台差异 | Mac 和手机不是同一个形状时，差在哪 |
| 契约 | props、受控值、不变量 |

## 现有

- [SearchSelect](search-select.md) —— 可搜索的单选，长列表
- [SheetSelect](sheet-select.md) —— 不可搜索的单选，短列表
- [SessionFilters](session-filters.md) —— 对话列表的状态 / 范围过滤

## 新增一条的门槛

先回答“哪个已有控件长不出这个”（TASTE 第 13 条）。答不上来就是加变体，不是
加控件。答上来了，按上面的表写文档，和组件同一次提交。

## 还缺什么、按什么顺序补

现状盘点、抽取规则、轮次和判定标准在
[`../../plans/2026-11-08-design-system-middle-layer.md`](../../plans/2026-11-08-design-system-middle-layer.md)。
数字用 `python3 scripts/ui_inventory.py` 重新测量，不要手抄。
