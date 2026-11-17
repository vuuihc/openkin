#!/usr/bin/env python3
"""Tests for the J1/J7 resolution in rsi/runtime/ux/walk.mjs.

Run directly: `python3 -B scripts/journeys_walk_test.py`. Pure: a fixture
seed.log and a spec file, no browser, no daemon, no network. The walker's
`--resolve-j1` / `--resolve-j7` modes run the same read/apply functions the
real walk uses, so a green case here is the resolution that walk would take.
"""

from __future__ import annotations

import json
import os
import re
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

# The one line scripts/journeys_seed.py prints only when BOTH held cards
# exist. Two conversations, two approvals, so a walk cannot pass by opening
# the approve card twice.
J1_LINE = (
    "j1 targets approve conversation=task-1 focus=appr-1 "
    "deny conversation=task-2 focus=appr-2"
)
J1_RESOLVED = "J1 approve /tasks/task-1?focus=appr-1 deny /tasks/task-2?focus=appr-2"
J1_SKIP = "J1 skip: no seeded approval targets"
J1_SEED_FAILED = "J1 skip: seed failed or empty daemon"


def j1_contract_problems(spec_path: str) -> list[str]:
    """What the checked-in J1 spec must carry for the deny leg to mean anything.

    A walk is only evidence when both decisions are mandatory and target the
    conversations the seed named. Returns the problems; empty means the spec
    holds the contract.
    """
    with open(spec_path, encoding="utf-8") as fh:
        spec = json.load(fh)
    steps = spec.get("journeys", {}).get("J1", {}).get("steps", [])
    problems: list[str] = []
    if not any(st[0] == "goto" and "{approve.conversation}" in st[1] for st in steps):
        problems.append("J1 has no goto to the seeded approve conversation")
    if not any(st[0] == "goto" and "{deny.conversation}" in st[1] for st in steps):
        problems.append("J1 has no goto to the seeded deny conversation")
    deny_at = None
    for index, st in enumerate(steps):
        if st[0] == "click" and re.search(r"拒绝|Deny", st[1]):
            deny_at = index
            if st[1].startswith("?"):
                problems.append("the deny click is optional")
            break
    if deny_at is None:
        problems.append("J1 has no click on the deny control")
        return problems
    click_sel = steps[deny_at][1]
    gone = [st for st in steps[deny_at + 1 :] if st[0] == "gone"]
    if not any(st[1] == click_sel and not st[1].startswith("?") for st in gone):
        problems.append("J1 has no mandatory gone on the deny control after the click")
    return problems


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


@unittest.skipUnless(NODE, "node is not installed; the journey walker needs it")
class WalkJ1ResolveTest(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.mkdtemp(prefix="j1-resolve-")
        self.addCleanup(shutil.rmtree, self.tmp, True)

    def resolve(self, seed: str | None, spec: str = SPEC) -> str:
        seed_path = os.path.join(self.tmp, "seed.log")
        if seed is not None:
            with open(seed_path, "w", encoding="utf-8") as fh:
                fh.write(seed)
        done = subprocess.run(
            [NODE, WALK, "--resolve-j1", seed_path, "--spec", spec],
            capture_output=True,
            text=True,
            timeout=20,
        )
        self.assertEqual(done.returncode, 0, done.stdout + done.stderr)
        return done.stdout.strip()

    def test_j1_targets_resolve_both_cards(self) -> None:
        seed = (
            "journeys seed: base http://127.0.0.1:<port>\n"
            + J1_LINE
            + "\n"
            + TARGET
            + "\nsummary: created 9, existing 0, skipped 1\n"
        )
        self.assertEqual(self.resolve(seed), J1_RESOLVED)

    def test_j1_absent_targets_skip(self) -> None:
        # The approve card exists but the deny card does not: the seed prints
        # the J7 line only. J1 must skip rather than walk a half pair — and it
        # must not read J7's line as its own.
        seed = "journeys seed: base http://127.0.0.1:<port>\n" + TARGET + "\n"
        self.assertEqual(self.resolve(seed), J1_SKIP)

    def test_j1_failed_seed_skips(self) -> None:
        self.assertEqual(self.resolve("seed failed (walk continues on what exists)\n"), J1_SEED_FAILED)
        self.assertEqual(self.resolve("seed: skipped (--no-seed), walking an empty daemon\n"), J1_SEED_FAILED)

    def test_j1_missing_seed_log_skips(self) -> None:
        self.assertEqual(self.resolve(None), J1_SKIP)

    def test_j1_deny_is_mandatory(self) -> None:
        # Red on the pre-change spec: J1 opened "whatever row happens to be
        # first" and every later step was optional, so a Deny that never
        # resolved still walked green.
        self.assertEqual(j1_contract_problems(SPEC), [])

    def test_j1_deny_leg_removed_is_rejected(self) -> None:
        with open(SPEC, encoding="utf-8") as fh:
            spec = json.load(fh)
        spec["journeys"]["J1"]["steps"] = [
            st
            for st in spec["journeys"]["J1"]["steps"]
            if not (st[0] in ("click", "gone") and re.search(r"拒绝|Deny", st[1]))
        ]
        path = os.path.join(self.tmp, "deny-removed.json")
        with open(path, "w", encoding="utf-8") as fh:
            json.dump(spec, fh)
        problems = j1_contract_problems(path)
        self.assertTrue(any("deny control" in problem for problem in problems), problems)


if __name__ == "__main__":
    unittest.main()
