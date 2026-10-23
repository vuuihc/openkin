# P0 形状：GitHub 集成这一层

> 依据 `docs/plans/2026-10-23-lody-parity.md` §10：**动手前先写清这一层正确的形状是什么，
> 再决定复用哪些、替换哪些。写不出来就说明还没想清楚，不要开工。**
>
> 相关：`specs/local-github-pr-observation.md` · `specs/github-command-credentials.md` ·
> `specs/session-orchestration.md`（LODY 源码）· ADR 0022（anchor 与 remote 规范化）

**状态**：形状已定，待实现。

---

## 1. 这一层到底是什么

先说结论：**PR 不是 Kin 的实体，是对外部世界的一次观测。**

它的 key 是 Kin 今天**已经持久化了**的一对值：

| key 分量 | 今天在哪 |
|---|---|
| `repo` —— `github.com/owner/name` | `workspace.CanonicalRemote`（`internal/workspace/anchor.go:120`），从任意 cwd 的 `origin` 推导，且**已经剥掉 userinfo**，token 不会随 URL 外流（ADR 0022 D7） |
| `head_branch` —— `kin/task/<id>/g<N>` | `task_workspaces.workspace_branch`（`internal/store/workspaces.go:38`），每次 generation 分配时写入 |

所以这一层是**建立在已有派生键之上的 reconciler**，不是新的领域实体。三个直接推论：

**推论一：不需要注册，不需要关联表。**
LODY：*"A remote identifies the repository; only a successful GitHub query establishes
read access."*（`local-github-pr-observation.md`）——remote 本身就是身份。
所以**不加** `projects.remote_url`，**不做**仓库注册界面，**不建** Project↔repo 外键。
（顺带：`workspace_anchors.project_id` 今天**永远是 NULL**，没人写过——我们也不需要它。
那个字段是上一次设计的残留，不是待填的坑。）

**推论二：每个字段都是可失败、可缓存的，所以 schema 必须自己承载「不擦除」。**
查询会失败。因此一行记录要分开存两件事：**最后一次成功的观测**，和**最后一次尝试**
（时间 + 失败原因）。失败的尝试**只写后者**。
LODY 的规则是 *"never invent a PR or erase a previously successful observation"*——
把它做成 schema 的形状，而不是靠代码里的自觉。

**推论三：真正缺的不是数据，是终结动作。**
会话、worktree、diff 都已经有了。断掉的是 diff **之后**。今天 generation 只有一个终结动作：
`finalize` —— 把工作分支 `merge --ff-only` 进你的本地 checkout，然后**删掉 worktree 和分支**
（`internal/workspace/finalize.go:185`、`:223-232`）。全程不出机器。

PR 是**同级的另一个终结动作**：把分支推上去、开 PR、分支留着。
两者回答的是同一个问题——「这份改动去哪」——只是答案不同：

```
                       ┌─ finalize → 进我的本地 checkout，分支消失
diff 审阅完 ───────────┤
                       └─ publish  → 推到远端，开 PR，分支存活
```

**所以 publish 必须是 `finalizeWorkspace` 的兄弟，不是它的一个分支步骤**，
并且**共用同一套前置条件**（工作区干净、HEAD ≠ base、源仓库还在目标分支上）。
把 PR 塞进 finalize 内部会让「本地合并」和「远端发布」共享一个状态机，
而它们的终态、清理策略、失败恢复完全不同。

---

## 2. 从 LODY 拿来的四条规则

| # | 规则 | 出处 | 落到 Kin 的哪 |
|---|---|---|---|
| 1 | remote 即身份，不注册 | `local-github-pr-observation.md` | §1 推论一 |
| 2 | 凭据留在本机；本地项目用原生认证，**不装托管包装器** | `github-command-credentials.md` | §3 F1、§6 |
| 3 | 绝不编造，也绝不擦除上一次成功观测 | `local-github-pr-observation.md` | §1 推论二、§7 |
| 4 | 轮询是有界且共享的，不是每个视图一个循环 | 同上 | §6、§10 |

