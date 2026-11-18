#!/usr/bin/env python3
"""Tests for the spec contracts in rsi/runtime/ux/walk.mjs.

Run directly: `python3 -B scripts/journeys_walk_test.py`. Pure: fixture
seed.log and spec files, no browser, no daemon, no network. The walker's
`--resolve-j1` / `--resolve-j7` modes run the same read/apply functions the
real walk uses, so a green case here is the resolution that walk would take.
`--check-spec` runs the J2 review-loop, J3 send and J8 phone-tap contracts
through the same parser, so a spec that regressed to photographing the diff, to
merely asserting Start is usable, or to pressing a desktop chord on the phone,
fails before a browser starts.
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
# The seed also names the conversation's title, so the walk can click the row
# by what a reader sees instead of by "the first row".
TARGET_TITLE = TARGET + " title=[seed] Answer the deploy"
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

    def test_j3_contract_rejects_a_title_only_prompt_wait(self) -> None:
        # The conversation header's title IS the prompt, so a bare `text=` wait
        # stays green while the bubble the draft drew is gone. The wait must be
        # scoped to the transcript scroller and name the prompt inside it.
        def title_only_wait(steps: list) -> None:
            at = next(
                i
                for i, step in enumerate(steps)
                if step[0] == "wait"
                and str(step[1]).startswith("css=")
                and "[role=" in str(step[1])
                and "Draft: summarise this week's TODOs [seed] slow" in str(step[1])
            )
            steps[at] = ["wait", "text=Draft: summarise this week's TODOs [seed] slow"]

        code, out = self.check(self.copy_with(title_only_wait))
        self.assertEqual(code, 1, out)
        self.assertIn("the title alone is not the message", out)

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
class WalkJ2ContractTest(unittest.TestCase):
    """J2 must walk the review loop, not stop at the diff screenshot.

    The loop a reviewer actually runs is: open the changed file, comment a
    changed line, save it into the tray, send the tray as one ordinary
    follow-up, and find the comment in the transcript WITH its anchor (path,
    hunk header and quoted line) — not only its words. Same shape as
    WalkJ3ContractTest: the checked-in spec passes the walker's own contract
    check, and a copy that regresses one rule at a time fails with a message
    naming that rule. Without this, a J2 that stops at `workspace-diff`, or
    one that asserts only the comment body, is green while a dropped anchor
    reaches dogfooding unnoticed.
    """

    BODY = "把这一行改成一句总结。[{vp}]"
    QUOTE = "- [seed] change: the journey walk reads this line as a real diff."

    def setUp(self) -> None:
        self.tmp = tempfile.mkdtemp(prefix="j2-contract-")
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
        mutate(spec["journeys"]["J2"]["steps"])
        path = os.path.join(self.tmp, "journeys.json")
        with open(path, "w", encoding="utf-8") as fh:
            json.dump(spec, fh)
        return path

    @staticmethod
    def at(steps: list, pred) -> int:
        return next(i for i, step in enumerate(steps) if pred(step))

    @staticmethod
    def is_send(step: list) -> bool:
        # The tray's send is the button, or its documented ⌘/Ctrl+Enter on a
        # focused row; the seeded pending approval floats over the button.
        return (
            step[0] == "click"
            and ("改动评论" in str(step[1]) or "Diff comments" in str(step[1]))
            and ("发送" in str(step[1]) or "Send" in str(step[1]))
        ) or (step[0] == "key" and re.search(r"(Meta|Ctrl|Control)\+Enter", str(step[1]), re.I) is not None)

    def test_j2_walks_the_review_loop(self) -> None:
        code, out = self.check()
        self.assertEqual(code, 0, out)
        self.assertIn("spec ok: J2", out)
        with open(SPEC, encoding="utf-8") as fh:
            journey = json.load(fh)["journeys"]["J2"]
        steps = journey["steps"]
        self.assertEqual(journey["viewports"], ["mac", "mac-wide"])
        names = [step[1] for step in steps if step[0] == "shot"]
        self.assertLess(names.index("diff-comment-box"), names.index("diff-comment-tray"), names)
        self.assertLess(names.index("diff-comment-tray"), names.index("diff-comment-sent"), names)
        # The transcript assertion carries the whole anchor, not the words.
        transcript = next(
            step[1]
            for step in steps
            if step[0] == "wait" and "notes.md:5" in str(step[1])
        )
        self.assertIn(self.BODY, transcript)
        self.assertIn("@@ ", transcript)
        self.assertIn(self.QUOTE, transcript)
        # Both widths run against one daemon and the same seeded conversation.
        # A shared body would let mac-wide's wait pass on mac's message, so each
        # viewport's substituted body must be its own needle.
        bodies = [self.BODY.replace("{vp}", vp) for vp in journey["viewports"]]
        for mine_vp, mine in zip(journey["viewports"], bodies):
            for other_vp, other in zip(journey["viewports"], bodies):
                if mine_vp != other_vp:
                    self.assertNotIn(mine, other, "%s's body would match %s's message" % (mine_vp, other_vp))

    def test_j2_reply_waits_are_indexed_past_the_earlier_rounds(self) -> None:
        # One seeded conversation carries the seed's own answer plus one reply
        # per width's tray send. A rerun wait indexed from 0 would already be
        # satisfied at the leg start, so the file could be re-picked before the
        # round that moves it landed. Pin the three indices to the replies they
        # actually wait for: the width's own tray reply (nth=2), then the
        # [seed] shift round (nth=3), then the [seed] rewrite round (nth=4).
        with open(SPEC, encoding="utf-8") as fh:
            steps = json.load(fh)["journeys"]["J2"]["steps"]
        waits = [
            step
            for step in steps
            if step[0] == "wait"
            and "Fake reply from the journey fake agent." in str(step[1])
            and "nth=" in str(step[1])
        ]
        self.assertEqual(
            [int(re.search(r"nth=(\d+)", step[1]).group(1)) for step in waits],
            [2, 3, 4],
            waits,
        )

    def test_j2_contract_rejects_a_comment_before_the_diff_is_open(self) -> None:
        # Today's shape: the workspace section ends at the diff screenshot, so
        # moving the review block above the file click still reads plausibly.
        def comment_before_diff(steps: list) -> None:
            start = self.at(
                steps,
                lambda step: step[0] == "wait" and ".monaco-diff-editor" in str(step[1]),
            )
            send = self.at(steps, self.is_send)
            block = steps[start : send + 1]
            del steps[start : send + 1]
            panel = self.at(steps, lambda step: step == ["shot", "workspace-panel"])
            steps[panel + 1 : panel + 1] = block

        code, out = self.check(self.copy_with(comment_before_diff))
        self.assertEqual(code, 1, out)
        self.assertIn("before the seeded file is open", out)

    def test_j2_contract_rejects_an_unanchored_transcript_assertion(self) -> None:
        # The failure the mutant proves: the comment arrives with its words but
        # no path/hunk/quote. A body-only wait must not satisfy the contract.
        def body_only(steps: list) -> None:
            at = self.at(
                steps,
                lambda step: step[0] == "wait" and "notes.md:5" in str(step[1]),
            )
            steps[at] = [
                "wait",
                "css=[role=region][tabindex='-1']:has-text('%s')" % self.BODY,
            ]

        code, out = self.check(self.copy_with(body_only))
        self.assertEqual(code, 1, out)
        self.assertIn("path, hunk header and quote", out)

    def test_j2_contract_rejects_a_comment_body_shared_across_viewports(self) -> None:
        # Both widths walk the same seeded conversation against one daemon.
        # Without the {vp} token, mac-wide's transcript wait was satisfied by
        # mac's message, so the second width's own send was never proven.
        def shared_body(steps: list) -> None:
            for step in steps:
                for i in (1, 2):
                    if len(step) > i and isinstance(step[i], str):
                        step[i] = step[i].replace("[{vp}]", "")

        code, out = self.check(self.copy_with(shared_body))
        self.assertEqual(code, 1, out)
        self.assertIn("{vp}", out)

    def test_j2_contract_rejects_an_unbracketed_viewport_token(self) -> None:
        # `mac` sits inside `mac-wide`, so an unbracketed token would still let
        # one viewport's body match the other's message.
        def unbracketed(steps: list) -> None:
            for step in steps:
                for i in (1, 2):
                    if len(step) > i and isinstance(step[i], str):
                        step[i] = step[i].replace("[{vp}]", "{vp}")

        code, out = self.check(self.copy_with(unbracketed))
        self.assertEqual(code, 1, out)
        self.assertIn("inside another", out)

    def test_j2_contract_rejects_a_missing_tray_send(self) -> None:
        # Deleting the press but keeping the transcript wait would prove only
        # that the words are somewhere on the page.
        def drop_send(steps: list) -> None:
            steps.pop(self.at(steps, self.is_send))

        code, out = self.check(self.copy_with(drop_send))
        self.assertEqual(code, 1, out)
        self.assertIn("send", out.lower())

    @staticmethod
    def find(steps: list, pred, what: str) -> int:
        for i, step in enumerate(steps):
            if pred(step):
                return i
        raise AssertionError("the checked-in J2 spec has no " + what)

    @staticmethod
    def rerun_fill(steps: list, marker: str) -> int:
        return WalkJ2ContractTest.find(
            steps,
            lambda step: step[0] == "fill" and len(step) > 2 and marker in str(step[2]),
            "composer fill carrying %s" % marker,
        )

    def test_j2_contract_rejects_a_rerun_without_the_shift_send(self) -> None:
        # The re-anchored row is only proof of a rerun if the round that moved
        # the quoted line was really asked for. Dropping the `[seed] shift`
        # send leaves a tray that happens to show a new line number for no
        # reason at all.
        def drop_shift(steps: list) -> None:
            at = self.rerun_fill(steps, "[seed] shift")
            del steps[at : at + 2]  # the fill and the send that follows it

        code, out = self.check(self.copy_with(drop_shift))
        self.assertEqual(code, 1, out)
        self.assertIn("[seed] shift", out)

    def test_j2_contract_rejects_a_stale_comment_without_the_badge_wait(self) -> None:
        # A stale row is the other half of the contract: when the quoted line
        # is gone the tray must say 该行已变化 and keep the quote. A walk that
        # sends `[seed] rewrite` and never reads the badge photographs a tray
        # that may have silently dropped the comment.
        def drop_stale_wait(steps: list) -> None:
            at = self.find(
                steps,
                lambda step: step[0] == "wait"
                and ("该行已变化" in str(step[1]) or "This line has changed" in str(step[1])),
                "stale-row wait naming the badge",
            )
            steps.pop(at)

        code, out = self.check(self.copy_with(drop_stale_wait))
        self.assertEqual(code, 1, out)
        self.assertIn("该行已变化", out)

    def test_j2_contract_rejects_the_shift_send_before_the_second_comment_is_saved(self) -> None:
        # The round that moves the line must run after the comment exists: a
        # shift sent first re-anchors nothing, and the later Save would record
        # the already-moved line as the saved position — the same row, but the
        # walk would no longer prove a comment survived a change.
        def shift_before_save(steps: list) -> None:
            at = self.rerun_fill(steps, "[seed] shift")
            pair = steps[at : at + 2]
            del steps[at : at + 2]
            saves = [
                i
                for i, step in enumerate(steps)
                if step[0] == "click" and re.search(r"保存|Save", str(step[1]))
            ]
            self.assertGreaterEqual(len(saves), 2, "the J2 spec has only one Save")
            steps[saves[1] : saves[1]] = pair

        code, out = self.check(self.copy_with(shift_before_save))
        self.assertEqual(code, 1, out)
        self.assertIn("before the second comment is saved", out)


@unittest.skipUnless(NODE, "node is not installed; the journey walker needs it")
class WalkJ8ContractTest(unittest.TestCase):
    """J8 must walk the review loop the way a thumb does, at 390 only.

    J2 proves the same loop from the keyboard (⌥C, ⌘Enter), which a phone does
    not have. J8 is its own journey so the phone path is a contract: tap the
    changed line's glyph, write in the sheet, Save, read the tray's one row,
    tap Send, and find the anchored follow-up in the transcript. Same shape as
    WalkJ2ContractTest: the checked-in spec passes the walker's own contract
    check, and a copy that regresses one phone rule at a time fails with a
    message naming that rule.
    """

    BODY = "手机上把这一行改成一句总结。[{vp}]"
    QUOTE = "- [seed] change: the journey walk reads this line as a real diff."

    def setUp(self) -> None:
        self.tmp = tempfile.mkdtemp(prefix="j8-contract-")
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
        mutate(spec["journeys"]["J8"])
        path = os.path.join(self.tmp, "journeys.json")
        with open(path, "w", encoding="utf-8") as fh:
            json.dump(spec, fh)
        return path

    def copy_spec_with(self, mutate) -> str:
        with open(SPEC, encoding="utf-8") as fh:
            spec = json.load(fh)
        mutate(spec)
        path = os.path.join(self.tmp, "journeys.json")
        with open(path, "w", encoding="utf-8") as fh:
            json.dump(spec, fh)
        return path

    @staticmethod
    def at(steps: list, pred) -> int:
        return next(i for i, step in enumerate(steps) if pred(step))

    @staticmethod
    def is_send(step: list) -> bool:
        return (
            step[0] == "click"
            and ("改动评论" in str(step[1]) or "Diff comments" in str(step[1]))
            and ("发送" in str(step[1]) or "Send" in str(step[1]))
        )

    def test_j8_walks_the_phone_review_loop(self) -> None:
        code, out = self.check()
        self.assertEqual(code, 0, out)
        self.assertIn("spec ok: J8", out)
        with open(SPEC, encoding="utf-8") as fh:
            spec = json.load(fh)
        journey = spec["journeys"]["J8"]
        steps = journey["steps"]
        self.assertEqual(journey["viewports"], ["phone"])
        # The entry is the tap a thumb makes on the changed line, never the
        # desktop chord: a phone has no Alt+C.
        opened = self.at(
            steps,
            lambda step: step[0] == "click" and ".kin-diff-comment-glyph" in str(step[1]),
        )
        self.assertGreater(opened, 0, steps)
        self.assertIn("nth=", str(steps[opened][1]))
        self.assertFalse(
            [step for step in steps if step[0] == "key" and re.search(r"Alt\+.*C", str(step[1]), re.I)],
            steps,
        )
        names = [step[1] for step in steps if step[0] == "shot"]
        self.assertLess(names.index("diff-comment-sheet"), names.index("diff-comment-tray"), names)
        self.assertLess(names.index("diff-comment-tray"), names.index("diff-comment-sent"), names)
        # The transcript assertion carries the whole anchor, not the words.
        transcript = next(
            step[1]
            for step in steps
            if step[0] == "wait" and "[role=region]" in str(step[1]) and "notes.md:5" in str(step[1])
        )
        self.assertIn(self.BODY, transcript)
        self.assertIn("@@ ", transcript)
        self.assertIn(self.QUOTE, transcript)
        # A changes row under the workspace panel must select J8, or a diff
        # there never walks the phone loop.
        self.assertIsNotNone(
            next(
                (row for row in spec["paths"]
                 if "ui/src/components/workspace/" in row[0] and "J8" in row[1]),
                None,
            )
        )

    def test_j8_contract_rejects_a_desktop_viewport(self) -> None:
        # J2 already walks the Mac keyboard path; a J8 that also walks mac
        # would replay the chords and prove nothing about the tap.
        def add_mac(journey: dict) -> None:
            journey["viewports"] = ["phone", "mac"]

        code, out = self.check(self.copy_with(add_mac))
        self.assertEqual(code, 1, out)
        self.assertIn('viewports must be exactly ["phone"]', out)

    def test_j8_contract_rejects_a_keyboard_opener(self) -> None:
        # Today's desktop shape: Alt+C on the cursor line. At 390 that proves
        # the keyboard, not the glyph a thumb has to hit.
        def key_opener(journey: dict) -> None:
            steps = journey["steps"]
            at = self.at(
                steps,
                lambda step: step[0] == "click" and ".kin-diff-comment-glyph" in str(step[1]),
            )
            steps[at] = ["key", "Alt+KeyC"]

        code, out = self.check(self.copy_with(key_opener))
        self.assertEqual(code, 1, out)
        self.assertIn("tap on the changed line's glyph", out)

    def test_j8_contract_rejects_an_unpinned_glyph_tap(self) -> None:
        # A tap that names no line, or that is optional, walks on when it
        # resolves to nothing and fails at the tray or the transcript — two
        # steps away from the tap that missed.
        def mutate_tap(prefix: str) -> None:
            def mutate(journey: dict) -> None:
                steps = journey["steps"]
                at = self.at(
                    steps,
                    lambda step: step[0] == "click" and ".kin-diff-comment-glyph" in str(step[1]),
                )
                steps[at][1] = prefix

            code, out = self.check(self.copy_with(mutate))
            self.assertEqual(code, 1, out)
            self.assertIn("without pinning a line", out)

        mutate_tap("css=.kin-diff-comment-glyph")
        mutate_tap("?css=.kin-diff-comment-glyph >> nth=4")

    def test_j8_contract_rejects_an_unanchored_transcript_assertion(self) -> None:
        # The mutant's shape: the comment arrives with its words but no
        # path/hunk/quote. A body-only wait must not satisfy the contract.
        def body_only(journey: dict) -> None:
            steps = journey["steps"]
            at = self.at(
                steps,
                lambda step: step[0] == "wait"
                and "[role=region]" in str(step[1])
                and "notes.md:5" in str(step[1]),
            )
            steps[at] = [
                "wait",
                "css=[role=region][tabindex='-1']:has-text('%s')" % self.BODY,
            ]

        code, out = self.check(self.copy_with(body_only))
        self.assertEqual(code, 1, out)
        self.assertIn("path, hunk header and quote", out)

    def test_j8_contract_rejects_a_key_only_send(self) -> None:
        # The tray's ⌘Enter is the desktop press; a thumb has only the button.
        def key_only_send(journey: dict) -> None:
            steps = journey["steps"]
            at = self.at(steps, self.is_send)
            steps[at : at + 1] = [["focus", steps[at][1]], ["key", "Meta+Enter"]]

        code, out = self.check(self.copy_with(key_only_send))
        self.assertEqual(code, 1, out)
        self.assertIn("never taps the tray's send", out)

        # Deleting the press but keeping the transcript wait would prove only
        # that the words are somewhere on the page.
        def drop_send(journey: dict) -> None:
            journey["steps"].pop(self.at(journey["steps"], self.is_send))

        code, out = self.check(self.copy_with(drop_send))
        self.assertEqual(code, 1, out)
        self.assertIn("never taps the tray's send", out)

    def test_j8_contract_rejects_a_send_before_the_tray_row(self) -> None:
        # Sending before the saved comment is in the tray would send an empty
        # tray (or the wrong row) and leave the transcript wait to match the
        # words from somewhere else.
        def early_send(journey: dict) -> None:
            steps = journey["steps"]
            send = steps.pop(self.at(steps, self.is_send))
            save = self.at(steps, lambda step: step[0] == "click" and "保存" in str(step[1]))
            steps.insert(save + 1, send)

        code, out = self.check(self.copy_with(early_send))
        self.assertEqual(code, 1, out)
        self.assertIn("before it holds the saved comment", out)

    def test_j8_contract_requires_the_workspace_paths_row(self) -> None:
        # A workspace diff that no longer selects J8 would let the phone loop
        # rot without the gate walking it.
        def drop_workspace_row(spec: dict) -> None:
            for row in spec["paths"]:
                if "ui/src/components/workspace/" in row[0]:
                    row[1] = [journey for journey in row[1] if journey != "J8"]

        code, out = self.check(self.copy_spec_with(drop_workspace_row))
        self.assertEqual(code, 1, out)
        self.assertIn("paths table", out)


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
        # The row opens by pointer tap: J7 must prove the tap target itself is
        # reachable, so no keyboard reopen stands in for the click.
        self.assertIn(["click", '[data-session-row="task-1"]'], steps, steps)
        self.assertIn(["goto", "/tasks/task-1?focus=appr-1"], steps, steps)
        self.assertIn(["url", "^/tasks/task-1"], steps, steps)
        # Every argument was resolved: no placeholder or legacy literal left.
        rendered = json.dumps(steps)
        self.assertNotIn("{focus}", rendered)
        self.assertNotIn("{conversation}", rendered)
        self.assertNotIn("{title}", rendered)
        self.assertNotIn("demo-item", rendered)


@unittest.skipUnless(NODE, "node is not installed; the journey walker needs it")
class WalkJ9ContractTest(unittest.TestCase):
    """J9 must prove a switch keeps the shell, the scroll and the draft.

    The keep-alive host ships and pieces of it are pinned in DOM tests, but no
    walk ever leaves a conversation and comes back, so a regression that
    remounts the shell, resets the transcript scroller, or drops an unsent
    draft is invisible to the gate. Same shape as WalkJ2ContractTest: the
    checked-in spec passes the walker's own contract check, and a copy that
    regresses one rule at a time fails with a message naming that rule.
    """

    DRAFT = "F4 draft [seed]"

    def setUp(self) -> None:
        self.tmp = tempfile.mkdtemp(prefix="j9-contract-")
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
        mutate(spec["journeys"]["J9"]["steps"])
        path = os.path.join(self.tmp, "journeys.json")
        with open(path, "w", encoding="utf-8") as fh:
            json.dump(spec, fh)
        return path

    @staticmethod
    def at(steps: list, pred, start: int = 0) -> int:
        return next(i for i, step in enumerate(steps) if i >= start and pred(step))

    @staticmethod
    def is_click_title(step: list, title: str) -> bool:
        return step[0] == "click" and title in str(step[1])

    def test_j9_walks_the_switch(self) -> None:
        code, out = self.check()
        self.assertEqual(code, 0, out)
        self.assertIn("spec ok: J9 keeps the shell, the scroll and the draft across a switch", out)
        with open(SPEC, encoding="utf-8") as fh:
            spec = json.load(fh)
        journey = spec["journeys"]["J9"]
        steps = journey["steps"]
        self.assertEqual(journey["viewports"], ["mac"])
        # The evidence the reviewer reads: the shell tagged before the switch
        # and asserted again after it, a scroll left behind, a draft typed, and
        # all three read back after the return.
        self.assertIn(["node", "css=#root .touch-lg", "shell"], steps)
        self.assertIn(["scroll-kept", "css=[role=region][tabindex='-1']", "320"], steps)
        self.assertIn(["value", "textarea", self.DRAFT], steps)
        names = [step[1] for step in steps if step[0] == "shot"]
        self.assertLess(names.index("switch-chat"), names.index("switch-back"), names)
        # A diff to the shell or the conversation pane must select J9.
        for row_needle in ("ui/src/components/layout/", "ui/src/pages/TaskDetail"):
            row = next((row for row in spec["paths"] if row_needle in row[0]), None)
            self.assertIsNotNone(row, row_needle)
            self.assertIn("J9", row[1], row_needle)

    def test_j9_contract_rejects_a_switch_without_the_same_shell_assertion(self) -> None:
        # A shell remounted on the new pathname is a page load wearing the same
        # markup. Dropping the assertion after the switch must redden the spec.
        def drop_the_switch_node(steps: list) -> None:
            switch = self.at(steps, lambda step: self.is_click_title(step, "Failed migration"))
            node = self.at(steps, lambda step: step[0] == "node", switch + 1)
            steps.pop(node)

        code, out = self.check(self.copy_with(drop_the_switch_node))
        self.assertEqual(code, 1, out)
        self.assertIn("same shell node", out)

    def test_j9_contract_rejects_a_return_without_the_draft_value(self) -> None:
        # The half-typed message is the thing keep-alive exists for. A return
        # that never reads the composer back proves only that the route works.
        def drop_the_draft_value(steps: list) -> None:
            at = self.at(steps, lambda step: step[0] == "value" and "textarea" in str(step[1]))
            steps.pop(at)

        code, out = self.check(self.copy_with(drop_the_draft_value))
        self.assertEqual(code, 1, out)
        self.assertIn("draft survived the return", out)

    def test_j9_contract_rejects_a_return_without_the_scroll_assertion(self) -> None:
        # A resumed conversation that snapped back to the bottom (or the top)
        # is the regression this journey exists to catch.
        def drop_the_scroll_kept(steps: list) -> None:
            at = self.at(steps, lambda step: step[0] == "scroll-kept")
            steps.pop(at)

        code, out = self.check(self.copy_with(drop_the_scroll_kept))
        self.assertEqual(code, 1, out)
        self.assertIn("scroll-kept", out)


class WalkJ10ContractTest(unittest.TestCase):
    """J10 must prove the phone's four tabs keep their place and a card stays answered.

    The tab memory itself is pinned in `phoneNavigation.test.tsx`, but no walk
    ever approves a deep-linked card, visits the four footer entries, and comes
    back. Without J10 a settings tab that reopens General, a Routines entry that
    forgets its machine, or an approved card that reappears on the return are
    all green. Same shape as WalkJ9ContractTest: the checked-in spec passes the
    walker's own contract check, and a copy that regresses one rule at a time
    fails with a message naming that rule.
    """

    SHOTS = (
        "f5-deep-link",
        "f5-approved",
        "f5-tab-settings-remembered",
        "f5-tab-routines",
        "f5-approved-card-stayed-gone",
    )

    def setUp(self) -> None:
        self.tmp = tempfile.mkdtemp(prefix="j10-contract-")
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
        mutate(spec["journeys"]["J10"]["steps"])
        path = os.path.join(self.tmp, "journeys.json")
        with open(path, "w", encoding="utf-8") as fh:
            json.dump(spec, fh)
        return path

    @staticmethod
    def at(steps: list, pred, start: int = 0) -> int:
        return next(i for i, step in enumerate(steps) if i >= start and pred(step))

    @staticmethod
    def approve(step: list) -> bool:
        return step[0] in ("click", "gone") and (
            "批准" in str(step[1]) or "Approve" in str(step[1])
        )

    def test_j10_contract_accepts_the_checked_in_spec(self) -> None:
        code, out = self.check()
        self.assertEqual(code, 0, out)
        self.assertIn("spec ok: J10 ", out)
        with open(SPEC, encoding="utf-8") as fh:
            journey = json.load(fh)["journeys"]["J10"]
        self.assertEqual(journey["viewports"], ["phone"])
        names = [step[1] for step in journey["steps"] if step[0] == "shot"]
        for name in self.SHOTS:
            self.assertIn(name, names)
        # The order is the story: land, approve, walk the tabs, return.
        self.assertLess(names.index("f5-deep-link"), names.index("f5-approved"))
        self.assertLess(names.index("f5-approved"), names.index("f5-tab-settings-remembered"))
        self.assertLess(names.index("f5-tab-settings-remembered"), names.index("f5-tab-routines"))
        self.assertLess(names.index("f5-tab-routines"), names.index("f5-approved-card-stayed-gone"))

    def test_j10_contract_rejects_a_walk_that_never_approves_the_card(self) -> None:
        # Approving is the decision the return must find gone. A walk that only
        # looks at the card never answers it, and the final gone is vacuous.
        def drop_the_approve_click(steps: list) -> None:
            steps.pop(self.at(steps, lambda step: step[0] == "click" and self.approve(step)))

        code, out = self.check(self.copy_with(drop_the_approve_click))
        self.assertEqual(code, 1, out)
        self.assertIn("never presses the card's approve control", out)

        def drop_the_approve_gone(steps: list) -> None:
            steps.pop(self.at(steps, lambda step: step[0] == "gone" and self.approve(step)))

        code, out = self.check(self.copy_with(drop_the_approve_gone))
        self.assertEqual(code, 1, out)
        self.assertIn("never proves the approve control left the screen", out)

    def test_j10_contract_rejects_a_walk_without_all_four_footer_taps(self) -> None:
        # IA D8: four peer entries. Dropping any one leaves its area's memory
        # unproven, so each is a required tap, not a nicety.
        for tab in ("sessions", "routines", "agents", "settings"):
            with self.subTest(tab=tab):
                def drop_one_tab(steps: list, tab: str = tab) -> None:
                    needle = f'[data-phone-return="{tab}"]'
                    hits = [i for i, step in enumerate(steps)
                            if step[0] == "click" and needle in str(step[1])]
                    for i in reversed(hits):
                        steps.pop(i)

                code, out = self.check(self.copy_with(drop_one_tab))
                self.assertEqual(code, 1, out)
                self.assertIn(f"never taps the {tab} footer entry", out)

    def test_j10_contract_rejects_a_tab_round_without_the_remembered_settings_url(self) -> None:
        # F5's whole point: 设置 and Agent 运维 share /settings but not a memory
        # key. A round that only asserts bare roots passes while Settings
        # reopens General after Agent Ops, which is the regression.
        def drop_the_settings_memory(steps: list) -> None:
            hits = [i for i, step in enumerate(steps)
                    if step[0] == "search" and "tab=agents" in str(step[1])]
            steps.pop(hits[-1])

        code, out = self.check(self.copy_with(drop_the_settings_memory))
        self.assertEqual(code, 1, out)
        self.assertIn("Settings remembered its tab", out)

    def test_j10_contract_rejects_a_return_that_never_proves_the_card_stayed_gone(self) -> None:
        # The return is the half that catches a decided card drawn as pending
        # again. Without the final gone the walk photographs a page and says
        # nothing about the answer it gave.
        def drop_the_final_gone(steps: list) -> None:
            hits = [i for i, step in enumerate(steps)
                    if step[0] == "gone" and self.approve(step)]
            steps.pop(hits[-1])

        code, out = self.check(self.copy_with(drop_the_final_gone))
        self.assertEqual(code, 1, out)
        self.assertIn("stayed gone", out)


if __name__ == "__main__":
    unittest.main()
