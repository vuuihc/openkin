#!/usr/bin/env python3
"""Seed the throwaway daemon that rsi/runtime/ux-walk.sh boots, so the J1-J7
journey screenshots judge real density instead of empty states.

Creates through the public HTTP API only, idempotently, matching rows by the
`[seed] ` name prefix rather than by id. Nothing outside KIN_BASE is touched;
the token is never printed. A state the API cannot produce without launching a
real agent CLI is reported as `skip <state>: <reason>` and does not fail the
walk — ux-walk.sh only treats a non-zero exit as a seed failure.

Usage:
    KIN_BASE=http://127.0.0.1:<port> KIN_TOKEN=<token> \
        python3 scripts/journeys_seed.py [--dry-run]
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import tempfile
import time
import urllib.error
import urllib.parse
import urllib.request

PREFIX = "[seed] "
# The focus line doubles as the sentinel: a second run finds it in the
# One-Pager and leaves the file alone, and nothing extra shows on the cover.
FOCUS_SENTINEL = "Finish the journey walk with real projects, conversations and routines on screen."

PROJECTS = (
    ("Project Alpha", "ship", "project-alpha"),
    ("Project Beta", "learn", "project-beta"),
    ("Project Gamma", "ship", "project-gamma"),
)
FOCUS_PROJECT = "Project Alpha"
FOCUS_MARKDOWN = f"""# {PREFIX}Project Alpha

## North Star
A walkthrough daemon that already looks lived-in.

## Current Focus
{FOCUS_SENTINEL}

