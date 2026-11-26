# Kin on React Native

The phone client for Kin: Expo + expo-router, sharing the console's TypeScript
where it has no browser dependency (ADR 0036). This package is the iOS/Android
app; it talks to a Kin node over the same HTTP and event-stream API as the web
console.

## What you need

- Node (the repo's `.nvmrc`/CI node) and `npm`
- Xcode with an iOS simulator runtime installed (`xcrun simctl list devices available`)
- A Kin node you can reach from the simulator (see "Point it at a node" below)

No lockfile is tracked in this package. Install without creating one:

```bash
cd mobile-rn
npm install --no-audit --no-fund --no-package-lock
```

## Checks

```bash
cd mobile-rn
npx tsc --noEmit
npx jest --ci --runInBand
```

## Run in the iOS simulator

Expo Go is the shortest path: it needs no generated `ios/` directory, and the
SDK version it ships must match `expo` in `package.json`.

Before an evidence walk, check host headroom:

```bash
vm_stat | head -5
sysctl vm.swapusage
xcrun simctl list devices available | head -20
```

If `xcrun` is unavailable, no iOS runtime is installed, or free memory is below
4 GB, skip the simulator walk. Record the reading and run the checks above.
Mark existing screenshots with their capture commit. A green test run does not
refresh visual or real-device evidence. See [EVIDENCE.md](EVIDENCE.md) for the
current code review and the historical screenshots.

For an evidence walk, use a throwaway node: a `mktemp -d` state directory,
a port selected by binding `127.0.0.1:0`, and the repo's `scripts/journeys_seed.py`
with `scripts/journeys_fake_agent` first on `PATH` and `KIN_CLAUDE_BIN` set to
that fake agent. Do not use the live node or its state directory. Keep
`&pairing=1` on the one-time link. Capture the list, conversation, approvals
and usage on each device. The conversation must contain the `[seed] reading`
long answer and its five-row GFM table, including at 820×1180.

```bash
cd mobile-rn
npx expo start --offline --port 8081
```

In another shell, boot a simulator and open the project in Expo Go. The first
`openurl` may show iOS's "Open in Expo Go?" alert; accept it.

```bash
xcrun simctl boot "iPhone 17e"
xcrun simctl install booted ~/.expo/ios-simulator-app-cache/Expo-Go-58.0.7.tar.app
xcrun simctl openurl booted "exp://127.0.0.1:8081"
```

Expo Go caches the app under `~/.expo/ios-simulator-app-cache/` the first time
it is installed. If the cache is empty, install Expo Go on the simulator from
the App Store, or use `npx expo run:ios` (which generates `ios/`; it is
gitignored and never committed). Neither fallback was exercised in the
historical `14918d30` capture: that simulator already had the cached Expo Go
58.0.7 app. The current evidence refresh skipped simulators.

Run one simulator at a time: finish the iPhone 17e walk at 390×844, then shut
it down before booting the iPad Air 11-inch (M4) at 820×1180. The iPad layout
uses the same project in portrait:

```bash
xcrun simctl shutdown "iPhone 17e"
xcrun simctl boot "iPad Air 11-inch (M4)"
xcrun simctl install booted ~/.expo/ios-simulator-app-cache/Expo-Go-58.0.7.tar.app
xcrun simctl openurl booted "exp://127.0.0.1:8081"
```

After the iPad walk, shut it down with
`xcrun simctl shutdown "iPad Air 11-inch (M4)"`. Save captures under
`rsi/state/shots/<run-name>/` and keep them out of Git. Do not boot another
simulator while one is in use by another lane.

## Point it at a node

A node prints a pairing link when it starts, or you can mint a one-time secret
yourself. The app accepts `http(s)://<node>/pair?token=<secret>&pairing=1`,
pastes it into the pair screen, exchanges the secret for a device token, and
stores both in the platform Keychain (`expo-secure-store`, key `kin.session`).
Nothing is written before the exchange succeeds.

Mint a secret from the node's own API (the token file is in the node's state
directory; never paste a live token into an issue or a screenshot). For an
evidence walk, set `KIN_PORT` to the allocated throwaway port and `TOKEN` to
that temporary node's token:

