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

## 3. 三个先于设计的本机事实

这三条是我在动手前（F3 是动手后回头查的）实测的，它们改变了设计，不是脚注。

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

> **2026-10-23 更正**：这条**已经不成立**。写这一层时两处 `gh auth status` 都是
> `The token in keyring is invalid`；实现完成后再测，`/opt/homebrew/bin/gh` 已经是
> `✓ Logged in to github.com account owner (keyring)`，scopes 含 `repo`。是同一台机器上
> 的凭据状态变了，不是当时的判断有误。
>
> **保留这一节的理由**，以及它当初推出的两条设计：**没有凭据是正常状态**（不是错误、
> 更不是阻断）、**读取要有不需要凭据的兜底**——这两条与凭据当前是否可用无关。一台没登录
> 的机器、一个 token 过期的下午，都会回到这个状态。凭据可用只是让已认证那条路现在
> 也能实测（`KIN_GITHUB_LIVE=1` 下的 `TestLiveLookupAgainstGitHub` 因此真的跑了，
> 且正确避开了 PATH 上排第一的 `gh-session-bin` 垫片，见 F1）。
>
> 未变的结论：**不去替用户修凭据**——重新认证是对外动作，由用户决定。

（git 侧另说：`credential.helper` = `osxkeychain` + `cache`，
`git push` 走的是系统钥匙串，和 `gh` 的 token 是两回事，可能仍然可用。**但不去替用户修凭据**——
重新认证是对外动作，由用户决定。）

### F3 — 垫片不只挡了 `gh`，**`git` 也被挡了**，而 Kin 的 git 走的是 PATH

F1 只查了 `gh`。实现 P0a 的读路径时回头查了一次：`~/.lody/gh-session-bin/<session-id>/`
里装的是**整个 `git-*` 家族**（`git`、`git-add`、`git-am`……），而且那个目录在
`dev.openkin.node` 这个 launchd job 的 `EnvironmentVariables.PATH` 里出现**两次**，
都在 `/usr/bin` 和 `/opt/homebrew/bin` 之前。

**用 daemon 自己的 PATH 实测**（不是从 `type -a` 推的）：

```
LookPath(git ) = "~/.lody/gh-session-bin/<session-id>/git"
LookPath(gh  ) = "~/.lody/gh-session-bin/<session-id>/gh"
```

而 Kin 解析 git 就是这个方式：

| 位置 | 代码 |
|---|---|
| `internal/workspace/manager.go:34` | `path, err := exec.LookPath("git")` |
| `internal/workspace/anchor.go:83` | `exec.LookPath("git")`（`NewAnchorResolver`） |

→ **今天 daemon 的每一次 git 操作都跑在另一个产品的会话垫片里**：probe、worktree add、
diff、merge、finalize，**以及读路径推导 repo 坐标用的那两条**
（`rev-parse --show-toplevel`、`remote get-url origin`）。实测那次 `git clone` 的 stderr
上就带着 `[Lody GitHub] {"source":"personal","stage":"acquire","code":"credential_unavailable"}`
这样的遥测行（clone 最终成功，垫片退回了本地路径）。

按严重程度：

1. **P0b 的 `git push` 会经过 LODY 的凭据代理。** 那是 P0 的写路径，也正是
   `github-command-credentials.md` 禁止的形态。**所以 P0b 的前置条件不是"写完 push"，
   而是先有一次"拒绝垫片"的 git 解析**——与 §6 的 `gh` 解析器同规格：候选绝对路径，
   拒绝 `gh-session-bin` 之下的任何候选。
2. **不能只修 `gh`。** 读路径今天就在用垫片跑 `git remote get-url`，只是它只读一个
   URL、不带凭据，所以没有立刻显形。要做的是**一处共享的可执行文件解析**，`git` 和
   `gh` 都用它；P0a 已经写好的 `internal/github/gh.go` 是它的雏形，P0b 时应提到
   两者都能用的位置。
3. **这不是"现在就坏了"**：垫片是透传代理，退出码和输出目前是对的。它的问题是
   **边界被第三方占着**——失败模式取决于另一个产品的行为，而那个行为不由我们决定。
   所以它是"必须在写路径之前解决"，不是"线上着火"。

**未验证**：垫片对 `git remote get-url` 的输出是否与真 git 逐字节一致（只比对了本例的
URL）；以及垫片在 git 操作失败时的退出码是否原样透传。

