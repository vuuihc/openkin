#!/usr/bin/env python3
"""Tests for scripts/journeys_seed.py.

Run directly: `python3 -B scripts/journeys_seed_test.py`. No network: every
case runs the real script against a local `http.server` stub that records the
requests it received, so "created nothing" is a fact about intercepted HTTP,
not about the script's own report.
"""

from __future__ import annotations

import json
import os
import queue
import re
import shutil
import subprocess
import sys
import tempfile
import threading
import time
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse

SCRIPTS = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(SCRIPTS)
SEED = os.path.join(SCRIPTS, "journeys_seed.py")
JOURNEYS_SPEC = os.path.join(ROOT, "rsi", "runtime", "ux", "journeys.json")

SPECPY = os.path.join(ROOT, "rsi", "runtime", "ux", "spec.py")


def load_spec(path: str = JOURNEYS_SPEC) -> dict:
    """The journey index resolved through rsi/runtime/ux/spec.py, the one reader."""
    out = subprocess.check_output([sys.executable, SPECPY, "--resolve", path])
    return json.loads(out)

sys.path.insert(0, SCRIPTS)
import journeys_seed  # noqa: E402
# A value the script is never allowed to echo. Deliberately fake: the point is
# the mechanism, and a real token must not live in a public test file.
TOKEN = "tok-test-2f8a1c-never-print"

PROJECTS = ["[seed] Project Alpha", "[seed] Project Beta", "[seed] Project Gamma"]
ROUTINES = ["[seed] Morning check-in", "[seed] Weekly review"]
# Three held cards: J1 approves one and denies another by id, and J7's deep
# link names the third. Created in this order so the approve card stays the
# newest row J1 opens.
HELD_CONVERSATION = "[seed] Approve the migration"
DENY_CONVERSATION = "[seed] Deny the migration"
J7_CONVERSATION = "[seed] Answer the deploy"
HELD_CONVERSATIONS = [DENY_CONVERSATION, J7_CONVERSATION, HELD_CONVERSATION]
# J15's held turn carries no approval card: two questions through the loopback
# bridge move it to `waiting_input`. It sits between the J7 card and the
# approve card, so the approve row J1 opens stays the newest one.
J15_CONVERSATION = "[seed] Choose the release path"
# The one conversation that is still working when J5 opens its row menu. It
# carries the `[seed] hold` marker, asks for no approval card, and stays
# `running` — the state the shipped 运行中 / Running line is drawn for.
RUNNING_CONVERSATION = "[seed] Running the migration"
CONVERSATIONS = [
    "[seed] Morning planning",
    "[seed] Failed migration",
    "[seed] Last week's review",
    # J8's own diff: Project Beta's notes.md, which J2's rerun leg never
    # rewrites. Created before the held fixtures so the approve row J1 opens
    # stays the newest row.
    "[seed] Phone review",
    # Two more rows in Gamma: J12's edge-back leg scrolls the phone list before
    # it pops the screen, and the filtered list must be more than scroll-kept's
    # 48px tolerance taller than the viewport for the read-back to mean anything.
    "[seed] Gamma planning",
    "[seed] Gamma review",
    RUNNING_CONVERSATION,
    DENY_CONVERSATION,
    J7_CONVERSATION,
    J15_CONVERSATION,
    HELD_CONVERSATION,
]
# The one line the next slice targets both cards from.
J1_TARGETS = re.compile(
    r"^j1 targets approve conversation=(\S+) focus=(\S+) deny conversation=(\S+) focus=(\S+)$", re.M
)
# J7's line names its own card and the title the walk clicks after Back.
J7_TARGET = re.compile(r"^j7 target conversation=(\S+) focus=(\S+) title=(.+)$", re.M)
# J5's line names the still-running row it must open the menu of.
J5_TARGET = re.compile(r"^j5 target conversation=(\S+) title=(.+)$", re.M)
# The path the seed must see when it asks the daemon which claude it would run.
# The directory name is what the seed checks; the script itself only has to be
# named `claude` for the stub.
FAKE_AGENT = os.path.join(SCRIPTS, "journeys_fake_agent", "claude")


class Stub:
    """In-memory daemon: just the routes journeys_seed.py is allowed to use."""

    def __init__(self) -> None:
        self.projects: list[dict] = []
        self.routines: list[dict] = []
        self.one_pagers: dict[str, str] = {}
        self.agents: list[dict] = []
        self.tasks: list[dict] = []
        self.approvals: list[dict] = []
        self.questions: list[dict] = []
        self.task_events: dict[str, list[dict]] = {}
        # False keeps every created task in `running` forever, for the bounded-
        # wait case.
        self.tasks_terminal = True
        # Force one terminal status for every created task, for the
        # wrong-outcome case. Empty means derive it from the prompt marker.
        self.force_status = ""
        # False drops the fake agent's stderr marker from the events.
        self.emit_fake_marker = True
        self.requests: list[tuple[str, str, bytes]] = []
        self.fail: list[tuple[tuple[str, str], int]] = []
        # Task title -> HTTP status the approval bridge answers for that task.
        # Lets a test refuse one held card without touching the other.
        self.approval_refusals: dict[str, int] = {}
        # Task title -> HTTP status the user-question bridge answers.
        self.question_refusals: dict[str, int] = {}
        self.seq = {"prj": 0, "rtn": 0, "tsk": 0, "apr": 0, "qst": 0}

    def mutations(self) -> list[tuple[str, str]]:
        return [(m, p) for m, p, _ in self.requests if m != "GET"]


