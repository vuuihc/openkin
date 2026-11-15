# NAS lanes (rsi/runtime/nas)

Extra RSI worker capacity on Ethan's LAN NAS (UGREEN DX4600, UGOS Pro). The Mac can SSH to it (`Host nas` in `~/.ssh/config`), so the loop is **unattended and Mac-driven**: no CopyToBox hop, no inbound ports on the NAS stack.

The NAS CPU is weak (Celeron N5105, 4 cores) but RAM is plentiful. Lanes do **agent thinking only**. Full `tsc` / UI inventory / vitest run on the Mac under `heavy.sh` after the result is fetched.

```
launchd every 20 min + run.sh pulse ─► pulse-nas.sh
  1. ingest-nas.sh     finished jobs: fetch bundle, heavy.sh self-check, push rsi/<slug>
                       (never force), open the PR, cloud-release, kick merge.sh
  2. if a NAS lane is idle:
       claim a state/cloud/*.json brief with no taker (never steal taker=box or taker=nas)
       set taker=nas, heartbeat claimed_at
       ship brief + git bundle of origin/main over ssh
       docker exec nas-lane.sh in the isolated container (Claude Code → host magpie :3425)
```

## Stack

- Location on the NAS: `/home/zhushihao/kin-rsi-nas` (volume1 NVMe, **not** the UGOS `/` overlay).
- Isolated Docker Compose project `kin-rsi-nas`: one `worker` container, **user-defined bridge `kin-rsi-nas` only** (no host/macvlan, does not join existing networks, no published ports, no privileged).
- Limits for the whole stack (up to 2 lanes share it): **1.0 CPU, 5 GB RAM**.
- Image: Node 24 + npm, git, Python 3, Claude Code CLI. No secrets in the image.
- Claude talks to the **already-running** NAS magpie on port 3425 via `host.docker.internal` (`extra_hosts: host-gateway`). Model aliases match the Mac `~/.claude/settings.json`: workers `volcengine-gw/volcengine/deepseek-v4.1-flash[1m]`, opus alias `volcengine-gw/kimi-k3.1-pro[1m]`. The gateway key is copied to `~/kin-rsi-nas/secrets/magpie.key` (mode 600) at install; magpie config is not modified.
- OpenClash VM, libvirt, Tailscale, openkin-hub, and magpie config are never touched.

## Lanes and guards

- `NAS_MAX_LANES=2` (default). Lane 2 starts only when NAS 1-minute load `< 3` and `MemAvailable > 6 GB`.
- New work is skipped if load `>= 5` or available RAM `< 3 GB`.
- `touch rsi/state/PAUSE` also stops the NAS pulse.

## Operate

- Install the stack (once): `rsi/runtime/nas/install-nas.sh`
- Smoke `claude -p`: `rsi/runtime/nas/smoke-nas.sh` (expects `NAS_LANE_OK`)
- Pulse now: `rsi/runtime/nas/pulse-nas.sh`
- Reinstall the launchd job: `rsi/runtime/launchd/install.sh nas`
- Revert: `ssh nas 'cd ~/kin-rsi-nas/compose && docker compose down'` and `launchctl bootout gui/$(id -u)/com.ethan.kin-rsi-nas`. Data stays in `~/kin-rsi-nas` until you delete it. The Mac job is also removed by deleting `~/Library/LaunchAgents/com.ethan.kin-rsi-nas.plist`.

## Magpie auth (do not edit magpie config from these scripts)

`MAGPIE_WEB_KEY` is the browser UI key only. The worker container reaches magpie via `host.docker.internal:3425` (host-gateway), which magpie treats as a remote caller, so it needs an **enabled gateway / caller key** in `~/kin-rsi-nas/secrets/magpie.key` (mode 600).

install-nas.sh will seed that file from `MAGPIE_WEB_KEY` if it is empty, but a smoke `claude -p` will fail with "not an enabled magpie gateway key" until you replace it. Adding a dedicated key is a magpie config change and is **not** done automatically:

```bash
ssh nas 'docker exec magpie magpie gateway-key add kin-rsi-nas'
# write the printed sk-magpie-key-… into ~/kin-rsi-nas/secrets/magpie.key (mode 600)
```


A dedicated key named `kin-rsi-nas` (id `ea912749d1ed091a4c0f088a`) was added with approval. Revert the key (does not delete the secrets file):

```bash
ssh nas 'docker exec magpie magpie gateway-key remove ea912749d1ed091a4c0f088a'
```

Then remove `~/kin-rsi-nas/secrets/magpie.key` if you also want the local copy gone. Do not reuse the existing `openclaw` or `hermes` caller keys. Do not change magpie providers, ports, or routing.