**已解决（P0b 之前）**：`internal/toolpath` 是 `gh` 和 `git` 共用的那一份解析器，
`internal/github/gh.go` 与 `internal/workspace/{git,manager,anchor}.go` 都改成调它。
三件事值得记下来：

1. **解析顺序**：显式覆盖（`KIN_GH_PATH` / `KIN_GIT_PATH`）→ 常见安装位置 →
   PATH（过滤掉被拒绝的目录）。覆盖值指向垫片时**报错而不是回退**——设了它的人是有意的，
   悄悄换一个二进制更糟。
2. **只解析二进制不够，子进程的 PATH 也要重写**：git 自己会通过 PATH 找
   `git-remote-https` 和凭据 helper，gh 自己会调 git。所以 `execGit.Run` 和 `ghEnv()`
   都把垫片目录从交给子进程的 PATH 里删掉（`toolpath.SanitizeEnv`）。
3. **本机的实际落点**：`/opt/homebrew/bin/git` **不存在**（只有 `/usr/bin/git`，
   Apple Git 2.50.1），所以 git 落到 `/usr/bin/git`；`gh` 落到 `/opt/homebrew/bin/gh`。
4. **PATH 不是唯一一扇门**（审查中逐条验证后补上）：
   - **`GIT_EXEC_PATH`**：git 找 helper 时它排在 PATH 前面。子进程里值指向被拒目录时
     直接删掉这个变量，git 会回落到自己编译进去的位置；用户自己的值原样保留。
   - **`GIT_CONFIG_COUNT` / `GIT_CONFIG_KEY_n` / `GIT_CONFIG_VALUE_n`**：垫片就是用它把
     凭据 helper 注进来的（本机会话环境里确实有一条清空 `credential.https://github.com.helper`
     再加一条 `!node "…/.lody/…"` 的组合）。这是一组被 count 约束的整体，删一个成员就
     改变了其余成员的含义，所以**要么整组留、要么整组删**；只有当某个值带上了被拒产品的
     指纹时才整组删，用户自己注入的配置不受影响。`GIT_CONFIG`、`GIT_CONFIG_SYSTEM`、
     `GIT_CONFIG_GLOBAL`、`GIT_ASKPASS` 也按路径判定。
   - **相对路径**：子进程会换工作目录，所以 `bin` 这样的 PATH 条目（以及覆盖值里的
     `tools/git`、裸文件名 `git`）是在 daemon 目录里判定、在仓库目录里使用的。`Resolve`
     现在返回的一定是**判定过的那个文件的绝对路径**（`os/exec` 对相对 `Path` 是在 chdir
     *之后*解析的，这是实测不是推断），`FilterPATH` 直接丢掉相对条目。
   - **state dir 本身是符号链接时**：比对根以前只有未解析的那一种拼法，而候选路径是解析
     过的，于是物理上位于其中的二进制能过关。现在两种拼法都比。
   - **push 那条路上的门**（第二轮补上）：`GIT_SSH`、`GIT_SSH_COMMAND`、
     `GIT_PROXY_COMMAND`、`SSH_ASKPASS`。前两个是 git 连远端时真正执行的程序（`GIT_SSH_COMMAND`
     是一整条命令行，交给 shell 跑），后两个在途中被调用；任何一个名字里带垫片，都会在
     **每次 push** 时被执行，正是在那条搬代码的路上。被拒就删掉，git 回落到 `ssh`。
   - **shell 拼法**：`Refuse` 是词法的，`~/.lody/...` 里的 `~` 不展开，而 `filepath.Abs`
     会把 `~` 当成工作目录下的一个目录名。现在先按 shell 的规则展开 `~`／`~/` 再判定——
     `~/bin/git-askpass` 这种"干净目录里指向垫片的符号链接"就是靠这一步才现形的。
   - **但只对绝对路径做路径判定**：这条是写测试时被自己的守卫反咬出来的。`GIT_SSH_COMMAND`
     是命令行不是路径，`filepath.Abs("ssh -i ~/.ssh/id_ed25519")` 会落到 daemon 自己的
     工作目录——如果那个目录恰好在被拒的 state dir 之下（本机就是：worktree 全在
     `~/.lody` 下面），用户自己的 `GIT_SSH_COMMAND` 会被无故删掉，`GIT_CONFIG_VALUE` 里
     一行 `!f() { … }` 同理。所以路径判定只对展开后仍是绝对路径的值做，相对值和命令行
     只做指纹判定。
