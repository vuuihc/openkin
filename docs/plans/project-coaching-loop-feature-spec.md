# Project Context + Kin Coaching Loop — Feature 实现规格

**状态：** Draft for review

**日期：** 2026-07-22

**前置：** Project / One-Pager P0 已实现

**产品设计：** [Kin 在项目中的角色与教练循环](./project-agent-role-design.md)

**相关决策：** [ADR 0008](../adr/0008-project-one-pager.md) · [Project + One-Pager](./project-one-pager.md)

> **2026-07-25 supersession:** Hard-coded session「收工」/ recycle suggestion APIs are retired. Application-layer coaching extends via **Prompt Recipes + Task** — see [ADR 0013](../adr/0013-prompt-recipes.md) and [migration plan](./2026-07-25-prompt-recipes-migration.md). This spec remains historical context for One-Pager inject and product intent; do not implement §收工 REST as specified below.

## 1. 这次要交付什么

让 Kin 在项目会话里自然使用 One-Pager，并在用户主动收工时，把本次真实结果整理成最多 3 条可审核建议。用户可以采纳、编辑后采纳或忽略；普通任务不因项目功能而变慢或被阻塞。

完整主路径：

```text
选择 cwd
  → 看见项目摘要
  → 输入任务并自动绑定项目
  → Kin 带着短项目上下文执行
  → 用户点击“收工”
  → 审核 0～3 条建议
  → 采纳后更新 One-Pager
  → 下次进入时看见最新 Focus / Next / 变化
```

这份文档定义 Feature 的产品行为、最小技术契约、迭代边界和验收方式。评审通过后，再制定逐文件实现计划。

## 2. 实现原则

1. **整体闭环优先。** 先让一条真实用户路径从进入项目走到更新封面，再增加自动化和智能程度。
2. **每个迭代独立可用。** 不提交只有数据表、没有入口，或只有 UI、没有可完成行为的半成品。
3. **简单实现。** 不引入通用工作流引擎、复杂 Markdown AST、条目 ID、语义合并系统或新的 Agent 实体。
4. **冲突时重新审核。** 不做智能三方合并；只要生成建议后 One-Pager 已变化，就基于最新版重新展示或重新生成建议。
5. **用户任务优先。** 项目查询、上下文生成、收工建议失败都不能阻止普通任务创建、执行和完成。
6. **用户掌握叙事。** North Star 不进入普通建议；Focus 单独建议；任何用户正文变化都要经过明确采纳。
7. **手动先于自动。** 首版只做用户主动“收工”，用真实使用验证价值后再决定自动触发。

## 3. 本 Feature 的范围

### 3.1 包含

- 新会话页显示当前 cwd 对应项目的短摘要。
- 创建任务时可靠绑定 `project_id`。
- 项目任务获得有上限的 One-Pager 上下文。
- Kin 根据项目 mode 调整关注点，但不改变权限和身份。
- Task 页面提供手动“收工”。
- 收工生成一句话总结和 0～3 条建议。
- 建议支持采纳、编辑后采纳、忽略。
- 采纳后更新 One-Pager，并能从 Evidence 回到来源 Task 或 Artifact。
- Project Home 显示最近一次有效变化和待处理建议。
- 中英文文案、空态、错误态、断连态、宽窄屏体验。

### 3.2 不包含

- 自动弹出收工卡片。
- Catch-up、整页 Overview refresh、过期提醒。
- 自动创建 Artifact 或通用内容路由器。
- 复杂语义去重、跨 Session 向量检索。
- 对 Markdown 列表项做稳定 ID 或精确原位修改。
- One-Pager Companion、跨 Agent handoff pack。
- 多项目路径歧义的高级管理界面。

以上能力只有在本 Feature 验证有效后才进入后续迭代。

## 4. 用户体验契约

### 4.1 新会话页

选择 cwd 后，页面进行只读项目解析，不因为浏览目录而自动创建项目。

若命中项目，展示：

- Project name + mode；
- North Star；
- Current Focus；
- 最多 3 条 Next；
- “打开封面”入口。

这里展示结构化摘要，不渲染完整 One-Pager。摘要目标是一眼决定“接下来要做什么”，并保持在普通桌面宽度的一屏内。

状态必须区分：

| 状态 | 行为 |
|---|---|
| 未选择 cwd | 提示选择工作目录 |
| cwd 无项目 | 保留普通新会话体验，不要求创建项目 |
| 项目存在、One-Pager 为空 | 展示项目身份和空封面入口 |
| 加载失败 | 展示可重试错误，不伪装成“无项目” |
| 断开连接 | 展示断连状态；恢复后可重试 |

用户可以在项目信息仍在加载时提交任务。此时任务照常创建，后端按 cwd 再次解析项目，避免依赖前端查询时序。

### 4.2 项目上下文注入

项目任务注入稳定、短小的上下文：

