# Box lanes (rsi/runtime/box)

Extra RSI worker capacity on a Linux box, for `executor: cloud` slices. The box has no GitHub write access and no inbound route, so a sync cycle moves
files in both directions through an agent that has both a Mac shell and the box (CopyToBox / CopyFromBox). Everything between the transfers is automatic.

## Status: deactivated

Box sync is paused. `state/BOX_OFF` says:

> box sync routine paused 2026-11-15 21:15; remove this file when it is resumed

While that file exists, `common.sh` caps cloud claims (`RSI_CLOUD_MAX=2`) and `run.sh` skips
`box-pack.sh`, so this code adds no capacity as long as the file is there.

To reactivate: deploy `box-side/*` flat into `/workspace/box-lane` on the box (that directory is the
proxy's cwd), copy `litellm.yaml.example` to `/workspace/box-lane/litellm.yaml` and set your gateway
host in it, export `VOLCENGINE_API_KEY` in the environment only (never on disk, never in the repo),
remove `state/BOX_OFF`, then start `supervisor.sh`. Briefs packed for the box remain public-repo-only
by the pack's own contract. Before reactivation, also port the ingest guards from `nas/ingest-nas.sh`
(lane-active, slug lock, ancestry, dirty tree) into `ingest-box.sh`; this publish is byte-for-byte and
does not carry them.

### Landing note (control tree)

If a control tree still carries untracked copies of `rsi/runtime/box/README.md` or
`rsi/runtime/box/box-side/start-proxy.sh`, landing this directory pins it: those copies differ from
the tracked ones, so `run.sh`'s `adopt_untracked_collision` refuses to sync and `--sync-check` exits
1. Delete the two before the next sync (keep `box-side/litellm.yaml`, which the repo-root
`.gitignore` rule covers); the other 12 files are byte-identical and are adopted automatically.

```
Mac  box-pack.sh        take untaken state/cloud/*.json claims (taker=box), write state/box/xfer/in.tgz (+acks.txt)
 └─ CopyToBox in.tgz -> /workspace/box-lane/xfer/in.tgz
box  box-inbox.sh       unpack as queued jobs;   supervisor.sh (always running) starts up to 3 box-lane.sh at once
box  box-lane.sh SLUG   worktree off origin/main -> worker (Claude Code -> litellm gateway -> Volcengine deepseek-v4.1-flash)
                        -> self-check (tsc, UI inventory ratchet, full vitest; one fix round) -> git bundle + PR body
box  box-outbox.sh      pack finished jobs -> xfer/out.tgz
 └─ CopyFromBox out.tgz -> Mac state/box/xfer/out.tgz
Mac  ingest-box.sh      push rsi/<slug> from the bundle, open the PR, record it like a lane, release the claim, kick merge.sh; acks go with the next pack
```
The merge lane, rework (sendbacks run on Mac lanes) and merged.log work exactly as for local PRs.

Box specifics: no magpie (macOS app); `litellm` proxy on 127.0.0.1:3425 translates Anthropic /v1/messages to the Volcengine OpenAI-compatible endpoint, same model
aliases and `[1m]` suffix as the Mac. `VOLCENGINE_API_KEY` comes from the process environment only (never on disk, never in the repo); `proxy.key` is a local random token for the gateway.
Start: `nohup setsid ./supervisor.sh >> logs/supervisor.log 2>&1 &` (needs VOLCENGINE_API_KEY in env). Stop: `touch STOP`. Lanes: `BOX_MAX_LANES` (3), memory floor `BOX_MIN_AVAIL_MB` (2500), heavy slots `RSI_HEAVY_SLOTS` (2).
