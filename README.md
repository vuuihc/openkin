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

MVP agent console (daemon + web UI) is implemented. A macOS menu-bar **desktop shell** lives in `desktop/` (Electron). Public docs describe **direction**; implementation notes are in [docs/IMPL_NOTES.md](./docs/IMPL_NOTES.md).

## In short

- **Cross-agent console** — dispatch / monitor / approve Claude Code, Codex, or any CLI agent from one place
- **Self-hosted remote** — LAN → tailnet / Funnel ladder; traffic never routed through an agent vendor's cloud
- **Cost transparency** — tokens and spend per task, per provider
- **User-owned** — local-first; no Kin account; export and leave
- **Artifacts, next** — keep readable session deliverables (study notes, HTML) in a local library with a reader; see [docs/TODO.md](./docs/TODO.md)
- **Memory, later (v2)** — governed memory that travels across agents and models
- **Small by default** — do not multiply entities without necessity; grow from real pain ([PRINCIPLE §5.11](./PRINCIPLE.md))

## Desktop app

macOS menu-bar shell (darwin-arm64). Supervises the local `kin` daemon as a sidecar, hosts the embedded web console in a BrowserWindow, and surfaces approvals as native notifications.

```bash
# Dev: builds ./kin, launches Electron (uses repo-root binary)
make desktop-dev

# Packaged unsigned .dmg under desktop/dist-electron/
make desktop-dist
```

**Unsigned builds:** after installing the `.dmg`, macOS Gatekeeper may block open. Right-click the app → **Open** the first time (or remove quarantine: `xattr -cr /Applications/Kin.app`). Code signing is not configured yet.

Architecture and decisions: [docs/IMPL_NOTES.md](./docs/IMPL_NOTES.md) § Desktop shell.

## License

Intended open-source license: Apache-2.0 (to be confirmed when code lands).
