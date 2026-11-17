#!/usr/bin/env python3
"""Seed the throwaway daemon that rsi/runtime/ux-walk.sh boots, so the J1-J7
journey screenshots judge real density instead of empty states.

Creates through the public HTTP API only, idempotently, matching rows by the
`[seed] ` name prefix rather than by id. Nothing outside KIN_BASE is touched;
the token is never printed. A state the API cannot produce without launching a
real agent CLI is reported as `skip <state>: <reason>` and does not fail the
walk — ux-walk.sh only treats a non-zero exit as a seed failure.

Each project root is a clean git repository with one committed file, and the
`conversation-created` prompt carries CHANGE_MARKER: the fake agent appends one
line to that tracked file, so the walk can open a real workspace diff instead
of an empty Changes bar.

Conversations are seedable because the harness (rsi/runtime/ux-walk.sh and
scripts/journeys-smoke.sh) puts scripts/journeys_fake_agent first on the
throwaway daemon's PATH: the seed creates one succeeded, one failed, one
archived and one held-open conversation, and refuses to create any unless
/api/agents names a `claude` inside that directory as the binary the daemon
would launch. The held conversation gets its approval card through the same
loopback-only `POST /internal/approvals` bridge the agent's own client uses.
When that card exists, the seed prints one line naming it for the walker:

    j7 target conversation=<task-id> focus=<approval-id>

With no card the line is absent and J7 stays a skip. States the fake cannot
produce — a failed routine run — still print `skip`.

Usage:
    KIN_BASE=http://127.0.0.1:<port> KIN_TOKEN=<token> \
        python3 scripts/journeys_seed.py [--dry-run]
"""

from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.parse
import urllib.request