第 4 条在 Kin 这里有个**硬数字**支撑：GitHub REST 匿名限额是 60 次/小时。
每视图一循环会在一瞬间烧穿；有界的共享 reconciler 是唯一可行解。

---

## 3. 两个先于设计的本机事实

这两条是我在动手前实测的，它们改变了设计，不是脚注。

### F1 — PATH 上的 `gh` 是 LODY 的会话垫片，而且它被注入了 Kin daemon 的 PATH

```
$ type -a gh
gh is ~/.lody/gh-session-bin/<session-id>/gh      ← 排第一
gh is /opt/homebrew/bin/gh                        ← 真正的 gh
```

`~/.lody/gh-session-bin/<session-id>` 在 `dev.openkin.node` 这个 launchd job 的
`EnvironmentVariables.PATH` 里出现了**两次**，都排在 `/opt/homebrew/bin` **前面**。

后果，按严重程度：

1. **执行了错的程序。** Kin 里一句 `exec.Command("gh", …)` 会跑起另一个产品会话目录下的二进制。
2. **流量被改道。** 那个垫片把调用代理到 LODY 的云侧，并往 stdout 打自己的遥测行。
   Kin 的 GitHub 读取会经过第三方基础设施。
3. **它恰好是 LODY 自己禁止的东西。** `github-command-credentials.md` 原话：
   *"Local projects and their worktrees retain native authentication… **Do not install
   managed wrappers**, broker contexts or tokens in these sessions."*
   本机项目**就是**该用原生认证的场景。

→ **设计约束**：Kin **不通过 PATH 解析 `gh`**，改用候选绝对路径，
并且**拒绝任何位于 `gh-session-bin` 之下的候选**。

### F2 — 这台机器上目前没有任何可用的 GitHub 凭据

两处 `gh auth status` 都是 `The token in keyring is invalid`。

这条不是"边缘情况"，它是**当前状态**。所以：

- "没有凭据"必须是**正常可显示状态**，不是错误、更不是阻断。会话循环照常跑。
- 读取需要一个**不需要凭据的兜底路径**（公开仓库的匿名读），否则今天这个功能一次都演示不了。

（git 侧另说：`credential.helper` = `osxkeychain` + `cache`，
`git push` 走的是系统钥匙串，和 `gh` 的 token 是两回事，可能仍然可用。**但不去替用户修凭据**——
重新认证是对外动作，由用户决定。）

---

## 4. 形状

```
                     ┌──────────────────────────────────────────┐
   cwd ──CanonicalRemote──► repo ─┐                              │
                                 ├──► (repo, head_branch) ──► pr_observations
   task_workspaces.workspace_branch ┘         │                  │
                                              │                  │
                    ┌─────────────────────────┴───────────┐      │
                    │                                     │      │
              [读] 观测 reconciler                  [写] publish  │
              有界、共享、只读                    仅用户点击触发   │
                    │                                     │      │
        ┌───────────┴───────────┐              git push ─┘      │
        │                       │              gh pr create      │
   gh（已认证）          匿名 HTTPS（仅公开仓库）                  │
        └───────────┬───────────┘                                 │
                    └──────────► 写入 last-success / last-attempt ┘
                                        │
                                    SSE 事件 ──► 控制台 PR 面板
```

**读**：一个后台 reconciler，只处理"未归档 且 已 publish"的任务对应的 `(repo, branch)`。
固定间隔，有界并发，结果变化时发事件。
**写**：只有两个动作会碰外部——`git push` 和 `gh pr create`——**都只由用户在 diff 上显式点击触发**。

---

## 5. 复用什么