5. **`WaitDelay` 把成功的 git 变成了失败**（第二轮审查抓到，P0a 自己引入的）：给 `execGit`
   加管道宽限期（`cmd.WaitDelay = 2s`）是为了不让一个被 git 落下、还攥着 stdout 的子进程
   （clean filter 之类）把 `Wait` 永远挂住。但 `os/exec` 的语义是：**进程自己退出码 0、
   只是管道没关**时，`Wait` 返回的就是 `exec.ErrWaitDelay` 本身——不是 `ExitError` 的包装。
   于是"读成功"被报成了"失败"。实测（`sh -c 'sleep 30 & echo done'` + `WaitDelay: 1s`）：
   1.008s 返回、exit status 0、`errors.Is(err, exec.ErrWaitDelay)` 为真、`errors.As(*ExitError)`
   为假。改法：认出它并按成功返回（已经读到的 stdout 就是答案）；`context` 的两种错误仍
   排在它前面，因为 ctx 被取消时 `Wait` 返回的是 ctx 的错误。

`internal/toolpath` 的测试覆盖拒绝规则（垫片目录、符号链接、大小写、相对路径、
产品 state dir、state dir 是符号链接）与解析顺序；`internal/workspace/git_test.go` 另钉两条
接线：子进程 PATH 里不再出现垫片，以及覆盖值指向垫片时不返回任何 git。每一条守卫都做过
"把守卫删掉、看测试是否变红"的验证——其中相对 PATH 条目那条一开始是**假绿**：本仓库正好
位于被拒的 state dir 之下，相对条目因为另一个理由被拒，测试在缺守卫时照样通过，所以它现在
自带一个临时工作目录。仍然**明确不覆盖**的是：干净目录里指向垫片的 helper 符号链接——子进程
会按什么名字去找 helper 没有一份固定清单可查。

第二轮补的四条守卫也各自做过删掉变红：四个远端程序变量各自变红；`~` 展开删掉后
`~/bin/git-askpass` 那条变红（同一表里的 `~/.lody/bin` 靠指纹本来就拦得住，所以它只算
记录真实拼法）；`filepath.IsAbs` 这一层删掉后，`TestSanitizeEnvKeepsACommandLineValue`
变红——它把 HOME 换成临时目录、再 `Chdir` 进 state dir，就是为了不依赖本仓库恰好长在
`~/.lody` 下面。`WaitDelay` 那条同规格：把 `ErrWaitDelay` 分支去掉，测试报出的正是审查里
那句话——`exec: WaitDelay expired before I/O complete`。

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

### 8.2 失败只说一遍：原因在行上，降级在面板上

`last_error` 属于**行**，`notice` 属于**这一次读取**。P0a 的面板最初两个都渲染，
于是同一句话在一张卡片上出现了两次——顶部一条灰的、卡片底部一条红的，
因为 `SnapshotForTask` 当时把 `cached.LastError` 也抄进了 `snap.Notice`。

现在各说各的：失败原因留在行上，也就是面板渲染它的地方（卡片底部、"上次观测于…"旁边）；
`notice` 只留"这次读取降级了"的话（匿名读、限流退避）。§10 验收第 4 条要的
"上次观测于 <时间>，本次查询失败：<原因>"因此正好落在一处，而不是拆成两处。
`TestSnapshotKeepsAFailedAttemptOnItsRowNotInTheNotice` 钉住这条。

路由本身的三个答案（200 空快照 / 502 组装失败 / 503 未配置）在
`internal/api/github_pr_test.go` 里直接打 HTTP，因为控制台就是靠状态码分流的。
其中 200 那条同时断言 `"observations":[]`——回头改坏成 `null` 会在这里红。

### 8.3 跟随查询的循环，别把"派生出来的状态"当信号

读路径在响应背后起了一个后台查询，所以 `refreshing: true` 时面板要跟着轮询，
否则"暂无 PR"会被当成答案。这里踩了一个值得记下来的坑：

轮询的 effect 依赖写成 `[following, load]`。而 `following` 是从
`pollDecision(refreshing, polls, MAX_POLLS)` 派生出来的**字符串**——在 `polls` 从 0 走到 11
的整个区间里它一直是 `"poll"`，`load` 又是 `useCallback` 稳定的，于是依赖不变、
effect 不重跑、**只发出一次轮询就彻底安静**：转圈、按钮禁用、daemon 已经拿到的答案
再也读不到。实测（同一个 stub 响应、同一个组件）：

