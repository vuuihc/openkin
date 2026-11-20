# Phone console baseline — 2026-11-21

**Status: measured and green (first slice).** On this machine the console the
daemon embeds became usable at **165 ms** (`cold`, loopback) and **3,615 ms**
(`throttled`, `phone-weak`), medians of three runs at 390×844. The entry chunk
is **1,917,339 bytes** on disk and **573,385 bytes gzipped** on the wire — the
"1.9 MB entry" in the P15 premise is the file size, not the transfer size.

## 现在的位置 / Current position

| Item | State |
|---|---|
| Command | `node scripts/phone-console-startup.mjs --runs 3` — exit 0, table below |
| Conditions | `cold` and `throttled` only; see *Second slice* for what was deferred |
| Machine | macOS Darwin 27.2.0, arm64, 8 CPUs; 1-minute load average **5.71–6.20** (other work shared the machine) |
| Viewport | 390×844, Chrome (`channel: "chrome"`, headless), `isMobile`, `hasTouch` |
| `cold` | green — 3/3 runs; `console-usable` p50 **165 ms** |
| `throttled` (`phone-weak`) | green — 3/3 runs; `console-usable` p50 **3,615 ms** |
| Entry chunk | `/assets/index-sIoXi5S1.js` — 1,917,339 B file, 573,385 B gzip, 573,685 B transfer |
| Guards | code unchanged: all six paths exit 2; the synthetic proof is in the second slice |
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
| `console-usable` | the first frame after `.kin-boot` has left `#root`, plus one more frame that shows a non-splash child |
| `shell-total` | navigation `loadEventEnd` |

| Condition | Cache | Network |
|---|---|---|
| `cold` | fresh context; `Network.setCacheDisabled(true)` | loopback |
| `throttled` | cold, plus `Network.emulateNetworkConditions` | `phone-weak`: latency 150 ms, download 250 KB/s, upload 750 KB/s |

`phone-weak` is named in the script and in every result. 250 KB/s keeps even the
uncompressed 1.9 MB entry near 7.7 s, inside the boot guard's 12 s deadline: a
profile that reliably trips P14's bound would measure the reload, not the first
load.

## Results

Milliseconds from `navigation-start`; raw runs follow each table.

### `cold` — fresh context, HTTP cache disabled, loopback

| mark | p50 | p90 | min | max | n |
|---|---:|---:|---:|---:|---:|
| `console-usable` | **165** | 173 | 158 | 173 | 3 |
| `shell-total` | 94 | 110 | 88 | 110 | 3 |

`console-usable` runs: 173, 158, 165 ms. The entry transferred **573,685 B**
(573,385 B encoded) on every run; a `transferSize` of 0 is refused as
`entry-not-from-this-origin`.

### `throttled` — cold, `phone-weak` (150 ms, 250 KB/s)

| mark | p50 | p90 | min | max | n |
|---|---:|---:|---:|---:|---:|
| `console-usable` | **3,615** | 3,621 | 3,576 | 3,621 | 3 |
| `shell-total` | 3,231 | 3,246 | 3,200 | 3,246 | 3 |

`console-usable` runs: 3,615, 3,621, 3,576 ms. The entry transferred the same
573,685 B; the difference from `cold` is latency and bandwidth, not bytes.

### Entry chunk

| Measure | Bytes |
|---|---:|
| File on disk (`web/dist/assets/index-sIoXi5S1.js`) | 1,917,339 |
| `encodedBodySize` (gzip, browser) | 573,385 |
| `transferSize` on `cold` / `throttled` (headers + body) | 573,685 |

The daemon gzips static text through the same middleware as the API, so Chrome
receives 573 KB, not 1.9 MB; whether a tunnel or the WKWebView preserves that
encoding is not measured here.

### Reading the numbers

`cold` is loopback: the 573 KB gzip body arrives in tens of milliseconds, so it
measures parse, execute, the pre-render account probe and the first commit, not
the network. The network-bearing row is `throttled`; its 3.6 s sits inside the
field's 2.9–5.3 s range, so `phone-weak` is a plausible stand-in, not a replay.
`shell-total` is earlier because the load event does not wait for the async
boot IIFE that runs before `createRoot`.

## Guards

All six print `GUARD <name>: <detail>` on stderr and exit 2; none prints a
number: `daemon-never-healthy`, `splash-never-left`, `boot-guard-reloaded`,
`entry-not-from-this-origin` (foreign origin, or `transferSize == 0` on a cold
run), `stale-dist` (served chunk differs from `web/dist/index.html`), and
`console-blank-or-error` (empty `#root`, or a visible error surface, at the
frame usability would have been stamped). The guard code is untouched by the
split; the browser-free `--self-check` proof returns in the second slice.

## Second slice (deferred by the 1,000-line hold)

The full draft at commit `7895d4ad` also measured `warm` (populated cache) and
`first-contentful-paint`, and carried `--json` and `--self-check`. Its
1,342-line diff exceeded the 1,000-line hold, so this branch lands the two P15
conditions; the rest returns as its own slice against the same script.

## What this does not prove

This is **Chrome at 390×844, not the Capacitor WKWebView**: WebKit's network
stack, JIT warm-up and memory limits differ. `cold` is **loopback** and
`throttled` an **emulated profile**, not the real tunnel or the Hub origin. It
does not model the **phone's CPU or thermal state**. The throwaway daemon has
**no account or session**, so the first committed screen is the standalone
connect screen; a signed-in Hub may fetch more before the list is useful. It
measures **time to the first usable screen, not to useful data**.

## Re-run

```bash
npm --prefix ui run build   # once: web/dist/assets is gitignored build output
node scripts/phone-console-startup.mjs --runs 3
```

## What the user sees now

手机打开 Kin 时，控制台要先下载 1.9 MB 的入口文件（gzip 后 573 KB）；在这台
机器上用 250 KB/s 的弱网配置，冷缓存要 **3.62 秒**才能真正可用，本机 loopback
冷缓存是 **165 毫秒**——而同一份控制台装进 App 包里之后，这段下载和等待就不存在。
