# Box lanes (rsi/runtime/box)

Extra RSI worker capacity on a Linux box, for `executor: cloud` slices. The box has no GitHub write access and no inbound route, so a sync cycle moves
files in both directions through an agent that has both a Mac shell and the box (CopyToBox / CopyFromBox). Everything between the transfers is automatic.

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
