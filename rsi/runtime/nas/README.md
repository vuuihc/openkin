# NAS lanes (rsi/runtime/nas)

Extra RSI worker capacity on a LAN NAS (UGREEN DX4600, UGOS Pro). The Mac can SSH to it (`Host nas` in `~/.ssh/config`), so the loop is **unattended and Mac-driven**: no CopyToBox hop, no inbound ports on the NAS stack.

The NAS CPU is weak (Celeron N5105, 4 cores) but RAM is plentiful. Lanes do **agent thinking only**. Full `tsc` / UI inventory / vitest run on the Mac under `heavy.sh` after the result is fetched.

```
launchd every 20 min + run.sh pulse ─► pulse-nas.sh
  0. bounded ssh probe (unreachable NAS = no remote work this round)
  1. ingest-nas.sh     finished jobs: fetch bundle, heavy.sh self-check, push rsi/<slug>
                       (never force), open the PR, cloud-release, kick merge.sh
                       jobs are marked `ingested` on the NAS + acked locally: a second pulse does nothing
  2. reconcile         status=running with no nas-lane.sh process, or queued/running older than
                       NAS_JOB_MAX_SECS (3900s), is marked failed so it cannot hold a slot forever
  3. if a NAS lane is idle:
       claim a state/cloud/*.json brief with no taker (never steal taker=box or taker=nas)
       set taker=nas under state/lanes/.flock (atomic replace), heartbeat claimed_at
       ship brief + git bundle of origin/main over ssh (every call bounded)
       docker exec nas-lane.sh in the isolated container (Claude Code → host magpie :3425)
```

## Stack

- Location on the NAS: `~/kin-rsi-nas` (volume1 NVMe, **not** the UGOS `/` overlay). The absolute path is resolved at install time from the NAS account's `$HOME` and written to `compose/.env`; no account path is committed.
- Isolated Docker Compose project `kin-rsi-nas`: one `worker` container, **user-defined bridge `kin-rsi-nas` only** (no host/macvlan, does not join existing networks, no published ports, no privileged).
- Limits for the whole stack (up to 2 lanes share it): **1.0 CPU, 5 GB RAM**.
- Image: Node 24 + npm, git, Python 3, Claude Code CLI. No secrets in the image.
- Claude talks to the **already-running** NAS magpie on port 3425 via `host.docker.internal` (`extra_hosts: host-gateway`). Model aliases match the Mac `~/.claude/settings.json`: workers `volcengine-gw/volcengine/deepseek-v4.1-flash[1m]`, opus alias `volcengine-gw/kimi-k3.1-pro[1m]`. A caller key is mounted read-only at `/secrets/magpie.key`; magpie config is not modified by these scripts.
- OpenClash VM, libvirt, Tailscale, openkin-hub, and magpie config are never touched.

## Lanes and guards

- `NAS_MAX_LANES=2` (default). Lane 2 starts only when NAS 1-minute load `< 3` and `MemAvailable > 6 GB`.
- New work is skipped if load `>= 5` or available RAM `< 3 GB`.
- `NAS_MAX_START_FAILS=2`: after two failed ssh/scp/`docker exec` starts for the same slug the brief is left untaken and skipped, instead of retried every 20 minutes.
- `NAS_JOB_MAX_SECS=3900`: a queued/running record older than this is marked failed and ingested; a `running` record whose `nas-lane.sh` process is gone (container restart, OOM) is marked failed on the next pulse.
- Every remote call runs under a timeout (`NAS_SSH_TIMEOUT=90`, `NAS_XFER_TIMEOUT=600`); a pulse older than `NAS_PULSE_MAX_SECS=7200` is reclaimed, and only if its pid still runs `pulse-nas.sh`.
- `touch rsi/state/PAUSE` also stops the NAS pulse.

## Screenshots and visible UI

NAS workers have no browser. When a finished job changes rendered UI (`ui/src/**/*.tsx|css`, tests excluded) and `rsi/state/shots/<slug>/` has no capture, `ingest-nas.sh` pushes the branch but does **not** open the PR: it writes `rsi/state/nas/hold/<slug>.md` with the exact capture-and-publish command and one line in `rsi/state/needs-ceo.md`. Capture 390x844 and 1100x760, then create the PR. Workers are told to write `Screenshots: pending …` rather than claiming "none".

## Operate

- Install the stack (once): `rsi/runtime/nas/install-nas.sh` (needs a provisioned caller key; see below)
- Smoke `claude -p`: `rsi/runtime/nas/smoke-nas.sh` (expects `NAS_LANE_OK`)
- Pulse now: `rsi/runtime/nas/pulse-nas.sh`
- Reinstall the launchd job: `rsi/runtime/launchd/install.sh nas`
- Regression tests: `bash rsi/runtime/nas/tests/test-nas.sh` (fake ssh/scp/docker/gh; no NAS, no network)
- Revert: `ssh nas 'cd ~/kin-rsi-nas/compose && docker compose down'` and `launchctl bootout gui/$(id -u)/com.ethan.kin-rsi-nas`. Data stays in `~/kin-rsi-nas` until you delete it. The Mac job is also removed by deleting `~/Library/LaunchAgents/com.ethan.kin-rsi-nas.plist`.

## Magpie auth (do not edit magpie config from these scripts)

A browser UI key (`MAGPIE_WEB_KEY`) is **not** a gateway caller key; the worker container reaches magpie via `host.docker.internal:3425` (host-gateway), which magpie treats as a remote caller, so it needs an **enabled gateway / caller key** in `<NAS root>/secrets/magpie.key` (mode 600). `install-nas.sh` never reads or copies a credential out of another container; it only checks that the file exists and prints these instructions when it does not:

```bash
ssh nas 'docker exec magpie magpie gateway-key add kin-rsi-nas'
# write the printed sk-magpie-key-… into <NAS root>/secrets/magpie.key (mode 600)
```

Adding a key is a magpie config change and is done **once, with approval**. To revert it, list the keys and remove the one you added — the id is local state, not something this repository records:

```bash
ssh nas 'docker exec magpie magpie gateway-key list'
ssh nas 'docker exec magpie magpie gateway-key remove <id>'
```

Then remove `<NAS root>/secrets/magpie.key` if you also want the local copy gone. Do not reuse any other caller key. Do not change magpie providers, ports, or routing.
