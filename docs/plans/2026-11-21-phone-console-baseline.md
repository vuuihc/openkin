# Phone console baseline — 2026-11-21

**Status: measured and green.** On this machine, the console the daemon embeds
became usable at **151 ms** (warm), **161 ms** (cold) and **3,595 ms**
(`phone-weak` throttle), medians of three runs at 390×844. The entry chunk is
**1,917,339 bytes** on disk and **573,385 bytes gzipped** on the wire — the
"1.9 MB entry" in the P15 premise is the file size, not the transfer size.

## 现在的位置 / Current position

| Item | State |
|---|---|
| Command | `node scripts/phone-console-startup.mjs --runs 3` — exit 0, table below |
| Machine | macOS Darwin 27.2.0, arm64, 8 CPUs; 1-minute load average **5.98–6.52** during the run (other work shared the machine) |
| Viewport | 390×844, Chrome (`channel: "chrome"`, headless), `isMobile`, `hasTouch` |
| `warm` | green — 3/3 runs; `console-usable` p50 **151 ms** |
| `cold` | green — 3/3 runs; `console-usable` p50 **161 ms** |
| `throttled` (`phone-weak`) | green — 3/3 runs; `console-usable` p50 **3,595 ms** |
| Entry chunk | `/assets/index-sIoXi5S1.js` — 1,917,339 B file, 573,385 B gzip, 573,685 B transfer on cold |
| Guards | green — `--self-check` proves all six exit 2 and a good mark set prints a number |
| Still unknown | the Capacitor WKWebView, the real tunnel and Hub origin, the phone's CPU/thermal state; see *What this does not prove* |
| Branch measurement | `379a123e` plus this branch's two files; no product source changed. `web/dist/index.html` was byte-identical before and after the build that produced the assets (`1414146…`) |

## Why this number

P15's premise is a field anecdote: on 2026-11-20 the same entry chunk returned
complete in **49 ms** over the LAN, but the first tunnel attempt received
**74 KB in 20 s** and stalled, then took **2.9–5.3 s** three times. P14 bounded
the resulting wheel but left the cold download in the start path; P11's own
*Out of scope* line handed this measurement forward. Without a baseline,
"usable before any Hub download" has no bar to clear.

## Method

`scripts/phone-console-startup.mjs` (Node, no new dependency):

- **Preflight.** Reads the entry chunk name out of `web/dist/index.html`,
  refuses with exit 2 if the file or its chunk is missing, and never builds the
  UI. It rebuilds `./kin` only when the binary is older than the Go tree or the
  embedded `web/dist`, then checks the built chunk still matches the document.
- **Daemon.** A reserved port (never 7777), a `mktemp` state directory outside
  `~/.kin`, inherited `KIN_*` variables stripped, `kin serve --port N`, and a
  bounded wait on `/api/health`.
- **Browser.** Playwright `chromium` with `channel: "chrome"`, viewport
  390×844, `isMobile`, `hasTouch`, service workers blocked. `playwright-core`
  is resolved from `$PW_CORE` or `~/.kin/ux-proto-tools/node_modules`, and
  missing tooling exits 2.
- **Clock.** An init script stamps `performance.timeOrigin` before any page
  script. Every later mark is `performance.now()` on that document's clock.

| Mark | How |
|---|---|
| `navigation-start` | `performance.timeOrigin` (epoch ms), stamped from `addInitScript` |
| `entry-chunk-bytes` | resource-timing entry for the document's entry script: `transferSize`, `encodedBodySize`, `decodedBodySize`, URL |
| `first-contentful-paint` | `PerformanceObserver` for `paint`, fallback `getEntriesByType("paint")` |
| `console-usable` | an in-page `requestAnimationFrame` loop: the first frame after `.kin-boot` has left `#root`, plus one more frame that shows a non-splash child |
| `shell-total` | navigation `loadEventEnd` |

The splash is a background and a spinner — no text, no image — so the first
*contentful* paint is the first React screen. FCP therefore lands at or just
after `console-usable`, never at the splash; that is a property of this
document, not a missing mark.

### Conditions

| Condition | Cache | Network |
|---|---|---|
| `warm` | one throwaway load, then `page.reload()` on the same context; HTTP cache enabled | loopback |
| `cold` | fresh context; `Network.setCacheDisabled(true)` | loopback |
| `throttled` | cold, plus `Network.emulateNetworkConditions` | `phone-weak`: latency 150 ms, download 250 KB/s, upload 750 KB/s |

`phone-weak` is named in the script and in every result. 250 KB/s keeps even the
uncompressed 1.9 MB entry near 7.7 s, inside the boot guard's 12 s deadline: a
profile that reliably trips P14's bound would measure the reload, not the first
load.

## Results

One table per condition, milliseconds from `navigation-start`; the raw
`console-usable` runs are listed under each table so the summary can be checked
against the per-run output.

### `warm` — cache populated, loopback

| mark | p50 | p90 | min | max | n |
|---|---:|---:|---:|---:|---:|
| `console-usable` | **151** | 152 | 105 | 152 | 3 |
| `first-contentful-paint` | 140 | 152 | 108 | 152 | 3 |
| `shell-total` | 18 | 36 | 15 | 36 | 3 |