| 依赖 | 36 秒内的请求 | 结果 |
|---|---|---|
| `[following, load]` | 2（首次 + 1 次轮询，t=1511ms） | 卡在转圈，刷新按钮**一直禁用** |
| `[following, polls, load]` | 13（首次 + 12 次，间隔 1502ms） | 18.1s 后停下，出"后台仍在查询"，按钮解禁 |

（上表是在"effect 从 `following` 分支 + 把 `polls` 补进依赖"那一版上测的；下面说的最终写法
把正文换成直接读 `refreshing`/`polls`，同一套 stub 下重测仍是 13 次、同样在 18s 停下。）

原因是计数器把信号**从派生值里拿掉了**：`useMachines.ts` 那种写法能成立，是因为它的依赖
（`current.at`、`current.failed`）每次尝试都会变；这里刻意用一个计数器，就是为了让"状态"
在区间内不动。于是把它放回依赖只是修好了症状——依赖表里仍然有一个"正文没读过的变量"，
下一个人照样可以把它当噪音删掉。**改法是让 effect 直接读两个原始输入**
（`refreshing`、`polls`），派生的 `following` 只留给渲染：

```js
useEffect(() => {
  if (!refreshing) { setPolls(0); return; }
  if (polls >= MAX_POLLS) return;
  const timer = setTimeout(() => { setPolls((n) => n + 1); void load(); }, POLL_INTERVAL_MS);
  return () => clearTimeout(timer);
}, [refreshing, polls, load]);
```

这样两个依赖都在正文里出现，删掉任何一个都必须先删掉一行逻辑，而不是删掉一行看似没用的
依赖。`pollDecision` 保留给渲染用（按钮禁用、卡片文案），是**同一条规则的另一种表述**，
两处必须一致——这是这次改动唯一的代价。

**第二轮：起始就预约下一次 = 读可以重叠。** 上面那版把 `polls` 补进依赖之后，计时器在
*发起*读的时候就重新上弦，于是比间隔慢的读会互相重叠，**旧答案能盖掉新答案**——包括把
"已经查到 PR"盖回"仍在查询"，以及在面板关闭后还留着最多 12 个未决请求。改法：**这一次读
结束之后再预约下一次**，并且给这次读一个上限（15s，用 `AbortController`）——否则一个永不
回答的请求会把循环、连同那个"仍在查询"的禁用按钮一起挂住，而那正是这一串改动要修的那个
bug。实测（stub 把每次读按住 3s）：

| 版本 | 35 秒内的请求 | 同时在飞的请求 | 结束状态 |
|---|---|---|---|
| 起始预约 | 12 次（每 1.5s 一次，重叠） | 最多 12 | 读到一半就烧完预算 |
| 读完再预约 | 9 次（间隔 4.55s ≈ 1.5 + 3） | **1** | 预算耗尽，出"后台仍在查询"，按钮解禁 |

另外两处：真正会重叠的两个读是**首读**和用户在首读未回时按下的**手动刷新**，而旧答案不是
新状态——用一个递增的序号决定"哪个读有权发布"，手动刷新一开始就作废在飞的读；以及
`上次观测于…` 是渲染时算的，面板开着不动就会一直说"刚刚"，现在按任务列表同样的写法每秒
tick 一次。

> **未钉住的部分**：轮询的**接线**（依赖表本身、读完再预约、序号判定）没有自动化测试。
> 仓库的 vitest 跑在 node 环境，没有 jsdom / testing-library，412 个测试全是纯函数测试；
> 为一个 effect 引入一套 DOM 测试栈，比这条 bug 本身重。所以接线的证据是浏览器里的 A/B
> 实测（上面两张表），而 `pollDecision` 的规则由纯函数测试覆盖。要给组件加测试环境的话，
> 属 P6——在那之前，这一块属于"改了就靠实测复核"的地方。

同一个改动顺带补了两处：预算耗尽时**任何** lead 行（不只"从未查询过"那种）都会说
"后台仍在查询"；以及首次打开、一行都还没有时，`refreshing` 为真就说"正在查询"，
而不是"尚未查询此分支"——后者读起来是结论，而它恰恰不是。

**第三轮：读可以重叠之后，"信号真的到 fetch 了吗"和"谁有权发布"。** 第二轮留下的两处，
审查里都点到了：

