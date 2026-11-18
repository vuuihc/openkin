# kin-rsi-nas — the NAS worker stack

One Compose project (`kin-rsi-nas`) holding **one container** (`kin-rsi-nas-worker`) that runs at most
**two RSI lanes**. It is the second worker pool: the Mac stays the control plane, and lanes here do agent
thinking only — no `npm ci`, no full vitest, no production build (see `../README.md`).

```
install-nas.sh ──rsync/scp over ssh──► <root>/{compose,nas-side,secrets,work}
                                             │
                          build-up.sh ───────┤ docker compose build && up -d
                                             ▼
                    kin-rsi-nas (bridge, no published ports)
                      └─ worker: Node 24 + Claude Code CLI
                           /work      <- <root>/work        (rw; repos, jobs, logs)
                           /secrets   <- <root>/secrets     (ro; magpie.key)
                           /opt/rsi   <- <root>/nas-side    (ro; nas-lane.sh, claude-env.sh)
                                 │
                                 └─ host.docker.internal:3425 -> host magpie gateway
```

`<root>` is `KIN_RSI_NAS_ROOT`, the install root on the NAS. Nothing here hardcodes an account name:
`docker-compose.yml` interpolates the variable, and `build-up.sh` defaults it to `$HOME/kin-rsi-nas` so a
run on the NAS needs no arguments.

## Invariants — do not let these drift

A reviewer should reject any change that breaks one of these without an explicit decision:

| Invariant | Where |
|---|---|
| No published ports (`ports:` must stay absent) | `docker-compose.yml` |
| No `privileged: true` anywhere | `docker-compose.yml` |
| No `network_mode: host`, no macvlan, no attachment to an existing network | `docker-compose.yml` |
| `no-new-privileges:true` | `security_opt` |
| 1.0 CPU and 5 GB for the whole stack (two lanes share it) | `cpus`, `mem_limit`, `memswap_limit` |
| `pids_limit: 2048`, `init: true`, `restart: unless-stopped` | service block |
| The `secrets` mount is read-only | `:ro` on `/secrets` |
| The magpie key is mounted from `<root>/secrets/magpie.key` and is **never printed** | `nas-side/claude-env.sh`, `nas-side/auth-probe.py`, `install-nas.sh` |
| The container user stays numeric (`1000:10`), matching the host owner of `<root>` | `user:` |

The key rule is the sharp one. `claude-env.sh` reads the file into `ANTHROPIC_AUTH_TOKEN` and never echoes
it. `auth-probe.py` prints only the HTTP status and an error body with the key replaced by `***`.
`install-nas.sh` prints a byte count, never the value. Keep that property in any new script.

`docker-compose.yml` uses a plain `${KIN_RSI_NAS_ROOT}` (no `:?` guard), so a bare `docker compose up`
without the variable set would silently mount `/work`. **`build-up.sh` is the supported entry point**; it
exports the default first.

## What it runs

- Base `node:24-bookworm-slim`, plus `git`, `ca-certificates`, `python3`, `curl`, `bash`, `tini`, and
  `@anthropic-ai/claude-code` from npm.
- `git config --system --add safe.directory '*'` so worktrees owned by the mount's uid are usable.
- `CMD ["sleep", "infinity"]`: the container idles, and `nas-lane.sh` is `docker exec`'d into it per job.
- Model routing comes from `claude-env.sh` and `claude-settings.json` (DeepSeek by default), pointing at
  the host magpie gateway. Both copies of `claude-settings.json` — this one and `../nas-side/` — are
  identical on purpose; update them together.

## Install

`../install-nas.sh` is the Mac-side installer. It:

1. resolves the install root as `NAS_REMOTE`, else `$HOME/kin-rsi-nas` on the NAS over ssh;
2. creates `<root>/{compose,nas-side,secrets,work/{jobs,wt,logs,home/.claude}}`;
3. ships `compose/` and `nas-side/` over tar-over-ssh (UGOS `rsync`/`scp` reject some home paths);
4. copies `claude-settings.json` into `work/home/.claude/`;
5. writes `secrets/magpie.key` (mode 600) from the running magpie container env, or keeps an existing file —
   it never prints the value;
6. clones a bare `origin/main` (falling back to a bundle shipped from the Mac when GitHub TLS is flaky);
7. prefetches `node:24-bookworm-slim` through a mirror when Docker Hub is unreachable, then runs
   `build-up.sh` over ssh with `KIN_RSI_NAS_ROOT` set to the resolved root — so an overridden `NAS_REMOTE`
   mounts exactly what was installed instead of falling back to the default.

Then `../smoke-nas.sh` proves the container can reach magpie (`auth-probe.py`) and that `claude -p`
returns a short answer.

Revert without touching data: `ssh nas 'cd ~/kin-rsi-nas/compose && docker compose down'`. Data stays until
`<root>` itself is removed.

## Proven vs unproven

**Proven on the live host:**

- Lanes complete end to end. Three finished jobs carry `"host": "nas"` and `"status": "done"` in
  `rsi/state/nas/xfer/`: `approval-dup-cta`, `project-cover-rename`, `manage-running-hint`.
- The pulse reaches it. `rsi/runtime/runs/launchd-nas.log` holds hundreds of capacity rows reading
  `allowed=2 running=0 idle_slots=2`, and `pulse-nas.sh` skips cleanly when the container is absent
  (it logs "NAS worker container not running" and exits 0).
- The stack stays up: `kin-rsi-nas-worker` has been running since 2026-11-15 (reported by the loop, not
  re-checked by this slice — publishing the files runs no live NAS command).

**Unproven, and should not be claimed:**

- A fresh host: the install has only ever run on one NAS, so the `$HOME` discovery and the mirror
  prefetch are exercised by one data point.
- The gateway key. `smoke-nas.sh` runs `auth-probe.py` and `claude -p` at install time, but this slice
  found no stored `NAS_LANE_OK` output, so the check is described here as intended, not as recorded
  evidence. Whether `magpie.key` holds a real gateway/caller key or the browser UI key is only reported
  by `smoke-nas.sh` (`not an enabled magpie gateway key`) when it is wrong.
- A hermetic regression test. The stack needs `docker` and `ssh`, and the only suite that could hold the
  cases (`../tests/test-nas.sh`) belongs to the pulse lane; a new suite file has to be wired into
  `scripts/check.sh`, which another open PR owns. This slice has **no** hermetic test by decision — a test
  that only asserted on file contents would be a fake.
- Throughput: 1.0 CPU was chosen for a 4-core Celeron. Every recorded capacity row reads `running=0`,
  so no row shows even one lane active at sample time, let alone two.
- Whether `magpie.key` holds a real gateway/caller key or the browser UI key. `smoke-nas.sh` reports the
  difference explicitly (`not an enabled magpie gateway key`) instead of guessing.
