# Popover

**受控、贴着触发点的通用浮层。** 一块由调用方排版的内容，挂在触发点旁边，
portal 到 `<body>` 并按视口坐标定位。它只拥有层本身的行为——外部关闭、
Escape、焦点进出、Tab 收束；菜单、选择器和自定义面板都长在它上面。

## 用它 / 别用它

用它：

- 一个触发点旁边需要一块自定义内容：一段表单、几行说明，或“搜索框 + 分组 +
  行”这种要自己排版的组合。
- 触发点所在的条带会裁剪绝对定位面板时——面板用视口坐标定位，不受祖先
  `overflow-*` 影响（TASTE 第 14 条）。
- 内容里还要开一层由调用方自己搭的浮层，需要把它的 DOM 声明成本层的范围
  （`pointerReach`）。

别用它：

- 一排动词或一小组单选 → [Menu](menu.md)。角色、方向键、字母跳转、选中关闭
  都已经在那里。
- 需要搜索的长列表 → [SearchSelect](search-select.md)；两到八个固定选项 →
  [SheetSelect](sheet-select.md)。
- 手机上的动作列表或单选面板 → [ActionSheet](action-sheet.md)。底部升起的
  形状属于 `Sheet`，桌面浮层不会在这里变成底部面板（TASTE 第 3 条）。
- 一句话说明 → [Tooltip](tooltip.md)；必须打断当前任务的模态 →
  [Dialog](dialog-sheet.md)。
- 只有一个动作、能直接放在行里 → 不要为了统一再藏一层（TASTE 第 7 条）。

## 行为

- **受控。** `open` 由调用方持有，触发按钮的点击和 `aria-expanded` /
  `aria-controls` 也归调用方。`onOpenChange(false)` 只在外部指针按下或
  Escape 时调用；挂载时从不调用，面板内部的点击也不会调用。
- **借触发点的 ref。** `triggerRef` 是调用方已经为触发按钮持有的那个 ref，
  primitive 不包裹触发点、不新增 DOM 外壳，也不改变它的布局尺寸。
- **挂到 `<body>`，按视口测量。** 面板是 `fixed`，定位由 `useAnchoredPanel`
  在 layout effect 里完成，第一帧就已经在位；窗口 resize、捕获阶段的 scroll、
  手机可视视口的变化和触发点自身的尺寸变化都会重新测量。
- **`placement` 是偏好。** 首选一侧能完整显示面板的实测内容时就留在那一侧；
  显示不下时去空间更大的一侧，一样大时留在首选。120px 只是面板挂载前、还
  没得可测时的粗判（首选一侧不足 120px 且另一侧更宽才翻），挂载后的测量会
  把它覆盖掉。`align` 决定面板与触发点的哪条边对齐，越界时被 8px 的视口
  边距夹住。
  `width` 省略时取触发点的实测宽度，再被 `maxWidth` 和视口宽度夹一次；
  `maxHeight` 默认 360，再按展开一侧的实际空间收窄，超出部分由面板自己滚动。
- **`padded` 是形状开关。** 面板默认带 `p-1.5`。基础内边距在编译后的样式表里
  排在调用方的 `p-0` 之后，所以调用方关不掉它；要自己画通栏头 / 脚的行
  （`BranchPicker`、`PlacePicker`）显式传 `padded={false}`。
- **`pointerReach` 只管指针。** 它接受一个选择器，目标命中的祖先算作本层
  范围。调用方在内容里开了 primitive 不认识的浮层时，用它的标记避免“按在
  自己层里却被判成外部”而提前卸载面板。Escape 仍按焦点链判断，别处的按键
  不会关掉这层。
- **焦点等锚点。** 面板在 `open` 变真后的下一渲染才 portal 出来，所以焦点
  进入看的是锚点是否测完，不是 `open`。第一个可用的停点拿焦点；内容自己
  放了焦点（`autoFocus`、按当前选项打开）就不抢；没有可停的内容时面板自己
  拿（`tabIndex={-1}`）。
- **一层一次 Escape。** 只有焦点在本层链里时才响应（TASTE 第 16 条）。
  嵌套时焦点链里最深的那层拿这次按键，与 document 监听器的注册顺序无关；
  即使焦点停在父层自己的标题上，最后打开的子层也先关。关闭后焦点回触发点
  （`preventScroll`），否则下一次 Tab 从文档开头开始。