class _Handler(BaseHTTPRequestHandler):
    def log_message(self, *args: object) -> None:  # keep the test output clean
        pass

    def _json(self, status: int, body: object) -> None:
        raw = json.dumps(body).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(raw)))
        self.end_headers()
        self.wfile.write(raw)

    def _dispatch(self, method: str) -> None:
        parsed = urlparse(self.path)
        path = parsed.path
        query = parse_qs(parsed.query)
        length = int(self.headers.get("Content-Length") or 0)
        raw = self.rfile.read(length) if length else b""
        stub: Stub = self.server.stub  # type: ignore[attr-defined]
        # Headers are not recorded: the Authorization token must never reach a
        # fixture another test could print.
        stub.requests.append((method, path, raw))
        for (want_method, prefix), status in stub.fail:
            if method == want_method and path.startswith(prefix):
                return self._json(status, {"error": "stub refused"})

        if method == "GET" and path == "/api/projects":
            return self._json(200, stub.projects)
        if method == "POST" and path == "/api/projects":
            body = json.loads(raw or b"{}")
            stub.seq["prj"] += 1
            row = {"id": f"prj-{stub.seq['prj']}", "name": body.get("name"), "roots": body.get("roots") or []}
            stub.projects.append(row)
            return self._json(201, row)
        match = re.fullmatch(r"/api/projects/([^/]+)/one-pager", path)
        if match and method == "GET":
            markdown = stub.one_pagers.get(match.group(1))
            if markdown is None:
                return self._json(404, {"error": "one-pager file missing"})
            return self._json(200, {"markdown": markdown, "updated_at": 1})
        if match and method == "PUT":
            stub.one_pagers[match.group(1)] = json.loads(raw or b"{}").get("markdown", "")
            return self._json(200, {"ok": True})
        if method == "GET" and path == "/api/routines":
            return self._json(200, stub.routines)
        if method == "POST" and path == "/api/routines":
            body = json.loads(raw or b"{}")
            stub.seq["rtn"] += 1
            row = {"id": f"rtn-{stub.seq['rtn']}", **body}
            stub.routines.append(row)
            return self._json(201, row)
        if method == "GET" and path == "/api/agents":
            return self._json(200, stub.agents)
        if method == "GET" and path == "/api/tasks":
            want_archived = query.get("archived", ["0"])[0] == "1"
            rows = [row for row in stub.tasks if bool(row.get("archived_at")) == want_archived]
            return self._json(200, rows)
        if method == "POST" and path == "/api/tasks":
            body = json.loads(raw or b"{}")
            stub.seq["tsk"] += 1
            ident = f"tsk-{stub.seq['tsk']}"
            prompt = str(body.get("prompt", ""))
            if not stub.tasks_terminal:
                status = "running"
            elif stub.force_status:
                status = stub.force_status
            elif "[seed] approve" in prompt:
                # The held turn never prints a result: it stays running until
                # an approval is requested.
                status = "running"
            elif "[seed] hold" in prompt:
                # The still-working turn never prints a result and never asks
                # for an approval: it stays `running` for the whole walk.
                status = "running"
            else:
                # The fake agent fails exactly the prompts carrying its marker.
                status = "failed" if "[seed] fail" in prompt else "succeeded"
            row = {
                "id": ident,
                "title": body.get("title"),
                "prompt": body.get("prompt"),
                "agent": body.get("agent"),
                "permission_mode": body.get("permission_mode"),
                "status": status,
                "archived_at": None,
            }
            stub.tasks.append(row)
            events = [{"type": "result", "payload": {"is_error": status == "failed"}}]
            if stub.emit_fake_marker:
                events.insert(0, {"type": "raw_output", "payload": {"line": f"fake-agent {row['title']}", "stream": "stderr"}})
            stub.task_events[ident] = events
            return self._json(201, row)
        if method == "POST" and path == "/internal/approvals":
            body = json.loads(raw or b"{}")
            row = next((task for task in stub.tasks if task["id"] == body.get("task_id")), None)
            if row is None:
                return self._json(404, {"error": "task not found"})
            refusal = stub.approval_refusals.get(str(row.get("title") or ""))
            if refusal:
                return self._json(refusal, {"error": "stub refused this card"})
            # Mirrors internal/task.RequestApproval: only a live turn can ask.
            if row["status"] not in ("running", "waiting_approval", "waiting_input"):
                return self._json(409, {"error": f"task status {row['status']} cannot request approval"})
            stub.seq["apr"] += 1
            approval = {
                "id": f"apr-{stub.seq['apr']}",
                "task_id": row["id"],
                "kind": body.get("kind") or "tool_use",
                "payload": body.get("payload") or {},
                "decision": "pending",
            }
            stub.approvals.append(approval)
            row["status"] = "waiting_approval"
            return self._json(201, approval)
        if method == "GET" and path == "/api/approvals":
            want_status = query.get("status", [""])[0]
            rows = [a for a in stub.approvals if not want_status or a.get("decision") == want_status]
            return self._json(200, rows)
        if method == "POST" and path == "/internal/user-questions":
            body = json.loads(raw or b"{}")
            row = next((task for task in stub.tasks if task["id"] == body.get("task_id")), None)
            if row is None:
                return self._json(404, {"error": "task not found"})
            refusal = stub.question_refusals.get(str(row.get("title") or ""))
            if refusal:
                return self._json(refusal, {"error": "stub refused this question"})
            # Mirrors internal/task.RequestUserQuestion: only a live turn can ask.
            if row["status"] not in ("running", "waiting_approval", "waiting_input"):
                return self._json(409, {"error": f"task status {row['status']} cannot request a question"})
            stub.seq["qst"] += 1
            question = {
                "id": f"qst-{stub.seq['qst']}",
                "task_id": row["id"],
                "payload": {
                    "question": body.get("question"),
                    "header": body.get("header"),
                    "options": body.get("options") or [],
                },
                "status": "pending",
            }
            stub.questions.append(question)
            row["status"] = "waiting_input"
            return self._json(201, question)
        if method == "GET" and path == "/api/user-questions":
            want_status = query.get("status", [""])[0]
            rows = [q for q in stub.questions if not want_status or q.get("status") == want_status]
            return self._json(200, rows)
        match = re.fullmatch(r"/api/tasks/([^/]+)/events", path)
        if match and method == "GET":
            if match.group(1) not in stub.task_events:
                return self._json(404, {"error": "not found"})
            return self._json(200, stub.task_events[match.group(1)])
        match = re.fullmatch(r"/api/tasks/([^/]+)/archive", path)
        if match and method == "POST":
            for row in stub.tasks:
                if row["id"] == match.group(1):
                    row["archived_at"] = 1
                    return self._json(200, row)
            return self._json(404, {"error": "not found"})
        match = re.fullmatch(r"/api/tasks/([^/]+)", path)
        if match and method == "GET":
            for row in stub.tasks:
                if row["id"] == match.group(1):
                    return self._json(200, row)
            return self._json(404, {"error": "not found"})
        return self._json(404, {"error": "no stub route"})

    def do_GET(self) -> None:
        self._dispatch("GET")

    def do_POST(self) -> None:
        self._dispatch("POST")

    def do_PUT(self) -> None:
        self._dispatch("PUT")

    def do_DELETE(self) -> None:
        self._dispatch("DELETE")


