#!/usr/bin/env python3
"""Tests for the J7 resolution in rsi/runtime/ux/walk.mjs.

Run directly: `python3 -B scripts/journeys_walk_test.py`. Pure: a fixture
seed.log and a spec file, no browser, no daemon, no network. The walker's
`--resolve-j7` mode runs the same read/apply functions the real walk uses, so
a green case here is the resolution the J7 walk would take.
"""

from __future__ import annotations

import json
import os
import shutil
import subprocess
import tempfile
import unittest

SCRIPTS = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(SCRIPTS)
WALK = os.path.join(ROOT, "rsi", "runtime", "ux", "walk.mjs")
SPEC = os.path.join(ROOT, "rsi", "runtime", "ux", "journeys.json")
NODE = shutil.which("node")

# The two ids a notification names: the conversation and the card it points
# at. Deliberately fake, like every other fixture in this repository.
TARGET = "j7 target conversation=task-1 focus=appr-1"
SKIP = "J7 skip: no seeded notification target"
SEED_FAILED = "J7 skip: seed failed or empty daemon"


@unittest.skipUnless(NODE, "node is not installed; the journey walker needs it")
class WalkJ7ResolveTest(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.mkdtemp(prefix="j7-resolve-")
        self.addCleanup(shutil.rmtree, self.tmp, True)

    def resolve(self, seed: str | None, spec: str = SPEC) -> str:
        seed_path = os.path.join(self.tmp, "seed.log")
        if seed is not None:
            with open(seed_path, "w", encoding="utf-8") as fh:
                fh.write(seed)
        done = subprocess.run(
            [NODE, WALK, "--resolve-j7", seed_path, "--spec", spec],
            capture_output=True,
            text=True,
            timeout=20,
        )
        self.assertEqual(done.returncode, 0, done.stdout + done.stderr)
        return done.stdout.strip()

    def write_spec(self, goto: str) -> str:
        path = os.path.join(self.tmp, "journeys.json")
        with open(path, "w", encoding="utf-8") as fh:
            json.dump({"journeys": {"J7": {"steps": [["goto", goto]]}}}, fh)
        return path

    def test_legacy_literals_resolve_to_the_seeded_ids(self) -> None:
        # The checked-in spec still says demo-task/demo-item (the merge-gate
        # spec is not edited); the walker must rewrite both.
        seed = "journeys seed: base http://127.0.0.1:<port>\n" + TARGET + "\nsummary: created 9, existing 0, skipped 1\n"
        self.assertEqual(self.resolve(seed), "J7 /tasks/task-1?focus=appr-1")

    def test_placeholders_resolve(self) -> None:
        self.assertEqual(
            self.resolve(TARGET + "\n", self.write_spec("/tasks/{conversation}?focus={focus}")),
            "J7 /tasks/task-1?focus=appr-1",
        )

    def test_absent_target_line_skips(self) -> None:
        # A seed that produced no card (a refusal) prints skip but no target;
        # walking the literal demo id would land on a 404, so J7 must skip.
        seed = "journeys seed: base http://127.0.0.1:<port>\nskip waiting-approval: internal approval refused: HTTP 404\n"
        self.assertEqual(self.resolve(seed), SKIP)

    def test_failed_seed_skips(self) -> None:
        self.assertEqual(self.resolve("seed failed (walk continues on what exists)\n"), SEED_FAILED)
        self.assertEqual(self.resolve("seed: skipped (--no-seed), walking an empty daemon\n"), SEED_FAILED)

    def test_missing_seed_log_skips(self) -> None:
        self.assertEqual(self.resolve(None), SKIP)


if __name__ == "__main__":
    unittest.main()