| 复用 | 位置 | 为什么是对的 |
|---|---|---|
| `CanonicalRemote` / `DeriveAnchor` | `internal/workspace/anchor.go:52-136` | 已经给出 token-safe 的 `host/owner/repo`，只需加一个 `github.com/` 主机判定 |
| 分支三元组 | `task_workspaces.workspace_branch` / `target_branch` / `base_oid` | PR 要的 head + base 已经持久化了，不用再推导 |
| 快照 diff 读模型 | `ListSnapshotChanges` / `ReadSnapshotFile`（`internal/workspace/diff.go:338-369`） | PR 描述里的"改了什么"直接取这里，且已发布到控制台 |
| git 运行器 | `internal/workspace/git.go:29-78` | argv-only、不走 shell、强制 `GIT_TERMINAL_PROMPT=0`、stdout 有硬上限——push 也走它 |
| 前置条件检查 | `InspectFinalizable` / `InspectIntegrationTarget` | publish 与 finalize 共用"工作区干净"这条，规则只写一遍 |
| 密钥存储 | `internal/secret` + `secret://` 约定（`internal/provider/secrets.go:31-65`） | **P0 用不到**——但它是将来要做"托管凭据"时的落点 |
| 路由与作用域 | `holderOnly` / `operatorOnly`、`r.Route("/api/tasks/{id}")` | 沿用，不新造 |

## 6. 新建什么

| 新建 | 说明 |
|---|---|
| `gh` 解析器 | 候选绝对路径列表 → 取第一个可执行的、**且不在 `gh-session-bin` 之下**的。找不到就如实说找不到。 |
| `gh` 运行器 | 与 git 运行器同规格：argv-only、`GH_PROMPT_DISABLED=1`、`GH_NO_UPDATE_NOTIFIER=1`、超时、输出上限。**读用 `gh api`（GitHub 原始 REST）而不是 `gh pr view --json`**——后者是 gh 自己的投影，跨版本会漂。 |
| 匿名读 | 到 `api.github.com` 的直接 HTTPS GET，无 token，仅公开仓库。小、独立、**与已认证缓存分开标记**（规则 4）。 |
| `pr_observations` 表 | §7 |
| publish 动作 | `git push --set-upstream origin <workspace_branch>` + `gh pr create`。与 finalize 同级。 |
| PR 路由 | 挂在 `r.Route("/api/tasks/{id}")` 下，沿用 `taskInScope`。 |

---

## 7. 数据模型

```sql
CREATE TABLE pr_observations (
  repo          TEXT NOT NULL,   -- github.com/owner/name，canonical、小写
  head_branch   TEXT NOT NULL,   -- kin/task/<id>/g<n>
  task_id       TEXT NOT NULL,

  -- 最后一次成功的观测；失败时一动不动（规则 3 由形状保证）
  number        INTEGER,         -- NULL = 确认「还没有 PR」，不是「不知道」
  url           TEXT,
  title         TEXT,
  state         TEXT,            -- open | closed | merged
  is_draft      INTEGER,
  base_branch   TEXT,
  head_oid      TEXT,            -- 远端报告的分支头；≠ 本地 HEAD 就该提示 push
  ci_state      TEXT,            -- none | pending | success | failure
  ci_summary    TEXT,            -- JSON：计数 + 失败项名字
  comments_seen INTEGER,         -- 已回喂的最高评论 id
  source        TEXT,            -- gh | anonymous —— 匿名读可能看不到私密内容
  observed_at   INTEGER,

  -- 最后一次尝试，无论成败
  attempted_at  INTEGER,
  last_error    TEXT,            -- '' = 上次尝试成功

  PRIMARY KEY (repo, head_branch)
);
```

三个字段值得单独解释：

- **`number` 可空**，是为了让「确认没有 PR」和「查不到」可区分。查询失败**不写** `number`，
  所以面板能显示"上次看到过 #42，这次没查到"而不是把 #42 抹掉。
- **`head_oid`** 让"PR 落后于工作区"变成可计算的事实，而不是让用户猜。
- **`comments_seen`** 让「拉评论回喂」这件事**幂等**——第二次点只拿到新评论。

---

## 8. 安全边界（硬编码，不交给模型判断）

按 `AGENTS.md` §3a：权限/安全边界可以硬编码，而且应该硬编码。

1. **Kin 永不自动 push。** 只有用户在 diff 上显式点击才会发生。任何后台路径都不碰写操作。
2. **不替用户提交。** 工作区脏 → publish 直接拒绝（复用 `InspectFinalizable` 的检查），
   **不由 Kin 生成 commit**。LODY：*"Commit authorship is independent of network credentials"*——
   署名是独立的一件事，Kin 代签就是伪造作者。
