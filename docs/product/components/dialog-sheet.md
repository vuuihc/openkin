# Dialog

**桌面模态。** 由原生 `<dialog>` 承载，焦点困在层内，关闭按用途分级。
手机上的底部面板仍然是 `Sheet`，两者的形状和生命周期不在这里合并。

## 用它 / 别用它

用它：

- 桌面上必须打断当前任务的一件事：改设置、确认危险操作、填一小段表单。
- 需要浏览器顶层（top layer）语义：页面其余部分不可点，读屏只读这一层。
- 已经有触发按钮、关掉后要回到它（或调用方指定的控件）的流程。

别用它：

- 手机上的编辑 / 选择流程 → 用 `Sheet`。它拥有历史记录条目、下滑关闭和安全区，
  这些是产品契约，不是样式。
- 贴着触发点的选择器 → 用 [SearchSelect](search-select.md) 或
  [SheetSelect](sheet-select.md)。选择器弹出来，不要把容器撑大（TASTE 第 14 条）。
- 页面跳转或整页内容 → 用路由。模态不是导航。

## 行为

- **受控。** `open` 由调用方持有；`onOpenChange` 只是“请求关闭”。Escape、背景点击、
  标题栏的关闭按钮都走这一个回调。调用方可以拒绝（例如未保存的表单），层不会自己关。
- **用途决定退路。** `info` 允许 Escape 和背景点击；`form` 只允许 Escape，背景点击
  不算；`required` 两者都不允许，也没有关闭按钮——出路只有调用方渲染的动作。
- **焦点进入与归还。** 打开时焦点落到标题（读屏先读名字），关闭后回到
  `finalFocusRef`，没传就回到打开前聚焦的元素。归还发生在 `<dialog>` 真正关闭之后。
- **宽度。** `width` 是建议宽度，默认 400。窄视口由 Astryx 用间距 token 收边。
- **不拥有历史记录。** 桌面模态不 push 历史条目；手机的回退手势属于 `Sheet`。
  桌面上按系统 Back 不会关闭它，这是平台差异，不是缺陷。
- **没有新流程。** 不发明尺寸、步骤或确认链；标题就是 `label`，页脚就是 `footer`，
  其余内容由调用方组合。

## 键盘

| 键 | 归属 |
|---|---|
| Tab / Shift+Tab | 在层内循环：最后一个之后回到第一个，第一个之前回到最后一个 |
| Escape | `info` / `form` 请求关闭；`required` 忽略 |
| 输入法组合中的 Escape | 属于输入法，不关闭（`isComposing` 与 `keyCode 229` 都拦） |
| 关闭按钮 | 原生 button，可 Tab 到；Enter / Space 触发 |

背景点击不是键盘路径：指针的按下与抬起都落在背景上才算数。

## 无障碍

| 项 | 条款 | 要求 | 状态 |
|---|---|---|---|
| 名称 | 4.1.2 | `label` 同时是可见标题和无障碍名称 | 全部 |
| 模态语义 | 4.1.2 | `aria-modal="true"`，页面其余部分 inert | 打开 |
| 层角色 | 4.1.2 | `dialog`（`info` / `form`）；`required` 为 `alertdialog` | 打开 |
| 初始焦点 | 2.4.3 | 打开后焦点在标题上，Tab 从标题进入控件 | 打开 |
| 焦点归还 | 2.4.3 | 关闭后回到触发控件或 `finalFocusRef` | 关闭 |
| 焦点可见 | 2.4.7 | 键盘聚焦时显示 token 化的 focus ring | 全部 |
| 触控目标 | 2.5.8 | 关闭按钮在粗指针下由 Astryx 扩到 44px | 触屏 |

## 平台差异

| | Mac | 手机 |
|---|---|---|
| 表面 | 居中模态，原生 `<dialog>` | 仍是 `Sheet` 的底部卡片 |
| 关闭 | Escape / 背景 / 关闭按钮，按 `purpose` 分级 | Escape、下滑、历史回退 |
| 历史 | 不新增条目 | Sheet 自己 push 一个条目 |
| 安全区 | 普通视口 | 由 Sheet 处理 |

`Sheet` 计划在 F5c2 里换到 Astryx 的 `BottomSheet` 上，公共 API 和测试不变。
在那之前，手机用户看到的仍然是现在的 Sheet；本组件只服务桌面调用方。

## 契约

```ts
type DialogProps = {
  open: boolean;                    // 受控
  onOpenChange: (open: boolean) => void;  // 请求关闭，不是命令
  label: string;                    // 可见标题 + 无障碍名称
  children: ReactNode;
  footer?: ReactNode;               // 动作行，由调用方组合
  purpose?: "info" | "form" | "required"; // 默认 info
  width?: number | string;          // 默认 400
  finalFocusRef?: RefObject<HTMLElement | null>;
  className?: string;               // 只加在表面，不改形状与关闭策略
};
```

不变量：组件永远不自己改 `open`；`required` 没有关闭按钮，Escape 与背景点击都被吞掉；
关闭后的焦点目标是 `finalFocusRef.current`，其次才是打开前的焦点。
