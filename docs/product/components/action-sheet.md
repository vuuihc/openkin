# ActionSheet

**底部动作列表。** 手机上的行内次要操作、一排动词的溢出菜单用它。它是
[`Sheet`](../../../ui/src/components/mobile/Sheet.tsx) 的一个内容形状，不是第二套模态：
scrim、焦点陷阱、Escape / Back、安全区都由 `Sheet` 负责。

## 用它 / 别用它

用它：

- 一个对象有三到八个动词，且其中一个是停止 / 删除这类不可逆操作。
- 窄屏的单选列表——`SheetSelect` 在 768px 以下就是用它。

别用它：

- 内容需要解释、输入或分组 → 直接用 `Sheet` 排版。
- 桌面上的选择 → 用贴着触发点的菜单（`SearchSelect` / `SheetSelect` 的宽屏形状）。
- 只有一两个动作且能直接放在行里 → 不要为了“统一”再藏一层。
- 禁用行动必须带 `hint` 说明原因。禁用行不可聚焦，原因留在 `title` 里就没人
  够得着——手机没有 hover，键盘也停不上去。

## 行为

- **行是按钮，不是 radio。** 点击先 `onClose()`，再 `onSelect()`。行不要同步打开
  另一个 `Sheet`：关闭中的 sheet 会把历史条目还回去，新 sheet 可能被这次
  traversal 关掉。需要下一层时，用 ref + 监听 `open` 变 false 的 effect，
  范例是 `TaskDetailPage` 的会话菜单。
- **当前值用 `selected` 标记。** 行加 `aria-current="true"` 和勾选图标；选中态
  不是“点完不关”的 radio。
- **破坏性行动用 `destructive`。** 行取 `--kin-red-ink`，不要自己塞颜色 class。
- **`hint` 是标签下的第二行。** 写行的后果，或禁用行不能执行的原因；设了就
  显示（不只禁用行）。它在按钮内部，因此也是行可访问名称的一部分——不要改用
  `title`：手机没有 hover，读屏之外的人看不到。
- **取消只有一条。** footer 的 `SheetSecondaryButton`，只关闭，不触发任何动作。
- **宽屏触摸设备用 `anyWidth`。** iPad 横屏跑桌面布局但没有鼠标，侧栏项目行的
  `⋯` 仍会打开它；此时面板限宽居中，不按 768px 断点自动关闭。

## 键盘

| 键 | 归属 |
|---|---|
| Tab / Shift+Tab | 在行与取消之间移动；焦点被 `Sheet` 圈在面板内 |
| Enter / Space | 激活聚焦的行（原生按钮） |
| Escape | 关闭并还焦点给打开它的控件 |
| Back（手机） | 关闭；有 `data-sheet-layer` 的下一层时先关那一层 |

行之间不响应方向键：这是一列动作，不是 radio 组。

## 无障碍

| 项 | 条款 | 要求 | 状态 |
|---|---|---|---|
| 对话框名称 | 4.1.2 | `role="dialog"`，名称取 `title` | 全部 |
| 行名称 | 4.1.2 | 每行是带可见文本的 `<button>` | 全部 |
| 当前值 | 4.1.2 | `aria-current="true"`，不只靠颜色 | 单选场景 |
| 禁用行 | 4.1.2 | 原生 `disabled`，不可聚焦 | 忙碌 / 终态 |
| 原因行 | 4.1.2 | `hint` 画在标签下，并在按钮名称内；不用 `title` | 设置 `hint` 的行 |
| 触控目标 | 2.5.8 Target Size | 行高 ≥44px（`min-h-11`） | 手机 |
| 破坏性行的对比度 | 1.4.3 | 用 `--kin-red-ink`，已在面板表面认证过 | 全部 |

## 平台差异

| | 手机 | 宽屏 + 粗指针 | 桌面鼠标 |
|---|---|---|---|
| 表面 | 从底部升起的 `Sheet` | 同一个 `Sheet`，限宽居中 | 不渲染 |
| 位置 | 盖住当前面板 | 屏幕底部，28rem 上限 | — |
| 关闭后 | 焦点还给触发控件 | 同手机 | — |

## 契约

```ts
type ActionSheetRow = {
  id: string;
  label: string;
  selected?: boolean;    // 当前值，画勾并给读屏
  destructive?: boolean; // 停止 / 删除
  disabled?: boolean;
  hint?: string;         // 标签下的第二行：后果，或禁用原因
  onSelect: () => void;
};

type Props = {
  open: boolean;
  onClose: () => void;
  title?: string;        // 对话框的可访问名称，也是可见标题
  subtitle?: ReactNode;  // 例如 “运行在 <machine>”
  rows: ActionSheetRow[];
  anyWidth?: boolean;    // 宽屏触摸设备也显示
};
```

不变量：打开 / 关闭由 `open` 控制；行的动作不自己关面板，`ActionSheet` 统一先关。