class SeedTest(unittest.TestCase):
    def setUp(self) -> None:
        self.stub = Stub()
        self.server = ThreadingHTTPServer(("127.0.0.1", 0), _Handler)
        self.server.stub = self.stub  # type: ignore[attr-defined]
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.base = f"http://127.0.0.1:{self.server.server_address[1]}"
        self.addCleanup(self._stop)

    def _stop(self) -> None:
        self.server.shutdown()
        self.server.server_close()

    def run_seed(
        self,
        *args: str,
        base: str | None = "stub",
        token: str = TOKEN,
        extra_env: dict[str, str] | None = None,
    ) -> subprocess.CompletedProcess[str]:
        env = {key: value for key, value in os.environ.items() if key in ("PATH", "TMPDIR", "LANG", "LC_ALL")}
        env["KIN_TOKEN"] = token
        env.update(extra_env or {})
        if base is not None:
            env["KIN_BASE"] = self.base if base == "stub" else base
        return subprocess.run(
            [sys.executable, "-B", SEED, *args],
            capture_output=True,
            text=True,
            env=env,
            timeout=120,
        )

    def preload(self) -> None:
        self.stub.projects = [
            {"id": "prj-alpha", "name": PROJECTS[0]},
            {"id": "prj-beta", "name": PROJECTS[1]},
            {"id": "prj-gamma", "name": PROJECTS[2]},
        ]
        self.stub.one_pagers = {
            "prj-alpha": f"# Alpha\n## Current Focus\n{journeys_seed.FOCUS_SENTINEL}\n",
            "prj-gamma": f"# Gamma\n## 工作方式\n{journeys_seed.GAMMA_INSTRUCTIONS}\n",
        }
        self.stub.routines = [
            {"id": "rtn-1", "title": ROUTINES[0]},
            {"id": "rtn-2", "title": ROUTINES[1]},
        ]

    def enable_fake_agent(self) -> None:
        """The daemon reports the harness fake as the claude it would launch."""
        self.stub.agents = [
            {"id": "claude-code", "name": "Claude Code", "installed": True, "available": True, "binary": FAKE_AGENT}
        ]

    def task_posts(self) -> list[dict]:
        return [json.loads(raw or b"{}") for m, p, raw in self.stub.requests if m == "POST" and p == "/api/tasks"]

    def approval_posts(self) -> list[dict]:
        return [
            json.loads(raw or b"{}")
            for m, p, raw in self.stub.requests
            if m == "POST" and p == "/internal/approvals"
        ]

    def skip_states(self, result: subprocess.CompletedProcess[str]) -> list[str]:
        return [line[len("skip ") :].split(":", 1)[0] for line in result.stdout.splitlines() if line.startswith("skip ")]

    def j1_targets(self, stdout: str) -> tuple[tuple[str, str], tuple[str, str]]:
        """((approve conversation, approve focus), (deny conversation, deny focus))."""
        hits = J1_TARGETS.findall(stdout)
        self.assertEqual(len(hits), 1, stdout)
        approve_conversation, approve_focus, deny_conversation, deny_focus = hits[0]
        return (approve_conversation, approve_focus), (deny_conversation, deny_focus)

    def j7_target(self, stdout: str) -> tuple[str, str, str]:
        hits = J7_TARGET.findall(stdout)
        self.assertEqual(len(hits), 1, stdout)
        return hits[0]

    def held_approval(self, title: str) -> dict:
        task = next(row for row in self.stub.tasks if row["title"] == title)
        approval = next(row for row in self.stub.approvals if row["task_id"] == task["id"])
        return {"task": task, "approval": approval}

    def assert_report(self, result: subprocess.CompletedProcess[str], pattern: str) -> None:
        self.assertRegex(result.stdout, pattern, result.stdout + result.stderr)

    def test_missing_base_refuses(self) -> None:
        result = self.run_seed(base=None)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("KIN_BASE", result.stderr)
        self.assertEqual(self.stub.requests, [])

    def test_dry_run_creates_nothing(self) -> None:
        result = self.run_seed("--dry-run")
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertEqual(self.stub.mutations(), [])
        self.assertIn("plan project [seed] Project Alpha", result.stdout)
        self.assertIn("plan routine [seed] Morning check-in", result.stdout)
        self.assertNotIn("create project", result.stdout)

    def test_second_run_is_idempotent(self) -> None:
        self.preload()
        result = self.run_seed()
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertEqual(self.stub.mutations(), [])
        for name in PROJECTS:
            self.assert_report(result, rf"existing project {re.escape(name)} \S+")
        self.assert_report(result, r"existing focus \[seed\] Project Alpha")
        for name in ROUTINES:
            self.assert_report(result, rf"existing routine {re.escape(name)} \S+")

    def test_unproducible_state_is_skipped(self) -> None:
        # The focus write is the one fixture most likely to be refused on a
        # daemon whose project One-Pager is read-only or locked.
        self.stub.fail = [(("PUT", "/api/projects/prj-1/one-pager"), 409)]
        result = self.run_seed()
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertIn("skip focus: ", result.stdout)
        self.assertIn("409", result.stdout)
        created = self.stub.mutations()
        self.assertIn(("POST", "/api/projects"), created)
        self.assertIn(("POST", "/api/routines"), created)

    def test_routine_422_skips_and_continues(self) -> None:
        self.stub.fail = [(("POST", "/api/routines"), 422)]
        result = self.run_seed()
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertIn("skip routine-enabled: ", result.stdout)
        self.assertIn("skip routine-paused: ", result.stdout)
        self.assertIn(("POST", "/api/projects"), self.stub.mutations())

    def test_token_never_printed(self) -> None:
        self.stub.fail = [(("PUT", "/api/projects/prj-1/one-pager"), 409)]
        for result in (self.run_seed(), self.run_seed(base=None), self.run_seed(base="http://127.0.0.1:1")):
            self.assertNotIn(TOKEN, result.stdout)
            self.assertNotIn(TOKEN, result.stderr)

    def test_conversations_are_created_idempotently(self) -> None:
        self.enable_fake_agent()
        result = self.run_seed()
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        posts = self.task_posts()
        self.assertEqual(len(posts), len(CONVERSATIONS), result.stdout)
        for body in posts:
            self.assertTrue(str(body.get("title", "")).startswith("[seed] "), body)
            self.assertTrue(str(body.get("prompt", "")).startswith("[seed] "), body)
            # YOLO keeps the fake from ever being asked for an approval card;
            # the one card comes from the permission bridge instead.
            self.assertEqual(body.get("agent"), "claude-code", body)
            self.assertEqual(body.get("permission_mode"), "yolo", body)
            # A clean git root would be isolated in a daemon worktree by auto
            # mode, where the fake agent's seed-root guard refuses to write.
            self.assertEqual(body.get("workspace_mode"), "shared", body)
        self.assertEqual(
            [body.get("cwd") for body in posts],
            [proj["roots"][0] for proj in self.stub.projects]
            + [
                # J8's own diff opens on Beta, where the deny/J7 fixtures never
                # write; the archived conversation stays in Gamma, and the
                # still-working one is named in Gamma too, so Alpha/Beta row
                # order does not move for the journeys that read it.
                self.stub.projects[1]["roots"][0],
                self.stub.projects[2]["roots"][0],
                self.stub.projects[2]["roots"][0],
                self.stub.projects[2]["roots"][0],
                self.stub.projects[1]["roots"][0],
                self.stub.projects[1]["roots"][0],
                # J15's question turn holds in Beta, before the approve card.
                self.stub.projects[1]["roots"][0],
                self.stub.projects[0]["roots"][0],
            ],
        )
        failed = [row for row in self.stub.tasks if row["status"] == "failed"]
        self.assertEqual(len(failed), 1, self.stub.tasks)
        self.assertIn("[seed] fail", failed[0]["prompt"])
        archived = [row for row in self.stub.tasks if row["archived_at"]]
        self.assertEqual(len(archived), 1, self.stub.tasks)
        self.assertEqual(archived[0]["title"], CONVERSATIONS[2])
        self.assertIn(("POST", f"/api/tasks/{archived[0]['id']}/archive"), self.stub.mutations())

        # A second run finds all three, including the archived one, and creates
        # nothing new.
        before = len(self.stub.tasks)
        self.stub.requests.clear()
        result = self.run_seed()
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertEqual(self.stub.mutations(), [])
        self.assertEqual(len(self.stub.tasks), before)
        for title in CONVERSATIONS:
            self.assert_report(result, rf"existing conversation {re.escape(title)} \S+")
        self.assert_report(result, rf"existing archive {re.escape(CONVERSATIONS[2])}")

    def test_seeds_a_pristine_review_conversation_for_j8(self) -> None:
        # J2's rerun leg rewrites [seed] Morning planning's notes.md: [seed]
        # shift moves the commented line and [seed] rewrite deletes the quoted
        # text. J8 must read a file no other journey touches, or its tray wait
        # asks for a line that is gone and the failure is excused as a known
        # artifact. Beta's root gets this one turn's sentinel and nothing else
        # writes there (the deny/J7 fixtures hold turns without touching files).
        morning = next(spec for spec in journeys_seed.CONVERSATIONS if spec["title"] == "[seed] Morning planning")
        review = next(spec for spec in journeys_seed.CONVERSATIONS if spec["title"] == "[seed] Phone review")
        self.assertIn(journeys_seed.CHANGE_MARKER, review["prompt"])
        self.assertEqual(review["prompt"], "[seed] change: review this diff from the phone.")
        self.assertEqual(review["expect"], ("succeeded",))
        self.assertIs(review["archive"], False)
        self.assertEqual(review.get("project"), "Project Beta")
        # The default is positional, so compare the project the seed will
        # actually use for Morning planning, not just its absent key.
        morning_project = morning.get("project") or journeys_seed.PROJECTS[
            journeys_seed.CONVERSATIONS.index(morning) % len(journeys_seed.PROJECTS)
        ][0]
        self.assertNotEqual(review["project"], morning_project)
        # Created after the archived fixture and before the held ones: the
        # approve row J1 opens must stay the newest row in the list.
        titles = [spec["title"] for spec in journeys_seed.CONVERSATIONS]
        self.assertLess(titles.index("[seed] Last week's review"), titles.index(review["title"]))
        self.assertLess(titles.index(review["title"]), titles.index(RUNNING_CONVERSATION))

    def test_conversations_are_not_created_in_dry_run(self) -> None:
        self.enable_fake_agent()
        result = self.run_seed("--dry-run")
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertEqual(self.stub.mutations(), [])
        for title in CONVERSATIONS:
            self.assertIn(f"plan conversation {title}", result.stdout)
        self.assertNotIn("create conversation", result.stdout)

    def test_reports_only_the_unproduced_states(self) -> None:
        self.enable_fake_agent()
        result = self.run_seed()
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertEqual(self.skip_states(result), ["routine-failed"], result.stdout)

    def test_seed_holds_three_conversations_in_waiting_approval(self) -> None:
        # One card is approved today, one is denied, and one is the J7 landing
        # target. All must be real waiting_approval tasks, or the walk
        # photographs nothing.
        self.enable_fake_agent()
        result = self.run_seed()
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        held = [row for row in self.stub.tasks if row["title"] in HELD_CONVERSATIONS]
        self.assertEqual([row["title"] for row in held], HELD_CONVERSATIONS, self.stub.tasks)
        for row in held:
            self.assertEqual(row["status"], "waiting_approval", self.stub.tasks)
        posts = self.approval_posts()
        self.assertEqual(len(posts), 3, result.stdout)
        self.assertEqual({post.get("task_id") for post in posts}, {row["id"] for row in held}, posts)
        for post in posts:
            self.assertEqual(post.get("kind"), "tool_use", post)
            self.assertTrue((post.get("payload") or {}).get("tool_name"), post)
        self.assertIn("create approval apr-1", result.stdout)
        self.assertIn("create approval apr-2", result.stdout)
        self.assertIn("create approval apr-3", result.stdout)
        self.assertNotIn("skip waiting-approval:", result.stdout)
        self.assertNotIn("skip waiting-approval-deny:", result.stdout)
        self.assertNotIn("skip waiting-approval-j7:", result.stdout)

    def test_seeds_two_pending_questions_and_names_the_first(self) -> None:
        # J15 answers one card by option and the Other field on the card left
        # behind, so both questions must be pending on one waiting_input turn.
        # The target line names the first id; the walker resolves it.
        self.enable_fake_agent()
        result = self.run_seed()
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        task = next(row for row in self.stub.tasks if row["title"] == J15_CONVERSATION)
        self.assertEqual(task["status"], "waiting_input", self.stub.tasks)
        pending = [q for q in self.stub.questions if q["status"] == "pending"]
        self.assertEqual(len(pending), 2, self.stub.questions)
        self.assertEqual(
            [q["payload"]["question"] for q in pending],
            [ask["question"] for ask in journeys_seed.J15_QUESTIONS],
        )
        match = re.search(r"^j15 target conversation=(\S+) focus=(\S+)$", result.stdout, re.M)
        self.assertIsNotNone(match, result.stdout)
        self.assertEqual(match.group(1), task["id"], result.stdout)
        self.assertEqual(match.group(2), pending[0]["id"], result.stdout)
        # A second run reuses both cards by their text: no duplicate POST.
        self.stub.requests.clear()
        result = self.run_seed()
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertEqual(len(self.stub.questions), 2, self.stub.questions)
        self.assertEqual(
            [m for m in self.stub.mutations() if m[1] == "/internal/user-questions"], []
        )

    def test_question_bridge_refusal_skips_and_names_no_target(self) -> None:
        # A refused bridge must never print a j15 target: the walk would aim
        # at a card that is not there. Fail closed with the skip instead.
        self.enable_fake_agent()
        self.stub.question_refusals[J15_CONVERSATION] = 503
        result = self.run_seed()
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertIn(
            "skip waiting-question-j15: internal user question refused: HTTP 503", result.stdout
        )
        self.assertNotIn("j15 target", result.stdout)
        self.assertEqual(self.stub.questions, [])

    def test_seeds_one_running_conversation_with_no_approval_card(self) -> None:
        # J5 opens this row's menu while the turn is still going. The row must
        # be `running` — `waiting_approval` reads as an approval card, not a
        # run — and the seed must not ask the bridge for a card for it.
        self.enable_fake_agent()
        result = self.run_seed()
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        row = next(row for row in self.stub.tasks if row["title"] == RUNNING_CONVERSATION)
        self.assertEqual(row["status"], "running", self.stub.tasks)
        self.assertIn("[seed] hold", row["prompt"])
        approval_tasks = {post.get("task_id") for post in self.approval_posts()}
        self.assertNotIn(row["id"], approval_tasks, "a card would turn the row into waiting_approval")
        self.assertIn(f"create conversation {RUNNING_CONVERSATION}", result.stdout)
        self.assertNotIn("skip conversation-running:", result.stdout)
        hits = J5_TARGET.findall(result.stdout)
        self.assertEqual(len(hits), 1, result.stdout)
        self.assertEqual(hits[0], (row["id"], RUNNING_CONVERSATION))

    def test_running_conversation_does_not_wait_for_a_terminal_status(self) -> None:
        # The turn is held open on purpose. Waiting for it to settle would
        # turn the one fixture J5's menu assertion needs into a skip (or a
        # 15-second stall on every seed).
        self.enable_fake_agent()
        started = time.monotonic()
        result = self.run_seed(extra_env={"KIN_SEED_TASK_TIMEOUT_SECS": "0.2"})
        elapsed = time.monotonic() - started
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        row = next(row for row in self.stub.tasks if row["title"] == RUNNING_CONVERSATION)
        self.assertEqual(row["status"], "running", self.stub.tasks)
        self.assertLess(elapsed, 60, "the seed must not poll a deliberately open turn to its deadline")

    def test_approval_conversation_does_not_wait_for_terminal(self) -> None:
        # The held task is running forever by design. Waiting for a terminal
        # status would turn the one fixture this slice exists for into a skip.
        self.enable_fake_agent()
        self.stub.tasks_terminal = False
        started = time.monotonic()
        result = self.run_seed(extra_env={"KIN_SEED_TASK_TIMEOUT_SECS": "0.2"})
        elapsed = time.monotonic() - started
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertIn("create approval", result.stdout)
        self.assertNotIn("skip waiting-approval:", result.stdout)
        self.assertLess(elapsed, 15, result.stdout)

    def test_internal_approval_refusal_keeps_the_skip(self) -> None:
        self.enable_fake_agent()
        self.stub.fail = [(("POST", "/internal/approvals"), 404)]
        result = self.run_seed()
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        for title in HELD_CONVERSATIONS:
            self.assertIn(f"create conversation {title}", result.stdout)
        self.assertIn("skip waiting-approval: internal approval refused: HTTP 404", result.stdout)
        self.assertIn("skip waiting-approval-deny: internal approval refused: HTTP 404", result.stdout)
        self.assertIn("skip waiting-approval-j7: internal approval refused: HTTP 404", result.stdout)
        self.assertEqual(self.stub.approvals, [])

    def test_j7_target_line_names_its_own_card_and_title(self) -> None:
        # The walker has no other way to learn which conversation a
        # notification would name, which card it points at, or which row to
        # click after Back: a refused card must produce no target line (J7
        # then skips), and a produced card must name all three.
        self.enable_fake_agent()
        self.stub.approval_refusals = {J7_CONVERSATION: 409}
        refused = self.run_seed()
        self.assertEqual(refused.returncode, 0, refused.stdout + refused.stderr)
        self.assertNotIn("j7 target", refused.stdout)
        self.assertIn("skip waiting-approval-j7: ", refused.stdout)
        # The two J1 cards are live; J7 still names neither of them.
        self.assertIn("j1 targets", refused.stdout)

        # Clearing the refusal makes the next run retry the held (still
        # running) J7 conversation and name exactly that card.
        self.stub.approval_refusals = {}
        result = self.run_seed()
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        held = next(row for row in self.stub.tasks if row["title"] == J7_CONVERSATION)
        approval = next(row for row in self.stub.approvals if row["task_id"] == held["id"])
        self.assertEqual(held["status"], "waiting_approval", self.stub.tasks)
        targets = [line for line in result.stdout.splitlines() if line.startswith("j7 target ")]
        self.assertEqual(
            targets,
            [f"j7 target conversation={held['id']} focus={approval['id']} title={J7_CONVERSATION}"],
            result.stdout,
        )

    def test_j7_target_line_survives_a_second_run(self) -> None:
        # A daemon seeded once and walked twice must still name the card: the
        # pending approval is already on the task, so the line comes from the
        # list rather than from a new POST.
        self.enable_fake_agent()
        first = self.run_seed()
        self.assertEqual(first.returncode, 0, first.stdout + first.stderr)
        second = self.run_seed()
        self.assertEqual(second.returncode, 0, second.stdout + second.stderr)
        held = next(row for row in self.stub.tasks if row["title"] == J7_CONVERSATION)
        approval = next(row for row in self.stub.approvals if row["task_id"] == held["id"])
        self.assertEqual(self.j7_target(second.stdout), (held["id"], approval["id"], J7_CONVERSATION))
        self.assertEqual(len(self.approval_posts()), 3, second.stdout)
        self.assertEqual(len(self.stub.approvals), 3, second.stdout)
        self.assertIn(("GET", "/api/approvals"), [(m, p) for m, p, _ in self.stub.requests])
        self.assertNotIn("create approval", second.stdout)

    def test_seeds_three_held_conversations_and_prints_both_targets(self) -> None:
        # The next slice denies by id and J7 lands on its own card, so the seed
        # must create all three cards and name each conversation with its own
        # approval in the machine lines.
        self.enable_fake_agent()
        result = self.run_seed()
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        held = [row for row in self.stub.tasks if row["title"] in HELD_CONVERSATIONS]
        self.assertEqual({row["title"] for row in held}, set(HELD_CONVERSATIONS), result.stdout)
        for row in held:
            self.assertEqual(row["status"], "waiting_approval", self.stub.tasks)
        posts = self.approval_posts()
        self.assertEqual(len(posts), 3, result.stdout)
        self.assertEqual(len({post.get("task_id") for post in posts}), 3, posts)
        agree = self.held_approval(HELD_CONVERSATION)
        deny = self.held_approval(DENY_CONVERSATION)
        j7 = self.held_approval(J7_CONVERSATION)
        (approve_conversation, approve_focus), (deny_conversation, deny_focus) = self.j1_targets(result.stdout)
        self.assertEqual((approve_conversation, approve_focus), (agree["task"]["id"], agree["approval"]["id"]))
        self.assertEqual((deny_conversation, deny_focus), (deny["task"]["id"], deny["approval"]["id"]))
        self.assertNotEqual(approve_conversation, deny_conversation, result.stdout)
        self.assertNotEqual(approve_focus, deny_focus, result.stdout)
        # The approve card stays the newest row, so J1 landed on it before the
        # other cards existed and keeps landing on it now.
        self.assertEqual(self.stub.tasks[-1]["title"], HELD_CONVERSATION, result.stdout)
        self.assertEqual(
            self.j7_target(result.stdout),
            (j7["task"]["id"], j7["approval"]["id"], J7_CONVERSATION),
        )

    def test_j7_target_is_its_own_pending_card(self) -> None:
        # J1 presses Approve on the approve card earlier in the same walk, so
        # asserting "the card is visible" there would be red for the wrong
        # reason. J7's line names its own held conversation, card and title —
        # never the approve or deny conversation.
        self.enable_fake_agent()
        result = self.run_seed()
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        j7 = self.held_approval(J7_CONVERSATION)
        agree = self.held_approval(HELD_CONVERSATION)
        deny = self.held_approval(DENY_CONVERSATION)
        conversation, focus, title = self.j7_target(result.stdout)
        self.assertEqual((conversation, focus), (j7["task"]["id"], j7["approval"]["id"]))
        self.assertEqual(title, J7_CONVERSATION)
        self.assertNotIn(conversation, {agree["task"]["id"], deny["task"]["id"]}, result.stdout)
        self.assertNotIn(focus, {agree["approval"]["id"], deny["approval"]["id"]}, result.stdout)

    def test_rerun_creates_no_second_pair(self) -> None:
        self.enable_fake_agent()
        first = self.run_seed()
        self.assertEqual(first.returncode, 0, first.stdout + first.stderr)
        tasks_after_first = len(self.stub.tasks)
        approvals_after_first = len(self.stub.approvals)
        first_targets = self.j1_targets(first.stdout)
        first_j7 = self.j7_target(first.stdout)
        self.stub.requests.clear()

        second = self.run_seed()
        self.assertEqual(second.returncode, 0, second.stdout + second.stderr)
        self.assertNotIn(("POST", "/api/tasks"), [(m, p) for m, p, _ in self.stub.requests])
        self.assertEqual(self.approval_posts(), [], second.stdout)
        self.assertEqual(len(self.stub.tasks), tasks_after_first, second.stdout)
        self.assertEqual(len(self.stub.approvals), approvals_after_first, second.stdout)
        self.assertEqual(self.j1_targets(second.stdout), first_targets)
        self.assertEqual(self.j7_target(second.stdout), first_j7)

    def test_deny_bridge_refusal_is_a_skip(self) -> None:
        # A daemon that refuses the second card must still leave the approve
        # and J7 cards usable, and must say which card it could not produce.
        self.enable_fake_agent()
        self.stub.approval_refusals = {DENY_CONVERSATION: 409}
        result = self.run_seed()
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        agree = self.held_approval(HELD_CONVERSATION)
        j7 = self.held_approval(J7_CONVERSATION)
        deny = next(row for row in self.stub.tasks if row["title"] == DENY_CONVERSATION)
        self.assertEqual(agree["task"]["status"], "waiting_approval", self.stub.tasks)
        self.assertEqual(j7["task"]["status"], "waiting_approval", self.stub.tasks)
        self.assertEqual(deny["status"], "running", self.stub.tasks)
        self.assertEqual(
            {row["task_id"] for row in self.stub.approvals},
            {agree["task"]["id"], j7["task"]["id"]},
            result.stdout,
        )
        self.assertIn("skip waiting-approval-deny: internal approval refused: HTTP 409", result.stdout)
        self.assertNotIn("skip waiting-approval:", result.stdout)
        # One card cannot be expressed as the two-pair target line.
        self.assertNotIn("j1 targets", result.stdout)
        self.assertEqual(
            self.j7_target(result.stdout),
            (j7["task"]["id"], j7["approval"]["id"], J7_CONVERSATION),
        )

    def test_approve_bridge_refusal_does_not_take_j7_down(self) -> None:
        # The mirror image: J7 no longer borrows the approve card, so a refused
        # approve card leaves J7's own line intact and the deny fixture usable.
        self.enable_fake_agent()
        self.stub.approval_refusals = {HELD_CONVERSATION: 409}
        result = self.run_seed()
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        agree = next(row for row in self.stub.tasks if row["title"] == HELD_CONVERSATION)
        deny = self.held_approval(DENY_CONVERSATION)
        j7 = self.held_approval(J7_CONVERSATION)
        self.assertEqual(agree["status"], "running", self.stub.tasks)
        self.assertEqual(deny["task"]["status"], "waiting_approval", self.stub.tasks)
        self.assertEqual(j7["task"]["status"], "waiting_approval", self.stub.tasks)
        self.assertEqual(
            {row["task_id"] for row in self.stub.approvals},
            {deny["task"]["id"], j7["task"]["id"]},
            result.stdout,
        )
        self.assertIn("skip waiting-approval: internal approval refused: HTTP 409", result.stdout)
        self.assertNotIn("skip waiting-approval-deny:", result.stdout)
        self.assertNotIn("j1 targets", result.stdout)
        self.assertEqual(
            self.j7_target(result.stdout),
            (j7["task"]["id"], j7["approval"]["id"], J7_CONVERSATION),
        )

    def test_agent_requests_are_bounded_and_report_failure(self) -> None:
        self.enable_fake_agent()
        self.stub.tasks_terminal = False
        result = self.run_seed(extra_env={"KIN_SEED_TASK_TIMEOUT_SECS": "1"})
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        skips = self.skip_states(result)
        for slug in ("conversation-created", "conversation-failed", "conversation-archived"):
            self.assertIn(slug, skips, result.stdout)
        self.assertIn("not waiting forever", result.stdout)
        # It gave up instead of waiting forever: one task polled, not slept on.
        self.assertLessEqual(len(self.stub.tasks), len(CONVERSATIONS))

    def test_dry_run_does_not_archive_an_existing_row(self) -> None:
        # An interrupted earlier run can leave the archived fixture filed but
        # not archived; a dry run must describe that, never fix it.
        self.enable_fake_agent()
        self.stub.tasks = [
            {"id": "tsk-1", "title": CONVERSATIONS[0], "status": "succeeded", "archived_at": None},
            {"id": "tsk-2", "title": CONVERSATIONS[1], "status": "failed", "archived_at": None},
            {"id": "tsk-3", "title": CONVERSATIONS[2], "status": "succeeded", "archived_at": None},
        ]
        result = self.run_seed("--dry-run")
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertEqual(self.stub.mutations(), [])
        self.assertIn(f"plan archive {CONVERSATIONS[2]}", result.stdout)
        self.assertNotIn("create archive", result.stdout)

    def test_dry_run_does_not_request_an_approval(self) -> None:
        # --dry-run promises no POST. An interrupted run can leave a held task
        # running; describing the retry must not perform it.
        self.enable_fake_agent()
        self.stub.tasks = [
            {"id": "tsk-1", "title": CONVERSATIONS[0], "status": "succeeded", "archived_at": None},
            {"id": "tsk-2", "title": CONVERSATIONS[1], "status": "failed", "archived_at": None},
            {"id": "tsk-3", "title": CONVERSATIONS[2], "status": "succeeded", "archived_at": None},
            {"id": "tsk-4", "title": DENY_CONVERSATION, "status": "running", "archived_at": None},
            {"id": "tsk-5", "title": HELD_CONVERSATION, "status": "running", "archived_at": None},
        ]
        result = self.run_seed("--dry-run")
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertEqual(self.stub.mutations(), [])
        self.assertEqual(self.approval_posts(), [])
        self.assertIn(f"plan approval {DENY_CONVERSATION}", result.stdout)
        self.assertIn(f"plan approval {HELD_CONVERSATION}", result.stdout)
        self.assertNotIn("skip waiting-approval", result.stdout)

    def test_blank_daemon_binary_refuses(self) -> None:
        # A blank binary means the daemon did not say which claude it would
        # start. This process's PATH must not stand in for that answer, even
        # when it points at the fake.
        self.stub.agents = [
            {"id": "claude-code", "name": "Claude Code", "installed": True, "available": True, "binary": ""}
        ]
        fake_path = f"{os.path.dirname(FAKE_AGENT)}:{os.environ.get('PATH', '')}"
        result = self.run_seed(extra_env={"PATH": fake_path})
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertEqual(self.task_posts(), [])
        self.assertIn("does not say which claude", result.stdout)
        self.assertIn("conversation-created", self.skip_states(result))

    def test_existing_wrong_state_is_reported(self) -> None:
        self.enable_fake_agent()
        self.stub.tasks = [
            {"id": "tsk-1", "title": CONVERSATIONS[0], "status": "running", "archived_at": None},
        ]
        result = self.run_seed()
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertIn("existing task tsk-1 is running, wanted succeeded", result.stdout)
        # Every other fixture is still created; the running row is left alone.
        self.assertEqual(len(self.task_posts()), len(CONVERSATIONS) - 1, result.stdout)

    def test_fake_agent_contract(self) -> None:
        # The shell fake is the only thing standing between a seeded turn and
        # a real model run; keep its stream-json and exit codes pinned to what
        # the adapter parses.
        fake = FAKE_AGENT
        self.assertTrue(os.access(fake, os.X_OK), fake)
        ok = subprocess.run(
            [fake, "-p", "[seed] hello", "--output-format", "stream-json", "--verbose"],
            capture_output=True,
            text=True,
            timeout=10,
        )
        self.assertEqual(ok.returncode, 0, ok.stderr)
        self.assertIn("fake-agent [seed] hello", ok.stderr)
        lines = [json.loads(line) for line in ok.stdout.splitlines() if line.strip()]
        self.assertEqual([line["type"] for line in lines], ["system", "stream_event", "assistant", "result"])
        self.assertFalse(lines[-1]["is_error"])
        self.assertIn("total_cost_usd", lines[-1])
        self.assertIn("input_tokens", lines[-1]["usage"])

        bad = subprocess.run([fake, "-p", "[seed] fail now"], capture_output=True, text=True, timeout=10)
        self.assertNotEqual(bad.returncode, 0)
        last = json.loads(bad.stdout.strip().splitlines()[-1])
        self.assertEqual(last["type"], "result")
        self.assertTrue(last["is_error"])

    def test_fake_agent_holds_an_approval_turn(self) -> None:
        # A held turn is what keeps the task running long enough for the seed
        # to request a real approval. It prints its tool_use and then waits; a
        # result line or an early exit would settle the task and delete the
        # card the walk is there to photograph.
        proc = subprocess.Popen(
            [FAKE_AGENT, "-p", "[seed] approve: hold this turn open.", "--output-format", "stream-json", "--verbose"],
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            env=dict(os.environ),
        )

        def reap() -> None:
            if proc.poll() is None:
                proc.kill()
            proc.wait(timeout=10)
            pump_thread.join(timeout=5)
            for pipe in (proc.stdout, proc.stderr):
                if pipe is not None:
                    pipe.close()

        self.addCleanup(reap)
        lines: queue.Queue[str] = queue.Queue()

        def pump() -> None:
            for line in proc.stdout:  # type: ignore[union-attr]
                lines.put(line)
            lines.put("")

        pump_thread = threading.Thread(target=pump, daemon=True)
        pump_thread.start()
        first = json.loads(lines.get(timeout=10))
        second = json.loads(lines.get(timeout=10))
        self.assertEqual(first["type"], "system")
        self.assertEqual(second["type"], "assistant")
        block = second["message"]["content"][0]
        self.assertEqual(block["type"], "tool_use")
        self.assertEqual(block["id"], "toolu_seed_approve")
        time.sleep(1)
        self.assertIsNone(proc.poll(), "the fake agent exited instead of holding the turn")
        proc.terminate()
        proc.wait(timeout=10)
        rest: list[str] = []
        while True:
            line = lines.get(timeout=10)
            if line == "":
                break
            rest.append(line)
        results = [json.loads(line) for line in rest if line.strip() and json.loads(line).get("type") == "result"]
        self.assertEqual(results, [], rest)

    def test_wrong_terminal_status_is_reported(self) -> None:
        self.enable_fake_agent()
        self.stub.force_status = "canceled"
        # Two held turns now poll until this timeout; keep it short.
        result = self.run_seed(extra_env={"KIN_SEED_TASK_TIMEOUT_SECS": "0.2"})
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertIn("ended canceled", result.stdout)
        self.assertIn("conversation-failed", self.skip_states(result))
        self.assertNotIn("create archive", result.stdout)

    def test_missing_fake_marker_is_reported(self) -> None:
        self.enable_fake_agent()
        self.stub.emit_fake_marker = False
        result = self.run_seed()
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertIn("no fake-agent marker", result.stdout)
        # It must not archive a conversation it could not prove the fake ran.
        self.assertNotIn("create archive", result.stdout)

    def test_real_agent_is_never_started(self) -> None:
        # A runnable claude that is not the harness fake: creating the
        # conversation would start a real model turn, so the seed must refuse.
        self.stub.agents = [
            {
                "id": "claude-code",
                "name": "Claude Code",
                "installed": True,
                "available": True,
                "binary": "/usr/local/bin/claude",
            }
        ]
        result = self.run_seed()
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertEqual(self.task_posts(), [])
        self.assertIn("conversation-created", self.skip_states(result))
        self.assertIn("fake", result.stdout)

        # The same daemon with the harness fake behind it does create: the
        # refusal above is about the binary, not a blanket "never seed".
        self.stub.requests.clear()
        self.enable_fake_agent()
        result = self.run_seed()
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertEqual(len(self.task_posts()), len(CONVERSATIONS), result.stdout)

    def test_alpha_one_pager_carries_the_work_instructions_section(self) -> None:
        """KIN-PROJECT-003: Alpha's document is the cover's 工作方式 source.

        The section sits after Current Focus and before Next, the one line is
        the text the journey fake echoes back, and the edit the J4 walk PUTs
        shares no words with it so the post-edit `count text=<old> 0` cannot
        pass on a substring.
        """
        result = self.run_seed()
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        markdown = self.stub.one_pagers.get("prj-1", "")
        self.assertIn("## 工作方式\n" + journeys_seed.ALPHA_INSTRUCTIONS + "\n", markdown)
        self.assertLess(markdown.index("## Current Focus"), markdown.index("## 工作方式"))
        self.assertLess(markdown.index("## 工作方式"), markdown.index("## Next"))
        self.assertIn(journeys_seed.FOCUS_SENTINEL, markdown)
        self.assertNotIn(
            journeys_seed.ALPHA_INSTRUCTIONS,
            journeys_seed.ALPHA_INSTRUCTIONS_EDITED,
            "the edited line must not contain the seeded line; a substring would defeat the old-line count",
        )
        edited = journeys_seed.FOCUS_MARKDOWN_EDITED
        self.assertIn(journeys_seed.ALPHA_INSTRUCTIONS_EDITED, edited)
        self.assertNotIn(journeys_seed.ALPHA_INSTRUCTIONS, edited)
        self.assertNotIn("## 工作方式\n" + journeys_seed.ALPHA_INSTRUCTIONS + "\n", edited)

    def test_gamma_one_pager_is_longer_than_the_digest_cut(self) -> None:
        """The truncation fixture: > 400 runes, cut inside a known phrase.

        Both the cover and the digest cut at 400 runes and append `…`; the
        phrase straddling the boundary is what a walk reads on both surfaces,
        and the tail beyond it is what must appear on neither.
        """
        body = journeys_seed.GAMMA_INSTRUCTIONS
        self.assertGreater(len(body), 400)
        cut = body[:400] + "…"
        self.assertTrue(cut.endswith("CUT-BOUNDARY…"), cut[-24:])
        self.assertNotIn(journeys_seed.GAMMA_SENTINEL, cut)
        self.assertIn(journeys_seed.GAMMA_SENTINEL, body)
        self.assertIn(journeys_seed.GAMMA_SENTINEL, journeys_seed.GAMMA_MARKDOWN)
        result = self.run_seed()
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertIn("## 工作方式\n" + body + "\n", self.stub.one_pagers.get("prj-3", ""))

    def test_beta_one_pager_is_left_alone(self) -> None:
        """Beta's empty state is the template's own empty section, not a write."""
        result = self.run_seed()
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        puts = [path for method, path, _ in self.stub.requests if method == "PUT" and path.endswith("/one-pager")]
        self.assertEqual(puts, ["/api/projects/prj-1/one-pager", "/api/projects/prj-3/one-pager"], puts)
        self.assertNotIn("prj-2", self.stub.one_pagers)

    def test_j4_target_line_names_the_project_it_edited(self) -> None:
        """J4's api step resolves `{project}` from this line, never from a guess."""
        result = self.run_seed()
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertIn("j4 target project=prj-1", result.stdout)

        # A daemon that already has the document names the id it found.
        self.preload()
        self.stub.requests.clear()
        result = self.run_seed()
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertIn("j4 target project=prj-alpha", result.stdout)

    def test_j4_target_is_absent_when_the_document_cannot_be_written(self) -> None:
        # A journey that edits a One-Pager must skip, not PUT against a
        # document this seed could not put in place.
        self.stub.fail = [(("PUT", "/api/projects/prj-1/one-pager"), 409)]
        result = self.run_seed()
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertNotIn("j4 target project=", result.stdout)

    def test_alpha_has_two_roots_in_non_sorted_order(self) -> None:
        """J4's reload proof needs a saved order that sorting would change.

        The cover reads a project's folders in saved order (`ORDER BY rowid`),
        and `TestProjectRootsKeepSavedOrder` pins the store. A fixture whose
        saved order happens to be alphabetical cannot prove that: a store that
        sorted would still walk green. Alpha keeps `alpha` first — J2 and J3
        start their conversations there — and gains `aaa-config` second, which
        sorts before it. The seed must post both, in that order, as one list.
        """
        alpha = next(spec for spec in journeys_seed.PROJECTS if spec[0] == "Project Alpha")
        roots = alpha[3]
        self.assertEqual(roots, ("alpha", "aaa-config"))
        self.assertEqual(roots[0], "alpha", "J2/J3 assume Alpha's first root is alpha")
        self.assertLess(roots[1], roots[0], "the second root must sort before the first")
        for name, _mode, _slug, other_roots in journeys_seed.PROJECTS:
            if name == "Project Alpha":
                continue
            self.assertEqual(len(other_roots), 1, name)

        result = self.run_seed()
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        posts = [
            json.loads(raw or b"{}")
            for method, path, raw in self.stub.requests
            if method == "POST" and path == "/api/projects"
        ]
        posted = next(post for post in posts if post.get("name") == "[seed] Project Alpha")
        self.assertEqual(
            [os.path.basename(root) for root in posted["roots"]],
            ["alpha", "aaa-config"],
            posted,
        )

    def test_created_report_lists_fixtures(self) -> None:
        result = self.run_seed()
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertIn("create project [seed] Project Alpha prj-1", result.stdout)
        self.assertIn("create project [seed] Project Beta prj-2", result.stdout)
        self.assertIn("create project [seed] Project Gamma prj-3", result.stdout)
        self.assertIn("create focus [seed] Project Alpha", result.stdout)
        self.assertIn("create routine [seed] Morning check-in rtn-1", result.stdout)
        self.assertIn("create routine [seed] Weekly review rtn-2", result.stdout)

    def test_conversations_fall_back_when_project_roots_missing(self) -> None:
        self.preload()
        self.enable_fake_agent()
        result = self.run_seed()
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertEqual(
            [os.path.basename(body["cwd"]) for body in self.task_posts()],
            ["alpha", "beta", "gamma", "beta", "gamma", "gamma", "gamma", "beta", "beta", "beta", "alpha"],
        )


