# W3 — Desktop footprint baseline

Status: complete
Date: 2026-11-01
Workstream: W3 of the client-contract program
Deliverable: `scripts/measure-desktop.sh` + this report

Pre-registered decision rule (from the program plan): **an idle Electron tree
above 400 MB, or growth above 100 MB/hour, means evaluate a light shell;
otherwise no rewrite.**

## Decision

**No rewrite. The idle Electron tree is well below the 400 MB threshold on both
metrics, and the 60-minute soak grew +16.8 MB/h in footprint — below the
100 MB/h trigger — while summed RSS fell.**

| Rule trigger | Threshold | Measured | Triggered? |
| --- | --- | --- | --- |
| Idle tree, footprint | > 400 MB | 197.0 MB median (200.0 MB p95) | No |
| Idle tree, summed RSS | > 400 MB | 318.4 MB median (319.4 MB p95) | No |
| Growth, footprint | > 100 MB/h | +16.8 MB/h (R² 0.75) | No |
| Growth, summed RSS | > 100 MB/h | −28.4 MB/h (R² 0.13) | No |

The footprint growth is real but slow: 192 → 207 MB over 57.9 minutes. At the
same rate for six hours it would add about 100 MB, still far from the 400 MB
idle threshold, but it is the number to watch in a longer soak. The RSS slope
is negative and poorly fitted (R² 0.13), consistent with page reclaim rather
than a leak.

The closest measurement to the threshold is the **session** scenario at
334.7 MB median RSS (347.7 MB maximum, 13% below the threshold); its
footprint is 266 MB. The rule is written against the idle tree, so the
decision does not depend on that scenario.

This is a baseline, not a permanent verdict: the measured tree is a 197 MB
footprint shell that is already heavier than the 180 MB daemon it talks
to. Re-run `scripts/measure-desktop.sh` before any decision that assumes this
number still holds, and treat a long-lived heavy session (large tool output,
artifacts, images) as unmeasured rather than covered by this result.

## What was measured

Two process trees, sampled separately:

- **Electron tree.** The `desktop/dist/main.js` bundle launched by
  `desktop/node_modules/electron` (Electron 33.4.11), plus every descendant at
  sample time: main process, renderer, GPU process, network utility, and the
  crashpad handler when present.
- **`kin` daemon tree.** The supervisor and daemon serving `:7777`, plus any
  descendants. Agent/CLI children of the daemon are reported in separate
  columns so a model process is not counted as daemon overhead.

Two memory numbers are reported for every tree, because per-process accounting
differs:

- **RSS** — `ps -o rss`, summed. macOS reports resident set in 1 KiB units.
  Shared pages are counted once per process, so a sum over a tree overstates
  unique physical memory.
