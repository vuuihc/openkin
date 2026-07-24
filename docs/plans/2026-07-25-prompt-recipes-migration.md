# Plan: Prompt Recipes 迁移（2026-07-25）

Implements [ADR 0013](../adr/0013-prompt-recipes.md).

目标：把「应用层教练/封面能力」从**专用 REST + merge 状态机**收回到 **Recipe 文案 + 现有 Task 原语**；扩展新功能时默认加配方，不加 API。

原则：每个 slice 可独立合并、可回滚；不引入 Recipe 引擎/表/工作流。

---

## 现状对照

| 能力 | 现状 | 目标 |
|------|------|------|
| 收工 recycle | 已删除 UI/API；schema 12 drop 表 | 保持删除；需要时用 recipe，不复活 suggestion 框架 |
| Continue focus | `POST /api/projects/{id}/continue` + 封面按钮 | recipe `focus.continue` → `POST /api/tasks` |
| Summarize cover | `POST /api/projects/{id}/summarize` + proposal UI + `mergeCoverProposal` | recipe `cover.update` → task；agent 改 `ONE_PAGER.md` 或对话出草稿 |
| 普通建任务 | `maybeInjectProjectContext` | **保留**（唯一注入路径） |
| One-Pager GET/PUT | 手改封面 | **保留** |
| Pulse | 确定性信号 + 可选写 `kin:auto` | **保留读**；不与 summarize 绑死 |
| 项目记忆（未来） | 无 | 新 recipe / 文件约定，不先上 memory API 中台 |

---

## Slice 0 — 钉死约定（文档 only）

**做：**

- 本 ADR + 本 plan 合入。
- 确认 `PRINCIPLE` §5.5 / 技术过滤器、`AGENTS.md` §3a 与 ADR 0013 交叉引用（已有则补 Related 链接即可）。
- 在 `docs/TODO.md` Project P1 中：recycle 已 RETIRED；continue/summarize 标为「迁 recipe」而非「做专用卡」。

**不做：** 代码行为变更。

**验收：** 评审能回答：新应用功能默认走哪条路径、何时才允许新 API。

---

## Slice 1 — Continue → Recipe 发射

**后端**

- 删除或废弃 `handleContinueProject` 与路由 `POST /api/projects/{id}/continue`。
- **保留** `BuildContinuePrompt` / `maybeInjectProjectContext`（create 路径仍用）。
- 若 continue 测试仅覆盖该路由：改为测「create + inject」或 recipe 渲染。

**前端**

- `ProjectDetailPage`「继续当前焦点」：
  - 组装 prompt（见下方默认文案）+ `project_id` + cwd/root；
  - 调用现有 `createTask`（与 NewChat 同源）；
  - 跳转新 task。
- 删除 `continueProject` client 封装（若无其它引用）。

**默认 recipe 文案（可先写死在 UI 或 `internal`/`ui` 常量）：**

```text
继续当前焦点。优先最小可验证的下一步；除非我明确要求，不要改写 North Star。
若 One-Pager 与代码现状冲突，先指出冲突再动手。
```

（项目 digest 仍由服务端 inject 附加，不必在按钮里塞全文。）

**验收：**

- 点击「继续当前焦点」产生普通 task；transcript 用户气泡是短意图，不把整份 digest 当作用户正文（现有 `UserPrompt` 行为保持）。
- 无 continue 路由后 `go test ./internal/api/...` 绿。
- 网络面板��再出现 `/continue`。

---

## Slice 2 — Summarize → Recipe + 去掉 merge 中台

**后端**

- 删除 `handleSummarizeProject`、`mergeCoverProposal`、`parseMDSections`（若仅被 summarize 使用）、路由 `POST /api/projects/{id}/summarize`。
- 删除/收缩仅服务于 summarize 的 cognition 旁路（若 title/model-directive 等仍用 provider，勿误删）。

**前端**

- 去掉封面「辅助更新」proposal 卡片（采纳/忽略/预览 merge）。
- 按钮改为 launch recipe，例如：

```text
请阅读本项目的 ONE_PAGER.md（及项目根目录约定路径）与近期工作线索，提出对封面的修改：
- 可更新：Current Focus、Next、结论、未决问题等用户区
- 不要擅自改写 North Star，除非我在下面说明
- 优先直接编辑 ONE_PAGER.md；若无把握先给出简短 diff 说明再写入
我的补充：{{user_note}}
```

- 用户确认发生在 **task 工具写文件 / 对话**，不再走「suggestion accept API」。

**验收：**

- 无 summarize API；无服务端章节 merge。
- 手改 One-Pager GET/PUT 仍可用。
- Agent 在有写权限的任务里能改封面（权限模式与现网一致；勿为 recipe 新开特权通道）。

