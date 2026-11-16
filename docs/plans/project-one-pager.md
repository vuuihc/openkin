# Project + One-Pager — 产品规范与实现计划

**状态：** P0 implemented（对应 [ADR 0008](../adr/0008-project-one-pager.md)）；P1+ 未开工  
**交互设计：** [Kin 在项目中的角色与教练循环](./project-agent-role-design.md)
**读者：** 产品决策 + 后续实现者  
**原则：** 随性开会话不被打断；结构在「收工 / 回顾」时长出来；用户拥有目标；Agent 只提议补丁。

---

## 0. 一句话

> 每个（可选）项目有一页活的 One-Pager：写清目标与焦点，沉淀结论与下一步，链回 session / artifact。  
> 它是**项目封面**，不是看板，不是固定 overview 聊天，不是 Memory v0。

---

## 1. 要解决的问题 / 不解决的问题

### 1.1 痛点

| 痛点 | 今天 | One-Pager 之后 |
|------|------|----------------|
| 多会话后不知道项目在干什么 | 翻 task 列表 / 终端历史 | 30 秒扫一页封面 |
| 学习项目与交付项目进度语义不同 | 无 | Mode 模板（Learn / Ship…） |
| 换 agent / 开新会话要重新解释 | 复制粘贴 | Continue Focus 注入摘要 |
| 想要全局感又怕 Scrum | 无好选项 | 召唤式整理 + 用户可改的一页 |

### 1.2 非目标（写进验收反例）

- ❌ 默认 Todo/Doing/Done 看板  
- ❌ 完成度百分比、连续打卡、逾期红灯  
- ❌ 强迫每个会话选状态  
- ❌ 用「固定 overview session」当唯一真源  
- ❌ 常驻 CEO 驾驶舱（首页全是仪表盘���  
- ❌ 完整 Wiki / 向量记忆 / 多人文档权限  

### 1.3 成功体感（个人效率）

1. 打开某个项目，**先看到自己写过的目标与焦点**，而不是一堆无序 session。  
2. 点「继续当前焦点」开干，少解释一轮。  
3. 收工时花 **≤20 秒** 决定是否把 0～3 条结论写回封面。  
4. 学习向项目能写下「我现在能讲到哪」，而不是假进度条。  

---

## 2. 概念模型

```text
Project                          容器（可归档）
├── id, name, mode, roots[]
├── one_pager  ───────────────►  活文档（文件真源）
├── sessions / tasks[]           材料（过程）
├── artifacts[]                  证据 / 产物
└── companion_thread? (P2)       针对 One-Pager 的修订对话
```

### 2.1 Project

| 字段 | 说明 |
|------|------|
| `id` | ulid |
| `name` | 展示名，默认可取目录名 |
| `mode` | `ship` \| `learn` \| `explore` \| `maintain` |
| `roots` | 关联路径（通常 git root / cwd），用于自动归拢建议 |
| `one_pager_id` | 指向 brief 文档 |
| `status` | `active` \| `archived` |
| `last_active_at` | 最近关联 session 活动时间 |
| `created_at` / `updated_at` | |

**归拢策略（P0 务实）：**

- 创建 task 时若 `cwd` 命中已有 project.root → 建议挂上（可取消）  
- 用户可「从当前 cwd 创建项目」  
- **不**在首次看到新目录时强制建项目  

### 2.2 One-Pager（真源）

- 磁盘：`~/.kin/projects/<project_id>/ONE_PAGER.md`（或复用 artifacts 目录 + 固定 kind）  
- SQLite：元数据 + `project_id` 唯一约束（一项目一页）  
- 用户可在 UI 直接编辑；也可在磁盘上改（daemon 读文件）  

**推荐 kind：** `project_brief`（若走 Artifacts 表扩展）；或独立 `project_briefs` 表。  
**决策倾向：** P0 独立表 + 文件，避免和「会话产物库」心智混淆；P1 再在 Artifacts 列表提供「来自项目」过滤。两种都行，实现时 **二选一写死**，见 §6。

### 2.3 与 Session / Artifact 的关系

| 对象 | 角色 |
|------|------|
| Session/Task | 过程；可 `project_id` 可空 |
| Artifact | 冷产物；可属于项目；可被 One-Pager 引用 |
| One-Pager | 项目级叙事真源；引用前两者作证据 |

---

## 3. One-Pager 内容规范

### 3.1 稳定骨架（所有 mode）

```markdown
# <Project name>

## What
一句话：这是什么。

## North Star
用户目标（学习 / 交付 / 探索……用用户自己的话）。

## Current Focus
当下唯一主线（越短越好）。

## Conclusions
- 已成立的结论（宜带证据：session / artifact 链接）

## Open questions
- 未决问题

## Next
1. 下一步（最多 3 条可见；多了就该改 Focus）
2.
3.

## Evidence
- 相关 sessions / artifacts（可自动维护附录）
```