- **footprint** — the `Footprint:` value from `/usr/bin/footprint -p`,
  summed. It tracks the auxiliary `phys_footprint:` ledger (the value
  Activity Monitor's Memory column shows) within about 2% on this machine,
  with the header slightly lower. The report uses the header because that is
  what the script's rows contain and what a rerun will reproduce; the decision
  is unaffected by the difference. Summing it over a tree is also an upper
  bound for the same shared-page reason.

Both totals are therefore upper bounds. The decision rule is applied to both;
if they disagree, the disagreement is reported rather than averaged away.

## Scenarios

| Scenario | Definition |
| --- | --- |
| `idle` | Fresh launch, no navigation. The app lands on `/new` (home). Sampled 25 s after DOM ready, 5 samples 2 s apart. |
| `session` | Fresh launch, then the renderer is navigated to the task with the largest token total among non-running tasks. Sampled 25 s after the task page is ready. |
| `task` | Shell launched first, then a probe task is created through `POST /api/tasks`; the renderer opens it, the run waits for a terminal status, then samples 25 s later. Probe tasks are deleted after each run. |
| `soak` | One launch held idle on the home view for 60 minutes, sampled every 30 s. Growth is a least-squares slope over samples after the first four (the 2-minute launch settling curve). |
| `startup` | Fresh launch, measured from just before spawn to DOM ready and first contentful paint. |

## Method

`scripts/measure-desktop.sh` performs every run itself:

1. Picks a free CDP port and a fresh `--user-data-dir` under the output
   directory, then launches the repo's Electron binary directly against
   `desktop/dist/main.js`. It deliberately does **not** use
   `desktop/scripts/run-electron.mjs`, whose "stop previous dev instance" sweep keys on
   the repo path and would kill a developer's running shell.
2. A tiny launcher in the run directory runs the real bundle and suppresses
   only two side effects: `app.setAsDefaultProtocolClient` (so a short-lived
   measurement instance does not rewrite the system `kin://` handler) and
   focus stealing (`BrowserWindow.show` → `showInactive`, `focus` → no-op).
   The window is still visible and painted; hidden windows are throttled by
   Chromium and would understate both memory and paint timing.
3. Waits for the page through CDP, reads its own
   `performance.getEntriesByType("paint")` and `performance.timing` for the
   startup stages, and polls up to 5 s for a paint entry without moving the
   DOM-ready timestamp.
4. Samples the Electron tree and the daemon tree with `ps` and `footprint`,
   writing per-process rows and per-sample tree totals.
5. Kills only the main process it spawned and that process's descendants, after
   checking the executable path (`lsof -d txt`) is this repo's Electron and
   the process start time still matches the one recorded at spawn. The app
   sets `process.title = "Kin"`, so the command line alone is not a safe
   identity check, and the start time guards against pid reuse.

Statistics: each run's settled value is the median of its samples; across
runs the report gives median, p95 (nearest rank), minimum, maximum, standard
deviation, and coefficient of variation. With n=5, p95 is the maximum — it is
shown to make the small-sample tail explicit, not because it is a stable
percentile estimate.

## Safety and isolation

- The live daemon on `:7777` was **not** restarted, stopped, or reconfigured.
  The shell attached to it as an external daemon, as the desktop shell already
  does on a node-managed machine.
- The only writes to the live daemon were the `w3-probe-footprint-*` tasks in
  the `task` scenario, each deleted with `DELETE /api/tasks/{id}` after
  measurement. All five ids were re-queried after the run and returned 404.
  The probe prompt asks the agent to reply with `ok` and use no tools; the
  working directory is a throwaway git repo under the ignored `.tmp/`
  directory.
- The session scenario opened a task whose `routine_id` was null, so opening
  it did not trigger the console's "opening a routine run marks it read" write.
- The final script refuses to start unless a healthy daemon already answers on
  `:7777`, so the shell's sidecar cannot create one mid-measurement. The
  quoted run is covered by a post-hoc check: the daemon's start time
  (2026-10-31 15:29) precedes the first launch, and its pid was unchanged at
  the end.
- Each run used its own user-data directory and CDP port, so it could not
  collide with the user's running dev shell (singleton lock in
  `~/Library/Application Support/Kin-dev`).
- No process outside the spawned Electron tree was signalled.

## Environment

| Item | Value |
| --- | --- |
| OS | macOS 26.6.2, arm64 |
| Electron | 33.4.11 (devDependency range `^33.2.1`), unpackaged dev bundle |
| Shell entry | `desktop/dist/main.js` built from this worktree |
| Daemon | `kin` 0.0.0-dev on `:7777`, uptime 1 d 6 h at measurement start, not restarted |
| Console | Served by the live daemon; the shell loads `http://127.0.0.1:7777` |
| Node | 22.23.4 (measurement helpers) |
| Source | commit `cc96de57`; `desktop/dist/main.js` sha256 `2c7ba073…30fd18b` |
| Daemon start | 2026-10-31 15:29, pid unchanged through the run |
| Machine | Shared working machine; other applications and agent sessions were active |

## Results

### Electron tree by scenario

n=5 runs per scenario (soak is one run, reported separately). Each run's value
is the median of its five settled samples; the table then summarizes across
runs. p95 is the nearest-rank value (the maximum at n=5).

