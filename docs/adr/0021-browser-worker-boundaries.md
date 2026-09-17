# ADR 0021: Browser Worker Boundaries

## Status

Accepted

## Decision

Browser automation is an optional user-owned worker implemented with
Playwright. Each worker process creates a fresh ephemeral browser context.
Browser actions arrive as structured NDJSON commands so the daemon can attach
the worker to an ordinary Task without creating a second task state machine.

The worker enforces these boundaries before execution:

- navigation and downloads use HTTP(S) and an exact-domain/subdomain allowlist;
- uploads must be contained in the configured upload directory;
- downloads use a configured filename and byte limit;
- clicks, key presses, and uploads require an approval callback; sensitive
  downloads require one as well;
- screenshots, console errors, network errors, and action summaries are
  bounded evidence; form values, file paths, and sensitive URL query values are
  redacted.

The first slice does not provide a hosted browser profile, CAPTCHA bypass, or
macOS Accessibility automation. The Go daemon composition layer starts one
worker process per action, routes side effects through the existing approval
engine, appends browser events to the parent Task, and stores redacted worker
evidence as proposed text Artifacts. Cancellation terminates the active
process. Human takeover remains an explicit follow-up rather than an implicit
credential or desktop-automation escape hatch.
