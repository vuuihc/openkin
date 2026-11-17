# Tabs

**一条标签带。** 在同一层里切换几块并列的内容：打开的对话、设置的分区、终端
会话、工作区的四个面板。Kin 持有受控的 `value` / `onChange` 和键盘模型，Astryx
的 `TabList` / `Tab` 持有表面和标签元素。

## 用它 / 别用它

用它：

- 同一层里的并列内容块（对话、设置分区、终端、工作区面板）。
- 三到五个并列内容块的切换（`segmented`，TASTE 5）：选中项决定显示哪一块内容，
  不是选一个值（选值用 `RadioGroup`）；可关闭、可重排的标签。

别用它：

- 页面之间的导航（地址栏和区域导航的事，TASTE 12）或没有“当前选中”的按钮组。
- 需要搜索、分组的选项；浮层里的命令列表（那是第二层，TASTE 16）。

## 行为

- **受控，一个 Tab 停点。** `value` / `onChange` 由调用方持有；选中的标签是带里
  唯一进 Tab 顺序的，没有选中项时第一个可用标签拿到停点。
- **方向键回绕。** 左右方向键走一步并回绕，跳过 `disabled`；`Home` / `End` 到
  两端。方向键在捕获阶段处理：Astryx 的标签也可能响应方向键，两层各动一次会
  一次按键跳两格。
- **Delete 关闭。** 只在 `closeable` 且给了 `onClose` 时；焦点交给接替它的邻居
  （右边的，删的是最后一个时取左边的），因为持有焦点的按钮正在被移除。
- **Alt+方向键移动标签本身。** `onMove(id, ±1)` 调一次，焦点留在同一个标签上；
  重排不移动读者。普通方向键移动的是“当前是哪个”，Alt+方向键移动的是“它排在哪”。
- **状态标记说人话。** `mark` 里的文字（`role="img"` 的 `aria-label`，或隐藏的
  文字节点）会拼进标签的无障碍名称：屏幕阅读器听到“Build the parser, waiting”，
  不是看到一个没有名字的小圆点（TASTE 18）。
- **不是浮层。** 不声明 menu / dialog 角色，不改变 `overlayOwnsKeyboard`。
- **实现边界。** `tabs` 变体走 Astryx `TabList` + `Tab`。`segmented` 复用同一条
  路径、换一套表面样式：`SegmentedControl` 的子项 API 在拆分时无法在本机核对
  （NAS 无 `node_modules`），所以不接猜出来的组件名。

## 键盘

| 键 | 归属 |
|---|---|
| Tab / Shift+Tab | 走进 / 离开这条带；带内只有一个停点 |
| ArrowRight / ArrowLeft | 选中并聚焦下一个 / 上一个可用标签，回绕 |
| Home / End | 第一个 / 最后一个可用标签 |
| Delete / Backspace | 关闭当前可关闭标签，焦点交给邻居 |
| Alt+ArrowRight / Alt+ArrowLeft | 把当前标签右移 / 左移一位，焦点不离开 |
| Enter / Space | 由标签自身的点击语义选中；`disabled` 的标签不响应 |

## 无障碍

| 项 | 条款 | 要求 | 状态 |
|---|---|---|---|
| 标签带名称 | 1.3.1 | 标签带角色 + `aria-label`（调用方的可见名称） | 全部 |
| 选中状态 | 4.1.2 | `aria-selected` 由 `value` 决定 | 全部 |
| 禁用状态 | 4.1.2 | `aria-disabled="true"`，且不在 Tab 顺序里 | 有禁用项 |
| 状态不只靠颜色 | 1.4.1 / TASTE 18 | 标记的文字进入标签的无障碍名称 | 有标记 |
| 关闭控件名称 | 4.1.2 | `tabs.close`（“关闭 {name}”） | 可关闭 |
| 触控目标 | 2.5.8 | 标签行与关闭控件在手机上 44px；桌面关闭控件 24px | 手机 |
| 焦点可见 | 2.4.7 | 沿用控制台的焦点环令牌 | 全部 |

## 平台差异

Mac 与手机同一个形状：横向滚动的标签带，不换成下拉或底部面板；手机上标签行与
关闭控件抬到 44px 触控地板。

## 契约

```ts
export type TabItem = {
  id: string;
  label: string;
  icon?: ReactNode;
  /** 状态点/徽标；它的文字必须进入标签的无障碍名称（TASTE 18）。 */
  mark?: ReactNode;
  closeable?: boolean;
  disabled?: boolean;
};

export type TabsProps = {
  items: TabItem[];
  value: string;
  onChange: (id: string) => void;
  onClose?: (id: string) => void;
  onMove?: (id: string, delta: -1 | 1) => void;
  variant?: "tabs" | "segmented";
  ariaLabel: string;
  className?: string;
};
```

不变量：`items` 的顺序即显示顺序；`value` 不在 `items` 里或指向禁用项时，第一个
可用标签拿停点；组件不读写存储，12 条上限、缓存和面板切换都属于调用方。