3. **不用 PATH 上的 `gh`**，且拒绝 `gh-session-bin` 下的任何候选（F1）。
4. **Kin 不持有 GitHub token。** P0 全程不引入 token 存储；匿名读无凭据，已认证读借用用户自己的 `gh`。
5. **远端 URL 里的凭据不外流** —— 复用 `CanonicalRemote`，它已经剥掉 userinfo（ADR 0022 D7）。

### 8.1 一处对"被动视图不隐式调第三方"的自觉偏离

`AGENTS.md` 的 External integration UX gates 写着：打开设置或其他被动视图**不得**隐式读
secure-store 密钥或调第三方 API。P0a 的读路径对此有一处**有意的偏离**，记在这里而不是
埋在代码里：

- `GET /api/tasks/{id}/pr` 在缓存过期时会**在请求之外启动一次后台查询**（响应先返回）。
- 但它**不读任何密钥**：凭据来自用户自己的 `gh` 进程，Kin 全程不持有 token（§8.4）。
- 而且没有可行的替代：reconciler 的巡检集合是 `state='open' AND number IS NOT NULL`，
  即**已经成功读到过 PR 的行**。一个全新的分支永远不会被 reconciler 发现——"这个分支
  还没有 PR"这个事实，只有视图路径能第一次学到。做成纯缓存读，面板会永远停在"未知"。
- 边界由三件事守住：**先读缓存**（响应从不等待网络）、**floor**（同一分支
  `failureFloor`/`anonymousFloor` 之内不重复问）、**匿名小时预算 + 限流退避**。
- 用户主动那条路是分开的：`POST /api/tasks/{id}/pr/refresh` 同步等待，且是 `operatorOnly`。

结论：这偏离的是"被动视图无副作用"的字面，服务的是它的本意（不因为打开一个页面就
消耗用户的凭据或配额）。如果将来要收紧，收紧点应该是**把 reconciler 的巡检集合
扩展到"尚无 PR 的活跃分支"**，而不是让视图变纯缓存。

---

## 9. 分步

| 步 | 内容 | 是否碰外部 |
|---|---|---|
| **P0a** | repo 坐标 + `gh` 解析器 + `pr_observations` + 读路径（gh，再匿名兜底）+ 有界 reconciler + 只读 API/面板 | 只读 |
| **P0b** | publish：push + `gh pr create`（描述由 agent 写，从快照 diff 取材），与 finalize 同级 | **写** |
| **P0c** | 评论拉取（issue + review 两类）+ `comments_seen` 游标 + 「回喂 agent」 | 只读 + 投递给会话 |

P0a 可以先独立验收：**不 publish 也能看到别人开的 PR 的 CI 和评论**。
这样 F2（没有凭据）不会卡住整个里程碑。

---

## 10. 验收

对齐计划文档 §6 的 P0 验收句，拆成可执行的三段：

1. 在一个有 GitHub remote 的项目里开会话，改代码 → **面板出现该分支的 PR 状态（此刻应为"无 PR"）**。
2. 点一下 publish → 远端出现分支和 PR；描述包含从快照 diff 得出的改动摘要。
3. 对着会话说「拉 PR 评论、判断对错、对的修掉」→ agent 拿到**新**评论并 push 修复 commit，
   面板的 CI 状态随之变化。
4. **断网 / 凭据失效时**：面板显示"上次观测于 <时间>，本次查询失败：<原因>"，
   已知的 PR 号与链接**仍然在**，会话功能不受影响。

第 4 条是这一层的形状是否正确的真正测试。

---

## 11. 明确不做

- 不做仓库注册、不加 `projects.remote_url`、不填 `workspace_anchors.project_id`（推论一）。
- 不引入 OAuth App、不建 GitHub App、不在 Kin 里存 token（§8.4）。
- 不装 git credential helper、不改用户 git config。
- 不让 PR 成为会话状态机的一部分——它是**旁挂的观测**，PR 查不到不该影响会话能否运行。
- P0 不做 merge / close / review 提交等其它写动词，只做 push + create。