PREFIX = "[seed] "
# The literal the fake agent looks for; a prompt carrying it asks for one
# modified tracked file, which is the diff the J2 walk opens.
CHANGE_MARKER = "[seed] change"
# The literal the fake agent looks for to hold one tool_use turn open: it
# emits the request and then stays alive, so the task stays `running` until
# the seed asks for an approval through the internal bridge.
APPROVE_MARKER = "[seed] approve"
# The exact line the fake agent appends to notes.md. The shell fake carries the
# same text; a re-run finds it and leaves the file alone.
CHANGE_SENTINEL = "- [seed] change: the journey walk reads this line as a real diff."
# The fake agent only writes inside a root whose path carries this prefix, and
# scripts/journeys_fake_agent/claude hard-codes the same match.
SEED_ROOT_PREFIX = "kin-journeys-seed-"
SEED_ROOT_NAMES = ("alpha", "beta", "gamma")
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
        # CHANGE_MARKER makes the fake agent leave one modified tracked file.
        "prompt": PREFIX + "change: summarise the three things worth doing today.",
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
    {
        # Created last so it is the newest row in the session list, which is
        # the conversation J1 opens.
        "slug": "waiting-approval",
        "title": PREFIX + "Approve the migration",
        # The literal marker keeps the turn open: no result is printed, so the
        # task stays `running` and can carry a real approval row.
        "prompt": APPROVE_MARKER + ": hold this turn open until a person answers.",
        "expect": ("running", "waiting_approval"),
        "archive": False,
        # The one spec that must not wait for a terminal status.
        "hold": True,
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


def _git(root: str, *args: str) -> None:
    """Run git in root. Missing git or a failed command is a seed failure."""
    try:
        done = subprocess.run(["git", *args], cwd=root, capture_output=True, text=True, timeout=30)
    except FileNotFoundError:
        raise SeedError("git is not installed; the seeded roots must be git repositories so the walk can open a real diff") from None
    except subprocess.TimeoutExpired:
        raise SeedError(f"git {' '.join(args)} did not finish within 30s in {root}") from None
    if done.returncode != 0:
        detail = " ".join((done.stderr or done.stdout or "").split())[:200]
        raise SeedError(f"git {' '.join(args)} failed in {root}" + (f": {detail}" if detail else ""))


def _seed_roots() -> str:
    """Fresh temp roots, each a clean git repository with a committed notes.md.

    Never a real repository: the fake agent appends its one diff line only
    inside a path carrying SEED_ROOT_PREFIX, and this is the only place that
    prefix is created. A missing git or a failed command raises SeedError, so
    the walk reports a seed failure instead of a half-prepared root.
    """
    base = tempfile.mkdtemp(prefix=SEED_ROOT_PREFIX)
    for name in SEED_ROOT_NAMES:
        root = os.path.join(base, name)
        os.makedirs(root, exist_ok=True)
        with open(os.path.join(root, "notes.md"), "w", encoding="utf-8") as fh:
            fh.write(
                f"# {name} notes\n\n"
                "- Seeded for the journey walk.\n"
                "- The walk opens the diff the fake agent leaves in this file.\n"
            )
        _git(root, "init", "-q")
        _git(root, "add", "notes.md")
        # Inline identity and no signing: the seed must not depend on, or
        # disturb, whatever git config the machine happens to carry.
        _git(
            root,
            "-c", "user.name=Kin journey seed",
            "-c", "user.email=owner@example.com",
            "-c", "commit.gpgsign=false",
            "commit", "-qm", f"seed: {name} notes",
        )
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


def _wait_status(api: Api, ident: str, wanted: tuple[str, ...], timeout: float) -> tuple[str | None, str]:
    """Poll one task until it reports a status in `wanted`. (status or None, last seen)."""
    deadline = time.monotonic() + timeout
    last = "unknown"
    while time.monotonic() < deadline:
        status, body = api.call("GET", f"/api/tasks/{ident}")
        if status == 200 and isinstance(body, dict):
            last = str(body.get("status") or "unknown")
            if last in wanted:
                return last, last
        else:
            # Say what went wrong instead of reporting a task as merely slow.
            last = _reason(status, body)
        time.sleep(0.1)
    return None, last


def _wait_terminal(api: Api, ident: str, timeout: float) -> tuple[str | None, str]:
    """Poll one task until it settles. Returns (terminal status or None, last seen)."""
    return _wait_status(api, ident, TERMINAL_STATUSES, timeout)


def _fake_answered(api: Api, ident: str) -> tuple[bool, str]:
    """Whether the task's events carry the fake agent's stderr marker, and why not."""
    status, body = api.call("GET", f"/api/tasks/{ident}/events")
    if status != 200:
        return False, f"cannot read task {ident} events: {_reason(status, body)}"
    if "fake-agent" not in json.dumps(body):
        return False, f"task {ident} has no fake-agent marker in its events"
    return True, ""


def _create_approval(api: Api, report: Report, ident: str, timeout: float) -> str | None:
    """Ask the internal bridge for one approval row, then confirm the task waits.

    POST /internal/approvals is what the agent's own client calls: loopback
    only, operator token, and internal/task.RequestApproval moves the task to
    `waiting_approval`. A refusal means this daemon cannot produce the card, so
    it stays a skip — never a failed seed, and never a fabricated card.

    Returns the approval id when the task is confirmed waiting on it, else None.
    """
    status, body = api.call(
        "POST",
        "/internal/approvals",
        {
            "task_id": ident,
            "kind": "tool_use",
            "payload": {"tool_name": "Bash", "input": {"command": "git status --short"}},
        },
    )
    if not (status in (200, 201) and isinstance(body, dict) and body.get("id")):
        report.skip("waiting-approval", f"internal approval refused: {_reason(status, body)}")
        return None
    approval = str(body["id"])
    state, last = _wait_status(api, ident, ("waiting_approval",), timeout)
    if state is None:
        report.skip("waiting-approval", f"task {ident} still {last} after {timeout:g}s of polling; no approval card")
        return None
    report.create("approval", approval)
    return approval


def _pending_approval(api: Api, ident: str) -> str | None:
    """The pending approval id on a task an earlier run already held open.

    A second seed run must still name the J7 target, or the walk would skip a
    conversation whose card is already there. A daemon that cannot answer the
    list leaves the target unnamed (the walker then skips J7); it never invents
    an id and never fails the seed.
    """
    status, body = api.call("GET", "/api/approvals?status=pending")
    if status != 200 or not isinstance(body, list):
        return None
    for row in body:
        if isinstance(row, dict) and str(row.get("task_id") or "") == ident:
            approval = str(row.get("id") or "")
            if approval:
                return approval
    return None


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


def seed_conversations(api: Api, report: Report, projects: dict[str, dict] | None = None) -> tuple[str, str] | None:
    """Create one succeeded, one failed, one archived and one held-open conversation.

    The fake agent makes every turn but the held one terminal; nothing here
    waits longer than KIN_SEED_TASK_TIMEOUT_SECS, and a turn that does not
    settle is reported as a skip rather than hanging the walk. The held
    conversation is never waited on for a terminal status: it exists so the
    walk can photograph the approval card a person actually meets.

    Returns (conversation id, approval id) for the first held conversation that
    really produced a card — the J7 deep link's target — or None.
    """
    agent, why = _fake_agent(api)
    if agent is None:
        for spec in CONVERSATIONS:
            report.skip(spec["slug"], why)
        return None
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
        return None

    target: tuple[str, str] | None = None

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
            if spec.get("hold"):
                # An earlier run can leave the task running because its
                # approval was refused; retry that instead of leaving the walk
                # with no card. A task already waiting needs nothing.
                approval = None
                if state == "running":
                    approval = _create_approval(api, report, ident, timeout)
                elif state == "waiting_approval":
                    approval = _pending_approval(api, ident)
                if approval and target is None:
                    target = (ident, approval)
                continue
            if spec["archive"]:
                _set_archived(api, report, spec, ident, bool(row.get("archived_at")))
            continue
        if report.dry_run:
            report.plan("conversation", title)
            continue
        project_name = PROJECTS[index % len(PROJECTS)][0]
        project_roots = ((projects or {}).get(project_name) or {}).get("roots") or []
        cwd = str(project_roots[0]) if project_roots and project_roots[0] else ""
        if not cwd:
            if not roots:
                roots = _seed_roots()
            cwd = os.path.join(roots, ("alpha", "beta", "gamma")[index % 3])
        status, body = api.call(
            "POST",
            "/api/tasks",
            {
                "agent": agent,
                "cwd": cwd,
                "prompt": spec["prompt"],
                "title": title,
                # YOLO: the fake is never asked for an approval card.
                "permission_mode": "yolo",
                # The seeded root is a clean git repo, which auto mode would
                # isolate in a daemon-owned worktree. The fake agent only
                # writes inside the `kin-journeys-seed-` root, so shared mode
                # keeps the turn there and the walk sees the real diff.
                "workspace_mode": "shared",
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

        if spec.get("hold"):
            # No terminal wait and no fake-answered gate: this turn is meant to
            # stay open. It only has to reach `running` before the agent's own
            # permission bridge will accept an approval for it.
            state, last = _wait_status(api, ident, ("running",), timeout)
            if state is None:
                report.skip(spec["slug"], f"task {ident} still {last} after {timeout:g}s of polling; not waiting forever")
                continue
            approval = _create_approval(api, report, ident, timeout)
            if approval and target is None:
                target = (ident, approval)
            continue

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
    return target


def report_unproducible(report: Report) -> None:
    """Name the journey states the fake agent still cannot produce."""
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
        target = seed_conversations(api, report, projects)
    except SeedError as exc:
        print(f"journeys seed: {exc}", file=sys.stderr)
        return 1
    # One line the walker can consume: the conversation a notification would
    # name and the card it must reveal. Absent when no card exists, which is
    # what keeps J7 a skip rather than a walk against a made-up id.
    if target:
        print(f"j7 target conversation={target[0]} focus={target[1]}")
    report_unproducible(report)
    report.summary()
    return 0


if __name__ == "__main__":
    sys.exit(main())