| Scenario | footprint median [p95] | summed RSS median [p95] | footprint range |
| --- | --- | --- | --- |
| idle | **197.0 MB** [200.0 MB] | **318.4 MB** [319.4 MB] | 196.0–200.0 MB |
| session (longest task) | 266.0 MB [269.0 MB] | 334.7 MB [347.7 MB] | 255.0–269.0 MB |
| task (probe run) | 219.0 MB [226.0 MB] | 270.6 MB [274.4 MB] | 212.0–226.0 MB |

Per-run footprint medians: idle 196/197/197/200/196; session
267/266/269/256/255; task 212/219/226/215/221.

Variance is small for footprint (CV 0.8% idle, 2.5% session and task) and
larger for RSS (CV 0.7% idle, 10.4% session, 5.8% task). RSS moves with page
reclaim and shared-page residency; footprint is the stable number.

### Idle tree by process

Per-process medians over the 25 idle samples (five launches × five samples).
Class medians do not add exactly to the tree median because the tree total is
summed per sample, not from medians.

| Process class | footprint median [p95] | range |
| --- | --- | --- |
| renderer | 83.0 MB [87.0 MB] | 79–87 MB |
| main | 54.0 MB [56.0 MB] | 53–56 MB |
| GPU | 49.0 MB [50.0 MB] | 49–50 MB |
| network utility | 14.0 MB [14.0 MB] | 14 MB |

The Electron tree is four processes; no crashpad handler was present while
sampled.

### Daemon tree

| Scenario | footprint median [p95] | summed RSS median [p95] |
| --- | --- | --- |
| idle | 180.0 MB [180.0 MB] | 63.0 MB [65.5 MB] |
| session | 180.0 MB [180.0 MB] | 60.9 MB [70.0 MB] |
| task | 181.0 MB [181.0 MB] | 32.0 MB [55.6 MB] |

The daemon tree is the `kin supervise` supervisor (75 MB footprint) plus
`kin serve` (105 MB footprint). Across idle, session, and task its footprint
is flat to the sampling resolution. The task row was sampled 25 s after the
task reached a terminal status, by which point the agent children had exited;
it is **not** a measurement of the daemon while a task is running. Any other
`kin` or agent child is counted in the separate children columns, so a model
process cannot inflate the daemon total (there were none in the quoted
scenarios). The daemon's RSS moved between 28 and 70 MB while its footprint
stayed flat; the artifacts support that observation, not a specific mechanism
such as page-cache residency.

For scale: the idle Electron shell's footprint (197 MB) is slightly larger
than the whole daemon tree's (180 MB) on this machine.

### Startup

Ten launches (five `idle`, five `startup`), all reaching a painted `/new` page:

| Stage | median | p95 | min | max | stdev | CV |
| --- | --- | --- | --- | --- | --- | --- |
| spawn → first CDP target | 730.5 ms | 853 ms | 715 ms | 853 ms | 45.3 ms | 6.0% |
| spawn → DOM ready | 1025 ms | 1250 ms | 872 ms | 1250 ms | 124.7 ms | 12.0% |
| DOM content loaded (page nav) | 161.5 ms | 264 ms | 138 ms | 264 ms | 42.2 ms | 23.6% |
| first contentful paint (page) | 265.5 ms | 392 ms | 244 ms | 392 ms | 48.3 ms | 16.9% |
| spawn → first contentful paint | 1012 ms | 1198 ms | 959 ms | 1198 ms | 84.6 ms | 8.2% |

The page timeline starts when the document navigates, not when Electron
starts; the last row adds the spawn-to-target interval measured by the harness.
"First paint" is the SPA shell painting, not the data-populated view.

Per launch:

| Launch | spawn → target | spawn → ready | FCP | spawn → FCP |
| --- | --- | --- | --- | --- |
| idle/1 | 783 ms | 1232 ms | 392 ms | 1175 ms |
| idle/2 | 769 ms | 1099 ms | 261 ms | 1030 ms |
| idle/3 | 715 ms | 1042 ms | 244 ms | 959 ms |
| idle/4 | 728 ms | 945 ms | 244 ms | 972 ms |
| idle/5 | 715 ms | 872 ms | 257 ms | 972 ms |
| startup/1 | 722 ms | 1082 ms | 263 ms | 985 ms |
| startup/2 | 788 ms | 965 ms | 268 ms | 1056 ms |
| startup/3 | 853 ms | 1250 ms | 345 ms | 1198 ms |
| startup/4 | 718 ms | 940 ms | 276 ms | 994 ms |
| startup/5 | 733 ms | 1008 ms | 304 ms | 1037 ms |

### Soak

| Metric | Value |
| --- | --- |
| Window after settling trim | 57.9 min |
| Samples | 114 used, 118 collected (first 4 dropped) |
| Electron footprint, start → end | 192.0 → 207.0 MB |
| Electron footprint growth | **+16.82 MB/h** (R² 0.746) |
| Electron summed RSS growth | −28.36 MB/h (R² 0.126) |
| Daemon footprint growth | +1.10 MB/h (R² 0.144) |

No footprint sample was missing for either tree. The shell stayed on the home
view with no navigation and no user input; the window was visible but not
focused. RSS fell from roughly 315 MB early in the run to roughly 150–180 MB
while footprint stayed in the 192–207 MB band — the two metrics diverge
because RSS gives back clean pages while the footprint ledger keeps the
dirty/compressed set.

The soak took three attempts, and the first two are excluded:

1. The first full run reached the soak but was stopped 7.7 minutes in when the
   measurement session ended. Every other scenario was already complete in that
   run and is reported above.
2. A standalone 60-minute attempt aborted after 9.5 minutes (exit 66). A
   short-lived daemon child had disappeared between the `ps` snapshot and
   `footprint -p`, and `footprint` exits 66 for a pid it cannot find; under
   `set -e` and `pipefail` that killed the run. `footprint_mb` now treats a
   vanished pid as "no footprint sample", and the API polling loops likewise
   tolerate a transient request failure.
3. The quoted 60-minute run is the one after that fix, in
   `.tmp/measure-desktop-soak-2026-11-01`.

The first output directory's `summary.json` still summarizes its own 7.7-minute
soak; use only its non-soak rows. The soak numbers quoted below come from the
separate soak directory.

## Caveats

- **Both tree totals are upper bounds.** Summed RSS counts shared pages once
  per process; summed footprint has the same issue for shared dirty pages.
  The true unique cost of the tree is lower, and the gap is why the two
  metrics differ so much (197 MB footprint vs 318 MB RSS when idle).
- **`footprint -p` runs per process, sequentially.** A tree total is a
  composite over roughly a second, not an instantaneous snapshot. This matters
  most right after launch, which is why settled samples start 25 s after DOM
  ready and the soak drops its first four samples.
- **Shared machine.** Other applications, agent sessions, and the
  developer's own running shell were active. The numbers are representative of
  a working machine, not a quiet benchmark host; variance includes that
  activity.
- **Unpackaged dev bundle.** The measured shell is `desktop/dist/main.js` run
  by the Electron dev binary, without an asar archive or code signing. A
  packaged `.app` may differ in load time and memory.
- **Visible but not focused.** The harness turns `show()` into
  `showInactive()` and `focus()` into a no-op so runs do not steal keyboard
  focus. The window is visible and painted (hidden windows are throttled), but
  no user input happens during a scenario. Chromium scheduling under a
  background-but-visible window can differ from a focused one.
- **The 60-minute soak is idle on the home view.** It does not cover a
  long-lived task session, streaming output, images, or artifact rendering —
  the states where a renderer is most likely to grow. The session scenario
  measures 25 s after load, not an hour.
- **The probe task is trivial.** It asks the agent to reply `ok` and use no
  tools. A task producing large tool output or a long transcript would put more
  into the renderer.
