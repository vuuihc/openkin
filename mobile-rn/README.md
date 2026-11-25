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
npx jest --ci
```

## Run in the iOS simulator

Expo Go is the shortest path: it needs no generated `ios/` directory, and the
SDK version it ships must match `expo` in `package.json`.

```bash
cd mobile-rn
npx expo start --offline --port 8081
```

In another shell, boot a simulator and open the project in Expo Go. The first
`openurl` may show iOS's "Open in Expo Go?" alert; accept it.

```bash
xcrun simctl boot "iPhone 18 Pro"
xcrun simctl install booted ~/.expo/ios-simulator-app-cache/Expo-Go-58.0.7.tar.app
xcrun simctl openurl booted "exp://127.0.0.1:8081"
```

Expo Go caches the app under `~/.expo/ios-simulator-app-cache/` the first time
it is installed. If the cache is empty, install Expo Go on the simulator from
the App Store, or use `npx expo run:ios` (which generates `ios/`; it is
gitignored and never committed). Neither fallback was exercised in this run:
the simulator already had the cached Expo Go 58.0.7 app.

The iPad layout is the same project on an iPad simulator; portrait is the
supported orientation today:

```bash
xcrun simctl boot "iPad Pro 11-inch (M5)"
xcrun simctl install booted ~/.expo/ios-simulator-app-cache/Expo-Go-58.0.7.tar.app
xcrun simctl openurl booted "exp://127.0.0.1:8081"
```

## Point it at a node

A node prints a pairing link when it starts, or you can mint a one-time secret
yourself. The app accepts `http(s)://<node>/pair?token=<secret>&pairing=1`,
pastes it into the pair screen, exchanges the secret for a device token, and
stores both in the platform Keychain (`expo-secure-store`, key `kin.session`).
Nothing is written before the exchange succeeds.

Mint a secret from the node's own API (the token file is in the node's state
directory; never paste a live token into an issue or a screenshot):

```bash
BASE="http://192.168.1.42:7777"
curl -sS -X POST \
  -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"label":"phone-sim"}' \
  "$BASE/api/pairing/sessions"
```

The response's `secret` goes into the link:

```
http://192.168.1.42:7777/pair?token=<secret>&pairing=1
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
accessibility tree:

```yaml
appId: host.exp.Exponent
---
- tapOn:
    point: "50%,50%"
- inputText: "http://127.0.0.1:7777/pair?token=<secret>&pairing=1"
- tapOn:
    point: "50%,41%"
```

Screenshots come from the same device without any GUI:
`xcrun simctl io booted screenshot shot.png`.

## Known gaps (next row: R4 native shell)

- The composer is not keyboard-avoiding yet: on a phone the software keyboard
  covers the send button. Tapping the transcript dismisses the keyboard. R4
  (`R-rn-native-shell`) owns the keyboard-avoiding composer, safe areas, the
  glass header and push registration.
- The iPad split layout (list beside conversation) is `rsi/rn-tablet-split`;
  today the iPad shows the same single-column stack.
- Push registration is not wired yet (`src/push/`, `rsi/rn-push-route`).

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
