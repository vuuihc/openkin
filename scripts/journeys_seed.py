#!/usr/bin/env python3
"""Seed the throwaway daemon that rsi/runtime/ux-walk.sh boots, so the J1-J7
journey screenshots judge real density instead of empty states.

Creates through the public HTTP API only, idempotently, matching rows by the
`[seed] ` name prefix rather than by id. Nothing outside KIN_BASE is touched;
the token is never printed. A state the API cannot produce without launching a
real agent CLI is reported as `skip <state>: <reason>` and does not fail the
walk — ux-walk.sh only treats a non-zero exit as a seed failure.

Conversations are seedable because the harness (rsi/runtime/ux-walk.sh and
scripts/journeys-smoke.sh) puts scripts/journeys_fake_agent first on the
throwaway daemon's PATH: the seed creates one succeeded, one failed and one
archived conversation, and refuses to create any unless /api/agents names a
`claude` inside that directory as the binary the daemon would launch. States
the fake cannot produce — a permission request, a routine run — still print
`skip`.

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
# The harness directory that holds the fake claude. The seed only creates
# conversations when the daemon resolves its `claude` binary inside it.
FAKE_AGENT_DIRNAME = "journeys_fake_agent"
FAKE_AGENT_LABEL = f"scripts/{FAKE_AGENT_DIRNAME}/claude"
TERMINAL_STATUSES = ("succeeded", "failed", "canceled")
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

CONVERSATIONS = (
    {
        "slug": "conversation-created",
        "title": PREFIX + "Morning planning",
        "prompt": PREFIX + "Summarise the three things worth doing today.",
        "expect": ("succeeded",),
        "archive": False,
    },
    {
        "slug": "conversation-failed",
        # The literal marker makes the fake agent emit an error result.
        "title": PREFIX + "Failed migration",
        "prompt": PREFIX + "fail: explain why the migration stopped.",
        "expect": ("failed",),
        "archive": False,
    },
    {
        "slug": "conversation-archived",
        "title": PREFIX + "Last week's review",
        "prompt": PREFIX + "Review the notes from last week and list what to keep.",
        "expect": ("succeeded",),
        "archive": True,
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


def _task_timeout() -> float:
    """How long to wait for a seeded task to settle. Overridable for tests."""
    try:
        return max(0.2, float(os.environ.get("KIN_SEED_TASK_TIMEOUT_SECS", "15")))
    except ValueError:
        return 15.0


def _fake_agent(api: Api) -> tuple[str | None, str]:
    """(agent id, why) — the id only when the daemon would launch this repo's fake.

    Every conversation route ends in a turn: POST /api/tasks starts the agent
    CLI the daemon resolves. Starting a real claude would be a model run on the
    seeding machine, which is the one thing the seed must not cause, so a
    binary outside scripts/journeys_fake_agent means no conversations at all.
    """
    try:
        rows = _list(api, "/api/agents", "agents")
    except SeedError:
        return None, "cannot list agents; refusing to guess which binary a turn would start"
    for row in rows:
        if row.get("id") != "claude-code":
            continue
        if not row.get("available"):
            return None, "the daemon reports no runnable claude-code agent"
        # The daemon's own resolution is the only proof: this process's PATH
        # says nothing about which binary the daemon would start. A caller
        # that does not hold the daemon gets a blanked binary, and that is a
        # refusal, not a reason to guess.
        binary = str(row.get("binary") or "")
        if not binary:
            return None, "the daemon does not say which claude it would start; refusing to guess"
        if os.path.basename(os.path.dirname(os.path.realpath(binary))) != FAKE_AGENT_DIRNAME:
            return None, "the daemon would start a real claude CLI; only the fake agent may answer"
        return "claude-code", ""
    return None, "no claude-code agent is installed on this daemon"


def _wait_terminal(api: Api, ident: str, timeout: float) -> tuple[str | None, str]:
    """Poll one task until it settles. Returns (terminal status or None, last seen)."""
    deadline = time.monotonic() + timeout
    last = "unknown"
    while time.monotonic() < deadline:
        status, body = api.call("GET", f"/api/tasks/{ident}")
        if status == 200 and isinstance(body, dict):
            last = str(body.get("status") or "unknown")
            if last in TERMINAL_STATUSES:
                return last, last
        else:
            # Say what went wrong instead of reporting a task as merely slow.
            last = _reason(status, body)
        time.sleep(0.1)
    return None, last


def _fake_answered(api: Api, ident: str) -> tuple[bool, str]:
    """Whether the task's events carry the fake agent's stderr marker, and why not."""
    status, body = api.call("GET", f"/api/tasks/{ident}/events")
    if status != 200:
        return False, f"cannot read task {ident} events: {_reason(status, body)}"
    if "fake-agent" not in json.dumps(body):
        return False, f"task {ident} has no fake-agent marker in its events"
    return True, ""


def _set_archived(api: Api, report: Report, spec: dict, ident: str, already: bool) -> None:
    title = spec["title"]
    if already:
        report.existing("archive", title, ident)
        return
    if report.dry_run:
        report.plan("archive", title)
        return
    status, body = api.call("POST", f"/api/tasks/{ident}/archive")
    if status in (200, 204):
        report.create("archive", title)
        return
    reason = _reason(status, body)
    if status in (401, 403):
        raise AuthError(f"POST /api/tasks/{ident}/archive refused: {reason}; check KIN_TOKEN")
    if status not in SKIPPABLE:
        raise SeedError(f"POST /api/tasks/{ident}/archive: {reason}")
    report.skip(spec["slug"], reason)


def seed_conversations(api: Api, report: Report) -> None:
    """Create one succeeded, one failed and one archived conversation.

    The fake agent makes each turn terminal; nothing here waits longer than
    KIN_SEED_TASK_TIMEOUT_SECS, and a turn that does not settle is reported as
    a skip rather than hanging the walk.
    """
    agent, why = _fake_agent(api)
    if agent is None:
        for spec in CONVERSATIONS:
            report.skip(spec["slug"], why)
        return
    print(f"fake agent: claude resolves to {FAKE_AGENT_LABEL}")

    try:
        # The archived conversation is not in the default list, so both sides
        # are needed for a second run to find all three.
        filed = _list(api, "/api/tasks", "tasks")
        archived = _list(api, "/api/tasks?archived=1", "tasks")
    except AuthError:
        raise
    except SeedError as exc:
        for spec in CONVERSATIONS:
            report.skip(spec["slug"], str(exc))
        return

    by_title: dict[str, dict] = {}
    for row in filed + archived:
        title = str(row.get("title") or "")
        if title:
            by_title.setdefault(title, row)

    roots = ""
    timeout = _task_timeout()
    for index, spec in enumerate(CONVERSATIONS):
        title = spec["title"]
        row = by_title.get(title)
        if row:
            ident = str(row.get("id") or "")
            report.existing("conversation", title, ident)
            # An interrupted earlier run can leave a row in the wrong state.
            # Say so instead of letting a later walk screenshot it as the
            # fixture it was supposed to be.
            state = str(row.get("status") or "unknown")
            if state not in spec["expect"]:
                report.skip(spec["slug"], f"existing task {ident} is {state}, wanted {'/'.join(spec['expect'])}")
                continue
            if spec["archive"]:
                _set_archived(api, report, spec, ident, bool(row.get("archived_at")))
            continue
        if report.dry_run:
            report.plan("conversation", title)
            continue
        if not roots:
            roots = _seed_roots()
        status, body = api.call(
            "POST",
            "/api/tasks",
            {
                "agent": agent,
                "cwd": os.path.join(roots, ("alpha", "beta", "gamma")[index % 3]),
                "prompt": spec["prompt"],
                "title": title,
                # YOLO: the fake is never asked for an approval card.
                "permission_mode": "yolo",
            },
        )
        if not (status in (200, 201) and isinstance(body, dict) and body.get("id")):
            reason = _reason(status, body)
            if status in (401, 403):
                raise AuthError(f"POST /api/tasks refused: {reason}; check KIN_TOKEN")
            if status not in SKIPPABLE:
                raise SeedError(f"POST /api/tasks: {reason}")
            report.skip(spec["slug"], reason)
            continue
        ident = str(body["id"])
        report.create("conversation", title, ident)

        state, last = _wait_terminal(api, ident, timeout)
        if state is None:
            report.skip(spec["slug"], f"task {ident} still {last} after {timeout:g}s of polling; not waiting forever")
            continue
        if state not in spec["expect"]:
            report.skip(spec["slug"], f"task {ident} ended {state}, wanted {'/'.join(spec['expect'])}")
            continue
        answered, why_not = _fake_answered(api, ident)
        if not answered:
            report.skip(spec["slug"], why_not)
            continue
        if spec["archive"]:
            _set_archived(api, report, spec, ident, False)


def report_unproducible(report: Report) -> None:
    """Name the journey states the fake agent still cannot produce."""
    report.skip("waiting-approval", "the fake agent never emits a permission request, so no approval card appears")
    report.skip("routine-failed", "a failed last run needs a real task execution; the seeded routines have not run")


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
        seed_conversations(api, report)
    except SeedError as exc:
        print(f"journeys seed: {exc}", file=sys.stderr)
        return 1
    report_unproducible(report)
    report.summary()
    return 0


if __name__ == "__main__":
    sys.exit(main())
