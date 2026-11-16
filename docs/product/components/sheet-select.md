# SheetSelect

**不可搜索的单选。** 短列表用它。手机打开控制台自己的底部 action sheet
（[ActionSheet](action-sheet.md)），768px 以上打开贴着触发点的菜单——同一个 chip，两种形状。

## 用它 / 别用它

用它：

- 两到八个固定选项，一眼能看完（权限模式、思考档位）。
- composer 底部那种合并控件里的一枚 chip。

别用它：

- 需要按名字找，或者选项超过一屏 → 用 [SearchSelect](search-select.md)。
- 选项需要解释。action sheet 只有一行标题，写不下第二行。

## 行为

- **形状跟着宽度走，不跟着平台走。** `useMinWidth(768)`：窄了是 action sheet，
  宽了是锚定菜单。触发按钮完全一致。
- **宽屏菜单就是共享的 `Menu` / `Popover` 层。** 测量、portal 到 `<body>`、
  外部按下、Escape、焦点进出、Tab 收束、输入法守卫都归那一层所有；这里只
  决定“哪一项是当前值”和“选中意味着什么”。不要在本控件里再挂 document
  监听。
- **不用原生 `<select>`。** iOS 的滚轮属于系统，关闭态是一个不认 token 的灰盒子
  （TASTE 第 14 条）。
- **`bordered` 在合并控件里关掉。** 容器已经画了边框，两条相隔 1px 的线读起来
  像渲染 bug。
- **破坏性选项用危险色（仅手机）。** 传 `destructive`，不要自己塞 class。
  宽屏走共享 `Menu`，它的行墨色是统一的；危险色留在 action sheet 上。

## 键盘

| 键 | 归属 |
|---|---|
| ↑ / ↓ | 在菜单项间移动，到头回绕（`Menu` 的漫游焦点） |
| Home / End | 首 / 末项 |
| Enter / Space | 选中（`Menu` 在菜单容器上处理） |
| Escape | 关闭并还焦点给触发按钮（`Popover` 层；只在焦点位于该层时响应） |
| Tab | 留在层内（`Popover` 的 Tab 收束）；Escape 是离开的路 |
| 输入法组合中 | 全部按键不动——`lib/ime.ts` 拦在菜单容器上 |

## 无障碍

| 项 | 条款 | 要求 | 状态 |
|---|---|---|---|
| 触发按钮名称 | 4.1.2 | 名称含当前值 | 全部 |
| 弹出类型 | 4.1.2 | `aria-haspopup="menu"`（宽）/ `"dialog"`（窄） | 全部 |
| 展开状态 | 4.1.2 | `aria-expanded` 跟随开合 | 打开 / 关闭 |
| 菜单语义 | 4.1.2 | `role="menu"` + `menuitemradio` + `aria-checked` | 打开（宽） |
| 浮层名称 | 4.1.2 | 承载菜单的面板是 `role="dialog"`，名为 `label` | 打开（宽） |
| 当前项 | 4.1.2 | `aria-checked="true"` 标记当前值；打开时焦点落在第一个可选项（`Menu` 的漫游焦点起点），不一定等于当前值 | 打开 |
| 触控目标 | 2.5.8 Target Size | 手机走 Sheet 的 44px 行高 | 手机 |

## 平台差异

| | 手机 | Mac |
|---|---|---|
| 表面 | 控制台 `Sheet`，带安全区 | 锚定菜单（`Menu` + `Popover`） |
| 层 | `ActionSheet` 自带 dialog 语义与焦点陷阱 | 共享 `Popover`：portal、测量、Escape、焦点 |
| 位置 | 从底部升起，盖住当前面板 | 贴着 chip |
| 主题 | 由控制台 token 着色 | 控制台自己的菜单样式 |

## 契约

```ts
type Props = {
  label: string;       // 面板标题，不是可见表单标签
  value: string;       // 受控
  options: SheetOption[];  // {id, label, destructive?}
  onChange: (id: string) => void;
  display?: string;    // 值不在 options 里时的触发文本
  placeholder?: string;
  disabled?: boolean;
  bordered?: boolean;
  className?: string;  // 只给宽度和墨色
};
```

不变量：两种形状共用一个触发按钮；`className` 不改变形状。