---

## Slice 3 — 最小 Recipe 目录（仍无引擎）

**做薄目录，方便复用与测试：**

建议位置（二选一，优先已有包边界）：

- `internal/recipes/catalog.go` — id → template + metadata；**或**
- `ui/src/recipes/catalog.ts` — 若暂时只有 UI 发射、后端零依赖。

推荐 **前端 catalog 起步**（continue/summarize 已不需要服务端模板），后端仅在未来 Routine/CLI 共享同一文案时再抽到 `internal`。

**v1 内置 id：**

| id | 用途 |
|----|------|
| `focus.continue` | 继续当前焦点 |
| `cover.update` | 辅助更新封面 |
| `project.memory.tidy`（占位可选） | 整理项目记忆草稿——**仅模板，不建 memory 表** |

**API：** 无。最多 `launchRecipe(id, ctx)` 本地函数：render → `createTask`.

**验收：**

- 两处按钮共用 `launchRecipe`。
- 单测：placeholder 渲染（纯字符串），不测模型输出。

---

## Slice 4 — 体验收口（可选，可与 1/2 合并）

- 命令面板增加 recipe 列表（可选）。
- Project 封面：弱化 `soft_progress` 枚举展示（或改为纯文案说明）；**不**在本 plan 强删列，避免无关迁移。
- `ModeStrategyLine`：评估改为仅 inject 用户封面中的一句，或保留一行默认；**不**新增 mode API。
- Pulse 热力图：保留；与 recipe 无耦合。
- 更新/归档 `project-coaching-loop-feature-spec.md` 文首：收工/专用建议卡路径 **superseded by ADR 0013**。

**验收：** 封面主路径 = 摘要 + 手改 One-Pager + 少量 recipe 按钮 + pulse；无第二套审核卡。

---

## 明确不做

- Recipe DB / CRUD 管理后台  
- 通用 Accept/Ignore suggestion 框架  
- 服务端 JSON→Markdown 章节 patcher  
- Workflow/DAG/条件分支  
- 自动弹出「该收工了」  
- 借本次迁移重做 project memory 存储  

---

## 建议落地顺序与风险

```text
Slice 0 (docs)
  → Slice 1 (continue)      // 低风险、行为几乎等价
  → Slice 2 (summarize)     // 去掉旁路 LLM + merge，注意权限与文案
  → Slice 3 (catalog)       // 去重按钮逻辑
  → Slice 4 (polish)        // 可延后
```

| 风险 | 缓解 |
|------|------|
| 用户依赖「辅助更新」一键 merge | 按钮仍在，改为开聊；手改 PUT 保留 |
| inject 与 recipe 双重上下文过长 | recipe 保持短；digest 仍走现有 budget |
| agent 乱改 North Star | 模板写明禁止；permission_mode 不抬权 |
| 误删 provider 通用路径 | summarize 删除时只撕 projects 内旁路 |

---

## Progress (2026-07-25)

- [x] Slice 0 — ADR 0013 + plan + TODO/spec links
- [x] Slice 1 — continue API removed; UI `focus.continue` → `createTask` via `ui/src/recipes`
- [x] Slice 2 — summarize API removed; UI `cover.update` recipe; client stubs deleted
- [x] Slice 3 — `ui/src/recipes/catalog.ts` + `launch.ts` + unit tests
- [x] Slice 4 — command palette recipes; memory.tidy button; soft_progress UI thinned; ModeStrategyLine simplified

**Migration complete for planned slices 0–4.** Further recipes = catalog entries only.

## Ship checklist

1. ADR 0013 + 本 plan 已链到 PRINCIPLE/AGENTS/TODO。  
2. 无 `/api/tasks/{id}/recycle`、`/api/recycles/*`（已完成）。  
3. 无 `/api/projects/{id}/continue`、`/api/projects/{id}/summarize`。  
4. 封面「继续焦点 / 更新封面」仅 `createTask`（或 follow-up）。  
5. 无 `mergeCoverProposal` / recycle suggestion 写回。  
6. `go test ./internal/api/... ./internal/store/...` 绿；`ui` typecheck 绿。  
7. 中英文案不出现已删能力的死链按钮。  
8. 新增应用向功能 PR 自检：是否违反 ADR 0013 compliance check。

---

## 以后加功能的默认模板（给作者）

1. 写 1 段 recipe prompt（放 catalog）。  
2. UI 一个入口调用 `launchRecipe`。  
3. 若必须持久化：**文件或已有表**，并说明为何 prompt 不够。  
4. 禁止：新 suggestion 表 + accept API + 专用审核卡，除非单独 ADR 推翻 0013。
