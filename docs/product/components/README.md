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

- [Button](button.md) —— 一个动作，页面上所有按钮的唯一起点
- [Tabs](tabs.md) —— 同一层里并列内容的切换，含三到五选一的分段按钮
- [RadioGroup](radio-group.md) —— 内联的分段单选，三到五个互斥值一行看全
- [Dialog](dialog-sheet.md) —— 桌面上打断当前任务的模态，退路按用途分级
- [Popover](popover.md) —— 受控、按视口定位的通用浮层，菜单和选择器长在它上面
- [Menu](menu.md) —— 贴着触发点的动词列表或一小组单选
- [SheetSelect](sheet-select.md) —— 不可搜索的单选，短列表
- [SearchSelect](search-select.md) —— 可搜索的单选，长列表
- [ActionSheet](action-sheet.md) —— 手机上的动作列表 / 单选面板
- [SessionFilters](session-filters.md) —— 对话列表的状态 / 范围过滤
- [Toast](toast.md) —— 浮在页面底部的一行即时结果
- [Tooltip](tooltip.md) —— 贴着触发点、只读的一句说明
- [PendingBadge](pending-badge.md) —— 行尾“等你处理”的计数标记，不是按钮

## 新增一条的门槛

先回答“哪个已有控件长不出这个”（TASTE 第 13 条）。答不上来就是加变体，不是
加控件。答上来了，按上面的表写文档，和组件同一次提交。

## 还缺什么、按什么顺序补

现状盘点、抽取规则、轮次和判定标准在
[`../../plans/2026-11-08-design-system-middle-layer.md`](../../plans/2026-11-08-design-system-middle-layer.md)。
数字用 `python3 scripts/ui_inventory.py` 重新测量，不要手抄。