### 3.2 Mode 增量（模板预填，用户可删）

**Ship**

```markdown
## Definition of done (demo)
怎样算「今天有进展 / 可演示」？

## Risks
…
```

**Learn**

```markdown
## Understood
…

## Still fuzzy
…

## Teach-back
如果现在让我讲，我能讲到哪？（5～10 行）
```

**Explore**

```markdown
## Hypotheses
…

## Rejected paths
…

## Signals to deepen
…
```

**Maintain**

```markdown
## Health
…

## Footguns
…

## Do not touch
…
```

### 3.3 进度语言（禁止假精确）

可选、软性、枚举（写在 Focus 旁或 meta）：

`fog` → `can_explain` → `can_build` → `can_ship` → `can_teach`

- UI 可用细标签，**不要**环形百分比。  
- Learn 默认强调 `can_explain` / `can_teach`；Ship 强调 `can_ship`。

### 3.4 权威与写入规则

| 区域 | 权威 |
|------|------|
| North Star、Mode、What | **仅用户**可定稿；Agent 只可提议 |
| Current Focus | 用户定稿；Agent 可在收工时建议切换 |
| Conclusions / Open / Next | 双写：用户直接改；Agent **diff 提议** |
| Evidence 附录 | 系统可自动追加链接；不删用户正文 |

Agent 提议 UX 对齐 Approvals / Artifacts：

`[采纳] [编辑后采纳] [忽略]`

---

## 4. 核心交互

### 4.1 信息架构

```text
Nav
├── Tasks          （过程流，保留）
├── Approvals      （信号，侧栏点/角标即可）
├── Artifacts      （产物库）
├── Projects       （新：项目列表）
└── Project Home   （One-Pager | 最近 Sessions | 相关 Artifacts | 主键 CTA）
```

**Project Home 主键 CTA：**

1. **继续当前焦点** → 创建 task，注入 prompt 块（见 §4.3）  
2. **编辑 One-Pager**  
3. **Catch-up**（P1）  
4. **收工回收** 从任意挂靠 session 回来（P1）

### 4.2 Resume 与 Project 的关系

- **全局 Resume（轻）：** 最近 N 个 session（可做在 Tasks 顶），不强制项目。  
- **项目内：** 最近 session + One-Pager。  
- 审批状态：**蓝点/绿点/角标**，不升级为工作台产品。

### 4.3 Continue Focus — 注入策略（对齐 ADR 0002）

创建 session 时系统组装 **稳定、短** 的前缀块（控制体积，利于缓存与成本）：

```text
[Project: name | mode]
North Star: …
Current Focus: …
Soft progress: can_build (optional)
Pinned next steps: (最多 3 条)
One-Pager digest: (短摘要 ≤ N 字，不是全文)
Evidence pointers: (最近 1～3 session id / 关键 artifact id)
```

规则：

- 默认 **不** 倾倒完整 One-Pager 全文  
- 用户在 Project Home 可勾选「附带全文」（显式）  
- 全文更适合 Companion / Catch-up，而不是每个 coding turn  

### 4.4 会话结束回收（P1，粘性引擎）

触发：task terminal、用户点「收工」、或空闲确认。

卡片内容：

1. 本会话一句话（可编辑）  
2. 建议写入 One-Pager 的 0～3 条（标到 Conclusions / Open / Next）  
3. 是否更新 Current Focus（建议文案 + 否）  
4. 一键挂到项目（若还没有 `project_id`）

**不弹窗轰炸：** 仅当会话有一定长度 / 有文件变更 / 用户手动触发。短会话默认静默。

### 4.5 Catch-up vs Overview refresh（P1）

| 命令 | 行为 |
|------|------|
| Catch-up | 读最近 N 个 session 摘要 + 当前 One-Pager → **补丁 diff** |
| Overview refresh | 生成整页草稿 → diff 对当前文件 → 用户确认后���换 |

两者都必须预览；默认 Catch-up。

### 4.6 过期提示（P1）

- `last_active_at` 或 One-Pager `updated_at` 超过阈值（默认 14 天）→ 文案「可能过期了」，按钮 Catch-up。  
- 无红灯、无扣分、无强制。

### 4.7 按需「模块图景」（P2，可选）

用户触发「整理模块图景」→ **生成普通 Artifact**（map），不是系统状态机，不反写完成度。  
One-Pager 可链到该 artifact。保持 ADR 非目标：不当成常驻驾驶舱。

---

## 5. 用户场景（验收故事）

### S1 — 学习项目

1. 用户把 `~/learn/raft` 标成项目，mode=Learn。  
2. 填写 North Star：「搞懂 Raft 投票与日志复制」。  
3. 多次随性 session 后，在 Project Home 看见 Focus 与 Teach-back。  
4. 点继续焦点，新会话开头已知目标。  
5. 收工采纳 2 条 Conclusions；Teach-back 自己改了两句。  