## Next
- Read the J4 project cover
- Check the routines page density
"""

ROUTINES = (
    {
        "slug": "routine-enabled",
        "title": "Morning check-in",
        "enabled": True,
        "interval_secs": 86400,
        "due_in_secs": 7 * 86400,
        "prompt": "Summarise yesterday's decisions and list today's three next actions.",
    },
    {
        "slug": "routine-paused",
        "title": "Weekly review",
        "enabled": False,
        "interval_secs": 7 * 86400,
        "due_in_secs": 7 * 86400,
        "prompt": "Review last week's work, then write the one thing worth continuing.",
    },
)

# A daemon answer that means "this daemon cannot produce that state", as
# opposed to "the caller is broken".
SKIPPABLE = {400, 404, 409, 422, 503}


class SeedError(Exception):
    """The run cannot continue: unreachable daemon or refused credentials."""


class AuthError(SeedError):
    """KIN_TOKEN was refused. Every later call would fail the same way."""


def redact_url(url: str) -> str:
    """Base URL without userinfo or query — the token can hide in either."""
    parts = urllib.parse.urlsplit(url)
    host = parts.hostname or ""
    if parts.port:
        host = f"{host}:{parts.port}"
    return urllib.parse.urlunsplit((parts.scheme, host, parts.path, "", ""))


def _decode(raw: bytes) -> object:
    try:
        return json.loads(raw.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError):
        return raw.decode("utf-8", "replace")[:300]


def _reason(status: int, body: object) -> str:
    detail = ""
    if isinstance(body, dict):
        detail = str(body.get("error") or "")
    elif isinstance(body, str):
        detail = body
    detail = " ".join(detail.split())[:160]
    return f"HTTP {status}" + (f": {detail}" if detail else "")


class Api:
    """Bearer-auth JSON calls to KIN_BASE and nowhere else."""

    def __init__(self, base: str, token: str) -> None:
        self.base = base.rstrip("/")
        self._token = token
        # An explicit empty ProxyHandler keeps the seed from dialing anything
        # but KIN_BASE, even when the shell exports http_proxy.
        self._opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))

    def call(self, method: str, path: str, body: object | None = None) -> tuple[int, object]:
        data = None
        headers = {"Authorization": f"Bearer {self._token}", "Accept": "application/json"}
        if body is not None:
            data = json.dumps(body).encode("utf-8")
            headers["Content-Type"] = "application/json"
        request = urllib.request.Request(self.base + path, data=data, headers=headers, method=method)
        try:
            with self._opener.open(request, timeout=20) as response:
                return response.status, _decode(response.read())
        except urllib.error.HTTPError as exc:
            return exc.code, _decode(exc.read())
        except (urllib.error.URLError, OSError) as exc:
            reason = getattr(exc, "reason", exc)
            raise SeedError(f"cannot reach {redact_url(self.base)}: {reason}") from None


class Report:
    def __init__(self, dry_run: bool) -> None:
        self.dry_run = dry_run
        self.created_count = 0
        self.existing_count = 0
        self.skipped_count = 0

    def create(self, kind: str, name: str, ident: str | None = None) -> None:
        self.created_count += 1
        print(f"create {kind} {name}" + (f" {ident}" if ident else ""))

    def existing(self, kind: str, name: str, ident: str | None = None) -> None:
        self.existing_count += 1
        print(f"existing {kind} {name}" + (f" {ident}" if ident else ""))

    def plan(self, kind: str, name: str) -> None:
        print(f"plan {kind} {name}")

    def skip(self, state: str, reason: str) -> None:
        self.skipped_count += 1
        print(f"skip {state}: {reason}")

    def summary(self) -> None:
        suffix = " (dry-run, nothing changed)" if self.dry_run else ""
        print(f"summary: created {self.created_count}, existing {self.existing_count}, skipped {self.skipped_count}{suffix}")


def _seed_roots() -> str:
    """Placeholder roots under a fresh temp dir — never a real repository."""
    base = tempfile.mkdtemp(prefix="kin-journeys-seed-")
    for name in ("alpha", "beta", "gamma"):
        os.makedirs(os.path.join(base, name), exist_ok=True)
    return base


def _list(api: Api, path: str, key: str) -> list[dict]:
    status, body = api.call("GET", path)
    if status in (401, 403):
        raise AuthError(f"GET {path}: {_reason(status, body)}; check KIN_TOKEN")
    if status != 200:
        raise SeedError(f"GET {path}: {_reason(status, body)}")
    if isinstance(body, dict):
        body = body.get(key)
    if not isinstance(body, list):
        raise SeedError(f"GET {path}: unexpected response shape")
    return [row for row in body if isinstance(row, dict)]


def seed_projects(api: Api, report: Report) -> dict[str, dict]:
    try:
        rows = _list(api, "/api/projects?status=all", "projects")
    except AuthError:
        raise
    except SeedError as exc:
        report.skip("projects", str(exc))
        return {}
    by_name = {row.get("name"): row for row in rows}
    created: dict[str, dict] = {}
    roots = ""
    for name, mode, slug in PROJECTS:
        full = PREFIX + name
        row = by_name.get(full)
        if row:
            report.existing("project", full, row.get("id"))
            created[name] = row
            continue
        if report.dry_run:
            report.plan("project", full)
            created[name] = {"id": None}
            continue
        if not roots:
            roots = _seed_roots()
        status, body = api.call(
            "POST",
            "/api/projects",
            {"name": full, "mode": mode, "roots": [os.path.join(roots, name.split()[-1].lower())]},
        )
        if status in (200, 201) and isinstance(body, dict) and body.get("id"):
            report.create("project", full, str(body["id"]))
            created[name] = body
        else:
            reason = _reason(status, body)
            if status in (401, 403):
                raise AuthError(f"POST /api/projects refused: {reason}; check KIN_TOKEN")
            if status not in SKIPPABLE:
                raise SeedError(f"POST /api/projects: {reason}")
            report.skip(slug, reason)
    return created


def seed_focus(api: Api, report: Report, projects: dict[str, dict]) -> None:
    full = PREFIX + FOCUS_PROJECT
    target = projects.get(FOCUS_PROJECT) or {}
    ident = target.get("id")
    if not ident:
        if report.dry_run:
            report.plan("focus", full)
        else:
            report.skip("focus", "the focus project was not created")
        return
    status, body = api.call("GET", f"/api/projects/{ident}/one-pager")
    markdown = body.get("markdown") if isinstance(body, dict) else None
    if status == 200 and isinstance(markdown, str) and FOCUS_SENTINEL in markdown:
        report.existing("focus", full)
        return
    if report.dry_run:
        report.plan("focus", full)
        return
    status, body = api.call("PUT", f"/api/projects/{ident}/one-pager", {"markdown": FOCUS_MARKDOWN})
    if status in (200, 201):
        report.create("focus", full)
        return
    reason = _reason(status, body)
    if status in (401, 403):
        raise AuthError(f"PUT /api/projects/{ident}/one-pager refused: {reason}; check KIN_TOKEN")
    if status not in SKIPPABLE:
        raise SeedError(f"PUT /api/projects/{ident}/one-pager: {reason}")
    report.skip("focus", reason)


def seed_routines(api: Api, report: Report) -> None:
    try:
        rows = _list(api, "/api/routines", "routines")
    except AuthError:
        raise
    except SeedError as exc:
        report.skip("routines", str(exc))
        return
    by_title = {row.get("title"): row for row in rows}
    cwd = ""
    now_ms = int(time.time() * 1000)
    for spec in ROUTINES:
        full = PREFIX + spec["title"]
        row = by_title.get(full)
        if row:
            report.existing("routine", full, row.get("id"))
            continue
        if report.dry_run:
            report.plan("routine", full)
            continue
        if not cwd:
            cwd = os.path.join(_seed_roots(), "alpha")
        status, body = api.call(
            "POST",
            "/api/routines",
            {
                "title": full,
                "cwd": cwd,
                "agent": "kin",
                "prompt": spec["prompt"],
                "interval_secs": spec["interval_secs"],
                "enabled": spec["enabled"],
                # Due in a week: the walk must never fire a routine and start
                # an agent turn on the review daemon.
                "next_due_at": now_ms + spec["due_in_secs"] * 1000,
            },
        )
        if status in (200, 201) and isinstance(body, dict) and body.get("id"):
            report.create("routine", full, str(body["id"]))
        else:
            reason = _reason(status, body)
            if status in (401, 403):
                raise AuthError(f"POST /api/routines refused: {reason}; check KIN_TOKEN")
            if status not in SKIPPABLE:
                raise SeedError(f"POST /api/routines: {reason}")
            report.skip(spec["slug"], reason)


def _runnable_agents(api: Api) -> list[str]:
    try:
        rows = _list(api, "/api/agents", "agents")
    except SeedError:
        return []
    return [str(row.get("id")) for row in rows if row.get("available") and row.get("id")]


def report_unproducible(api: Api, report: Report) -> None:
    """Say out loud which journey states this daemon cannot be given safely.

    Every conversation route ends in a turn: POST /api/tasks starts the agent
    CLI in the task cwd. The walk's daemon shares this machine's PATH, so on a
    machine with claude or codex installed that is a real model run — the one
    thing seeding must not cause. A fake agent binary in the daemon's PATH is a
    harness change (rsi/runtime/ux-walk.sh), not something this script can do.
    """
    agents = _runnable_agents(api)
    if agents:
        why = (
            "POST /api/tasks starts a real agent CLI "
            f"({', '.join(agents)} runnable on this daemon); no agent-free conversation route exists"
        )
    else:
        why = "POST /api/tasks refuses every conversation: no runnable agent on this daemon"
    report.skip("conversation-created", why)
    report.skip("conversation-archived", "a task must exist before it can be archived, and creating one starts a turn")
    report.skip("conversation-failed", "a failed task needs a real turn; nothing fails a task before the agent starts")
    report.skip("waiting-approval", "approvals attach only to a running task, and reaching running starts an agent")
    report.skip("routine-failed", "a failed last run needs a real task execution")


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Seed the UX journey-walk daemon.")
    parser.add_argument("--dry-run", action="store_true", help="print the plan; issue no POST/PUT/DELETE")
    args = parser.parse_args(argv)

    base = os.environ.get("KIN_BASE", "").strip()
    token = os.environ.get("KIN_TOKEN", "").strip()
    if not base:
        print(
            "journeys seed: KIN_BASE is not set; nothing was created "
            "(rsi/runtime/ux-walk.sh sets it to the throwaway daemon)",
            file=sys.stderr,
        )
        return 2
    if not token:
        print("journeys seed: KIN_TOKEN is empty; the daemon refuses every request", file=sys.stderr)
        return 2

    print(f"journeys seed: base {redact_url(base)}")
    api = Api(base, token)
    report = Report(args.dry_run)
    try:
        projects = seed_projects(api, report)
        seed_focus(api, report, projects)
        seed_routines(api, report)
    except SeedError as exc:
        print(f"journeys seed: {exc}", file=sys.stderr)
        return 1
    report_unproducible(api, report)
    report.summary()
    return 0


if __name__ == "__main__":
    sys.exit(main())
