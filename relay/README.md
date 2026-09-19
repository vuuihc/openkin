# OpenKin Relay v2

The Relay is a user-deployed Cloudflare Worker for firewall-friendly remote
access. It does not store task state and OpenKin does not operate a shared
relay.

## Deploy

From this directory:

```bash
npx wrangler@latest deploy
```

`wrangler.toml` provisions the `RELAY_ROOM` Durable Object binding. A plain
Worker with an in-memory room map is not compatible with this protocol.

## Use

```bash
kin serve --relay wss://<your-worker-domain>
```

The daemon creates a random room ID and relay key in
`~/.kin/relay/credentials.json` (mode `0600`). The URL printed for a paired
phone includes that key; keep it private and rotate the relay credentials by
stopping Kin and removing that file.

When using the Desktop console, the same setup is available in
**Settings → Remote Relay**. Enter the deployed Worker URL and save; the
running daemon connects without a restart and the console displays a
short-lived phone pairing QR. The command above remains useful for headless
or scripted deployments.

The room accepts one authenticated daemon, bounded client sockets, and bounded
REST requests. A client WebSocket is bridged to the daemon's local `/api/ws`.
Reconnects are expected; SQLite remains the source of truth.

## Trust model

This is bring-your-own infrastructure. Cloudflare terminates TLS at the
Worker and can observe proxied HTTP/WebSocket traffic. Relay v2 does not
provide end-to-end encryption. Never publish the room key or use a shared
Worker for multiple trust domains. A guessed room, wrong key, duplicate daemon,
oversized body/frame, and unavailable daemon fail closed.