### S2 — Solo 交付

1. mode=Ship；Definition of done：「本地可演示重试退避」。  
2. 若干 session 后 Next 保持 ≤3。  
3. Continue Focus 开干，不需要看板。  

### S3 — 拒绝办公化

1. 用户从不建项目，只开 Tasks → 体验与现在一致。  
2. 不出现强制状态、强制百分比。  

### S4 — 跨设备

1. 手机�� remote 打开 Project Home，只读/小改 One-Pager，批一次继续。  

---

## 6. 技术计划（实现分期）

> 实现时 copy 现有 Artifacts / Tasks 模式（store migration、api handler、ui page）。下列为建议切片，细节以代码落地为准。

### P0 — 有封面、能继续（先有体感）

**目标：** 项目列表 + One-Pager 读写 + 挂 session + Continue Focus。

| 层 | 工作项 |
|----|--------|
| Store | `projects` 表；`one_pager` 文件路径；task 可选 `project_id` |
| API | CRUD project；GET/PUT one-pager content；list sessions/artifacts by project；create task with project_id |
| Templates | ship/learn（explore/maintain 可先内置字符串） |
| UI | ProjectsPage；ProjectHomePage（md 编辑/渲染）；Create Project from cwd；Continue Focus 按钮 |
| Prompt | task 创建时写入 system/pinned 短块（仅 Kin host 先做；外置 CLI 能塞初始 prompt 的做，不能则降级为 task description 前缀） |
| i18n | en/zh |
| Export | 备份包含 `~/.kin/projects/**` |

**P0 验收**

- [ ] 可从 cwd 创建项目并生成模板 One-Pager 文件  
- [ ] 可编辑保存；重启仍在  
- [ ] 可将 task 关联到项目；项目页能列出  
- [ ] Continue Focus 创建的新 task 描述/注入含 North Star + Focus  
- [ ] 不建项目的用户路径零回归  
- [ ] 无看板、无 % 完成 UI  

**P0 非目标：** 收工卡片、自动 catch-up、companion、模块图、自动 git 扫描全家桶。

### P1 — 回收与 Catch-up（形成习惯）

| 工作项 | 说明 |
|--------|------|
| 收工提议 | terminal 时生成 suggestion 记录；UI 卡片采纳写回 md |
| Catch-up | 选定最近 N tasks 事件摘要 → 模型或规则生成 patch（优先模型，失败则规则抽取标题列表） |
| Stale hint | 14 天文案 |
| Diff 视图 | 采纳前看 md diff |
| 通知 | 可选：收工提议待处理（勿吵） |

**P1 验收**

- [ ] 长会话结束后可一键写入 0～3 条，文件可见 diff  
- [ ] Catch-up 不直接静默覆盖  
- [ ] 用户清空 Next / 改 North Star 后 Agent 再跑不会擅自改回（除非新提议被采纳）  

### P2 — 更深但不膨胀

| 工作项 | 说明 |
|--------|------|
| Companion | 复用 Artifacts P1 思路，`scope=project_brief` |
| 更好的 inject | 与 ADR 0002 packing 对齐；Focus 进稳定前缀 |
| On-demand map | 「模块图景」→ 普通 artifact |
| Handoff pack | 导出 One-Pager + Focus + 最近摘要，供跨 agent |
| explore/maintain 打磨 | 模板与空状态文案 |

---

## 7. 数据草图（P0 建议）

```sql
CREATE TABLE projects (
  id              TEXT PRIMARY KEY,
  name            TEXT NOT NULL,
  mode            TEXT NOT NULL,           -- ship|learn|explore|maintain
  status          TEXT NOT NULL DEFAULT 'active',
  one_pager_rel   TEXT NOT NULL,           -- relative to projects dir
  soft_progress   TEXT,                    -- fog|can_explain|...
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL,
  last_active_at  INTEGER NOT NULL
);

CREATE TABLE project_roots (
  project_id TEXT NOT NULL REFERENCES projects(id),
  path       TEXT NOT NULL,
  PRIMARY KEY (project_id, path)
);

-- tasks.project_id TEXT NULL  (migration)
```

One-Pager 正文只存文件；可选 `projects.one_pager_updated_at` 冗余。

**写回安全：** PUT 全文覆盖需 `updated_at` 乐观锁，避免手机/桌面互相踩。

---

## 8. API 草图（P0）

```text
GET    /api/projects
POST   /api/projects                  {name, mode, roots[]}
GET    /api/projects/:id
PATCH  /api/projects/:id              {name, mode, status, soft_progress}
GET    /api/projects/:id/one-pager    → {markdown, updated_at}
PUT    /api/projects/:id/one-pager    {markdown, updated_at}  // optimistic
GET    /api/projects/:id/tasks
GET    /api/projects/:id/artifacts
POST   /api/projects/:id/continue     {title?, agent?, ...} → created task
```

