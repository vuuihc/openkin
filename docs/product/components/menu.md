# Menu

**贴着触发点的命令列表。** 一个控件旁边弹出的一列动词或一小组单选，用它。
它是受控的：开关由调用方持有，`Menu` 只负责菜单本身——角色、方向键、字母跳转、
选中与关闭、焦点归还。

## 用它 / 别用它

用它：

- 一排动词（重命名、复制、删除）挂在某个对象或控件上。
- 权限模式、模型这类"从一小组成员里挑一个"的桌面形态：行用 `checked` 变成
  `menuitemradio`。
- 触发点所在的条带会裁剪绝对定位面板时——面板由底层 `Popover` 挂到 `<body>`
  并用视口坐标定位，不会被 `overflow-*` 切掉（TASTE 14）。

别用它：

- 目录长到要自带过滤、分组或手机底栏时 → `SearchSelect`（完整的下拉控件，自带触发器）；
  Menu 的 `search` 只用于调用方自己按查询过滤的短目录。
- 手机上从底部升起的单选 / 动作面板 → `ActionSheet` / `SheetSelect`。
- 一行后果说明 → `description`；一个由某一行展开的编辑器 → `footer`；多行或需要
  分组排版的内容 → 用 `Popover` 自己排版，不要塞进菜单行。
- 只有一个动作、能直接放在行里 → 不要为了统一再藏一层（TASTE 7）。

## 行为

- **受控。** `open` 与 `onOpenChange` 都由调用方持有；`Menu` 没有内部开关状态，
  也不会在挂载时自行打开或关闭。
- **贴着触发点。** `placement` 是偏好，上面放不下时底层的测量会翻到另一侧；
  `align` 决定面板与触发点的哪条边对齐。打开前后容器高度不变。
- **焦点先到 `initialFocusId`。** 打开后焦点落在调用方指定的那一行；没指定或
  该行不可用时，落在第一个可用的行上。单选菜单传当前选中行，第一次按方向键
  就从读者已经处在的位置出发。
- **`search` 的上下进出。** 有 `search` 时打开焦点先落在字段里；Down 进列表
  （优先 `initialFocusId`，否则第一行），从第一行 Up 回到字段，从字段 Up 到
  最后一行，形成回绕。菜单不自行过滤：`items` 由调用方按查询过滤，Enter 选中
  第一行可用项。
- **关闭只有三种来路：** 选中一行（`keepOpen` 行除外）、Escape、在面板外按下
  指针。外部关闭只调用 `onOpenChange(false)`，不触发任何 `onSelect`。
- **选中后焦点回触发点。** 关闭菜单的行在选中后卸载；不还焦点，下一次 Tab
  就从文档开头开始。`keepOpen` 行不关闭也不移动焦点，由调用方在之后关闭。
- **一层一次 Escape。** 菜单开在另一个 `Popover` 里时，一次 Escape 只关菜单，
  外层保持打开；关闭与焦点归还由底层 `Popover` 的层注册表负责，不在这里
  装第二个 document 监听。
- **实现。** 这一版组合现有的 `Popover` 原语（portal、定位、外部关闭、Escape、
  焦点、Tab 圈定），菜单语义在 `Menu` 内实现。等 Astryx `DropdownMenu` 的 API
  可以在本机核对后，再把内部换成它；公开 props 不变。

## 键盘

| 键 | 归属 |
|---|---|
| ArrowDown / ArrowUp | 在可用的行之间走一步并回绕；有 `search` 时 Down 从字段进列表（优先 `initialFocusId`）、Up 从第一行回字段、从字段 Up 到最后一行；禁用的行不停留 |
| Home / End | 第一行 / 最后一行（都跳过禁用行）；焦点在 `search` 字段时归字段，编辑文本 |
| 字母 / 数字 | 焦点在行上时，500ms 内的连续输入按行首字母查找，从当前行之后开始并回绕；不区分大小写。焦点在 `search` 字段时归字段 |
| Enter / Space | 选中当前行一次；除 `keepOpen` 行外关闭。焦点在 `search` 字段时 Enter 选中第一行可用项 |
| Escape | 关闭本层，焦点回触发点；输入法组字期间不响应（`isImeKeyEvent`） |
| Tab / Shift+Tab | 由底层层圈在面板内；行是**一个** Tab 停点，不是每行一个；`search` 字段、它的清除按钮与 `footer` 里的控件是面板内各自独立的停点 |
| 输入法组字中的任何键 | 归输入法；不选中、不关闭、不跳行 |