1. **读没有把 signal 交给 fetch。** `load` 收了 `AbortController` 的 signal，却只在
   `await` 结束后看一眼 `signal.aborted`；`getTaskPullRequest` 根本不接受 signal（`apiFetch`
   支持 `{signal}`，`waitSessions` 就在用）。于是 15s 的上限只结束了**等待**，请求本身还在
   路上——传输层可能是连到另一台机器的 relay，一个没人等的读也是一次往返。改法：
   `getTaskPullRequest(id, signal?)` 把 signal 透传给 `apiFetch`，被放弃的读在传输层被取消；
   abort 引发的 reject 由 `load` 里原有的 `signal?.aborted` 分支吃掉，不会变成一行错误。
   实测（stub 记录每个请求的 signal）：面板打开再按 Esc 关掉，在飞的那个读
   `signal.aborted === true`（改动前每个读 `hasSignal` 都是 false、aborts 为空）；正常轮询
   7 次读全部带 signal，同时在飞仍是 **1**、间隔 4.004s（≈2.5s 读 + 1.5s 间隔）——补 signal
   没有动第二轮的节奏。
2. **发布权按"请求开始"排序，而不是按"数据新旧"。** 到 P0a 为止的规则是"号最大的读才能
   发布"，手动刷新在**开始**时取号。审查提出的场景是：一个在点按**之前**上弦的轮询计时器
   在刷新途中开火、取到更大的号，读到的是刷新前的缓存却赢过刷新结果。
   **实测这一条不可达，原因是按钮的 disabled 属性**：让按钮可点的状态（`refreshing` 为假，
   或 `polls` 用完预算）恰好就是让轮询计时器被清掉的状态——两者由同一组依赖决定，cleanup
   在"让按钮变灰/解禁"的那次提交里跑完，React 也会在派发离散事件前冲掉 passive effect，
   所以"计时器已上弦"和"按钮可点"不会同时成立。但它的处方是对的，所以按不变量落地：
   **刷新落地时再取一次号**，让刷新成为"最新的那个答案"，跑在它期间、读的是旧缓存的读因此
   盖不回来；失败落地时同样取号，免得一个赛跑的读把"为什么没有新数据"那句话清掉。规则
   从此长在写者身上，而不是长在按钮的 disabled 属性上——那是个后人可以随手删掉的 UI 约定。
   仍然**没有自动化测试**（见下），浏览器里的实测是：stub 让读 8s、刷新 0.6s，先开面板
   （首读在飞）再按刷新，刷新先落地显示 `#222 FRESH`，8s 后旧读带着 `#111 STALE` 回来，
   卡片仍是 `#222`。

> **未钉住的部分**：轮询的**接线**（依赖表本身、读完再预约、序号判定）没有自动化测试。
> 仓库的 vitest 跑在 node 环境，没有 jsdom / testing-library，413 个测试全是纯函数测试；
> 为一个 effect 引入一套 DOM 测试栈，比这条 bug 本身重。所以接线的证据是浏览器里的 A/B
> 实测（上面几张表），而 `pollDecision` 的规则由纯函数测试覆盖。第三轮里**能下沉到纯函数
> 层的那一半下沉了**：`signal` 是否真的交给 fetch 由 `ui/src/api/client.signal.test.ts`
> 钉住（把 `{ signal }` 删掉立刻变红），剩下的"哪个读有权发布"仍属 P6——在那之前，这一块
> 属于"改了就靠实测复核"的地方。

---

## 9. 分步

| 步 | 内容 | 是否碰外部 |
|---|---|---|
| **P0a** | repo 坐标 + `gh` 解析器 + `pr_observations` + 读路径（gh，再匿名兜底）+ 有界 reconciler + 只读 API/面板 | 只读 |
| **P0b** | publish：push + `gh pr create`（描述由 agent 写，从快照 diff 取材），与 finalize 同级 | **写** |
| **P0c** | 评论拉取（issue + review 两类）+ `comments_seen` 游标 + 「回喂 agent」 | 只读 + 投递给会话 |

> **P0b 的前置条件（F3）— 已满足**：git 也做了一次"拒绝垫片"的解析
> （`internal/toolpath`，与 `gh` 共用一份）。`git push` 不再经过 LODY 的凭据代理，
> 所以 P0b 可以直接从"写 push"开始。

P0a 可以先独立验收：**不 publish 也能看到别人开的 PR 的 CI 和评论**。
这样"读"不必等"写"——凭据是否可用、reconciler 是否调好，都不挡住先把面板跑起来。

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
