# Tooltip

**贴着触发点的一句说明。** 鼠标悬停或键盘聚焦后，在触发点上方或下方出现一段
只读文字；它描述触发点，不抢焦点、不接管键盘。Astryx `Tooltip` 持有浮层、定位
和工具提示角色，Kin 持有延迟、方向和 `disabled` 的含义。

## 用它 / 别用它

用它：

- 一个图标的名称、一个动作的一句话解释，或快捷键提示。
- 被截断名称的完整文本。

别用它：

- 需要点、选、输入的内容。那是 `Popover`、`Menu` 或 `Sheet`。
- 唯一的错误说明或必填提示（必须常驻，WCAG 1.4.13）、手机上的主要操作，
  或一段长文。工具提示是一句话，不是帮助面板。

## 行为

- **触发。** 悬停或聚焦后等 `delay` 毫秒出现；离开即消失。
- **Escape 关闭，焦点不动。** 关闭的是说明，不是读者所在的控件；下一键仍归触发点
  （TASTE 16）。
- **描述而不是命名。** 触发点通过 `aria-describedby` 指向内容：屏幕阅读器先读
  名字，再读说明。说明不塞进 `aria-label`，那会替换掉名字。
- **`disabled` 是“什么都不渲染”。** 不出现空泡，不留下指向不存在内容的
  `aria-describedby`，也没有隐藏的 live region。
- **触屏轻点。** 粗指针下由 Astryx 的 `touchTrigger="tap"` 处理：轻点触发点即打开说明，
  不是长按。如果轻点已被触发点的动作占用，这条说明就不该是唯一入口。
- **不是浮层。** 工具提示角色不在 `overlayOwnsKeyboard` 的层名单里；它不接收
  指针事件、不持有焦点，也不改变快捷键归属。
- **实现边界。** 这一版是 Astryx `Tooltip` 的薄映射：`content`、`placement`、
  `delay`、`isEnabled`、`focusTrigger`、`touchTrigger`。其余参数不进入公开 API。

## 键盘

| 键 | 归属 |
|---|---|
| Tab / Shift+Tab | 聚焦 / 离开触发点；聚焦即显示说明 |
| Escape | 关闭说明，焦点留在触发点 |
| 其余按键 | 归触发点所在的层；工具提示不拦截 |

## 无障碍

| 项 | 条款 | 要求 | 状态 |
|---|---|---|---|
| 说明关联 | 1.3.1 / 4.1.2 | `aria-describedby` 解析到工具提示的内容 | 显示时 |
| 键盘可达 | 2.1.1 | 每个悬停说明也有聚焦路径 | 全部 |
| 可关闭 | 1.4.13 | Escape 关闭，不移动焦点 | 显示时 |
| 可悬停 | 1.4.13 | 指针可以移到说明上而不消失 | 显示时 |
| 不是唯一信息源 | 1.4.13 | 错误与必填说明不放在工具提示里 | 全部 |
| 对比度 | 1.4.3 | 说明文字 ≥4.5:1；Astryx 主题令牌 | 全部 |

## 平台差异

- **Mac。** 悬停为主，聚焦同样触发；`placement="above"` 是默认。
- **触屏。** 没有悬停；Astryx 的 `touchTrigger="tap"` 把轻点当打开手势：按压本身不打开，
  抬起后的 `click` 才算。触摸目标仍由触发点负责（≥44px，TASTE 11），工具提示不扩大它。

## 契约

```ts
export type TooltipProps = {
  content: ReactNode;
  /** 触发点，必须能接收 ref。 */
  children: ReactElement;
  placement?: "above" | "below";
  delay?: number;
  disabled?: boolean;
};
```

不变量：`children` 是单个元素且能把 ref 交给浮层；`content` 只读、不含交互控件；
`disabled` 时返回触发点本身，不新增 DOM 包裹；不渲染 dialog / menu 角色。