## 无障碍

| 项 | 条款 | 要求 | 状态 |
|---|---|---|---|
| 菜单名称 | 4.1.2 | `role="menu"`，名称取 `label` | 全部 |
| 行动行 | 4.1.2 | `role="menuitem"`，名称是可见文本（含 `description`） | 全部 |
| 单选行 | 4.1.2 | `checked` 有定义时 `role="menuitemradio"` + `aria-checked` | 单选场景 |
| 禁用行 | 4.1.2 | `aria-disabled="true"`，方向键跳过，指针不聚焦、不触发 | 忙碌 / 不可用 |
| 焦点可见 | 2.4.7 | 焦点行用 `--kin-fill-strong` 加 `--kin-focus-ring` 描边 | 全部 |
| 触控目标 | 2.5.8 Target Size | 窄屏行高 ≥44px（`max-sm:min-h-11`） | 手机 |
| 热键归属 | — | 打开时 `overlayOwnsKeyboard()` 为真，背后列表不响应 j/k、⌘F（TASTE 16） | 全部 |

## 平台差异

| | 手机 | 桌面鼠标 / 键盘 |
|---|---|---|
| 形状 | 通常不出现：单选与动作用 `SheetSelect` / `ActionSheet` | 贴着触发点的浮层 |
| 行高 | ≥44px | 36px |
| 关闭 | 同左 | 选中、Escape、点外面 |

## 契约

```ts
type MenuItem = {
  id: string;
  label: string;
  icon?: ReactNode;
  disabled?: boolean;
  /** 第二行说明；仍在行的可访问名称里。 */
  description?: string;
  /** 有定义即渲染 role="menuitemradio" 与 aria-checked。 */
  checked?: boolean;
  /** 选中后菜单保持打开、焦点不移动：让 `footer` 里刚展开的编辑器不被卸载；这一行仍可以是 `checked` 的选项。 */
  keepOpen?: boolean;
  onSelect: () => void;
};

type MenuSearch = {
  value: string;
  onChange: (value: string) => void;
  label: string;                 // 输入框的可访问名称
  placeholder: string;
  clearLabel: string;            // 清除按钮的可访问名称
};

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  triggerRef: RefObject<HTMLElement | null>;
  label: string;                 // 菜单的可访问名称，不是可见标题
  items: MenuItem[];
  initialFocusId?: string;       // 打开时先落在哪一行；缺省第一个可用行
  placement?: "above" | "below"; // 偏好；放不下会翻面
  align?: "left" | "right";
  width?: number;                // 面板宽度（px），默认 240
  search?: MenuSearch;
  footer?: ReactNode;            // 行下方内容，属这一层，不是菜单命令
  emptyLabel?: string;           // 调用方的过滤没有留下行时显示
};
```

不变量：

- `onSelect` 只由选中触发（Enter / Space / 点击），每次一行、一次。
- 关闭从不触发 `onSelect`；`onOpenChange(false)` 在选中（`keepOpen` 行除外）、
  Escape、外部指针三条路径上各调用一次。
- 菜单状态（哪一行有焦点、字母缓冲）不越过一次打开：关闭后下次重新从
  `initialFocusId`（缺省第一个可用行；有 `search` 时先落在字段）开始。
- 行在 `open` 为真时总在 `<body>` 的 portal 里，`role="menu"` 挂在菜单容器上。
