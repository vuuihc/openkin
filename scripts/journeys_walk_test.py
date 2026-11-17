#!/usr/bin/env python3
"""Tests for the spec contracts in rsi/runtime/ux/walk.mjs.

Run directly: `python3 -B scripts/journeys_walk_test.py`. Pure: fixture
seed.log and spec files, no browser, no daemon, no network. The walker's
`--resolve-j7` mode runs the same read/apply functions the real walk uses, so
a green case here is the resolution the J7 walk would take. `--check-spec`
runs the J3 send contract through the same parser, so a spec that regressed to
merely asserting Start is usable fails before a browser starts.
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
# The seed also names the conversation's title, so the walk can click the row
# by what a reader sees instead of by "the first row".
TARGET_TITLE = TARGET + " title=[seed] Answer the deploy"
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


@unittest.skipUnless(NODE, "node is not installed; the journey walker needs it")
class WalkJ3ContractTest(unittest.TestCase):
    """J3 must press Start for real, not photograph a startable composer.

    The checked-in spec is the merge-gate spec; these cases run the walker's
    own contract check against it and against copies that regress one rule at
    a time, so the check cannot go green on a spec that only asserts Start.
    """

    def setUp(self) -> None:
        self.tmp = tempfile.mkdtemp(prefix="j3-contract-")
        self.addCleanup(shutil.rmtree, self.tmp, True)

    def check(self, spec_path: str = SPEC) -> tuple[int, str]:
        done = subprocess.run(
            [NODE, WALK, "--check-spec", "--spec", spec_path],
            capture_output=True,
            text=True,
            timeout=20,
        )
        return done.returncode, done.stdout + done.stderr

    def copy_with(self, mutate) -> str:
        with open(SPEC, encoding="utf-8") as fh:
            spec = json.load(fh)
        mutate(spec["journeys"]["J3"]["steps"])
        path = os.path.join(self.tmp, "journeys.json")
        with open(path, "w", encoding="utf-8") as fh:
            json.dump(spec, fh)
        return path

    def test_j3_presses_start_for_real(self) -> None:
        code, out = self.check()
        self.assertEqual(code, 0, out)
        self.assertIn("spec ok: J3", out)
        with open(SPEC, encoding="utf-8") as fh:
            steps = json.load(fh)["journeys"]["J3"]["steps"]
        # The evidence the reviewer reads: a real press, the prompt and the
        # waiting row still on screen, then the reply and the empty composer.
        ops = [step[0] for step in steps]
        self.assertIn("send", ops, steps)
        self.assertIn(["value", "textarea", ""], steps, steps)
        names = [step[1] for step in steps if step[0] == "shot"]
        self.assertLess(names.index("sent"), names.index("replied"), names)

    def test_j3_contract_rejects_a_spec_that_only_enables(self) -> None:
        # Today's shape: assert Start is usable, never press it.
        def only_enables(steps: list) -> None:
            at = next(i for i, step in enumerate(steps) if step[0] == "send")
            steps[at] = ["enabled", steps[at][1]]

        code, out = self.check(self.copy_with(only_enables))
        self.assertEqual(code, 1, out)
        self.assertIn("no send step", out)

    def test_j3_contract_rejects_sending_before_the_run_settings(self) -> None:
        # The page navigates away on Start, so the pickers must be chosen first.
        def send_after_place(steps: list) -> None:
            at = next(i for i, step in enumerate(steps) if step[0] == "send")
            send = steps.pop(at)
            place_shot = next(i for i, step in enumerate(steps) if step == ["shot", "place"])
            steps.insert(place_shot + 1, send)

        code, out = self.check(self.copy_with(send_after_place))
        self.assertEqual(code, 1, out)
        self.assertIn("before choosing the run settings", out)

    def test_j3_contract_rejects_a_prompt_without_the_slow_marker(self) -> None:
        # Without [seed] slow the pending window is a race, and the `sent`
        # screenshot proves nothing.
        def plain_prompt(steps: list) -> None:
            at = next(i for i, step in enumerate(steps) if step[0] == "fill")
            steps[at][2] = "Draft: summarise this week's TODOs"
            for step in steps:
                if step[0] == "wait" and "[seed] slow" in step[1]:
                    step[1] = "text=Draft: summarise this week's TODOs"

        code, out = self.check(self.copy_with(plain_prompt))
        self.assertEqual(code, 1, out)
        self.assertIn("[seed] slow", out)


@unittest.skipUnless(NODE, "node is not installed; the journey walker needs it")
class WalkJ7ContractTest(unittest.TestCase):
    """J7 must prove the notification landed on the card it named.

    Same shape as WalkJ3ContractTest: the checked-in spec passes the walker's
    own contract check, and a copy that regresses one rule at a time fails with
    a message naming that rule. Without this, a J7 that photographs whatever
    loaded and clicks Back only if it happens to be there is green.
    """

    def setUp(self) -> None:
        self.tmp = tempfile.mkdtemp(prefix="j7-contract-")
        self.addCleanup(shutil.rmtree, self.tmp, True)

    def check(self, spec_path: str = SPEC, seed: str | None = None) -> tuple[int, str]:
        argv = [NODE, WALK, "--check-spec", "--spec", spec_path]
        if seed is not None:
            seed_path = os.path.join(self.tmp, "seed.log")
            with open(seed_path, "w", encoding="utf-8") as fh:
                fh.write(seed + "\n")
            argv += ["--seed", seed_path]
        done = subprocess.run(argv, capture_output=True, text=True, timeout=20)
        return done.returncode, done.stdout + done.stderr

    def copy_with(self, mutate) -> str:
        with open(SPEC, encoding="utf-8") as fh:
            spec = json.load(fh)
        mutate(spec["journeys"]["J7"]["steps"])
        path = os.path.join(self.tmp, "journeys.json")
        with open(path, "w", encoding="utf-8") as fh:
            json.dump(spec, fh)
        return path

    @staticmethod
    def card_wait_at(steps: list) -> int:
        return next(
            i
            for i, step in enumerate(steps)
            if step[0] == "wait" and "[data-pending-id=" in str(step[1])
        )

    def test_j7_lands_on_the_named_card(self) -> None:
        # With a seed line the check resolves the real ids and prints the
        # assertion the walk will make, not just "the spec mentions {focus}".
        code, out = self.check(seed=TARGET_TITLE)
        self.assertEqual(code, 0, out)
        self.assertIn("spec ok: J7", out)
        self.assertIn('[data-pending-id="appr-1"]', out)
        with open(SPEC, encoding="utf-8") as fh:
            steps = json.load(fh)["journeys"]["J7"]["steps"]
        ops = [step[0] for step in steps]
        # The landing is asserted, not photographed: a visible card, DOM focus
        # on that card, then proof the ?focus= link was consumed.
        self.assertIn("active", ops, steps)
        self.assertIn("search", ops, steps)
        self.assertIn("back", ops, steps)
        # The spec keeps placeholders; only the walker substitutes real ids.
        self.assertIn("{focus}", json.dumps(steps))
        self.assertNotIn("demo-item", json.dumps(steps))

    def test_j7_contract_rejects_a_landing_without_a_card_assertion(self) -> None:
        # Today's shape: goto the link, photograph whatever loaded.
        def drop_the_landing_wait(steps: list) -> None:
            steps.pop(self.card_wait_at(steps))

        code, out = self.check(self.copy_with(drop_the_landing_wait))
        self.assertEqual(code, 1, out)
        self.assertIn("named card", out)
        self.assertIn('[data-pending-id="{focus}"]', out)

    def test_j7_contract_rejects_an_optional_back(self) -> None:
        # `?/返回|Back/` skips at 1100px, so nothing proves Back returned
        # anywhere. A required Back is the rule.
        def make_back_optional(steps: list) -> None:
            at = next(i for i, step in enumerate(steps) if step[0] == "back")
            steps[at] = ["click", "?/返回|Back/"]

        code, out = self.check(self.copy_with(make_back_optional))
        self.assertEqual(code, 1, out)
        self.assertIn("Back", out)

    def test_j7_contract_requires_the_card_after_back(self) -> None:
        # Back is only half the promise: the reader must find the same card
        # when they open the conversation again.
        def drop_the_reopen_assertions(steps: list) -> None:
            at = next(i for i, step in enumerate(steps) if step[0] == "back")
            steps[at + 1 :] = [
                step
                for step in steps[at + 1 :]
                if not (step[0] == "wait" and "[data-pending-id=" in str(step[1]))
            ]

        code, out = self.check(self.copy_with(drop_the_reopen_assertions))
        self.assertEqual(code, 1, out)
        self.assertIn("after Back", out)

    def test_j7_assertion_uses_the_seeded_ids(self) -> None:
        # Pure node mode: the same substitution the walk applies, printed so a
        # reviewer can read the exact assertion without a browser.
        seed_path = os.path.join(self.tmp, "seed.log")
        with open(seed_path, "w", encoding="utf-8") as fh:
            fh.write("journeys seed: base http://127.0.0.1:<port>\n" + TARGET_TITLE + "\n")
        done = subprocess.run(
            [NODE, WALK, "--resolve-j7-plan", seed_path, "--spec", SPEC],
            capture_output=True,
            text=True,
            timeout=20,
        )
        self.assertEqual(done.returncode, 0, done.stdout + done.stderr)
        plan = json.loads(done.stdout)
        steps = plan["steps"]
        card = 'css=[data-pending-id="appr-1"]'
        self.assertIn(["wait", card], steps, steps)
        self.assertIn(["active", card], steps, steps)
        self.assertIn(["wait", "text=[seed] Answer the deploy"], steps, steps)
        # The row opens from the keyboard: at 390px the floating needs-you
        # panel covers the row's pointer target (recorded for the CEO lane).
        self.assertIn(["focus", '[data-session-row="task-1"]'], steps, steps)
        self.assertIn(["key", "Enter"], steps, steps)
        self.assertIn(["goto", "/tasks/task-1?focus=appr-1"], steps, steps)
        self.assertIn(["url", "^/tasks/task-1"], steps, steps)
        # Every argument was resolved: no placeholder or legacy literal left.
        rendered = json.dumps(steps)
        self.assertNotIn("{focus}", rendered)
        self.assertNotIn("{conversation}", rendered)
        self.assertNotIn("{title}", rendered)
        self.assertNotIn("demo-item", rendered)


if __name__ == "__main__":
    unittest.main()
