# Kin Relay

WebSocket relay for Kin remote control. Bridges a Kin daemon and an iOS app
through Cloudflare Workers — no Tailscale, no open ports, works through any
firewall.

## Quick deploy — zero source code

### Option A: One-click deploy (easiest)

[![Deploy to Cloudflare Workers](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/vuuihc/openkin&directory=relay)

Click the button above → log in to Cloudflare → done.  
You get `https://kin-relay.your-subdomain.workers.dev`.

### Option B: wrangler CLI (if you already have it)

```bash
npx wrangler@latest deploy relay.js --name kin-relay
```

### Option C: Cloudflare Dashboard (no CLI at all)

1. Go to https://dash.cloudflare.com → Workers & Pages → Create → Worker
2. Delete the default code
3. Paste the content of `relay.js` from this directory
4. Click "Save and Deploy"

All three options give you the same result: a public HTTPS URL.

## Usage

```bash
# Mac daemon (after install.sh)
kin serve --relay wss://kin-relay.your-subdomain.workers.dev

# iOS app: Settings → Add Device → enter:
https://kin-relay.your-subdomain.workers.dev
```

Each daemon automatically gets its own room by hostname.  
Multiple daemons can share one relay URL.

## How it works

```
iPhone ── HTTPS/WSS ──→ Cloudflare Worker ←── WSS ── Kin daemon
                               │
                         Room-based pairing:
                         same room = same session
```

Both sides connect **outbound** — no inbound ports, no VPN, no Tailscale needed.