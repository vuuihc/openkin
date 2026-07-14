# Remote access

Kin is a **single HTTP port** (default `7777`) with token auth on every request. Any tunnel, reverse proxy, or VPN that can forward plain HTTP to that port works — Kin does not special-case vendors beyond the optional Tailscale/tsnet plug-in.

| Rung | Command | Who can reach it |
|------|---------|------------------|
| Local | `kin serve` | This machine only (`127.0.0.1`) |
| LAN | `kin serve --lan` | Devices on the same Wi‑Fi/LAN; terminal QR |
| Tailnet | `kin serve --tailscale` | Your Tailscale/Headscale tailnet |
| Funnel | `kin serve --tailscale --funnel` | Public HTTPS via Tailscale Funnel |
| BYO tunnel | `kin serve --lan` (or local) behind frp / Cloudflare Tunnel / nginx / … | Whatever the tunnel exposes |

Token auth applies on **every** rung (`Authorization: Bearer` or `?token=` for QR deep links). On a public endpoint the token is the only barrier — treat it as a secret. If it leaks:

```bash
kin token rotate
```

A running daemon **re-reads `~/.kin/token` on every request**, so the old token stops working immediately without a restart.

---

## 1. LAN QR

```bash
kin serve --lan
# optional: --port 7777
```

- Binds `0.0.0.0:<port>` (still reachable as `127.0.0.1` for local MCP).
- Prints a terminal QR of `http://<primary-lan-ip>:<port>/?token=<token>`.
- On the phone (same Wi‑Fi): scan → UI loads → token is stored in `localStorage` and stripped from the URL.

Approve a task from the Approvals page as in the M2 flow.

---

## 2. Tailscale (tsnet)

Requirements: a Tailscale account (free tier is fine). Kin embeds a tsnet node named **`kin`**; state lives in `~/.kin/tsnet/`.

```bash
kin serve --tailscale
# or with LAN as well:
kin serve --lan --tailscale
```

### First run (login)

On first start, tsnet prints a login URL to the terminal (via its user logger), for example:

```text
To start this tsnet server, … go to: https://login.tailscale.com/a/…
```

Open that URL in a browser, authenticate, and approve the device. Subsequent starts reuse `~/.kin/tsnet/` and skip login.

Once up, Kin prints the tailnet URL and a QR (with token). Open it from any device on your tailnet (phone on cellular with the Tailscale app connected works).

### Funnel (public HTTPS)

Funnel is **Tailscale-only** (not Headscale).

1. In the [Tailscale admin console](https://login.tailscale.com/admin/dns), enable HTTPS and Funnel for your tailnet (DNS → HTTPS Certificates; Funnel policy as prompted).
2. Run:

```bash
kin serve --tailscale --funnel
```

3. Kin serves public HTTPS via Funnel and prints/QRs the public URL. Phone on cellular (no Tailscale client required for Funnel) can open it with the token.

`--funnel` requires `--tailscale`. Combining `--funnel` with `--ts-control-url` exits with an error before starting anything.

---

## 3. Headscale

Pass your Headscale coordination URL:

```bash
kin serve --tailscale --ts-control-url https://headscale.example.com
```

This sets `tsnet.Server.ControlURL` (also stored as setting `tailscale.control_url`). Node name remains `kin`; state dir remains `~/.kin/tsnet/`.

Enroll the node per your Headscale docs (pre-auth key via `TS_AUTHKEY`, or the printed auth URL if your server issues one).

**Funnel is not available** against a custom control URL — Kin refuses `--funnel --ts-control-url …`.

---

## 4. frp (recommended where Tailscale is unreachable)

In regions where the Tailscale control plane or DERP paths are unreliable (e.g. mainland China), **frp** is the recommended bring-your-own path: Kin stays a dumb HTTP origin; frp carries the traffic.

### Server (`frps`) — public VPS

`frps.toml`:

```toml
bindPort = 7000
# Optional dashboard
webServer.addr = "0.0.0.0"
webServer.port = 7500
webServer.user = "admin"
webServer.password = "change-me"

# Auth — use a strong token
auth.method = "token"
auth.token = "replace-with-long-random-secret"
```

```bash
frps -c frps.toml
```

Open TCP `7000` (and your remote port below) on the VPS firewall.

### Client (`frpc`) — machine running Kin

Start Kin on LAN or loopback:

```bash
kin serve --lan --port 7777
```

`frpc.toml`:

```toml
serverAddr = "your.vps.example.com"
serverPort = 7000
auth.method = "token"
auth.token = "replace-with-long-random-secret"

[[proxies]]
name = "kin"
type = "tcp"
localIP = "127.0.0.1"
localPort = 7777
remotePort = 17777
```

```bash
frpc -c frpc.toml
```

Reach Kin at `http://your.vps.example.com:17777/?token=<token>`.

Set the deep-link base so notifications point at the public URL:

- Settings UI → **UI base URL** → `http://your.vps.example.com:17777`
- or `PUT /api/settings` with `{"ui.base_url":"http://your.vps.example.com:17777"}`

For HTTPS, put Caddy/nginx + Let’s Encrypt in front of `remotePort`, or use frp’s HTTPS proxy type — Kin itself stays HTTP.

---

## 5. Cloudflare Tunnel

On the Kin host:

```bash
kin serve --lan --port 7777   # or plain serve on loopback
```

Install [cloudflared](https://developers.cloudflare.com/cloudflare-one/connections/connect-apps/install-and-setup/), then either:

**Quick tunnel (ephemeral URL):**

```bash
cloudflared tunnel --url http://127.0.0.1:7777
```

Copy the printed `https://….trycloudflare.com` URL, append `?token=<token>`, open on your phone.

**Named tunnel (stable hostname):**

```bash
cloudflared tunnel login
cloudflared tunnel create kin
cloudflared tunnel route dns kin kin.example.com
```

`config.yml`:

```yaml
tunnel: <TUNNEL_ID>
credentials-file: /path/to/<TUNNEL_ID>.json

ingress:
  - hostname: kin.example.com
    service: http://127.0.0.1:7777
  - service: http_status:404
```

```bash
cloudflared tunnel run kin
```

Set `ui.base_url` to `https://kin.example.com` for notification deep links.

---

## Security notes

- Kin is one HTTP port; **any** tunnel works unmodified.
- The **token** is the only application-level barrier on a public endpoint. Prefer short-lived exposure, Tailscale ACLs, or reverse-proxy IP allowlists when you can.
- Rotate with `kin token rotate` if the token may have leaked.
- `/internal/*` (approval MCP bridge) remains loopback-only in addition to token auth.