```bash
BASE="http://127.0.0.1:$KIN_PORT"
curl -sS -X POST \
  -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"label":"phone-sim"}' \
  "$BASE/api/pairing/sessions"
```

The response's `secret` goes into the link:

```
http://127.0.0.1:<port>/pair?token=<secret>&pairing=1
```

For a node on the same Mac as the simulator, `127.0.0.1` works — the simulator
shares the host's loopback. For a phone on the LAN, use the node's LAN address
(`192.168.1.42`) and start the node with `--lan`. A public URL
(`kin.example.com`) works too when the node is behind a tunnel or Hub. Pairing
secrets expire after a few minutes; mint a new one rather than retrying an old
link.

To point the app at a different node, pair again with that node's link. The new
session replaces the old one; there is no separate "sign out" control yet.

## Driving the simulator without the Simulator app

On a machine with only `simctl` (no Simulator.app), the app can still be walked
with [Maestro](https://maestro.mobile.dev/) against the booted device. It needs
a JDK on `JAVA_HOME`; this repo's machines already have Maestro installed.

```bash
export JAVA_HOME=/opt/homebrew/opt/openjdk@17
export PATH="$JAVA_HOME/bin:$PATH"
~/.maestro/bin/maestro --udid <simulator-udid> test flow.yaml
```

A minimal flow taps by coordinates when React Native text is not exposed to the
accessibility tree. Replace `<port>` and `<secret>` with the throwaway
node's allocated port and newly minted secret before running the flow:

```yaml
appId: host.exp.Exponent
---
- tapOn:
    point: "50%,50%"
- inputText: "http://127.0.0.1:<port>/pair?token=<secret>&pairing=1"
- pressKey: Enter
```

Use one `inputText` followed by Enter to submit the pairing link. In the
historical walk, Expo Go's floating dev button covered the usage action; drag
it away before tapping `conversation:usage`. See the run notes in
[EVIDENCE.md](EVIDENCE.md#运行经验给下一个人).

Screenshots come from the same device without any GUI:
`xcrun simctl io booted screenshot shot.png`.

## Known gaps and evidence limits

- Keyboard avoidance and safe areas landed in #733 (`445dffab`). The component
  regression passes, but keyboard animation, occlusion and glass blur still
  need a person on a real device. See `EVIDENCE.md` §已知 for the source and test.
- Push registration and the glass header remain unwired on the reviewed
  `6cd5f5cd` baseline. #768 tracks the glass usage sheet, not the header.
- QR scanning and the phone's new-conversation entry are still absent.
- The iPad split layout is visible only in the historical `14918d30`
  screenshots. This refresh captured two 390 screens (`390-list.png` and
  `390-conversation.png` in `rsi/state/shots/rn-evidence-refresh/`, local and
  not committed) showing the record-named headings and the rendered table; no
  fresh 820 screen was captured because the memory gate skipped the full
  four-surface walk. Table rendering, partial usage failure and project-record
  headings also have passing regressions; see `EVIDENCE.md` §已修 for the
  commits and checks.

## Notes for maintainers

- Metro blocks `app/**/*.test.{ts,tsx,js,jsx}` from its file map. expo-router
  builds its route table with `require.context("./app")`, so without the block
  list a route test is bundled into the app graph and its
  `@testing-library/react-native` import dies on Hermes
  (`require("console")`) before the first frame. Jest resolves through its own
  resolver and is unaffected; `src/shared/importContract.test.ts` pins the
  block list.
- The shared code under `ui/` is imported in place (ADR 0036). `metro.config.js`
  maps the browser-bound modules to the RN adapters in `src/`; add a mapping
  there rather than copying a shared file.