```text
Project: <name>
Mode: ship | learn | explore | maintain
North Star: <bounded text>
Current Focus: <bounded text>
Next:
1. ...
2. ...
3. ...
```

规则：

- 不默认注入完整 One-Pager；
- 不默认读取 Evidence 内容，只携带必要指针；
- 上下文总预算使用一个后端常量，首版沿用现有 digest 上限；
- 用户当前请求始终是直接目标，Current Focus 是背景约束；
- 上下文读取失败时使用原始用户请求继续创建任务。

Mode 只影响提示策略：

| Mode | 首要关注 |
|---|---|
| Ship | 验收、最短交付路径、风险 |
| Learn | 能否解释、应用和迁移 |
| Explore | 假设、证据、反例 |
| Maintain | 根因、低风险恢复、回归保护 |

首版不实现运行时“教练状态机”。这些规则作为项目上下文中的短指令，由同一个主 Agent 执行。

### 4.3 手动收工

只有满足以下条件时展示可用的“收工”操作：

- Task 已绑定项目；
- Task 已产生至少一条用户或 Agent 消息；
- Task 不在等待首次启动的空状态。

用户点击后：

1. UI 显示生成中状态，但不改变 Task 完成状态；
2. 后端读取当前 Task、当前 One-Pager 和项目 mode；
3. 模型返回一句话总结及 0～3 条结构化建议；
4. 后端校验数量、目标、文本长度和 Evidence；
5. UI 展示审核卡片。

生成失败时显示重试和关闭操作，不影响 Task，也不写 One-Pager。

### 4.4 建议审核

普通建议只允许写入：

- `conclusions`
- `open_questions`
- `next`

Focus 建议单独展示，不计入普通建议的 3 条上限。North Star 不生成可直接采纳的建议。

每条建议支持：

- **采纳：** 使用建议原文；
- **编辑后采纳：** 用户修改文本后写入；
- **忽略：** 本次不写入，并从待处理列表移除。

审核操作逐条生效。用户不需要处理所有建议，可以随时关闭卡片。

## 5. 简单补丁模型

首版不做通用 Markdown patch。建议表达用户要审核的内容，而不是底层文本编辑指令：

```json
{
  "target": "conclusions | open_questions | next | focus",
  "text": "一到两行建议内容",
  "reason": "为什么值得写回",
  "evidence": [
    { "kind": "task", "id": "task_id", "label": "本次任务" }
  ],
  "confidence": "low | medium | high"
}
```

采纳规则保持简单：

- Conclusions / Open Questions：追加一条 Markdown 列表项；
- Next：追加后只保留用户审核后的最多 3 条，超过时要求用户先编辑，不自动删除旧内容；
- Focus：以新旧值对比单独确认，确认后替换整个 Focus section；
- North Star：不支持此 API 修改。

建议生成时记录 One-Pager 的 `updated_at`。采纳时若版本已变化，返回冲突，并把“建议内容 + 最新 One-Pager”重新交给用户审核。首版不做自动重放或智能合并。

## 6. 最小数据契约

为了支持关闭卡片后继续审核，只保存一个轻量建议批次，不建设通用工作流系统。

```text
project_recycles
  id
  project_id
  task_id
  base_one_pager_updated_at
  summary
  suggestions_json
  status: pending | resolved
  created_at
  resolved_at nullable
```

`suggestions_json` 中每条建议包含自己的处理状态：

```text
pending | accepted | accepted_edited | ignored
```

约束：

- 一个 Task 首版最多保留一个未完成的 recycle；再次生成时明确替换旧批次；
- 所有建议处理完成或用户选择“全部忽略”后，批次进入 `resolved`；
- 不保存复杂语义指纹；首版只在同一批次内做标准化文本去重；
- 记录最终采纳文本和采纳时间，满足最小审计；
- 项目或 Task 不存在时不生成孤立记录。

Evidence 首版仅要求 Task 和 Artifact 可点击。文件 Evidence 暂时只作为不可点击的项目相对路径展示，不承诺文件移动后的追踪。

## 7. API 行为草图

具体路径可在实现计划中按现有路由风格调整，但行为保持稳定。

```text
GET  /api/projects/find-by-root?path=...
     → 项目身份 + one_pager_summary

POST /api/tasks
     body 可带 project_id；未带时后端按 cwd best-effort 绑定

POST /api/tasks/{task_id}/recycle
     → 生成或替换该 Task 的 pending recycle

GET  /api/tasks/{task_id}/recycle
     → 当前 pending/resolved recycle

POST /api/recycles/{id}/suggestions/{index}/accept
     body: final_text, one_pager_updated_at

POST /api/recycles/{id}/suggestions/{index}/ignore
```

接口规则：