`console-usable` runs: 152, 105, 151 ms.

### `cold` — fresh context, HTTP cache disabled, loopback

| mark | p50 | p90 | min | max | n |
|---|---:|---:|---:|---:|---:|
| `console-usable` | **161** | 162 | 153 | 162 | 3 |
| `first-contentful-paint` | 176 | 208 | 168 | 208 | 3 |
| `shell-total` | 90 | 93 | 88 | 93 | 3 |

`console-usable` runs: 162, 153, 161 ms. The entry chunk transferred
**573,685 B** (573,385 B encoded) on every cold run; a `transferSize` of 0 is
refused as `entry-not-from-this-origin`.

### `throttled` — cold, `phone-weak` (150 ms, 250 KB/s)

| mark | p50 | p90 | min | max | n |
|---|---:|---:|---:|---:|---:|
| `console-usable` | **3,595** | 3,669 | 3,590 | 3,669 | 3 |
| `first-contentful-paint` | 3,600 | 3,672 | 3,592 | 3,672 | 3 |
| `shell-total` | 3,231 | 3,303 | 3,225 | 3,303 | 3 |

`console-usable` runs: 3,595, 3,590, 3,669 ms. The entry transferred the same
573,685 B; the difference from `cold` is latency and bandwidth, not bytes.

### Entry chunk

| Measure | Bytes |
|---|---:|
| File on disk (`web/dist/assets/index-sIoXi5S1.js`) | 1,917,339 |
| `encodedBodySize` (gzip, browser) | 573,385 |
| `transferSize` on `cold` / `throttled` (headers + body) | 573,685 |
| `transferSize` on `warm` | 0 (cache; not a failure for this condition) |

The daemon compresses static text through the same middleware as the API, so
Chrome receives 573 KB, not 1.9 MB. Whether a tunnel or the WKWebView preserves
that encoding is not measured here.

### Load average

Sampled before each condition, so nine samples in all: 1-minute **5.98–6.52**,
5-minute 7.51–7.57, 15-minute 7.33–7.36 on 8 CPUs. The machine was busy with
other work; absolute numbers are for this machine under this load, and the
three conditions share it.

### Reading the numbers

`cold` is only 10 ms slower than `warm` because both are loopback: the 573 KB
gzip body arrives in tens of milliseconds, so this pair measures parse,
execute, the pre-render account probe and the first commit — not the network.
The network-bearing row is `throttled`. Its 3.6 s sits inside the field's
2.9–5.3 s range for the 2026-11-20 tunnel attempts, which makes `phone-weak` a
plausible stand-in for that path; it is not a replay of the tunnel.

`shell-total` is earlier than `console-usable` in every row because the load
event does not wait for the async boot IIFE (`bootIntoStoredHub`,
`bootstrapTokenFromURL`, the account probe) that runs before `createRoot`.
That gap is why the headline is `console-usable` and not load time.

## Guards

All six print `GUARD <name>: <detail>` on stderr and exit 2; none prints a
number: `daemon-never-healthy`, `splash-never-left`, `boot-guard-reloaded`,
`entry-not-from-this-origin` (foreign origin, or `transferSize == 0` on a cold
run), `stale-dist` (served chunk name differs from `web/dist/index.html`), and
`console-blank-or-error` (empty `#root`, or a visible error surface, at the
frame usability would have been stamped). `--self-check` feeds synthetic mark
sets through the parser and the same guard path without a browser.

## What this does not prove

This is **Chrome at 390×844, not the Capacitor WKWebView**: WebKit's network
stack, JIT warm-up and memory limits differ, and a real iPhone may be slower or
faster. It is **loopback, not the real tunnel or the Hub origin**: in `warm` and
`cold` the network is excluded entirely, and `throttled` is an emulated profile,
not the 2026-11-20 tunnel or the NAS Hub. It does not model the **phone's CPU or
thermal state** — the JS ran on this Mac's 8 CPUs while the load average was
around 8. The throwaway daemon has **no account or session**, so the first
committed screen is the standalone connect screen; a signed-in Hub's
conversation list may fetch more before it is useful, and the stored-Hub path
adds its own bounded check that this route does not take. It measures **time to
the first usable screen, not to useful data**, and it does not measure how a
tunnel or webview treats the daemon's gzip encoding.

## Re-run

```bash
npm --prefix ui run build   # once: web/dist/assets is gitignored build output
node scripts/phone-console-startup.mjs --runs 3
```

`--json` prints the same runs and summaries as machine-readable JSON. The
script exits 2 with a `GUARD` line rather than printing a number when the
measurement would be untrustworthy.

## What the user sees now

手机打开 Kin 时，控制台要先下载 1.9 MB 的入口文件（gzip 后 573 KB）；在这台
机器上用 250 KB/s 的弱网配置，冷缓存要 **3.60 秒**才能真正可用，本机 loopback
冷缓存是 **161 毫秒**——而同一份控制台装进 App 包里之后，这段下载和等待就不存在。