def git(root: str, *args: str) -> subprocess.CompletedProcess[str]:
    return subprocess.run(["git", "-C", root, *args], capture_output=True, text=True, timeout=30)


def make_repo(root: str, notes: str = "# notes\n\n- Seeded for the journey walk.\n") -> None:
    """A committed notes.md, with an inline identity so no global config leaks in."""
    os.makedirs(root, exist_ok=True)
    with open(os.path.join(root, "notes.md"), "w", encoding="utf-8") as fh:
        fh.write(notes)
    commands = (
        ("init", "-q"),
        ("add", "notes.md"),
        (
            "-c", "user.name=Kin journey seed",
            "-c", "user.email=owner@example.com",
            "-c", "commit.gpgsign=false",
            "commit", "-qm", "seed: notes",
        ),
    )
    for argv in commands:
        done = git(root, *argv)
        if done.returncode != 0:
            raise AssertionError(f"git {' '.join(argv)} failed in {root}: {done.stderr}")


def run_fake_agent(cwd: str, prompt: str) -> subprocess.CompletedProcess[str]:
    """The real fake agent, started exactly the way the adapter starts claude."""
    env = dict(os.environ)
    # cwd= moves the process but leaves the inherited PWD variable alone (the
    # daemon passes its own environment through), so the guard must read the
    # real directory, not this value. Deliberately stale to prove it does.
    env["PWD"] = "/nope/not-a-seed-root"
    return subprocess.run(
        [FAKE_AGENT, "-p", prompt, "--output-format", "stream-json", "--verbose"],
        cwd=cwd,
        capture_output=True,
        text=True,
        env=env,
        timeout=10,
    )