- 生成接口可重复调用，但必须明确替换旧 pending 批次；
- accept / ignore 对同一建议幂等；
- accept 必须携带生成时或最新审核时的 One-Pager 版本；
- 冲突返回 `409` 和最新 One-Pager，不写任何内容；
- 模型原始输出不直接写文件；必须先解析和校验；
- 所有长度和枚举限制由后端执行，不能只依赖 UI。

## 8. 闭环迭代

### Iteration 1 — 项目入口闭环

**用户价值：** 从任意 cwd 开新会话时，能看见正确的项目方向，并确保新 Task 归入该项目。

交付：

- 新会话页结构化摘要；
- 完整空态、错误态和断连态；
- 前后端 project lookup；
- 创建 Task 时由后端可靠绑定项目；
- 短上下文注入和四种 mode 的提示策略；
- 中英文文案、宽窄屏验证。

完成定义：用户从新会话页提交任务，Task 页面和 Project Home 都显示正确项目，Agent 初始上下文包含有上限的 Focus 信息；无项目路径不回归。

### Iteration 2 — 手动收工闭环

**用户价值：** 完成一次真实任务后，可在约 20 秒内把有效结论写回封面。

交付：

- 轻量 recycle 存储和迁移；
- 手动收工生成 API；
- 0～3 条结构化建议；
- Task 页面审核卡片；
- 采纳、编辑后采纳、忽略；
- 简单 section 写入、版本冲突处理；
- Evidence 跳回来源 Task/Artifact；
- 生成失败、空建议和重试状态。

完成定义：从点击收工到采纳建议形成完整链路；刷新或重启后待审建议仍在；冲突不会覆盖用户新编辑；无建议时明确结束，不制造内容。

### Iteration 3 — 项目继续闭环

**用户价值：** 下次进入项目时能快速知道上次改变了什么，并继续工作。

交付：

- Project Home 展示最近一次 recycle 总结；
- 展示未处理建议并继续审核；
- 展示 Current Focus 和最多 3 条 Next；
- 项目级关闭收工建议和教练提示；
- 基于实际使用修正文案和建议 prompt。

完成定义：用户关闭 Task 后从 Project Home 重新进入，不需要寻找原会话就能恢复方向、处理遗留建议并开始下一 Task。

每个 Iteration 必须同时完成 API、存储、UI、i18n、测试和 `web/dist/`，通过验证并形成独立提交后才进入下一 Iteration。

## 9. 后续 Feature，而不是本次尾项

下列能力不会以未接线代码或隐藏开关进入本 Feature：

- 自动收工触发；
- Catch-up；
- 整页 Overview refresh；
- 更长期的忽略去重；
- 自动 Artifact 分流；
- 文件 Evidence 移动追踪；
- One-Pager Companion；
- 跨 Agent handoff。

如果手动收工使用率和采纳率证明循环有价值，再分别立项。其中自动收工必须先定义确定性触发条件和“不打扰”指标。

## 10. 验收标准

### 功能

- 用户无需理解“教练循环”即可直接创建和完成任务。
- 有项目时展示短摘要；无项目、加载失败、断连不会混为同一状态。
- 项目 Task 可靠绑定 `project_id`，不依赖前端请求是否先完成。
- 项目上下文有固定上限，不注入完整 One-Pager。
- 手动收工返回 0～3 条普通建议，可有一条独立 Focus 建议。
- 采纳、编辑后采纳和忽略均可刷新后恢复结果。
- 未经用户采纳，One-Pager 不变化。
- One-Pager 在建议生成后发生变化时，采纳返回冲突且不覆盖文件。
- 模型失败、空建议、项目缺失不影响 Task 完成状态。
- Evidence 至少能返回来源 Task 或 Artifact。

### 质量

- 收工建议在正常模型响应后可于约 20 秒内完成审核。
- One-Pager 摘要在代表性桌面和窄屏宽度可用。
- 所有用户可见文字具有中英文翻译。
- 后端包含空结果、非法模型输出、重复请求、版本冲突和权限边界测试。
- UI 包含加载、空、错误、断连、生成中、空建议、冲突状态测试。
- UI 构建成功并同步生成 `web/dist/`。
- 不建项目的普通新会话和 Task 流程通过回归验证。

## 11. 需要评审确认的决策

1. 首版只做手动收工，自动触发后续单独立项。
2. 普通建议只追加 Conclusions / Open Questions / Next；不做精确条目替换。
3. Focus 使用整段新旧值确认；North Star 不开放建议写入 API。
4. 一个 Task 只保留一个 pending recycle，再次生成明确替换。
5. 冲突只重新审核，不做自动合并。
6. 首版去重仅限单批次，不实现跨 Session 语义去重。
7. 文件 Evidence 只显示项目相对路径，不承诺移动追踪。
8. Catch-up、自动收工和 Artifact 自动分流不与本 Feature 捆绑。

这些决策确认后，再将三个闭环 Iteration 展开为可执行实现计划。