- **关闭即清理。** 面板只在 `open` 为真时存在；关闭时层注册表和两个
  document 监听一起移除，之后的按键不再到达这一层。
- **一个层，不是第四个浮层。** `Menu`、`SearchSelect` 的桌面形状都长在它上面；
  新内容优先复用这一层，不另写一套定位、外部关闭和焦点逻辑（TASTE 第 13 条）。
- **不拥有**方向键行导航、领域选项、数据加载和手机底部面板——这些分别属于
  `Menu`、调用方和 `Sheet`。

## 键盘

| 键 | 归属 |
|---|---|
| Escape | 本层：焦点在本层链里才响应；最深的一层拿这次按键；关闭后焦点回触发点 |
| 输入法组合中的 Escape | 属于输入法，不关闭（`isComposing` 与 `keyCode 229` 都拦） |
| Tab / Shift+Tab | 在面板内循环：最后一个之后回第一个，第一个之前到最后；跳过不能真正接收焦点的控件 |
| 方向键 / Home / End / 字母键 | 归面板里的内容；`Popover` 自己不拦截 |

## 无障碍

| 项 | 条款 | 要求 | 状态 |
|---|---|---|---|
| 层名称 | 4.1.2 Name, Role, Value | `role="dialog"`，名称取 `label`（调用方的可见标签） | 打开 |
| 焦点进入 | 2.4.3 Focus Order | 焦点落在第一个可用停点；内容自己放的焦点不被覆盖 | 打开 |
| 焦点归还 | 2.4.3 | Escape 关闭后回触发点 | 打开 |
| 不被困住 | 2.1.2 No Keyboard Trap | Tab 在层内循环，Escape 是标准出口 | 打开 |
| 隐藏控件 | 2.4.3 / 2.4.7 | 焦点跳过隐藏、`display: none` 祖先、`inert` 或 `tabIndex < 0` 的控件 | 打开 |
| 可见焦点 | 2.4.7 | 面板本身不是停点（`focus:outline-none`）；可见焦点环由面板内的控件负责 | 打开 |
| 点按区 | 2.5.8 Target Size | 不适用：面板不是目标；44px 地板由里面的控件各自承担 | 手机 |

## 平台差异

| | 手机 | Mac |
|---|---|---|
| 形状 | 仍是贴着触发点的浮层，宽度被视口夹住 | 贴着触发点的浮层 |
| 单选 / 动作 | 用 `Sheet` / `ActionSheet` 的底部面板，不是把 `Popover` 拉到底部 | 用 `Popover` / `Menu` |
| 关闭 | 外部 `pointerdown`（含触摸）与 Escape | 外部指针与 Escape |
| 点按区 | 面板内控件各自 44px，面板本身不扩大它 | 内容按桌面密度 |

## 契约

```ts
export type PopoverProps = {
  open: boolean;                              // 受控
  onOpenChange: (open: boolean) => void;      // 外部指针 / Escape；挂载时不调用
  triggerRef: RefObject<HTMLElement | null>;  // 借用，不包裹
  label: string;                              // 层的可访问名
  id?: string;                                // 面板 id，供触发点的 aria-controls
  children: ReactNode;
  placement?: "above" | "below";              // 默认 below；只是偏好
  align?: "left" | "right";                   // 默认 left
  width?: number;                             // 省略时取触发点实测宽度
  maxWidth?: number;
  maxHeight?: number;                         // 默认 360，再按空间收窄
  className?: string;                         // 内容密度，不替换形状
  padded?: boolean;                           // 默认 true；通栏行传 false
  pointerReach?: string;                      // 额外算作本层范围的祖先选择器，只管指针
};
```

不变量：

- `open` 为假时渲染 `null`，不留下隐藏 DOM 或空层。
- `onOpenChange` 只由外部 `pointerdown` 和 Escape 触发，每次关闭调用一次；
  关闭从不触发内容里的任何动作。
- 面板打开时总在 `<body>` 的 portal 里；触发点周围不新增包裹元素，布局尺寸
  不变。
- 文档监听只在打开期间存在，关闭时全部移除。
- 面板宽度不超过视口宽度减 16px；`className` 追加在形状类之后，不用它替换
  边框、圆角、阴影或内边距。
