# Kin

[中文](./README.zh.md)

> One console for all your coding agents. Self-hosted. Any device.

Dispatch, watch, and approve agent tasks — Claude Code, Codex, any CLI — from your phone or any device, over your own network. No vendor relay, no Kin account. Growing into a local-first personal agent whose memory you own.

```text
Your agent. Your memory. Any model.
```

## Docs

| Doc | What it is |
|-----|------------|
| [PRINCIPLE.md](./PRINCIPLE.md) · [中文](./PRINCIPLE.zh.md) | Product principles (non-negotiables) |
| [SYSTEM_DESIGN.md](./SYSTEM_DESIGN.md) · [中文](./SYSTEM_DESIGN.zh.md) | Public architecture snapshot (draft—not an API contract) |
| [OPEN_DEVELOPMENT.md](./docs/OPEN_DEVELOPMENT.md) | What we publish and how we pace open development |

## Status

Design stage; building the MVP (the agent console) is next. Public docs describe **direction**; implementation details land with code.

## In short

- **Cross-agent console** — dispatch / monitor / approve Claude Code, Codex, or any CLI agent from one place
- **Self-hosted remote** — LAN → tailnet / Funnel ladder; traffic never routed through an agent vendor's cloud
- **Cost transparency** — tokens and spend per task, per provider
- **User-owned** — local-first; no Kin account; export and leave
- **Memory, next (v2)** — governed memory that travels across agents and models
- **Small by default** — do not multiply entities without necessity; grow from real pain ([PRINCIPLE §5.11](./PRINCIPLE.md))

## License

Intended open-source license: Apache-2.0 (to be confirmed when code lands).
