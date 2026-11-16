# SessionFilters

**对话列表的注意力视图与精确状态筛选。** 一排常驻的视图 chip（全部 / 等你处理 /
运行中 / 已归档），加一个“筛选”chip 原地展开的面板（六个精确状态 + 项目排序）。

## 用它 / 别用它

用它：

- 对话列表（`SessionsPage` / 左栏）的视图切换、状态过滤和归档范围。
- 视图或过滤条件需要写进地址栏、刷新后还在的场景。

别用它：

- 别的列表。这不是通用过滤器——状态词表属于对话（TASTE 第 1、4 条：一份列表
  一个搜索框，一个东西只有一个列表）。
- 需要搜索的过滤。搜索框属于列表本身，不塞进过滤器面板。

## 两个问题，两个控件

- **chip 行回答“什么在等我 / 什么在动”。** 四个 chip 是同一份列表的四个视图，
  同一时刻只有一个按下：
  - **全部**（无 `attention`、无 `scope`）
  - **等你处理**（`?attention=needs`）——`waiting_approval` + `waiting_input`，
    以及任何挂着待审批/待回答的对话；**这是组合，不是新状态**。挂起项比状态更
    权威：状态还没翻到 waiting 时，待处理项已经说明有人在等。
  - **运行中**（`?attention=running`）——`running`、`queued`、`retrying`。终态
    （`succeeded` / `failed` / `canceled`）和没有状态的导入会话不在里面。
  - **已归档**（`?scope=archived`）——同一份列表的另一侧，不是第二份列表。
- **面板回答“具体是哪个状态 / 项目怎么排”。** 六个精确状态（`running` /
  `waiting_approval` / `waiting_input` / `succeeded` / `failed` / `canceled`）和
  项目排序留在“筛选”面板里；范围不再出现在面板里，它已经是 chip 的同伴。

## URL 契约

一次只表达一个视图：

| 地址 | 按下的 chip |
|---|---|
| `?scope=archived` | 已归档（`?attention=` 被忽略） |
| `?attention=needs` | 等你处理 |
| `?attention=running` | 运行中 |
| 其它 / 未知值 | 全部 |

- 未知或缺失的 `?attention=` 一律读作“全部”，不是一个什么都匹配不上的视图
  （`normalizeAttentionFilter`）。
- `?status=` 在当前视图内继续收窄；**点任意 chip 会在同一次变更里清掉
  `?status=`**。
- 一次点击 = 一次 `onChange` = 一次 `setParams(..., { replace: true })`，不会为
  中间态留下历史记录。

`?status=` 仍然发给 daemon 过滤，不只是筛已加载的那一页。已加载页是 100 行，只筛
这一页会对“还有没有在跑的对话”给出错误答案。未知或缺失的 `?status=` 一律当作
“全部”（`normalizeStatusFilter`）。导入的 agent 会话没有状态，所以设了状态过滤
或注意力视图时列表会隐藏它们。

## 计数

- **等你处理** = `pendingByTask` 里的对话 ∪ 第一页里匹配 needs 的对话，按对话去
  重；同一条对话既挂着待处理项、状态又是 waiting 时只算一次。
- **运行中** = 第一页里匹配 running 且未归档的对话数。
- 数字读**第一页实时数据**（`taskList.data`），不读“加载更早”合并出来的旧页：
  一边滚动一边变大的数字不可信。待处理那一半是全局的（`pendingByTask` 本身就是
  全局）。
- 已知边界：真正的全局运行中计数需要 API 聚合；这个视图只承诺第一页 + 全局待处理。

## 行为

- **chip 行常驻，面板原地展开，不是 sheet。** `Sheet` 是 `md:hidden`，用它就得再
  做一个桌面专属表面，于是有两个机会对“选了什么”给出不同答案。触发点下面的面
  板是两个宽度下的同一个控件。
- **数字是标记，不是名字。** 气泡对屏幕阅读器 `aria-hidden`，chip 通过
  `aria-describedby` 指向一句完整的话（“3 个对话等你处理” / “2 个对话正在运
  行”）；计数为 0 时既不画气泡也不播报。
- **有精确状态时 chip 显示摘要。** 触发点显示状态名和一个数字角标；数字本身对
  屏幕阅读器隐藏，另有一句完整的播报。范围不在摘要里——它已经是 chip。
- **Escape 关闭面板并把焦点还给触发点。**
- **“清除”只清精确状态**，不动 chip 行。
- **chip 行在 390px 内不产生横向滚动**；放不下时换行到两行。

## 键盘

| 键 | 归属 |
|---|---|
| Tab | 在四个 chip、触发点和面板选项间移动 |
| Enter / Space | 选择 chip / 展开或收起面板 / 选择状态 |
| Escape | 关闭面板，焦点回到触发点 |

## 无障碍

| 项 | 条款 | 要求 | 状态 |
|---|---|---|---|
| 视图分组 | 1.3.1 Info and Relationships | 四个 chip 用 `role="group"` + `aria-labelledby` 命名 | 常驻 |
| 选中状态 | 4.1.2 | 选中 chip 由 `aria-pressed` 表达，同一时刻只有一个 true，不只靠颜色 | 常驻 |
| 计数播报 | 4.1.3 | 气泡数字 `aria-hidden`，`aria-describedby` 指向含名词的完整句子 | 计数 > 0 |
| 展开状态 | 4.1.2 | 触发点 `aria-expanded` + `aria-controls` 指向面板 | 打开 / 关闭 |
| 分组名称 | 1.3.1 | 面板内的状态组与排序组各用 `role="group"` + `aria-labelledby` | 打开 |
| 计数播报（面板） | 4.1.3 | 触发点角标数字 `aria-hidden`，另有完整播报 | 有精确状态 |
| 触控目标 | 2.5.8 | 基准 `min-h-9`（36px，桌面密度）；手机上 AppShell 根节点的 `.touch-lg` 地板把 chip 与“清除”抬到 44px | 手机 |

## 契约

```ts
type SessionFilterChange = {
  status: SessionStatusFilter;              // "" 表示全部
  scope: SessionScopeFilter;                // "active" | "archived"
  attention: SessionAttentionFilter;        // "" | "needs" | "running"
};

type Props = {
  status: SessionStatusFilter;
  scope: SessionScopeFilter;
  attention?: SessionAttentionFilter;       // 默认 ""
  needsYouCount?: number;                   // 默认 0
  runningCount?: number;                    // 默认 0
  onChange: (next: SessionFilterChange) => void;
  sortMode?: ProjectSortMode;
  onSortChange?: (mode: ProjectSortMode) => void;
};
```

受控组件：自己不开状态，`open` 是唯一的内部状态。URL 读写归页面，不归这里。
