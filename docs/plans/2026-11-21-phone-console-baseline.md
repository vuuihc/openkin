# Phone console baseline — 2026-11-21

**Status: measured and green.** On this machine the console the daemon embeds
became usable at **61 ms** (`warm`, populated cache), **177 ms** (`cold`,
loopback) and **3,674 ms** (`throttled`, `phone-weak`), medians of three runs at
390×844. The entry chunk is **1,917,339 bytes** on disk and **573,385 bytes
gzipped** on the wire — the "1.9 MB entry" in the P15 premise is the file size,
not the transfer size.

## 现在的位置 / Current position

| Item | State |
|---|---|
| Command | `node scripts/phone-console-startup.mjs --runs 3` — exit 0, table below |
| Conditions | `warm`, `cold` and `throttled`, all measured below; `--json` emits them machine-readably |
| Machine | macOS Darwin 27.2.0, arm64, 8 CPUs; 1-minute load average **7.35–7.84** (other work shared the machine) |
| Viewport | 390×844, Chrome (`channel: "chrome"`, headless), `isMobile`, `hasTouch` |
| `warm` | green — 3/3 runs; `console-usable` p50 **61 ms** |
| `cold` | green — 3/3 runs; `console-usable` p50 **177 ms** |
| `throttled` (`phone-weak`) | green — 3/3 runs; `console-usable` p50 **3,674 ms** |
| Entry chunk | `/assets/index-sIoXi5S1.js` — 1,917,339 B file, 573,385 B gzip, 573,685 B transfer on cold/throttled, 0 B on warm |
| Guards | green — the browser-free `--self-check` proves the parser and all six guards (exit 2) |
| Still unknown | the Capacitor WKWebView, the real tunnel and Hub origin, the phone's CPU/thermal state |

## Method

`scripts/phone-console-startup.mjs` (Node, no new dependency):

- **Preflight.** Reads the entry chunk name out of `web/dist/index.html`,
  refuses with exit 2 if the file or its chunk is missing, and never builds the
  UI; it rebuilds `./kin` only when the binary is older than the Go tree or the
  embedded `web/dist`.
- **Daemon.** A reserved port (never 7777), a `mktemp` state dir outside
  `~/.kin`, inherited `KIN_*` stripped, `kin serve --port N`, and a bounded
  wait on `/api/health`.
- **Browser and clock.** Playwright `chromium` (`channel: "chrome"`, viewport
  390×844, `isMobile`, `hasTouch`, service workers blocked) from `$PW_CORE` or
  `~/.kin/ux-proto-tools/node_modules`; missing tooling exits 2. An init script
  stamps `performance.timeOrigin` before any page script; every later mark is
  `performance.now()` on that document's clock.

| Mark | How |
|---|---|
| `navigation-start` | `performance.timeOrigin` (epoch ms), stamped from `addInitScript` |
| `entry-chunk-bytes` | resource-timing entry for the entry script: `transferSize`, `encodedBodySize`, `decodedBodySize`, URL |
| `first-contentful-paint` | `PerformanceObserver` for the `paint` entry, with `getEntriesByType("paint")` as fallback |
| `console-usable` | the first frame after `.kin-boot` has left `#root`, plus one more frame that shows a non-splash child |
| `shell-total` | navigation `loadEventEnd` |

The splash is a background and a spinner — no text, no image — so the first
*contentful* paint is the first React screen. FCP therefore lands at or just
after `console-usable`, never at the splash; that is a property of this
document, not a missing mark.

| Condition | Cache | Network |
|---|---|---|
| `warm` | one throwaway load, then `page.reload()` on the same context; HTTP cache enabled, and the reload must produce a new `timeOrigin` | loopback |
| `cold` | fresh context; `Network.setCacheDisabled(true)` | loopback |
| `throttled` | cold, plus `Network.emulateNetworkConditions` | `phone-weak`: latency 150 ms, download 250 KB/s, upload 750 KB/s |

`phone-weak` is named in the script and in every result. 250 KB/s keeps even the
uncompressed 1.9 MB entry near 7.7 s, inside the boot guard's 12 s deadline: a
profile that reliably trips P14's bound would measure the reload, not the first
load.

## Results

Milliseconds from `navigation-start`; raw runs follow each table.

### `warm` — cache populated, loopback

| mark | p50 | p90 | min | max | n |
|---|---:|---:|---:|---:|---:|
| `first-contentful-paint` | 92 | 184 | 72 | 184 | 3 |
| `console-usable` | **61** | 85 | 60 | 85 | 3 |
| `shell-total` | 36 | 37 | 15 | 37 | 3 |

`console-usable` runs: 60, 61, 85 ms. The entry transferred **0 B** on every
run: that is what this condition means, so the cold-cache guard deliberately
does not apply to it.

### `cold` — fresh context, HTTP cache disabled, loopback

| mark | p50 | p90 | min | max | n |
|---|---:|---:|---:|---:|---:|
| `first-contentful-paint` | 192 | 196 | 168 | 196 | 3 |
| `console-usable` | **177** | 181 | 155 | 181 | 3 |
| `shell-total` | 91 | 92 | 89 | 92 | 3 |

`console-usable` runs: 181, 177, 155 ms. The entry transferred **573,685 B**
(573,385 B encoded) on every cold run; a `transferSize` of 0 is refused as
`entry-not-from-this-origin`.

