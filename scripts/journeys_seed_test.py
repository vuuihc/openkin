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
import re
import subprocess
import sys
import threading
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse

SCRIPTS = os.path.dirname(os.path.abspath(__file__))
SEED = os.path.join(SCRIPTS, "journeys_seed.py")

sys.path.insert(0, SCRIPTS)
import journeys_seed  # noqa: E402
# A value the script is never allowed to echo. Deliberately fake: the point is
# the mechanism, and a real token must not live in a public test file.
TOKEN = "tok-test-2f8a1c-never-print"

PROJECTS = ["[seed] Project Alpha", "[seed] Project Beta", "[seed] Project Gamma"]
ROUTINES = ["[seed] Morning check-in", "[seed] Weekly review"]


class Stub:
    """In-memory daemon: just the routes journeys_seed.py is allowed to use."""

    def __init__(self) -> None:
        self.projects: list[dict] = []
        self.routines: list[dict] = []
        self.one_pagers: dict[str, str] = {}
        self.agents: list[dict] = []
        self.requests: list[tuple[str, str, bytes]] = []
        self.fail: list[tuple[tuple[str, str], int]] = []
        self.seq = {"prj": 0, "rtn": 0}

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
        path = urlparse(self.path).path
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

    def run_seed(self, *args: str, base: str | None = "stub", token: str = TOKEN) -> subprocess.CompletedProcess[str]:
        env = {key: value for key, value in os.environ.items() if key in ("PATH", "TMPDIR", "LANG", "LC_ALL")}
        env["KIN_TOKEN"] = token
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
        self.stub.one_pagers = {"prj-alpha": f"# Alpha\n## Current Focus\n{journeys_seed.FOCUS_SENTINEL}\n"}
        self.stub.routines = [
            {"id": "rtn-1", "title": ROUTINES[0]},
            {"id": "rtn-2", "title": ROUTINES[1]},
        ]

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

    def test_created_report_lists_fixtures(self) -> None:
        result = self.run_seed()
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertIn("create project [seed] Project Alpha prj-1", result.stdout)
        self.assertIn("create project [seed] Project Beta prj-2", result.stdout)
        self.assertIn("create project [seed] Project Gamma prj-3", result.stdout)
        self.assertIn("create focus [seed] Project Alpha", result.stdout)
        self.assertIn("create routine [seed] Morning check-in rtn-1", result.stdout)
        self.assertIn("create routine [seed] Weekly review rtn-2", result.stdout)


if __name__ == "__main__":
    unittest.main(verbosity=2)