P1 追加：

```text
POST   /api/projects/:id/catch-up     → {suggestion_id, diff}
POST   /api/projects/:id/suggestions/:sid/decision  {accept|edit|reject, markdown?}
POST   /api/tasks/:id/recycle-suggest → suggestion against task.project_id
```

---

## 9. UI 草图

### Projects 列表

- 卡片：name、mode 标签、Current Focus 第一行（解析 md 或缓存字段）、last_active  
- 空状态：说明「可选；不建也能用 Tasks」  

### Project Home

```text
┌─────────────────────────────────────────────┐
│ Name                    [Ship ▾]  [Archived]│
│ Focus: …                    soft: can_build │
│ [继续当前焦点]  [Catch-up]  [编辑]           │
├─────────────────┬───────────────────────────┤
│ One-Pager       │ 最近 Sessions             │
│ (reader/edit)   │ 相关 Artifacts            │
└─────────────────┴───────────────────────────┘
```

手机：One-Pager 为主；Sessions/Artifacts �� tab。

### 收工卡片（P1）

紧凑、可跳过、语言像入库不是像打卡。

---

## 10. 提示词 / 文案语气

- 对用户：像「给未来的自己的封面」，不像「周报」。  
- 对 Agent 提议：谦逊、可错、带证据。  
- 禁止：催促完成 sprint、责备过期、假精确进度。  

---

## 11. 风险与缓解

| 风险 | 缓解 |
|------|------|
| 变成第二个笔记应用 | 固定骨架；一项目一页；不做双向链接网 |
| Agent 乱改目标 | North Star 保护区 + propose/accept |
| 用户不愿维护 | 不强制；P1 收工 20 秒；无项目零惩罚 |
| 与 Artifacts 概念重叠 | 文案区分：产物库 vs 项目封面；存储可分可合但 UX 分入口 |
| Continue 注入过长毁上下文 | 硬预算 + ADR 0002 稳定前缀 |
| 外置 Claude/Codex 难注入 | 降级为 task 初始 message / description；不阻塞 P0 |

---

## 12. 决策清单（实现前拍板）

- [ ] One-Pager 存 **独立 projects 目录** vs **Artifacts kind=project_brief**（推荐独立目录 + Project 入口）  
- [ ] P0 mode 是否只上 **ship + learn**  
- [ ] Continue 对 `claude-code` / `codex` 的注入通道分别是什么（description / 首条 user / 文件 drop）  
- [ ] Catch-up 是否依赖 Kin host 模型，还是允许外部模型（推荐：有 provider 则用，无则规则 fallback）  
- [ ] Nav 文案：`Projects` / `项目` 是否比 `Overview` 更清晰（推荐 Projects）  

---

## 13. 建议排期（相对，非日历）

| 切片 | 依赖 | 体感 |
|------|------|------|
| P0 | Artifacts P0 已可参考 | 「终于有个项目封面 + 一键续上」 |
| P1 | P0 + 某 agent 摘要能力 | 「随性干完能收回去」→ 真粘性 |
| P2 | Artifacts companion 模式 | 深用，不挡前两步 |

**推荐顺序关系：**  
Artifacts P1（陪读）与 Project P0 **可并行**；Project P1 的 companion 最好复用 Artifacts P1 的线程模型。

---

## 14. 文档落地（本仓库）

| 文件 | 作用 |
|------|------|
| [ADR 0008](../adr/0008-project-one-pager.md) | 决策与非目标 |
| 本计划 | 规范 + 分期 + 验收 |
| [TODO.md](../TODO.md) | 可勾选 backlog |
| 日后 SYSTEM_DESIGN | P0 开工时补一小节对外快照 |

---

## 15. 一页总结（给自己）

**做：** Project 容器 + 一页用户拥有的 One-Pager + Continue Focus +（稍后）收工补丁。  
**不做：** 看板、KPI、强制整理、overview session 当真源、自动 CEO 舱。  
**气质：** 随性开发保留；结构在封面生长；Agent 是副编辑，用户是主编。

## 16. Cover density — Pulse (shipped slice)

One-Pager felt empty as a blank template. Add a **structured cover**:

1. User sections: 项目描述 / North Star / Focus / 结论 / 下一步 / 模块笔记
2. **Pulse strip (UI)**: session + commit heatmaps, window 30/90/180d, hot modules
3. **Managed auto block** in markdown between `<!-- kin:auto:start/end -->` — refresh merges without overwriting user text
4. Rule-based next-step suggestions first; LLM narrative refresh can come later as optional Catch-up
5. No guilt KPI; soft signals only

APIs: `GET /api/projects/:id/pulse`, `POST /api/projects/:id/pulse/refresh`