### `throttled` — cold, `phone-weak` (150 ms, 250 KB/s)

| mark | p50 | p90 | min | max | n |
|---|---:|---:|---:|---:|---:|
| `first-contentful-paint` | 3,712 | 3,800 | 3,676 | 3,800 | 3 |
| `console-usable` | **3,674** | 3,731 | 3,671 | 3,731 | 3 |
| `shell-total` | 3,279 | 3,279 | 3,252 | 3,279 | 3 |

`console-usable` runs: 3,731, 3,674, 3,671 ms. The entry transferred the same
573,685 B; the difference from `cold` is latency and bandwidth, not bytes.

### Entry chunk

| Measure | Bytes |
|---|---:|
| File on disk (`web/dist/assets/index-sIoXi5S1.js`) | 1,917,339 |
| `encodedBodySize` (gzip, browser) | 573,385 |
| `transferSize` on `cold` / `throttled` (headers + body) | 573,685 |
| `transferSize` on `warm` | 0 (cache; not a failure for this condition) |

The daemon gzips static text through the same middleware as the API, so Chrome
receives 573 KB, not 1.9 MB; whether a tunnel or the WKWebView preserves that
encoding is not measured here.

### Load average

Recorded on every row, so nine samples in all: 1-minute
**7.35–7.84**, 5-minute 6.80–6.86, 15-minute 6.77–6.79 on 8 CPUs. The machine
was busy with other work; the absolute numbers are for this machine under this
load, and all three conditions share it.

### Reading the numbers

`warm` is 116 ms faster than `cold` because the entry came from cache (0 B
transferred) and the context had already loaded and compiled the bundle once;
this run does not separate the HTTP cache from that warm engine state. `cold`
is loopback: the 573 KB gzip body arrives in tens of milliseconds, so it
measures parse, execute, the pre-render account probe and the first commit, not
the network. The network-bearing row is `throttled`; its 3.67 s sits inside the
field's 2.9–5.3 s range, so `phone-weak` is a plausible stand-in, not a replay.

`first-contentful-paint` lands just after `console-usable` in every condition
(92 vs 61 ms warm, 192 vs 177 ms cold, 3,712 vs 3,674 ms throttled), as the
splash-versus-first-screen reasoning above predicts. `shell-total` is earlier
than both because the load event does not wait for the async boot IIFE that
runs before `createRoot`.

## Guards

All six print `GUARD <name>: <detail>` on stderr and exit 2; none prints a
number: `daemon-never-healthy`, `splash-never-left`, `boot-guard-reloaded`,
`entry-not-from-this-origin` (foreign origin, or `transferSize == 0` on a cold
run), `stale-dist` (served chunk differs from `web/dist/index.html`), and
`console-blank-or-error` (empty `#root`, or a visible error surface, at the
frame usability would have been stamped).

`--self-check` proves that without a browser or a built tree: it feeds two
parser fixtures through `parseEntry` (a two-script document must pick
`/assets/index-deadbeef.js` and ignore `boot-guard.js`; a document with no
entry must parse to `null`), runs each of the six guards plus the cold-cache
case (`transferSize` 0, which must report `entry-not-from-this-origin`) through
the same `runGuards()` a real run uses, and requires each to exit 2 with
`GUARD <name>: ` as its first stderr line. A good mark set must print
`console-usable <n>ms`. Its final line:

```
ok phone-console-startup --self-check: parser checked, 6 guards exit 2, a good mark set prints console-usable
```

## Second slice (landed)

The 1,000-line hold split the work into two rounds. This one adds the `warm`
condition (one throwaway load, then a measured `page.reload()` that must have a
new `timeOrigin`), `first-contentful-paint` as a reported mark,
`--json` (one JSON document on stdout; progress and failures stay on stderr)
and the browser-free `--self-check`. Both halves now sit in the same script on
`main`.

## What this does not prove

This is **Chrome at 390×844, not the Capacitor WKWebView**: WebKit's network
stack, JIT warm-up and memory limits differ. `warm` and `cold` are **loopback**
and `throttled` an **emulated profile**, not the real tunnel or the Hub origin.
`warm` is one reload inside the same throwaway context, not a phone that has
opened the console before across app launches. It does not model the **phone's
CPU or thermal state**. The throwaway daemon has **no account or session**, so
the first committed screen is the standalone connect screen; a signed-in Hub
may fetch more before the list is useful. It measures **time to the first
usable screen, not to useful data**.

## Re-run

```bash
npm --prefix ui run build   # once: web/dist/assets is gitignored build output
node scripts/phone-console-startup.mjs --runs 3
node scripts/phone-console-startup.mjs --runs 1 --json   # stdout is one JSON document
node scripts/phone-console-startup.mjs --self-check      # no browser, no built tree
```

`--json` prints the machine, viewport, throttle, entry chunk, every run and the
per-condition `summary` as one parseable document. The script exits 2 with a
`GUARD` line rather than printing a number when the measurement would be
untrustworthy.

## What the user sees now

手机打开 Kin 时，控制台要先下载 1.9 MB 的入口文件（gzip 后 573 KB）；在这台
机器上用 250 KB/s 的弱网配置，冷缓存要 **3.67 秒**才能真正可用，本机 loopback
冷缓存是 **177 毫秒**，缓存已热时是 **61 毫秒**——而同一份控制台装进 App 包里
之后，这段下载和等待就不存在。