class HarnessContractTest(unittest.TestCase):
    """The seed, the fake agent and the walk spec must agree, on disk."""

    def notes(self, root: str) -> str:
        with open(os.path.join(root, "notes.md"), encoding="utf-8") as fh:
            return fh.read()

    def test_tablet_fixture_uses_fake_agent_and_keeps_other_replies(self) -> None:
        # The 820 reading walk needs a real answer with a real markdown table.
        # The only allowed source is the journey fake's stream-json: no DOM
        # insertion, no API interception, no product CSS injection, no model
        # call. The prompt carries an explicit marker; every other prompt must
        # keep the reply the other journeys already assert.
        with tempfile.TemporaryDirectory() as cwd:
            notes = os.path.join(cwd, "notes.md")
            with open(notes, "w", encoding="utf-8") as fh:
                fh.write("# notes\n\n- untouched\n")
            result = run_fake_agent(cwd, "Draft the reading review [seed] reading")
            self.assertEqual(result.returncode, 0, result.stderr)
            lines = [json.loads(line) for line in result.stdout.splitlines() if line.strip()]
            self.assertEqual([line["type"] for line in lines],
                             ["system", "stream_event", "assistant", "result"])
            text = "".join(
                part.get("text", "")
                for line in lines if line["type"] == "assistant"
                for part in line["message"]["content"] if part.get("type") == "text"
            )
            self.assertIn("Tablet reading fixture", text)
            self.assertGreater(len(text), 1200, "the answer must be long enough to overflow an 820x1180 reading pane")
            rows = [line.strip() for line in text.splitlines() if line.strip().startswith("|")]
            self.assertGreaterEqual(len(rows), 6, text)  # header + separator + 4 body rows
            body = rows[2:]
            self.assertGreaterEqual(len(body), 4, text)
            self.assertEqual({len(line.strip().strip("|").split("|")) for line in body}, {4}, text)
            # This cwd is not a `kin-journeys-seed-` root, so the fixture
            # proves the long answer without writing anything.
            with open(notes, encoding="utf-8") as fh:
                self.assertEqual(fh.read(), "# notes\n\n- untouched\n")

            plain = run_fake_agent(cwd, "Draft: summarise this week's TODOs")
            self.assertEqual(plain.returncode, 0, plain.stderr)
            plain_lines = [json.loads(line) for line in plain.stdout.splitlines() if line.strip()]
            plain_text = "".join(
                part.get("text", "")
                for line in plain_lines if line["type"] == "assistant"
                for part in line["message"]["content"] if part.get("type") == "text"
            )
            self.assertEqual(plain_text, "Fake reply from the journey fake agent.")

    def test_seed_roots_are_clean_git_repos(self) -> None:
        base = journeys_seed._seed_roots()
        self.addCleanup(shutil.rmtree, base, True)
        self.assertTrue(os.path.basename(base).startswith("kin-journeys-seed-"), base)
        # Every root the projects declare, not a hand-kept list: a root the
        # seed names to the daemon but never creates is a picker row that
        # cannot be opened.
        self.assertEqual(
            journeys_seed.SEED_ROOT_NAMES, ("alpha", "aaa-config", "beta", "gamma")
        )
        for name in journeys_seed.SEED_ROOT_NAMES:
            root = os.path.join(base, name)
            top = git(root, "rev-parse", "--show-toplevel")
            self.assertEqual(top.returncode, 0, top.stderr)
            self.assertEqual(os.path.realpath(top.stdout.strip()), os.path.realpath(root))
            tracked = git(root, "ls-files", "--error-unmatch", "notes.md")
            self.assertEqual(tracked.returncode, 0, tracked.stderr)
            self.assertTrue(self.notes(root).strip())
            # J13's page/source leg: a committed, self-contained document. No
            # script, link or remote src can be in it — the preview's inert
            # document would strip them, and the walk would be proving the
            # stripper, not the page.
            html = git(root, "ls-files", "--error-unmatch", "preview.html")
            self.assertEqual(html.returncode, 0, html.stderr)
            with open(os.path.join(root, "preview.html"), encoding="utf-8") as fh:
                preview = fh.read()
            self.assertIn("<style>", preview)
            self.assertIn("<p>Seed preview page</p>", preview)
            for active in ("<script", " src=", " href="):
                self.assertNotIn(active, preview)
            status = git(root, "status", "--porcelain")
            self.assertEqual(status.returncode, 0, status.stderr)
            self.assertEqual(status.stdout, "", f"{root} is not clean")

    def test_fake_agent_changes_a_tracked_file_in_a_seed_root(self) -> None:
        base = tempfile.mkdtemp(prefix="kin-journeys-seed-test-")
        self.addCleanup(shutil.rmtree, base, True)
        root = os.path.join(base, "alpha")
        make_repo(root)
        result = run_fake_agent(root, "[seed] change: summarise the three things worth doing today.")
        self.assertEqual(result.returncode, 0, result.stderr)
        lines = [json.loads(line) for line in result.stdout.splitlines() if line.strip()]
        self.assertTrue(lines)
        self.assertEqual(lines[-1]["type"], "result")
        status = git(root, "status", "--porcelain")
        self.assertEqual(status.returncode, 0, status.stderr)
        self.assertIn("notes.md", status.stdout)
        # One modified tracked file, nothing new and untracked.
        self.assertEqual(len(status.stdout.splitlines()), 1, status.stdout)

    def test_fake_agent_change_names_the_file_in_a_tool_use(self) -> None:
        # The console's changed-files bar is fed by path-bearing tool_use
        # events. A text-only turn leaves it empty, and the journey walk then
        # photographs a conversation with no bar on it at all.
        base = tempfile.mkdtemp(prefix="kin-journeys-seed-test-")
        self.addCleanup(shutil.rmtree, base, True)
        root = os.path.join(base, "alpha")
        make_repo(root)
        result = run_fake_agent(root, "[seed] change: summarise the three things worth doing today.")
        self.assertEqual(result.returncode, 0, result.stderr)
        lines = [json.loads(line) for line in result.stdout.splitlines() if line.strip()]
        tools = [
            (block["name"], block["input"].get("file_path"))
            for line in lines
            if line.get("type") == "assistant"
            for block in line["message"]["content"]
            if block.get("type") == "tool_use"
        ]
        self.assertEqual(tools, [("Write", "notes.md")])

    def test_fake_agent_change_is_idempotent(self) -> None:
        base = tempfile.mkdtemp(prefix="kin-journeys-seed-test-")
        self.addCleanup(shutil.rmtree, base, True)
        root = os.path.join(base, "alpha")
        make_repo(root)
        prompt = "[seed] change: summarise the three things worth doing today."
        for _ in range(2):
            result = run_fake_agent(root, prompt)
            self.assertEqual(result.returncode, 0, result.stderr)
        text = self.notes(root)
        sentinel = journeys_seed.CHANGE_SENTINEL
        self.assertEqual(text.count(sentinel), 1, text)
        status = git(root, "status", "--porcelain")
        self.assertEqual(len(status.stdout.splitlines()), 1, status.stdout)
        self.assertIn("notes.md", status.stdout)

    def test_fake_agent_ignores_the_marker_outside_a_seed_root(self) -> None:
        # The binary is chosen by path, so the guard must hold even when a
        # caller points it at a repository that is not a throwaway seed root.
        base = tempfile.mkdtemp(prefix="kin-journeys-ordinary-")
        self.addCleanup(shutil.rmtree, base, True)
        root = os.path.join(base, "alpha")
        make_repo(root)
        before = self.notes(root)
        result = run_fake_agent(root, "[seed] change: summarise the three things worth doing today.")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(git(root, "status", "--porcelain").stdout, "")
        self.assertEqual(self.notes(root), before)

    def test_plain_prompt_still_writes_nothing(self) -> None:
        base = tempfile.mkdtemp(prefix="kin-journeys-seed-test-")
        self.addCleanup(shutil.rmtree, base, True)
        root = os.path.join(base, "alpha")
        make_repo(root)
        before = self.notes(root)
        result = run_fake_agent(root, "[seed] hello")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(git(root, "status", "--porcelain").stdout, "")
        self.assertEqual(self.notes(root), before)

    def test_two_conversations_request_a_workspace_change(self) -> None:
        marked = [spec for spec in journeys_seed.CONVERSATIONS if journeys_seed.CHANGE_MARKER in spec["prompt"]]
        # Two, on purpose: J2's rerun leg rewrites the first one's file, so J8
        # reads a second seeded diff nothing else touches. A third diff would
        # be a fixture nobody walks.
        self.assertEqual(
            [spec["title"] for spec in marked],
            ["[seed] Morning planning", "[seed] Phone review"],
            [spec["title"] for spec in marked],
        )
        # Idempotency matches by title, so the titles must not move with the prompts.
        self.assertEqual(marked[0]["title"], "[seed] Morning planning")
        self.assertEqual(marked[1]["title"], "[seed] Phone review")
        # Different roots: the rewrite lands in Alpha, so J8's file must live
        # elsewhere or the isolation is only on paper.
        self.assertNotEqual(marked[1].get("project"), "Project Alpha")
        for spec in journeys_seed.CONVERSATIONS:
            if spec is not marked[0] and spec is not marked[1]:
                self.assertNotIn(journeys_seed.CHANGE_MARKER, spec["prompt"])

    def test_three_conversations_hold_approval_turns(self) -> None:
        marked = [spec for spec in journeys_seed.CONVERSATIONS if journeys_seed.APPROVE_MARKER in spec["prompt"]]
        self.assertEqual([spec["title"] for spec in marked], HELD_CONVERSATIONS, [spec["title"] for spec in marked])
        # One held card is approved, one denied, and J7 lands on the third; the
        # walk learns every pair by id from the seed's target lines. The
        # projects are named so a new card cannot move an existing
        # conversation to another bucket.
        self.assertEqual([spec.get("target") for spec in marked], ["deny", "j7", "approve"], marked)
        self.assertEqual(
            [spec.get("project") for spec in marked],
            ["Project Beta", "Project Beta", "Project Alpha"],
            marked,
        )
        for spec in marked:
            self.assertTrue(spec.get("hold"), spec)
            # The hold path must never be given a terminal expectation: no
            # result line is ever printed, so waiting for one would only time out.
            self.assertNotIn("succeeded", spec["expect"])
        for spec in journeys_seed.CONVERSATIONS:
            if spec in marked:
                continue
            self.assertNotIn(journeys_seed.APPROVE_MARKER, spec["prompt"])
            self.assertFalse(spec.get("hold"), spec)
            if spec.get("questions"):
                # The question fixture names its own role (`j15`), but it is
                # not an approval target and never asks the approval bridge.
                self.assertEqual(spec.get("target"), "j15", spec)
                self.assertEqual(spec.get("expect"), ("running", "waiting_input"), spec)
            else:
                self.assertNotIn("target", spec)

    def test_j2_opens_changes_before_leaving_the_conversation(self) -> None:
        spec = load_spec()
        steps = spec["journeys"]["J2"]["steps"]
        panel = next((i for i, step in enumerate(steps) if step[:2] == ["shot", "workspace-panel"]), -1)
        new_chat = next((i for i, step in enumerate(steps) if step[:2] == ["goto", "/new"]), -1)
        self.assertGreaterEqual(panel, 0, steps)
        self.assertGreaterEqual(new_chat, 0, steps)
        # The regression: the workspace click used to run after `goto /new`,
        # where no conversation (and so no workspace) exists.
        self.assertLess(panel, new_chat, steps)
        changes = [
            i
            for i, step in enumerate(steps)
            if step[0] == "click" and re.search(r"变更|文件|Changes|Files", step[1])
        ]
        self.assertTrue(changes, steps)
        self.assertLess(changes[0], panel, steps)
        diff = next((i for i, step in enumerate(steps) if step[:2] == ["shot", "workspace-diff"]), -1)
        self.assertGreater(diff, panel, steps)
        file_click = next(
            (i for i, step in enumerate(steps) if step[0] == "click" and "notes" in step[1]), -1
        )
        self.assertGreater(file_click, panel, steps)
        self.assertLess(file_click, diff, steps)
        conversation = next((i for i, step in enumerate(steps) if step[:2] == ["shot", "conversation"]), -1)
        self.assertGreaterEqual(conversation, 0, steps)
        self.assertLess(conversation, changes[0], steps)
        # Every selector stays optional: an empty daemon must skip, not fail.
        for index in (changes[0], file_click):
            self.assertTrue(steps[index][1].startswith("?"), steps[index])


if __name__ == "__main__":
    unittest.main(verbosity=2)