- **Daemon state is real, not fresh.** It had been up about 1 d 6 h with the
  owner's tasks and caches at measurement start. That is the right number for
  "what the shell costs alongside the daemon as used", but it is not a
  cold-start daemon baseline.
- **Idle RSS is a 25-second value, not steady state.** In the soak the same
  home view shed RSS over minutes (roughly 315–320 MB down to 140–190 MB)
  while footprint stayed near 194–200 MB. A memory budget should use the
  footprint figure; the idle RSS number is the conservative early value and
  overstates long-run RSS by roughly 40%.
- **n=5, and p95 is the maximum.** The tail estimate is nominal. Run-to-run
  spread was small enough that the decision does not depend on it. For the
  daemon, n=5 is one long-lived supervisor+server pair sampled across five
  launches, not five independent daemons; its p95 and CV describe sampling
  noise, not population spread.
- **One shell window.** The app opens one window; multi-window cost is not
  covered.
- **Warm page cache.** Launches followed earlier launches; a first launch after
  reboot would likely be slower.
- **No automated test for the harness.** The analyzer was checked against the
  raw CSVs and a synthetic short-soak fixture (which now correctly refuses a
  slope), but `scripts/measure-desktop.sh` has no CI test. Its arithmetic is
  simple enough to re-verify from `summary.json` and the CSVs, and this report
  did so, but a future edit could regress it silently.

## What was not measured

- **Chrome/Safari comparison (optional in the brief).** Not measured. Opening
  the console in the owner's daily browser requires planting the bearer token
  in that browser and would put it in the URL bar/history; a throwaway
  headless browser is a different rendering path and would not be a fair
  comparison to a visible Electron window. Skipping it was deliberate.
- **Packaged desktop build.** Only the unpackaged dev bundle was measured.
  `desktop-rebuild.sh` was explicitly out of scope for this workstream, and
  packaging would also restart the live shell.
- **Long-lived heavy session.** The soak is idle/home only. A multi-hour
  session with streaming output, artifacts, or many images is the most likely
  place for growth and remains unmeasured.
- **Other platforms.** The desktop shell is macOS-only today; no Windows or
  Linux numbers.
- **GPU VRAM and window-server memory.** Those live outside the process trees
  sampled here, so the totals exclude them.
- **Energy and CPU.** Memory and startup only; no power or sustained-CPU
  measurement.
- **Time to interactive/data-ready.** FCP is the shell's first paint, not the
  point where the conversation list and task data have arrived, and no input
  latency was measured.
- **Multi-device/Hub overhead.** The phone → Hub → Mac path was not part of
  this measurement.
- **Cold boot.** All launches benefited from a warm page cache.

## Reproduction

```bash
# install desktop deps once, then:
(cd desktop && npm install && npm run build)

# all scenarios; --task-runs 5 reproduces the task table (each run spends
# model tokens). About 25 minutes before the 60-minute soak.
scripts/measure-desktop.sh --task-runs 5 --out .tmp/measure-desktop-$(date +%Y%m%d-%H%M%S)

# soak alone:
scripts/measure-desktop.sh --scenario soak --soak-minutes 60 --out .tmp/soak

# recompute summary.txt/json from an existing output directory without
# launching anything:
scripts/measure-desktop.sh --summarize-only --out .tmp/measure-desktop-<stamp>
```

Raw outputs (ignored by git) land in the `--out` directory:

| File | Contents |
| --- | --- |
| `samples.csv` | per-process Electron rows: scenario, run, pid, class, RSS MB, footprint MB |
| `daemon-samples.csv` | per-process daemon rows, including agent children |
| `tree-samples.csv` | one row per sample with both tree totals |
| `startup.csv` | spawn→target, spawn→ready, DCL, load, FCP, spawn→FCP |
| `task-runs.csv` | probe task ids and terminal status |
| `summary.txt` / `summary.json` | medians, p95, variance, soak slope |
| `logs/<scenario>-<run>.log` | the shell's own main-process log for that run |
