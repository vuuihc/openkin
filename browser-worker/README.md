# OpenKin Browser Worker

This is an optional, user-owned headless worker for browser QA and web
inspection tasks. It uses Playwright with a fresh isolated browser context per
process and communicates through newline-delimited JSON on stdin/stdout.

The worker requires `KIN_BROWSER_DOMAINS` and rejects navigation/download URLs
outside the exact domains or their subdomains. Uploads must be inside
`KIN_BROWSER_UPLOAD_DIR`; downloads are written under
`KIN_BROWSER_DOWNLOAD_DIR` with a configured size limit. Clicks, key presses,
and uploads require approval; downloads marked `sensitive: true` do as well.

Evidence contains screenshots, redacted console/network errors, and sanitized
action summaries. Fill values, upload paths, and sensitive URL query values are
never included in evidence. The browser context is ephemeral; credentials are
not exported or persisted by this package.

Example:

```bash
npm run build
KIN_BROWSER_DOMAINS=example.com \
KIN_BROWSER_DOWNLOAD_DIR=/tmp/kin-downloads \
node dist/src/cli.js
{"id":"one","type":"action","action":{"type":"navigate","url":"https://example.com"}}
{"id":"two","type":"action","action":{"type":"screenshot","name":"home"}}
```

The daemon bridge enables this package by setting
`KIN_BROWSER_WORKER_SCRIPT` to the built `dist/src/cli.js` path. It passes
`KIN_BROWSER_DOMAINS`, `KIN_BROWSER_DOWNLOAD_DIR`,
`KIN_BROWSER_UPLOAD_DIR`, and `KIN_BROWSER_MAX_DOWNLOAD_BYTES` to each
isolated process. Side-effect requests produce an `approval_required` frame;
the daemon replies with an `approval` frame after the normal approval inbox
decides.
