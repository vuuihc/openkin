#!/usr/bin/env python3
"""Tests for the spec contracts in rsi/runtime/ux/walk.mjs.

Run directly: `python3 -B scripts/journeys_walk_test.py`. Pure: fixture
seed.log and spec files, no browser, no daemon, no network. The walker's
`--resolve-j1` / `--resolve-j7` modes run the same read/apply functions the
real walk uses, so a green case here is the resolution that walk would take.
`--check-spec` runs the J2 review-loop, J3 send, J8 phone-tap, J9 Mac switch,
J11 phone switch, J12 thumb gesture, J13 phone file-link, J14 cold-start /
palette / one-list contracts through the same parser, so a spec that regressed
to photographing the diff, to merely asserting Start is usable, to pressing a
desktop chord on the phone, to leaving the shell, the scroll, the draft or the
composer element unread, to pressing a file link without reading where Back
lands, or to losing a cold start's last conversation, the palette's zero rows
or a level of the phone's one list, fails before a browser starts.
"""

from __future__ import annotations

import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import unittest

SCRIPTS = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(SCRIPTS)
WALK = os.path.join(ROOT, "rsi", "runtime", "ux", "walk.mjs")
SPEC = os.path.join(ROOT, "rsi", "runtime", "ux", "journeys.json")
JOURNEYS_DIR = os.path.join(ROOT, "rsi", "runtime", "ux", "journeys")
NODE = shutil.which("node")

SPECPY = os.path.join(ROOT, "rsi", "runtime", "ux", "spec.py")

sys.path.insert(0, SCRIPTS)
import journeys_seed  # noqa: E402  — the fixture literals the J4 leg edits
# The walk's browser context has no stored locale, so the console renders its
# default (zh). The J4 prefill assertion is therefore the zh prompt, and this
# reader pins it to the shipped string instead of a hand-copied one.
ZH_LOCALE = os.path.join(ROOT, "ui", "src", "i18n", "locales", "zh.ts")


def shipped_instructions_prompt() -> str:
    with open(ZH_LOCALE, encoding="utf-8") as fh:
        match = re.search(r'instructionsPrompt:\s*\n?\s*"([^"]+)"', fh.read())
    return match.group(1) if match else ""


def load_spec(path: str = SPEC) -> dict:
    """Resolve the journey index through its one reader, rsi/runtime/ux/spec.py.

    The spec is an index with one file per journey; reading the files here by
    hand would be a second reader that can drift from the walker's loader.
    Inline fixture specs (the temp files the mutants write) pass through.
    """
    out = subprocess.check_output([sys.executable, SPECPY, "--resolve", path])
    return json.loads(out)

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
    spec = load_spec(spec_path)
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
        spec = load_spec()
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
        spec = load_spec()
        mutate(spec["journeys"]["J3"]["steps"])
        path = os.path.join(self.tmp, "journeys.json")
        with open(path, "w", encoding="utf-8") as fh:
            json.dump(spec, fh)
        return path

    def test_j3_presses_start_for_real(self) -> None:
        code, out = self.check()
        self.assertEqual(code, 0, out)
        self.assertIn("spec ok: J3", out)
        steps = load_spec()["journeys"]["J3"]["steps"]
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

    KIN-RESULT-001: the leg opens 文件, picks the seeded notes.md, and waits
    for the rendered diff (`.monaco-diff-editor`) at mac and mac-wide — the
    file list → open a file → diff path, not a photograph of the empty panel.
    KIN-RESULT-003: the comment loop — Alt+C on a changed line, the anchored
    box, Save into the one-row tray, ⌘Enter to send, and the follow-up in the
    transcript carrying path, hunk header and quote; then a rerun re-anchors
    the row to notes.md:6 and a rewrite marks it 该行已变化 without dropping it.

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
        spec = load_spec()
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
        journey = load_spec()["journeys"]["J2"]
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
        steps = load_spec()["journeys"]["J2"]["steps"]
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

    def test_j2_list_leg_presses_the_fold_before_the_seeded_row(self) -> None:
        # Conversations other journeys create land in the seed's own bucket, so
        # past five rows the seeded row sits behind 展开全部; a loose optional
        # text click then logs `skipped` and the rest of the journey runs on
        # /sessions (2026-11-22: PR #585, 52 hard failures, four hours).
        steps = load_spec()["journeys"]["J2"]["steps"]
        fold = self.at(steps, lambda s: s[0] == "click"
                       and ("展开全部" in str(s[1]) or "Show all" in str(s[1])))
        row = self.at(steps, lambda s: s[0] == "click" and "[data-session-row]" in str(s[1])
                      and "Morning planning" in str(s[1]))
        self.assertLess(fold, row)
        self.assertFalse(str(steps[row][1]).startswith("?"), steps[row])

    def test_j2_contract_rejects_a_seeded_row_without_the_fold(self) -> None:
        def drop_the_fold(steps: list) -> None:
            hit = self.at(steps, lambda s: s[0] == "click"
                          and ("展开全部" in str(s[1]) or "Show all" in str(s[1])))
            steps.pop(hit)

        code, out = self.check(self.copy_with(drop_the_fold))
        self.assertEqual(code, 1, out)
        self.assertIn("never presses the project fold", out)

    def test_j2_contract_rejects_an_optional_seeded_row_click(self) -> None:
        def make_it_optional(steps: list) -> None:
            hit = self.at(steps, lambda s: s[0] == "click" and "[data-session-row]" in str(s[1]))
            steps[hit][1] = "?" + str(steps[hit][1])

        code, out = self.check(self.copy_with(make_it_optional))
        self.assertEqual(code, 1, out)
        self.assertIn("must be mandatory", out)

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


# The read-only Pull Request tab's honest absent-repo state (F3's PR leg).
# The seeded checkout is a plain git repo with no origin remote, so the daemon
# reports no repository and no branch; `shouldAskForRead` is false, and opening
# the tab must ask GitHub nothing and settle on these words instead.
PR_REFRESH = "button[aria-label='刷新'], button[aria-label='Refresh']"
PR_UNOBSERVED = ("尚未查询此分支。", "This branch has not been checked yet.")
PR_NO_REPO = ("此任务不在 GitHub 仓库中", "This task is not in a GitHub repository")
PR_CHECKING = ("正在查询该分支", "Checking this branch")


def pr_tab_click_at(steps: list) -> int | None:
    """Index of the mandatory click that opens the Pull Request surface.

    The selector names the panel's tab and the task header's toggle, because
    the side panel is stacked at 1100px (the file view covers the strip) and a
    peer column at 1280; the header toggle is the control a person can press
    at both widths.
    """
    for index, step in enumerate(steps):
        if step[0] != "click":
            continue
        selector = str(step[1])
        if selector.startswith("?"):
            continue
        if "[role=tab]" in selector and re.search(r"pull request", selector, re.I):
            return index
    return None


def pr_panel_problems(steps: list) -> list[str]:
    """What the J2 PR leg must carry to prove the panel is honest and quiet.

    Returns the problems; empty means the checked-in leg holds the contract.
    A step that went optional (`?`) is a recorded skip, not evidence, so the
    checks below only read mandatory steps.
    """
    click = pr_tab_click_at(steps)
    if click is None:
        return ["J2 has no mandatory click on a [role=tab] naming the Pull Request tab"]
    problems: list[str] = []
    # The leg must run at every width. Inside a `vp` scope only one width
    # executes it, so the other width's shot silently disappears from the walk.
    scope = ""
    for step in steps[:click]:
        if step[0] == "vp":
            scope = str(step[1]).strip() if len(step) > 1 else ""
    if scope:
        problems.append(
            "the Pull Request tab click sits inside the %s-only vp scope; "
            "both widths must walk the panel" % scope
        )
    # Opening the PR surface unmounts the files surface. With a Monaco diff
    # still mounted that unmount throws `TextModel got disposed before
    # DiffEditorWidget model got reset`, a page error the walker records as a
    # hard failure — so the PR leg walks before the diff is opened.
    diff_at = next(
        (
            index
            for index, step in enumerate(steps)
            if step[0] == "wait" and ".monaco-diff-editor" in str(step[1])
        ),
        None,
    )
    if diff_at is not None and diff_at < click:
        problems.append(
            "the Pull Request tab click comes after the diff editor is mounted; "
            "switching surfaces unmounts Monaco and its dispose error reddens the walk"
        )
    leg = steps[click + 1 :]
    # The review loop that follows expects the files surface back in front.
    if not any(
        step[0] == "click"
        and (
            "button[aria-label='文件']" in str(step[1])
            or "button[aria-label='Files']" in str(step[1])
        )
        for step in leg
    ):
        problems.append(
            "J2 never returns to the files panel after the Pull Request leg "
            "(the review loop would run against the PR pane)"
        )
    waits = [step for step in leg if step[0] == "wait" and not str(step[1]).startswith("?")]
    if not any(all(needle in str(step[1]) for needle in PR_UNOBSERVED) for step in waits):
        problems.append(
            "J2 never waits for the unobserved line in both locales "
            "('尚未查询此分支。' and 'This branch has not been checked yet.') "
            "after opening the Pull Request tab"
        )
    if not any(all(needle in str(step[1]) for needle in PR_NO_REPO) for step in waits):
        problems.append(
            "J2 never waits for the absent-repo header in both locales "
            "('此任务不在 GitHub 仓库中' and 'This task is not in a GitHub repository') "
            "after opening the Pull Request tab"
        )
    counts = [
        step
        for step in leg
        if step[0] == "count" and len(step) > 2 and not str(step[1]).startswith("?")
    ]
    refresh_counts = [step for step in counts if PR_REFRESH in str(step[1])]
    if not any(str(step[2]) == "1" for step in refresh_counts):
        problems.append(
            "J2 never asserts exactly one explicit Refresh control "
            "(count button[aria-label='刷新'|'Refresh'] 1)"
        )
    enabled = [
        step
        for step in leg
        if step[0] == "enabled"
        and not str(step[1]).startswith("?")
        and PR_REFRESH in str(step[1])
    ]
    if not enabled:
        problems.append(
            "J2 never asserts the Refresh control is usable "
            "(enabled button[aria-label='刷新'|'Refresh'])"
        )
    checking = [
        step
        for step in counts
        if all(needle in str(step[1]) for needle in PR_CHECKING)
    ]
    if not any(str(step[2]) == "0" for step in checking):
        problems.append(
            "J2 never asserts the panel does not read as still checking "
            "(count '正在查询该分支|Checking this branch' 0)"
        )
    shot_at = next(
        (index for index, step in enumerate(steps) if step[0] == "shot" and step[1] == "pr-panel"),
        None,
    )
    if shot_at is None:
        problems.append("J2 takes no `pr-panel` shot")
    elif shot_at < click:
        problems.append("the `pr-panel` shot is taken before the Pull Request tab is opened")
    return problems


@unittest.skipUnless(NODE, "node is not installed; the journey walker needs it")
class J2PrPanelContractTest(unittest.TestCase):
    """J2 must walk the read-only PR tab, and opening it must ask GitHub nothing.

    The seeded checkout has no origin remote, so the panel's honest state is
    the absent-repo header, "This branch has not been checked yet." and exactly
    one explicit Refresh — with no query in flight. Nothing walked that state:
    a change that hides Refresh, replaces the honest line with a spinner, or
    fires an implicit first-look read on open stayed green. Same shape as
    WalkJ2ContractTest: the checked-in spec passes, and a copy that regresses
    one rule at a time fails with a message naming that rule.
    """

    # (op, selector needles, the guard's own words for that proof)
    PROOFS = (
        ("wait", PR_UNOBSERVED, "unobserved line"),
        ("wait", PR_NO_REPO, "absent-repo header"),
        ("count", (PR_REFRESH,), "Refresh control"),
        ("enabled", (PR_REFRESH,), "usable"),
        ("count", PR_CHECKING, "still checking"),
    )

    def setUp(self) -> None:
        self.tmp = tempfile.mkdtemp(prefix="j2-pr-contract-")
        self.addCleanup(shutil.rmtree, self.tmp, True)

    def check(self, spec_path: str = SPEC) -> tuple[int, str]:
        done = subprocess.run(
            [NODE, WALK, "--check-spec", "--spec", spec_path],
            capture_output=True,
            text=True,
            timeout=20,
        )
        return done.returncode, done.stdout + done.stderr

    def steps(self) -> list:
        return load_spec()["journeys"]["J2"]["steps"]

    def leg(self) -> list:
        steps = self.steps()
        at = pr_tab_click_at(steps)
        self.assertIsNotNone(
            at,
            "J2 has no mandatory click on a [role=tab] naming the Pull Request tab",
        )
        return steps[at + 1 :]

    def test_j2_pr_tab_click_is_mandatory(self) -> None:
        steps = self.steps()
        at = pr_tab_click_at(steps)
        self.assertIsNotNone(
            at,
            "J2 has no mandatory click on a [role=tab] naming the Pull Request tab",
        )
        selector = str(steps[at][1])
        self.assertIn("[role=tab]", selector)
        self.assertRegex(selector, r"(?i)pull request")
        # Adding the leg must not weaken the review-loop contract it joins.
        code, out = self.check()
        self.assertEqual(code, 0, out)
        self.assertIn("spec ok: J2", out)

    def test_j2_pr_panel_asserts_the_honest_unobserved_state(self) -> None:
        waits = [step for step in self.leg() if step[0] == "wait"]
        self.assertTrue(
            any(all(needle in str(step[1]) for needle in PR_UNOBSERVED) for step in waits),
            "J2 never waits for '尚未查询此分支。' and 'This branch has not been checked yet.' "
            "in one selector after opening the Pull Request tab",
        )
        self.assertTrue(
            any(all(needle in str(step[1]) for needle in PR_NO_REPO) for step in waits),
            "J2 never waits for '此任务不在 GitHub 仓库中' and "
            "'This task is not in a GitHub repository' in one selector after opening the tab",
        )

    def test_j2_pr_panel_offers_one_explicit_refresh(self) -> None:
        leg = self.leg()
        counts = [
            step
            for step in leg
            if step[0] == "count" and len(step) > 2 and PR_REFRESH in str(step[1])
        ]
        self.assertTrue(counts, "J2 never counts the Refresh control after opening the Pull Request tab")
        self.assertEqual(
            str(counts[0][2]),
            "1",
            "the Refresh control must be exactly one; got %r" % (counts[0][2],),
        )
        self.assertTrue(
            any(
                step[0] == "enabled" and PR_REFRESH in str(step[1]) for step in leg
            ),
            "J2 never asserts the Refresh control is enabled; a fired implicit query "
            "leaves it disabled, so this is the liveness check",
        )

    def test_j2_pr_panel_does_not_read_as_checking(self) -> None:
        checking = [
            step
            for step in self.leg()
            if step[0] == "count"
            and len(step) > 2
            and all(needle in str(step[1]) for needle in PR_CHECKING)
        ]
        self.assertTrue(
            checking,
            "J2 never counts '正在查询该分支' / 'Checking this branch' after opening the tab",
        )
        self.assertEqual(
            str(checking[0][2]),
            "0",
            "the unobserved state must not read as a query in flight; got %r" % (checking[0][2],),
        )

    def test_j2_pr_panel_leg_cannot_be_weakened(self) -> None:
        steps = self.steps()
        self.assertEqual(pr_panel_problems(steps), [])

        def problems_after(mutate) -> list[str]:
            copy = json.loads(json.dumps(steps))
            mutate(copy)
            return pr_panel_problems(copy)

        def required(op: str, needles: tuple[str, ...]) -> int:
            return next(
                index
                for index, step in enumerate(steps)
                if step[0] == op
                and not str(step[1]).startswith("?")
                and all(needle in str(step[1]) for needle in needles)
            )

        # The click is the whole leg's entry: without it nothing below runs.
        def drop_click(copy: list) -> None:
            copy.pop(pr_tab_click_at(copy))

        problems = problems_after(drop_click)
        self.assertTrue(any("Pull Request tab" in problem for problem in problems), problems)

        # Each proof, deleted, must redden the guard with its own name.
        for op, needles, keyword in self.PROOFS:
            at = required(op, needles)

            def drop_step(copy: list, at: int = at) -> None:
                copy.pop(at)

            problems = problems_after(drop_step)
            self.assertTrue(
                any(keyword in problem for problem in problems),
                "dropping the %s proof left the guard green: %r" % (keyword, problems),
            )

        # A proof that went optional is a recorded skip, not evidence.
        for op, needles, keyword in self.PROOFS:
            at = required(op, needles)

            def make_optional(copy: list, at: int = at) -> None:
                copy[at][1] = "?" + str(copy[at][1])

            problems = problems_after(make_optional)
            self.assertTrue(
                any(keyword in problem for problem in problems),
                "an optional %s proof left the guard green: %r" % (keyword, problems),
            )

        # Inside the mac-wide rerun scope only one width would walk the panel.
        at = pr_tab_click_at(steps)

        def scope_to_mac_wide(copy: list, at: int = at) -> None:
            copy.insert(at, ["vp", "mac-wide"])

        problems = problems_after(scope_to_mac_wide)
        self.assertTrue(any("vp scope" in problem for problem in problems), problems)

        # A live Monaco diff cannot be unmounted by a surface switch: the
        # dispose error is a page error, which the walker fails on.
        def after_the_diff(copy: list) -> None:
            moved = copy.pop(pr_tab_click_at(copy))
            at = next(
                index
                for index, step in enumerate(copy)
                if step[0] == "wait" and ".monaco-diff-editor" in str(step[1])
            )
            copy.insert(at + 1, moved)

        problems = problems_after(after_the_diff)
        self.assertTrue(
            any("diff editor is mounted" in problem for problem in problems), problems
        )

        # Without the return click the review loop that follows runs against
        # the PR pane, where notes.md has no row.
        ret = next(
            index
            for index, step in enumerate(steps)
            if step[0] == "click" and "button[aria-label='文件']" in str(step[1])
        )

        def drop_return(copy: list, at: int = ret) -> None:
            copy.pop(at)

        problems = problems_after(drop_return)
        self.assertTrue(any("files panel" in problem for problem in problems), problems)

        # The shot is the stored evidence (TASTE 9), and it names the leg.
        shot = next(
            index
            for index, step in enumerate(steps)
            if step[0] == "shot" and step[1] == "pr-panel"
        )

        def drop_shot(copy: list, shot: int = shot) -> None:
            copy.pop(shot)

        problems = problems_after(drop_shot)
        self.assertTrue(any("pr-panel" in problem for problem in problems), problems)


@unittest.skipUnless(NODE, "node is not installed; the journey walker needs it")
class WalkJ8ContractTest(unittest.TestCase):
    """J8 must walk the review loop the way a thumb does, at 390 only.

    KIN-RESULT-001: the phone opens 文件 → taps the seeded notes.md row → the
    rendered `.monaco-diff-editor`. KIN-RESULT-003: the same loop by thumb —
    tap the changed line's glyph, write in the sheet, Save, read the tray's
    one row, tap Send, and find the anchored follow-up as one settled
    transcript row, with the tray gone and 已发回对话 shown.

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
        spec = load_spec()
        mutate(spec["journeys"]["J8"])
        path = os.path.join(self.tmp, "journeys.json")
        with open(path, "w", encoding="utf-8") as fh:
            json.dump(spec, fh)
        return path

    def copy_spec_with(self, mutate) -> str:
        spec = load_spec()
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
        spec = load_spec()
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

    def test_j8_reviews_a_conversation_no_other_journey_rewrites(self) -> None:
        # J2's rerun leg sends [seed] shift and [seed] rewrite into [seed]
        # Morning planning: the first moves the commented line, the second
        # deletes the quoted text. A J8 on the same conversation asks the tray
        # for a line that is no longer there, fails, and the gate learns to
        # excuse that one line as a known artifact. J8 must review its own
        # seeded diff instead, so a future break in the phone loop cannot hide
        # behind that excuse.
        code, out = self.check()
        self.assertEqual(code, 0, out)
        self.assertIn("spec ok: J8", out)
        steps = load_spec()["journeys"]["J8"]["steps"]
        conversation = next(
            step
            for step in steps
            if step[0] == "click" and re.fullmatch(r"\??/.*/", str(step[1]))
        )
        self.assertIn("Phone review", conversation[1])
        self.assertNotIn("Morning planning", conversation[1])

        def back_to_j2_conversation(journey: dict) -> None:
            mutated = journey["steps"]
            at = next(
                i
                for i, step in enumerate(mutated)
                if step[0] == "click" and re.fullmatch(r"\??/.*/", str(step[1]))
            )
            mutated[at] = ["click", "?/Morning planning/"]

        code, out = self.check(self.copy_with(back_to_j2_conversation))
        self.assertEqual(code, 1, out)
        self.assertIn("give J8 its own seeded conversation", out)

    def test_j8_contract_rejects_a_missing_own_message_count(self) -> None:
        # The transcript wait can pass on the local pending bubble before the
        # daemon's message row exists. Counting the settled rows makes the
        # proof about the message that was sent; without the count the wait is
        # satisfied by the echo the console drew itself.
        def drop_count(journey: dict) -> None:
            steps = journey["steps"]
            at = next(
                i
                for i, step in enumerate(steps)
                if step[0] == "count" and "data-message-key" in str(step[1])
            )
            steps.pop(at)

        code, out = self.check(self.copy_with(drop_count))
        self.assertEqual(code, 1, out)
        self.assertIn("carrying its own comment body", out)

    def test_j8_contract_rejects_an_unsettled_or_unanchored_count(self) -> None:
        # The pending echo is also a `data-message-key` row and carries the
        # whole composed comment, so a count without the `pending-` exclusion
        # is satisfied before the daemon's message exists; one that keeps the
        # exclusion but counts the body alone lets a projection that dropped
        # the path/hunk/quote walk green. Both must fail the contract.
        def mutate_count(selector: str) -> None:
            def mutate(journey: dict) -> None:
                steps = journey["steps"]
                at = next(
                    i
                    for i, step in enumerate(steps)
                    if step[0] == "count" and "data-message-key" in str(step[1])
                )
                steps[at][1] = selector

            code, out = self.check(self.copy_with(mutate))
            self.assertEqual(code, 1, out)
            self.assertIn("carrying its own comment body", out)

        # Dropping the exclusion makes the echo countable.
        mutate_count(
            "css=[role=region][tabindex='-1'] [data-message-key]:has-text('%s')"
            % self.BODY
        )
        # Keeping it but dropping the anchor proves only that the words exist.
        mutate_count(
            "css=[role=region][tabindex='-1'] [data-message-key]:not([data-message-key^='pending-']):has-text('%s')"
            % self.BODY
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
            # Both anchored region waits (the transcript wait and the settled-
            # row wait) must lose the anchor; leaving either one would keep the
            # contract green and the mutant would prove nothing.
            at = [
                i
                for i, step in enumerate(steps)
                if step[0] == "wait"
                and "[role=region]" in str(step[1])
                and "notes.md:5" in str(step[1])
            ]
            self.assertEqual(len(at), 2, steps)
            for i in at:
                steps[i] = [
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
        spec = load_spec()
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

    @staticmethod
    def approve_count_at(steps: list, want: str) -> int:
        return next(
            i
            for i, step in enumerate(steps)
            if step[0] == "count"
            and "批准" in str(step[1])
            and "Approve" in str(step[1])
            and str(step[2]) == want
        )

    def test_j7_spec_pins_the_phone_root_count(self) -> None:
        # The checked-in spec is the proof the walk runs: the phone list count
        # after Back, its scope, and the positive count after the reopen are
        # all present and in order here, not only inside the contract.
        code, out = self.check()
        self.assertEqual(code, 0, out)
        self.assertIn("spec ok: J7", out)
        steps = load_spec()["journeys"]["J7"]["steps"]
        phone = self.approve_count_at(steps, "0")
        back = next(i for i, step in enumerate(steps) if step[0] == "back")
        self.assertGreater(phone, back, steps)
        reopen = next(
            i
            for i, step in enumerate(steps)
            if i > phone
            and step[0] == "count"
            and "批准" in str(step[1])
            and str(step[2]) != "0"
        )
        scope = next(i for i, step in enumerate(steps) if step[0] == "vp" and step[1] == "phone")
        self.assertLess(back, scope, steps)
        self.assertLess(scope, phone, steps)
        clear = next(
            i for i, step in enumerate(steps) if i > phone and step[0] == "vp" and step[1] == ""
        )
        self.assertLess(phone, clear, steps)
        # The same control is tapped back into view and counted, so the card's
        # return is a number a reviewer can read, not only a wait.
        row = next(i for i, step in enumerate(steps) if step[0] == "click" and "data-session-row" in str(step[1]))
        self.assertLess(row, reopen, steps)

    def test_j7_contract_requires_the_phone_root_count(self) -> None:
        # The phone tab root draws the approval strip only; the decision card
        # belongs to a conversation. Without the count, the pre-#252 layout
        # that draws the card over the list is green (the committed mutant).
        def drop_the_phone_count(steps: list) -> None:
            steps.pop(self.approve_count_at(steps, "0"))

        code, out = self.check(self.copy_with(drop_the_phone_count))
        self.assertEqual(code, 1, out)
        self.assertIn("phone list", out)
        self.assertIn("批准", out)
        self.assertIn("Approve", out)

    def test_j7_contract_rejects_a_phone_count_that_is_not_zero(self) -> None:
        # Exactly zero: one card on the phone list is the decision surface
        # floating over rows it does not belong to.
        def one_card_on_the_list(steps: list) -> None:
            steps[self.approve_count_at(steps, "0")][2] = "1"

        code, out = self.check(self.copy_with(one_card_on_the_list))
        self.assertEqual(code, 1, out)
        self.assertIn("phone list", out)
        self.assertIn("0", out)

    def test_j7_contract_requires_the_phone_scope_around_the_count(self) -> None:
        # On the Mac the card on the list is legitimate, so an unscoped count
        # asserts the wrong thing at that width: the scope is the assertion.
        def drop_the_phone_scope(steps: list) -> None:
            at = next(i for i, step in enumerate(steps) if step[0] == "vp" and step[1] == "phone")
            steps.pop(at)

        code, out = self.check(self.copy_with(drop_the_phone_scope))
        self.assertEqual(code, 1, out)
        self.assertIn("phone scope", out)
        self.assertIn("vp phone", out)

    def test_j7_contract_requires_a_positive_count_after_the_reopen(self) -> None:
        # The reopen is a pointer tap into the conversation; the card coming
        # back is a count of the same control, not just a wait that found a
        # node somewhere on the page.
        def drop_the_reopen_count(steps: list) -> None:
            at = next(
                i
                for i, step in enumerate(steps)
                if step[0] == "count" and "批准" in str(step[1]) and str(step[2]) != "0"
            )
            steps.pop(at)

        code, out = self.check(self.copy_with(drop_the_reopen_count))
        self.assertEqual(code, 1, out)
        self.assertIn("after reopening", out)

    def test_j7_lands_on_the_named_card(self) -> None:
        # With a seed line the check resolves the real ids and prints the
        # assertion the walk will make, not just "the spec mentions {focus}".
        code, out = self.check(seed=TARGET_TITLE)
        self.assertEqual(code, 0, out)
        self.assertIn("spec ok: J7", out)
        self.assertIn('[data-pending-id="appr-1"]', out)
        steps = load_spec()["journeys"]["J7"]["steps"]
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
        # The folded list hides the row behind its project bucket, so the
        # reopen goes through the search box with the seeded title and then
        # waits on the resolved row id before pressing it.
        self.assertIn(["click", "?/Search chats|搜索对话/"], steps, steps)
        self.assertIn(["fill", "?input[type=search]", "deploy"], steps, steps)
        self.assertIn(["wait", 'css=[data-session-row="task-1"]'], steps, steps)
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
        spec = load_spec()
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
        spec = load_spec()
        journey = spec["journeys"]["J9"]
        steps = journey["steps"]
        self.assertEqual(journey["viewports"], ["mac"])
        # The evidence the reviewer reads: the shell tagged before the switch
        # and asserted again after it, a scroll left behind, a draft typed, and
        # all three read back after the return.
        self.assertIn(["node", "css=#root .touch-lg", "shell"], steps)
        self.assertIn(["scroll-kept", "css=[role=region][tabindex='-1']", "320"], steps)
        self.assertIn(["value", "textarea", self.DRAFT], steps)
        # The scroll must be taken after the draft fill: the fill re-renders the
        # pane and can move the transcript, and a position taken before it is
        # what `scroll-kept` would then convict.
        scroll = self.at(steps, lambda step: step[0] == "scroll")
        draft = self.at(steps, lambda step: step[0] == "fill" and step[2] == self.DRAFT)
        self.assertLess(draft, scroll, "J9 must scroll after the draft fill")
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

    def test_j9_contract_rejects_a_scroll_before_the_draft(self) -> None:
        """The scroll must be taken after the last text entry before the switch.

        A draft fill re-renders the conversation pane. A scroll taken before it
        can be undone before the walk leaves, so `scroll-kept` then convicts a
        green PR at the walker's own last offset (2026-11-24 #656: transcript at
        2201 where 320±48 was asked, confirm flaked 85/85). The deep form of
        this test is `test_j9_walks_the_switch`; this one keeps the rejection
        named when the rule is removed.
        """
        def scroll_before_the_draft(steps: list) -> None:
            at = self.at(steps, lambda step: step[0] == "scroll")
            step = steps.pop(at)
            fill = self.at(steps, lambda s: s[0] == "fill" and s[2] == self.DRAFT)
            steps.insert(fill, step)

        code, out = self.check(self.copy_with(scroll_before_the_draft))
        self.assertEqual(code, 1, out)
        self.assertIn("scrolls the transcript before typing the unsent draft", out)

    def test_j9_contract_rejects_the_retired_area_shot(self) -> None:
        # The shot's name is the reviewer's only index into the evidence: it
        # must name the page it photographs. The Projects area retired in
        # KIN-CONTRACT-001 and the walk now clicks [data-area="routines"], so a
        # shot still called `area-projects` sends every reader to a page that
        # no longer exists.
        def rename_the_area_shot(steps: list) -> None:
            at = self.at(
                steps,
                lambda step: step[0] == "shot" and step[1] in ("area-routines", "area-projects"),
            )
            steps[at][1] = "area-projects"

        code, out = self.check(self.copy_with(rename_the_area_shot))
        self.assertEqual(code, 1, out)
        self.assertIn("J9 takes no `area-routines` shot", out)

    def test_j9_pins_the_composer_element(self) -> None:
        """TASTE 15: the composer is part of the shell that must not repaint.

        #342 tagged the `form` itself — `composer` before the switch,
        `composer-failed` on the other conversation, `composer` again after the
        return — because a per-route re-key leaves the shell node identical
        while the input is a new element. No contract read those tags, so any
        of them could be deleted with every check green. Deleting each tag must
        redden the spec.
        """
        code, out = self.check()
        self.assertEqual(code, 0, out)
        steps = load_spec()["journeys"]["J9"]["steps"]
        switch = self.at(steps, lambda step: self.is_click_title(step, "Failed migration"))
        return_i = self.at(steps, lambda step: self.is_click_title(step, "Morning planning"), switch + 1)
        tags = [(i, step[2]) for i, step in enumerate(steps) if step[0] == "node"]
        composers = [(i, name) for i, name in tags if name in ("composer", "composer-failed")]
        self.assertEqual([name for _, name in composers],
                         ["composer", "composer-failed", "composer"], composers)
        before, failed, back = (i for i, _ in composers)
        self.assertLess(before, switch)
        self.assertLess(switch, failed)
        self.assertLess(failed, return_i)
        self.assertLess(return_i, back)
        for index, name in composers:
            with self.subTest(tag=name, step=index):
                code, out = self.check(self.copy_with(lambda steps: steps.pop(index)))
                self.assertEqual(code, 1, out)
                self.assertIn("spec red: J9", out)
                self.assertIn("composer", out)


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
        spec = load_spec()
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
        journey = load_spec()["journeys"]["J10"]
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


class WalkJ11ContractTest(unittest.TestCase):
    """J11 must prove the phone switch keeps the shell, the scroll and the draft.

    J9 proves the same promise on the Mac; the phone has its own Back, its own
    list rows and a footer, and nothing walked the switch at 390. A regression
    that remounts the pane, resets the transcript, or drops the draft reads as
    "the app ate my draft" and is invisible to the gate. Same shape as
    WalkJ9ContractTest: the checked-in spec passes the walker's own contract
    check, and a copy that regresses one rule at a time fails naming that rule.
    """

    DRAFT = "F4 draft [seed]"
    OFFSET = "320"
    TRANSCRIPT = "css=[role=region][tabindex='-1']"

    def setUp(self) -> None:
        self.tmp = tempfile.mkdtemp(prefix="j11-contract-")
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
        spec = load_spec()
        mutate(spec["journeys"]["J11"]["steps"])
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

    def test_j11_spec_pins_the_phone_switch(self) -> None:
        code, out = self.check()
        self.assertEqual(code, 0, out)
        self.assertIn("spec ok: J11 keeps the shell, the scroll and the draft", out)
        spec = load_spec()
        journey = spec["journeys"]["J11"]
        steps = journey["steps"]
        # Phone only: the footer and the phone's own Back are what this walks.
        self.assertEqual(journey["viewports"], ["phone"])
        # The three pieces, in the order the switch runs: a numeric middle
        # scroll and the shell tagged before the first leaving, an unsent
        # draft, then the same shell, the same offset and the same draft read
        # back after the return.
        self.assertIn(["node", "css=#root .touch-lg", "shell"], steps)
        self.assertIn(["scroll", self.TRANSCRIPT, self.OFFSET], steps)
        self.assertIn(["scroll-kept", self.TRANSCRIPT, self.OFFSET], steps)
        self.assertIn(["value", "textarea", self.DRAFT], steps)
        names = [step[1] for step in steps if step[0] == "shot"]
        self.assertLess(names.index("switch-chat"), names.index("switch-back"), names)
        # The order is the story: leave, switch, assert the shell, return,
        # read the draft and the position, then the footer round.
        scroll_i = steps.index(["scroll", self.TRANSCRIPT, self.OFFSET])
        back_i = self.at(steps, lambda step: step[0] == "back", scroll_i + 1)
        switch_i = self.at(steps, lambda step: self.is_click_title(step, "Failed migration"), back_i + 1)
        node_i = self.at(steps, lambda step: step[0] == "node" and step[2] == "shell", switch_i + 1)
        return_i = self.at(steps, lambda step: self.is_click_title(step, "Morning planning"), node_i + 1)
        value_i = self.at(steps, lambda step: step[0] == "value" and step[2] == self.DRAFT, return_i + 1)
        kept_i = self.at(steps, lambda step: step[0] == "scroll-kept", value_i + 1)
        routines_i = self.at(steps, lambda step: step[0] == "click"
                             and '[data-phone-return="routines"]' in str(step[1]), kept_i + 1)
        self.assertLess(scroll_i, back_i)
        self.assertLess(back_i, switch_i)
        self.assertLess(switch_i, node_i)
        self.assertLess(node_i, return_i)
        self.assertLess(return_i, value_i)
        self.assertLess(value_i, kept_i)
        self.assertLess(kept_i, routines_i)
        # The leaving is the phone's Back (a `goto` after the conversation is
        # open would reload the document and make the shell question
        # meaningless). The area round is the footer's, never the Mac's
        # `[data-area=…]` nav.
        first_open = self.at(steps, lambda step: self.is_click_title(step, "Morning planning"))
        first_back = self.at(steps, lambda step: step[0] == "back", first_open + 1)
        self.assertTrue(all(i < first_open for i, step in enumerate(steps) if step[0] == "goto"))
        self.assertLess(first_open, first_back)
        self.assertFalse(any("[data-area=" in str(step[1])
                             for step in steps if step[0] == "click"), steps)
        for tab in ("routines", "sessions"):
            self.assertTrue(any(step[0] == "click" and f'[data-phone-return="{tab}"]' in str(step[1])
                                for step in steps), tab)
        # The area switch is the stronger claim: the pane was off screen, so
        # the return must prove the restore again, not only element identity.
        values = [i for i, step in enumerate(steps)
                  if step[0] == "value" and "textarea" in str(step[1])]
        kepts = [i for i, step in enumerate(steps) if step[0] == "scroll-kept"]
        self.assertEqual(len(values), 2, values)
        self.assertEqual(len(kepts), 2, kepts)
        self.assertGreater(kepts[1], self.at(
            steps, lambda step: step[0] == "click" and '[data-phone-return="sessions"]' in str(step[1])), kepts)
        # A shell or conversation-pane diff must select J11.
        for row_needle in ("ui/src/components/layout/", "ui/src/pages/TaskDetail"):
            row = next((row for row in spec["paths"] if row_needle in row[0]), None)
            self.assertIsNotNone(row, row_needle)
            self.assertIn("J11", row[1], row_needle)

    def test_j11_contract_rejects_a_return_without_the_scroll_assertion(self) -> None:
        # A resumed conversation that snapped back to the top is the regression
        # this journey exists to catch; without scroll-kept the walk only
        # photographs the right pane.
        def drop_the_scroll_kept(steps: list) -> None:
            hits = [i for i, step in enumerate(steps) if step[0] == "scroll-kept"]
            for i in reversed(hits):
                steps.pop(i)

        code, out = self.check(self.copy_with(drop_the_scroll_kept))
        self.assertEqual(code, 1, out)
        self.assertIn("never asserts the transcript came back", out)

    def test_j11_contract_rejects_a_return_without_the_draft_value(self) -> None:
        # The half-typed message is the thing keep-alive exists for. A return
        # that never reads the composer back proves only that the route works.
        def drop_the_draft_value(steps: list) -> None:
            hits = [i for i, step in enumerate(steps)
                    if step[0] == "value" and "textarea" in str(step[1])]
            for i in reversed(hits):
                steps.pop(i)

        code, out = self.check(self.copy_with(drop_the_draft_value))
        self.assertEqual(code, 1, out)
        self.assertIn("draft survived the return", out)

    def test_j11_contract_rejects_an_area_round_without_the_shell_assertion(self) -> None:
        # The footer tap is a route change while the pane is off screen; a
        # shell remounted there is exactly the page-load flash F4 prevents.
        def drop_the_routines_node(steps: list) -> None:
            tap = self.at(steps, lambda step: step[0] == "click"
                          and '[data-phone-return="routines"]' in str(step[1]))
            node = self.at(steps, lambda step: step[0] == "node", tap + 1)
            steps.pop(node)

        code, out = self.check(self.copy_with(drop_the_routines_node))
        self.assertEqual(code, 1, out)
        self.assertIn("routines area change", out)

    def test_j11_pins_the_composer_element(self) -> None:
        """TASTE 15 at 390: the same `form` survives every switch.

        The four tags #342 added — `composer` before the first Back,
        `composer-failed` on the second conversation, `composer` after the
        return and `composer` after the footer round — assert element identity
        on the phone, where the pane is also unmounted off screen. No contract
        read them; deleting any one must redden the spec.
        """
        code, out = self.check()
        self.assertEqual(code, 0, out)
        steps = load_spec()["journeys"]["J11"]["steps"]
        leave = self.at(steps, lambda step: step[0] == "back")
        switch = self.at(steps, lambda step: self.is_click_title(step, "Failed migration"))
        back = self.at(steps, lambda step: step[0] == "back", switch + 1)
        return_i = self.at(steps, lambda step: self.is_click_title(step, "Morning planning"), back + 1)
        last_return = self.at(steps, lambda step: self.is_click_title(step, "Morning planning"), return_i + 1)
        composers = [(i, step[2]) for i, step in enumerate(steps)
                     if step[0] == "node" and step[2] in ("composer", "composer-failed")]
        self.assertEqual([name for _, name in composers],
                         ["composer", "composer-failed", "composer", "composer"], composers)
        first, failed, returned, final = (i for i, _ in composers)
        self.assertLess(first, leave)
        self.assertLess(switch, failed)
        self.assertLess(failed, back)
        self.assertLess(return_i, returned)
        self.assertLess(returned, last_return)
        self.assertLess(last_return, final)
        for index, name in composers:
            with self.subTest(tag=name, step=index):
                code, out = self.check(self.copy_with(lambda steps: steps.pop(index)))
                self.assertEqual(code, 1, out)
                self.assertIn("spec red: J11", out)
                self.assertIn("composer", out)

    def test_j11_contract_rejects_a_list_entry_without_the_fold_press(self) -> None:
        # Conversations another journey created land in the same project
        # bucket. Past five rows the list draws them behind 展开全部, so the
        # seeded row is not in the DOM and the click is a hard fail. A spec
        # that drops the press is green in a standalone walk and red only in
        # the gate, which is why the contract has to name the missing press.
        steps = load_spec()["journeys"]["J11"]["steps"]
        hits = [i for i, step in enumerate(steps)
                if step[0] == "click" and "展开全部" in str(step[1])]
        self.assertTrue(hits)
        for index in hits:
            with self.subTest(step=index):
                code, out = self.check(self.copy_with(lambda steps: steps.pop(index)))
                self.assertEqual(code, 1, out)
                self.assertIn("project fold", out)


class WalkJ12ContractTest(unittest.TestCase):
    """J12 must walk the phone's three thumb gestures and read each consequence.

    #318 landed the body, the `swipe`/`drag`/`rows` verbs and the contract, but
    the index did not name J12, so the contract returned [] for an absent J12
    and no gate ever walked a gesture. These cases are the registration's proof:
    the shipped index resolves J12 and prints its `spec ok` line, a body with a
    gesture removed is red naming J12, and an index that drops the entry is an
    error rather than a silently retired walk.

    Same shape as WalkJ11ContractTest: the walker's own `--check-spec` is the
    reader, so a rule cannot drift between the spec and the gate.
    """

    # The evidence, in the order a thumb learns the gestures: the searched and
    # scrolled list, the same list back after the edge swipe, the revealed row,
    # then the order before the hold, after it, and after the reload.
    SCREENS = ["list-searched-scrolled", "list-restored", "row-revealed",
               "order-before", "order-after-drag", "order-after-reload"]

    def setUp(self) -> None:
        self.tmp = tempfile.mkdtemp(prefix="j12-contract-")
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
        spec = load_spec()
        mutate(spec["journeys"]["J12"]["steps"])
        path = os.path.join(self.tmp, "resolved.json")
        with open(path, "w", encoding="utf-8") as fh:
            json.dump(spec, fh)
        return path

    def copy_spec_with(self, mutate) -> str:
        spec = load_spec()
        mutate(spec)
        path = os.path.join(self.tmp, "paths.json")
        with open(path, "w", encoding="utf-8") as fh:
            json.dump(spec, fh)
        return path

    def index_without_j12(self) -> str:
        """A copy of the shipped index with only the J12 entry deleted.

        The bodies resolve relative to the index, so the fixture copies the
        directory too. It is a temp spec, not the committed index: the real
        index is hand-edited, never round-tripped through ``json.dump``.
        """
        shutil.copytree(JOURNEYS_DIR, os.path.join(self.tmp, "journeys"))
        with open(SPEC, encoding="utf-8") as fh:
            index = json.load(fh)
        self.assertIn("J12", index["journeys"],
                      "the shipped index does not register J12")
        del index["journeys"]["J12"]
        path = os.path.join(self.tmp, "journeys.json")
        with open(path, "w", encoding="utf-8") as fh:
            json.dump(index, fh, ensure_ascii=False)
        return path

    def test_j12_spec_pins_the_thumb_gestures(self) -> None:
        code, out = self.check()
        self.assertEqual(code, 0, out)
        self.assertIn("spec ok: J12 walks the phone's edge back, row reveal", out)
        spec = load_spec()
        journey = spec["journeys"]["J12"]
        steps = journey["steps"]
        # Phone only: every leg is real touch, and a width without a touch
        # context refuses the sequence.
        self.assertEqual(journey["viewports"], ["phone"])

        def at(pred, start: int = 0) -> int:
            return next(i for i, step in enumerate(steps) if i >= start and pred(step))

        # Leg 1 — the edge back. The finger starts inside the 20px strip and
        # travels past the 64px commit distance; the search text and the scroll
        # offset are set before it and read after it, with no reload between.
        edge = at(lambda step: step[0] == "swipe" and isinstance(step[1], int)
                  and isinstance(step[2], int) and step[1] <= 20 and step[2] - step[1] > 64)
        fill = at(lambda step: step[0] == "fill" and "input[type=search]" in str(step[1]))
        scroll = at(lambda step: step[0] == "scroll" and "data-phone-scroll" in str(step[1])
                    and int(step[2]) > 0)
        self.assertLess(fill, edge)
        self.assertLess(scroll, edge)
        value = at(lambda step: step[0] == "value" and "input[type=search]" in str(step[1]), edge + 1)
        kept = at(lambda step: step[0] == "scroll-kept" and "data-phone-scroll" in str(step[1]),
                  edge + 1)
        self.assertEqual(steps[value][2], steps[fill][2])
        self.assertEqual(int(steps[kept][2]), int(steps[scroll][2]))
        self.assertFalse(any(step[0] == "goto" for step in steps[edge:value]),
                         "the edge back must survive the pop, not a fresh load")

        # Leg 2 — the row swipe. Past the 152px reveal width the chip is read,
        # the rightward close takes it away, and the route stays on /sessions.
        left = at(lambda step: step[0] == "swipe" and isinstance(step[1], int)
                  and isinstance(step[2], int) and step[1] - step[2] > 152)
        chip = at(lambda step: step[0] == "wait" and re.search(r"置顶|Pin|改名|Rename", str(step[1])),
                  left + 1)
        closed = at(lambda step: step[0] == "swipe" and isinstance(step[1], int)
                    and isinstance(step[2], int) and step[2] > step[1], chip + 1)
        gone = at(lambda step: step[0] == "gone"
                  and re.search(r"置顶|Pin|改名|Rename", str(step[1])), closed + 1)
        url = at(lambda step: step[0] == "url" and str(step[1]).startswith("^/sessions"), closed + 1)
        self.assertLess(left, chip)
        self.assertLess(chip, closed)
        self.assertLess(closed, gone)
        self.assertLess(closed, url)

        # Leg 3 — hold-to-reorder. A real 500ms hold, the new order read from
        # the drawn DOM, then the same read after a reload: a reorder that
        # lives only in React state must not pass. The travel reaches past the
        # bucket's first row's midpoint: a journey walked earlier in the same
        # daemon (J3, on every layout row) can leave its own conversations
        # between the two seeded rows, so an 80px step across the neighbour
        # would read a different order while the drag itself is correct.
        drag = at(lambda step: step[0] == "drag" and "data-session-row" in str(step[1])
                  and int(step[3]) >= 500)
        self.assertLessEqual(int(steps[drag][2]), -200,
                             "the drag must pass above the bucket's first row midpoint")
        before = max(i for i, step in enumerate(steps)
                     if i < drag and step[0] == "rows")
        after = at(lambda step: step[0] == "rows", drag + 1)
        reload = at(lambda step: step[0] == "goto" and step[1] == "/sessions", after + 1)
        post = at(lambda step: step[0] == "rows", reload + 1)
        self.assertLess(before, drag)
        self.assertLess(drag, after)
        self.assertLess(after, reload)
        self.assertLess(reload, post)
        self.assertNotEqual(steps[before][2], steps[after][2])
        self.assertEqual(steps[after][2], steps[post][2])

        # The six screens are the walk's evidence and run in this order.
        shots = [step[1] for step in steps if step[0] == "shot"]
        self.assertEqual([name for name in shots if name in self.SCREENS], self.SCREENS, shots)

        # The shell, list, conversation and locale diffs must select J12, or a
        # dead gesture passes on a PR the UX gate never walks.
        for row_needle in ("ui/src/components/layout/", "ui/src/components/sessions/",
                           "ui/src/components/mobile/", "ui/src/pages/TaskDetail",
                           "ui/src/i18n/locales/"):
            row = next((row for row in spec["paths"] if row_needle in row[0]), None)
            self.assertIsNotNone(row, row_needle)
            self.assertIn("J12", row[1], row_needle)

    def test_j12_order_read_tolerates_rows_another_journey_created(self) -> None:
        # The layout row lists J1..J12 in array order, so any walk on a shell
        # or list change runs J3 before J12 against one daemon. J3's two
        # viewports create two `Draft: … [seed] slow` conversations in Project
        # Alpha; the "seed" search keeps them (the project label matches), so
        # the order read must allow extra rows while still failing the pre-drag
        # order after the drag. Both halves are the proof: without the first,
        # J12 hard-fails every combined walk; without the second, a dead drag
        # passes on a list another journey populated.
        def matches(got: list[str], wanted: list[str]) -> int:
            done = subprocess.run(
                [NODE, WALK, "--rows-match", "--got", json.dumps(got),
                 "--want", json.dumps(wanted)],
                capture_output=True,
                text=True,
                timeout=20,
            )
            return done.returncode

        drafts = ["Draft: summarise this week's TODOs [seed] slow"] * 2
        before = ["[seed] Approve the migration", "[seed] Morning planning"] + drafts
        after = ["[seed] Morning planning", "[seed] Approve the migration"] + drafts
        self.assertEqual(matches(before, ["[seed] Approve the migration",
                                          "[seed] Morning planning"]), 0,
                         "extra rows from an earlier journey must not fail the order read")
        self.assertEqual(matches(before, ["[seed] Morning planning",
                                          "[seed] Approve the migration"]), 1,
                         "the pre-drag order must not satisfy the post-drag read")
        self.assertEqual(matches(after, ["[seed] Morning planning",
                                         "[seed] Approve the migration"]), 0)
        self.assertEqual(matches(drafts, ["[seed] Approve the migration"]), 1,
                         "a missing row must not match")

    def test_j12_contract_rejects_a_spec_without_the_reorder(self) -> None:
        # A J12 that dropped the hold still passes every earlier leg, so the
        # contract has to name the absent gesture rather than return [] for a
        # body that merely exists.
        def drop_the_drag(steps: list) -> None:
            hits = [i for i, step in enumerate(steps) if step[0] == "drag"]
            for i in reversed(hits):
                steps.pop(i)

        code, out = self.check(self.copy_with(drop_the_drag))
        self.assertEqual(code, 1, out)
        self.assertIn("spec red: J12", out)
        self.assertIn("hold", out)

    def test_j12_contract_rejects_a_list_load_without_the_fold_press(self) -> None:
        # Past five rows the project bucket renders 展开全部 instead of the
        # seeded row, and every gesture aimed at it fails as "not on the
        # screen". Each unsearched load needs its own mandatory press, even
        # when another load in the same journey already opened the fold.
        steps = load_spec()["journeys"]["J12"]["steps"]
        hits = [i for i, step in enumerate(steps)
                if step[0] == "click" and "展开全部" in str(step[1])]
        self.assertTrue(hits)
        for index in hits:
            with self.subTest(step=index):
                code, out = self.check(self.copy_with(lambda steps: steps.pop(index)))
                self.assertEqual(code, 1, out)
                self.assertIn("project fold", out)

    def test_j12_contract_rejects_a_fold_without_clearing_search(self) -> None:
        steps = load_spec()["journeys"]["J12"]["steps"]
        resets = [i for i, step in enumerate(steps)
                  if step == ["fill", "input[type=search]", ""]]
        self.assertTrue(resets)
        for index in resets:
            with self.subTest(step=index):
                code, out = self.check(self.copy_with(lambda steps: steps.pop(index)))
                self.assertEqual(code, 1, out)
                self.assertIn("clear the search", out)
            with self.subTest(clear_after_fold=index):
                def clear_after_fold(steps: list) -> None:
                    reset = steps.pop(index)
                    fold = next(i for i, step in enumerate(steps)
                                if i >= index and step[0] == "click"
                                and "展开全部" in str(step[1]))
                    steps.insert(fold + 1, reset)

                code, out = self.check(self.copy_with(clear_after_fold))
                self.assertEqual(code, 1, out)
                self.assertIn("clear the search", out)

    def test_j12_contract_rejects_a_fold_without_a_tall_fixture(self) -> None:
        def drop_fixture_send(steps: list) -> None:
            steps.pop(next(i for i, step in enumerate(steps) if step[0] == "send"))

        code, out = self.check(self.copy_with(drop_fixture_send))
        self.assertEqual(code, 1, out)
        self.assertIn("four fixture conversations", out)

    def test_j12_contract_accepts_an_optional_fold_only_with_the_row_wait(self) -> None:
        # ROWS_BEFORE_SHOW_ALL is 10, so the seeded bucket plus four fixtures
        # may offer no fold at all and the press must be optional. An optional
        # press is accepted only while a mandatory seeded-row wait follows it:
        # a fold that silently stops matching would otherwise hide a row that
        # is not there. The shipped spec is the accept case.
        steps = load_spec()["journeys"]["J12"]["steps"]
        folds = [i for i, step in enumerate(steps)
                 if step[0] == "click" and "展开全部" in str(step[1])]
        self.assertTrue(folds)
        for index in folds:
            self.assertTrue(str(steps[index][1]).startswith("?"),
                            "the shipped fold press must be optional")
            wait = next(
                i for i, step in enumerate(steps)
                if i > index and step[0] == "wait"
                and "Morning planning" in str(step[1])
                and not str(step[1]).startswith("?"))
            with self.subTest(step=index, wait=wait):
                def unmandate_the_row_wait(steps: list) -> None:
                    steps[wait][1] = "?" + str(steps[wait][1])

                code, out = self.check(self.copy_with(unmandate_the_row_wait))
                self.assertEqual(code, 1, out)
                self.assertIn("mandatory seeded-row wait", out)

        code, out = self.check()
        self.assertEqual(code, 0, out)
        self.assertIn("spec ok: J12", out)

    def test_j12_contract_rejects_a_generic_seeded_row_click(self) -> None:
        def generic_row(steps: list) -> None:
            step = next(step for step in steps
                        if step[0] == "click" and "data-session-row" in str(step[1]))
            step[1] = "css=[data-session-row]:has-text('[seed]')"

        code, out = self.check(self.copy_with(generic_row))
        self.assertEqual(code, 1, out)
        self.assertIn("Morning planning", out)

    def test_j12_contract_still_rejects_an_optional_proof(self) -> None:
        # An optional chip wait would let a dead reveal pass with every remaining
        # assertion still green, which is what the ban exists for.
        def make_the_chip_wait_optional(steps: list) -> None:
            step = next(step for step in steps
                        if step[0] == "wait"
                        and re.search(r"置顶|Pin|改名|Rename", str(step[1])))
            step[1] = "?" + str(step[1])

        code, out = self.check(self.copy_with(make_the_chip_wait_optional))
        self.assertEqual(code, 1, out)
        self.assertIn("is optional", out)

    def test_j12_contract_rejects_an_index_without_the_registration(self) -> None:
        # Registration is the point of this row: deleting the one line must be
        # loud, or the walk can be retired by an index edit no gate notices.
        code, out = self.check(self.index_without_j12())
        self.assertEqual(code, 1, out)
        self.assertIn("spec red: J12", out)
        self.assertIn("J12 is not in the spec", out)

    def test_j12_contract_requires_the_gesture_paths_rows(self) -> None:
        # `--files` selects the journeys from the paths table, first match
        # wins. A shell, list, conversation or locale row that drops J12 would
        # let the thumb gestures rot without any gate ever walking them.
        def drop_j12_rows(spec: dict) -> None:
            for row in spec["paths"]:
                if any(needle in row[0] for needle in (
                    "ui/src/components/layout/", "ui/src/components/sessions/",
                    "ui/src/components/mobile/", "ui/src/pages/TaskDetail",
                    "ui/src/i18n/locales/",
                )):
                    row[1] = [journey for journey in row[1] if journey != "J12"]

        code, out = self.check(self.copy_spec_with(drop_j12_rows))
        self.assertEqual(code, 1, out)
        self.assertIn("paths table", out)
        for file in ("AppShell.tsx", "SessionList.tsx", "SessionRow.tsx", "MobileList.tsx",
                     "TaskDetailPage.tsx", "locales/zh.ts", "locales/en.ts"):
            self.assertIn(file, out)


class WalkJ13ContractTest(unittest.TestCase):
    """KIN-RESULT-002's phone leg: the file link, its two Back stops and the
    preview/source switch must be walked, not photographed.

    The shipped index resolves J13 and prints its `spec ok` line; a body that
    drops the Back after the deep link, or the source switch's consequence, is
    red naming J13; an index without the entry is an error rather than a
    silently retired walk; and the two ``paths`` rows that own the page and the
    locale strings select J13, or a diff there never runs the walk.

    Same shape as WalkJ12ContractTest: the walker's own ``--check-spec`` is the
    reader, so a rule cannot drift between the spec and the gate.
    """

    # The evidence, in the order the phone meets it: the conversation the link
    # starts from, the source file the address names, the list Back leaves the
    # file for, the conversation the second Back reaches, the HTML page, its
    # source, the page again, and the source restored by a reload.
    SCREENS = ["conversation", "file-source", "file-back-list",
               "file-back-conversation", "html-preview", "html-source",
               "html-preview-again", "file-source-again"]

    def setUp(self) -> None:
        self.tmp = tempfile.mkdtemp(prefix="j13-contract-")
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
        spec = load_spec()
        mutate(spec["journeys"]["J13"]["steps"])
        path = os.path.join(self.tmp, "resolved.json")
        with open(path, "w", encoding="utf-8") as fh:
            json.dump(spec, fh)
        return path

    def copy_spec_with(self, mutate) -> str:
        spec = load_spec()
        mutate(spec)
        path = os.path.join(self.tmp, "paths.json")
        with open(path, "w", encoding="utf-8") as fh:
            json.dump(spec, fh)
        return path

    def index_without_j13(self) -> str:
        """A copy of the shipped index with only the J13 entry deleted."""
        shutil.copytree(JOURNEYS_DIR, os.path.join(self.tmp, "journeys"))
        with open(SPEC, encoding="utf-8") as fh:
            index = json.load(fh)
        self.assertIn("J13", index["journeys"],
                      "the shipped index does not register J13")
        del index["journeys"]["J13"]
        path = os.path.join(self.tmp, "journeys.json")
        with open(path, "w", encoding="utf-8") as fh:
            json.dump(index, fh, ensure_ascii=False)
        return path

    @staticmethod
    def at(steps: list, pred, start: int = 0) -> int:
        return next(i for i, step in enumerate(steps) if i >= start and pred(step))

    def test_j13_spec_pins_the_phone_file_deep_link(self) -> None:
        code, out = self.check()
        self.assertEqual(code, 0, out)
        self.assertIn("spec ok: J13", out)
        spec = load_spec()
        journey = spec["journeys"]["J13"]
        steps = journey["steps"]
        # The files panel's phone answer is a page stack; a Mac width would
        # draw the split and walk a different surface.
        self.assertEqual(journey["viewports"], ["phone"])

        # Leg 1 — the cold-start link names the seeded conversation and the
        # seeded source file, and the file is read before Back.
        deep = self.at(steps, lambda step: step[0] == "goto"
                       and "panel=files&file=" in str(step[1])
                       and "{conversation}" in str(step[1]))
        self.assertIn("notes.md", steps[deep][1])
        self.assertEqual(steps[deep][1].count("file=notes.md"), 1)
        back = self.at(steps, lambda step: step[0] == "back", deep + 1)
        self.assertTrue(
            any(step[0] == "wait" and "Seeded for the journey walk" in str(step[1])
                for step in steps[deep:back]),
            "the deep link must be read before Back; a link that only changed the URL proves nothing",
        )

        # Back leaves the file for the list's own address, then a second Back
        # leaves the panel for the conversation. The URL is the evidence, and
        # `url` only sees the pathname: `search` is what names the query.
        url = self.at(steps, lambda step: step[0] == "url", back + 1)
        list_address = self.at(
            steps,
            lambda step: step[0] == "search"
            and "panel=files" in str(step[1])
            and "file=" not in str(step[1]),
            back + 1,
        )
        self.assertLess(back, url)
        self.assertLess(back, list_address)
        # The way out of the list is the panel's own close: a cold deep link's
        # history parent is the session list, not the conversation it was
        # pasted from, so the walk proves the app's exit rather than a second
        # browser Back the product does not promise here.
        close = self.at(
            steps,
            lambda step: step[0] == "click" and "关闭" in str(step[1])
            and "Close" in str(step[1]),
            list_address + 1,
        )
        conversation_url = self.at(
            steps,
            lambda step: step[0] == "url" and "/tasks/" in str(step[1]),
            close + 1,
        )
        clean_address = self.at(
            steps,
            lambda step: step[0] == "search" and str(step[1]).strip() == "^$",
            close + 1,
        )
        panel_gone = self.at(
            steps,
            lambda step: step[0] == "gone" and "data-phone-view" in str(step[1]),
            close + 1,
        )
        self.assertLess(back, close)
        self.assertLess(close, conversation_url)
        self.assertLess(close, clean_address)
        self.assertLess(close, panel_gone)

        # Leg 2 — the self-contained HTML file. The preview is pressed, 源码
        # takes the iframe away and shows the seeded source, and 预览 brings the
        # page back; every press reads its consequence and the address stays on
        # the file (the switch is component state, not history).
        source = self.at(
            steps,
            lambda step: step[0] == "click" and "源码" in str(step[1])
            and "Code" in str(step[1]),
        )
        # The file opens on the page, so the first preview proof is the pressed
        # segment; the preview *press* is the way back from the source.
        pressed_preview = self.at(
            steps,
            lambda step: step[0] == "count" and "aria-pressed" in str(step[1])
            and "预览" in str(step[1]),
        )
        preview = self.at(
            steps,
            lambda step: step[0] == "click" and "预览" in str(step[1])
            and "Preview" in str(step[1]),
            source + 1,
        )
        self.assertLess(pressed_preview, source)
        self.assertLess(source, preview)
        iframe_gone = self.at(
            steps,
            lambda step: step[0] == "gone" and "iframe" in str(step[1]),
            source + 1,
        )
        pressed_source = self.at(
            steps,
            lambda step: step[0] == "count" and "aria-pressed" in str(step[1])
            and "源码" in str(step[1]),
            source + 1,
        )
        source_text = self.at(
            steps,
            lambda step: step[0] == "wait" and "Seed preview page" in str(step[1]),
            source + 1,
        )
        iframe_back = self.at(
            steps,
            lambda step: step[0] in ("wait", "count") and "iframe" in str(step[1]),
            source + 1,
        )
        self.assertLess(pressed_preview, source)
        self.assertLess(source, iframe_gone)
        self.assertLess(source, pressed_source)
        self.assertLess(source, source_text)
        self.assertLess(source, iframe_back)
        self.assertTrue(
            any(step[0] == "search" and "file=" in str(step[1])
                for step in steps[source:preview]),
            "the switch must assert the address stayed on the file",
        )

        # Leg 3 — the URL is the address: reloading it restores the file, not
        # the list (the arrival pulse is the thing a refresh exercises).
        refresh = self.at(
            steps,
            lambda step: step[0] == "goto" and "panel=files&file=" in str(step[1]),
            preview + 1,
        )
        self.assertTrue(
            any(step[0] in ("wait", "count") and "Seeded for the journey walk" in str(step[1])
                for step in steps[refresh + 1:]),
            "the reload leg must read the restored source file",
        )

        # The evidence runs in the order the phone meets it.
        shots = [step[1] for step in steps if step[0] == "shot"]
        self.assertEqual([name for name in shots if name in self.SCREENS], self.SCREENS, shots)

        # `--files` picks journeys from the paths table, first match wins: a
        # page or locale diff that drops J13 would never walk the file panel.
        for row_needle in ("ui/src/pages/TaskDetail", "ui/src/components/workspace/",
                           "ui/src/i18n/locales/"):
            row = next((row for row in spec["paths"] if row_needle in row[0]), None)
            self.assertIsNotNone(row, row_needle)
            self.assertIn("J13", row[1], row_needle)

    def test_j13_contract_rejects_a_body_without_the_back_to_the_list(self) -> None:
        # Browser Back at the deep link is the only proof that the panel's
        # address is a place and not a moment. A body without it still opens
        # the file, so the contract has to name the missing press.
        def drop_the_first_back(steps: list) -> None:
            steps.pop(self.at(steps, lambda step: step[0] == "back"))

        code, out = self.check(self.copy_with(drop_the_first_back))
        self.assertEqual(code, 1, out)
        self.assertIn("spec red: J13", out)
        self.assertIn("Back", out)

    def test_j13_pins_the_system_back_queue(self) -> None:
        """KIN-RESULT-002's history queue is a promise to the system Back.

        The walker's contract is the reader; this pins the evidence in the
        order the phone meets it. Three browser Backs from a cold file link:
        file list, conversation, session list. Then Files, reopened from the
        conversation through the action sheet, must show the list — the file
        the reader left belongs to a history entry, not to the panel's memory.
        Two more Backs close the PR tab's address — the cold `?panel=pr` one
        (after a reload and a Forward) and the in-session press — and each
        must return to the conversation with the query cleared.
        """
        code, out = self.check()
        self.assertEqual(code, 0, out)
        self.assertIn("spec ok: J13", out)
        steps = load_spec()["journeys"]["J13"]["steps"]

        history = [i for i, step in enumerate(steps) if step[0] == "history-back"]
        self.assertEqual(
            len(history), 5,
            "J13 must press the system Back three times on the file queue "
            "and twice from the PR address",
        )
        first, second, third, pr_back, pr_sheet_back = history
        self.assertTrue(
            any(step[0] == "search" and "panel=files" in str(step[1])
                and "file=" not in str(step[1]) for step in steps[first:second]),
            "the first system Back must land on the file list address",
        )
        self.assertTrue(
            any(step[0] == "wait" and "data-phone-view" in str(step[1])
                for step in steps[first:second]),
            "the first system Back must prove the list is the pane on screen",
        )
        self.assertTrue(
            any(step[0] == "gone" and "data-pane" in str(step[1])
                for step in steps[first:second]),
            "the first system Back must prove the viewer left the screen",
        )
        self.assertTrue(
            any(step[0] == "url" and "/tasks/" in str(step[1]) for step in steps[second:third]),
            "the second system Back must land on the conversation",
        )
        self.assertTrue(
            any(step[0] == "search" and str(step[1]) == "^$" for step in steps[second:third]),
            "the second system Back must clear panel/file from the address",
        )
        self.assertTrue(
            any(step[0] == "url" and "sessions" in str(step[1]) for step in steps[third:]),
            "the third system Back must reach the session list",
        )

        # The PR tab's address (R-panel-exit) adds the last two presses. Each
        # must close only the panel: the address returns to the conversation,
        # the query is clean, and the selected PR tab leaves the screen.
        self.assertTrue(
            any(step[0] == "history-forward" for step in steps[pr_back:pr_sheet_back]),
            "Forward must return to the PR address after Back closed the panel",
        )
        for start, end, label in ((pr_back, pr_sheet_back, "the cold PR address"),
                                  (pr_sheet_back, len(steps), "the in-session PR press")):
            window = steps[start + 1:end]
            self.assertTrue(
                any(step[0] == "url" and "/tasks/" in str(step[1]) for step in window),
                f"Back from {label} must land on the conversation",
            )
            self.assertTrue(
                any(step[0] == "search" and str(step[1]) == "^$" for step in window),
                f"Back from {label} must clear the query",
            )
            self.assertTrue(
                any(step[0] == "gone" and "aria-selected" in str(step[1])
                    and "Pull" in str(step[1]) for step in window),
                f"Back from {label} must take the selected PR tab off the screen",
            )

        shots = [step[1] for step in steps if step[0] == "shot"]
        for name in ("history-back-file", "history-back-list", "history-back-conversation",
                     "history-back-sessions", "files-no-replay",
                     "pr-cold", "pr-refresh", "pr-back", "pr-forward", "pr-open",
                     "pr-back-sheet"):
            self.assertIn(name, shots)

        # Files, reopened from the conversation through the action sheet, is
        # the list: a file replayed from the earlier leg fails the pane proof.
        sheet = self.at(steps, lambda step: step[0] == "click"
                        and ("会话操作" in str(step[1]) or "Session actions" in str(step[1])))
        files = self.at(steps, lambda step: step[0] == "click"
                        and ("text-is" in str(step[1]) or "^(文件|Files)$" in str(step[1])),
                        sheet + 1)
        self.assertTrue(
            any(step[0] == "search" and "panel=files" in str(step[1])
                and "file=" not in str(step[1]) for step in steps[files:]),
            "opening Files must name the list address, not a file",
        )
        self.assertTrue(
            any(step[0] == "wait" and "data-phone-view" in str(step[1])
                for step in steps[files:]),
            "opening Files must prove the panel shows the list",
        )
        self.assertTrue(
            any(step[0] == "gone" and "data-pane" in str(step[1]) for step in steps[files:]),
            "opening Files must prove the earlier file did not replay",
        )

    def test_j13_contract_rejects_a_body_without_the_system_back_queue(self) -> None:
        # `back` may press the panel's own Return control; the queue the story
        # promises is what the browser itself pops. Dropping the first
        # `history-back` leaves a walk that never proves the conversation stop.
        def drop_the_first_history_back(steps: list) -> None:
            steps.pop(self.at(steps, lambda step: step[0] == "history-back"))

        code, out = self.check(self.copy_with(drop_the_first_history_back))
        self.assertEqual(code, 1, out)
        self.assertIn("spec red: J13", out)
        self.assertIn("system Back", out)

    def test_j13_contract_rejects_reopening_files_on_the_old_file(self) -> None:
        # A walk that opens Files without reading the pane proves only that the
        # sheet row was delivered; the stale file could still be on screen.
        def drop_the_replay_proof(steps: list) -> None:
            sheet = self.at(steps, lambda step: step[0] == "click"
                            and "会话操作" in str(step[1]))
            files = self.at(steps, lambda step: step[0] == "click"
                            and ("text-is" in str(step[1]) or "^(文件|Files)$" in str(step[1])),
                            sheet + 1)
            gone = self.at(steps, lambda step: step[0] == "gone"
                           and "data-pane" in str(step[1]), files + 1)
            steps.pop(gone)

        code, out = self.check(self.copy_with(drop_the_replay_proof))
        self.assertEqual(code, 1, out)
        self.assertIn("spec red: J13", out)
        self.assertIn("replay", out)

    def test_j13_contract_rejects_the_source_switch_without_its_consequence(self) -> None:
        # Pressing 源码 and moving on proves the click was delivered, not that
        # the page changed. `gone` on the iframe is the consequence.
        def drop_the_iframe_gone(steps: list) -> None:
            steps.pop(self.at(steps, lambda step: step[0] == "gone" and "iframe" in str(step[1])))

        code, out = self.check(self.copy_with(drop_the_iframe_gone))
        self.assertEqual(code, 1, out)
        self.assertIn("spec red: J13", out)
        self.assertIn("iframe", out)

    def test_j13_contract_rejects_an_index_without_the_registration(self) -> None:
        code, out = self.check(self.index_without_j13())
        self.assertEqual(code, 1, out)
        self.assertIn("spec red: J13", out)
        self.assertIn("J13 is not in the spec", out)

    def test_j13_contract_rejects_a_mac_width(self) -> None:
        # The split draws both panes; a walk that claims it covered the phone
        # stack at a Mac width is not the surface KIN-RESULT-002 promises.
        def add_mac(spec: dict) -> None:
            spec["journeys"]["J13"]["viewports"] = ["phone", "mac"]

        code, out = self.check(self.copy_spec_with(add_mac))
        self.assertEqual(code, 1, out)
        self.assertIn("viewports", out)

    def test_j13_contract_requires_the_workspace_and_locale_paths_rows(self) -> None:
        def drop_j13_rows(spec: dict) -> None:
            for row in spec["paths"]:
                if any(needle in row[0] for needle in (
                    "ui/src/pages/TaskDetail", "ui/src/components/workspace/",
                    "ui/src/i18n/locales/",
                )):
                    row[1] = [journey for journey in row[1] if journey != "J13"]

        code, out = self.check(self.copy_spec_with(drop_j13_rows))
        self.assertEqual(code, 1, out)
        self.assertIn("paths table", out)
        self.assertIn("TaskDetailPage.tsx", out)
        self.assertIn("locales/zh.ts", out)
        self.assertIn("locales/en.ts", out)


class WalkJ14ContractTest(unittest.TestCase):
    """KIN-CONTINUE-001's cold start, palette and one list must stay walked.

    #342 added J14 (31 steps) and the composer element tags in J9/J11, seven
    files and not one test: ``--check-spec`` had no J14 case at all, so any of
    those steps could be deleted with every check green and only a browser walk
    would notice. Same shape as WalkJ13ContractTest — the walker's own
    ``--check-spec`` is the reader, so a rule cannot drift between the spec and
    the gate. The Mac cold start must reopen the *last* conversation by its own
    prompt, ⌘K must hold places but no conversation rows, and the phone home
    must draw the device, project and conversation levels of one list.
    """

    # The seeded conversation's own prompt. The generic fake reply is on every
    # seeded conversation, so it cannot prove *which* one the Mac reopened.
    PROMPT = "[seed] change: summarise the three things worth doing today."

    def setUp(self) -> None:
        self.tmp = tempfile.mkdtemp(prefix="j14-contract-")
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
        spec = load_spec()
        mutate(spec["journeys"]["J14"]["steps"])
        path = os.path.join(self.tmp, "resolved.json")
        with open(path, "w", encoding="utf-8") as fh:
            json.dump(spec, fh, ensure_ascii=False)
        return path

    def copy_spec_with(self, mutate) -> str:
        spec = load_spec()
        mutate(spec)
        path = os.path.join(self.tmp, "paths.json")
        with open(path, "w", encoding="utf-8") as fh:
            json.dump(spec, fh, ensure_ascii=False)
        return path

    def index_without_j14(self) -> str:
        """A copy of the shipped index with only the J14 entry deleted."""
        shutil.copytree(JOURNEYS_DIR, os.path.join(self.tmp, "journeys"))
        with open(SPEC, encoding="utf-8") as fh:
            index = json.load(fh)
        self.assertIn("J14", index["journeys"],
                      "the shipped index does not register J14")
        del index["journeys"]["J14"]
        path = os.path.join(self.tmp, "journeys.json")
        with open(path, "w", encoding="utf-8") as fh:
            json.dump(index, fh, ensure_ascii=False)
        return path

    @staticmethod
    def at(steps: list, pred, start: int = 0) -> int:
        return next(i for i, step in enumerate(steps) if i >= start and pred(step))

    def test_shipped_j14_spec_is_ok(self) -> None:
        code, out = self.check()
        self.assertEqual(code, 0, out)
        self.assertIn("spec ok: J14", out)
        journey = load_spec()["journeys"]["J14"]
        self.assertEqual(journey["viewports"], ["mac", "phone"],
                         "J14 is two cold starts: the Mac and the phone")

    def test_j14_without_mac_last_conversation_is_red(self) -> None:
        # A Mac cold start that only reaches *a* conversation is not the story:
        # `goto /` must land on the conversation the reader left, named by its
        # own prompt. Deleting the reload, the address proof or the prompt
        # wait must each redden the spec.
        steps = load_spec()["journeys"]["J14"]["steps"]
        mac = self.at(steps, lambda step: step[0] == "vp" and step[1] == "mac")
        goto_i = self.at(steps, lambda step: step[0] == "goto" and step[1] == "/", mac + 1)
        url_i = self.at(steps, lambda step: step[0] == "url"
                        and str(step[1]).startswith("^/tasks/"), goto_i + 1)
        prompt_i = self.at(steps, lambda step: step[0] == "wait"
                           and self.PROMPT in str(step[1]), goto_i + 1)
        for label, index in (("the mac reload onto /", goto_i),
                             ("the conversation address after it", url_i),
                             ("the last conversation's own prompt", prompt_i)):
            with self.subTest(removed=label):
                code, out = self.check(self.copy_with(lambda steps: steps.pop(index)))
                self.assertEqual(code, 1, out)
                self.assertIn("spec red: J14", out)
                self.assertIn("cold start", out)

    def test_j14_without_palette_zero_rows_is_red(self) -> None:
        # The palette's claim is a zero: places and recipes are there, the
        # conversation list is not. An empty palette would satisfy a zero, so
        # the contract also requires the places row; this test removes each of
        # the two zero counts and expects the gate to name it.
        steps = load_spec()["journeys"]["J14"]["steps"]
        zeroes = [i for i, step in enumerate(steps)
                  if step[0] == "count" and str(step[2]) == "0"
                  and "[role=dialog]" in str(step[1])]
        self.assertEqual(len(zeroes), 2, zeroes)
        for index in zeroes:
            selector = str(steps[index][1])
            with self.subTest(step=index, selector=selector):
                code, out = self.check(self.copy_with(lambda steps: steps.pop(index)))
                self.assertEqual(code, 1, out)
                self.assertIn("spec red: J14", out)
                self.assertIn("palette", out)
                if "[data-session-row]" in selector:
                    self.assertIn("conversation rows", out)
                else:
                    self.assertIn("seeded conversation", out)

    def test_j14_without_phone_three_levels_is_red(self) -> None:
        # One list at three levels: the device heading, the project button and
        # the conversation row, with the seeded row drawn exactly once. Each
        # level is its own proof; deleting any of them must be red.
        steps = load_spec()["journeys"]["J14"]["steps"]
        phone = self.at(steps, lambda step: step[0] == "vp" and step[1] == "phone")
        goto_i = self.at(steps, lambda step: step[0] == "goto" and step[1] == "/", phone + 1)
        # The project level is proved twice now — the heading's project button
        # and the expanded bucket's 工作方式 region both name `[seed] Project
        # Alpha` — so removing either wait alone leaves the level still proved.
        project_waits = [
            i for i, step in enumerate(steps)
            if i > goto_i and step[0] == "wait"
            and "[seed] Project Alpha" in str(step[1])
        ]
        self.assertGreaterEqual(len(project_waits), 2, steps)
        targets = {
            "device heading": [self.at(
                steps, lambda step: step[0] == "wait"
                and ("此设备" in str(step[1]) or "This machine" in str(step[1])), goto_i + 1)],
            "project level": project_waits,
            "session row": [self.at(
                steps, lambda step: step[0] == "wait"
                and "data-session-row" in str(step[1])
                and "Morning planning" in str(step[1]), goto_i + 1)],
            "one-row count": [self.at(
                steps, lambda step: step[0] == "count"
                and "data-session-row" in str(step[1]) and str(step[2]) == "1", goto_i + 1)],
        }
        for label, indices in targets.items():
            with self.subTest(removed=label):
                def drop(steps: list, indices: tuple = tuple(indices)) -> None:
                    for index in sorted(indices, reverse=True):
                        steps.pop(index)

                code, out = self.check(self.copy_with(drop))
                self.assertEqual(code, 1, out)
                self.assertIn("spec red: J14", out)
                self.assertIn("one list", out)

    def test_j14_optional_proof_is_red(self) -> None:
        # A `?`-prefixed step that misses is logged as `skipped`: one optional
        # address, count or wait would leave the walk green while the cold
        # start, the palette's zero or a list level is dead. Only the project
        # fold may be optional (it exists only when the bucket is taller than
        # five rows).
        steps = load_spec()["journeys"]["J14"]["steps"]
        for op in ("wait", "url", "count"):
            index = self.at(steps, lambda step: step[0] == op)

            def make_optional(steps: list) -> None:
                steps[index][1] = "?" + str(steps[index][1]).lstrip("?")

            with self.subTest(op=op, step=index):
                code, out = self.check(self.copy_with(make_optional))
                self.assertEqual(code, 1, out)
                self.assertIn("spec red: J14", out)
                self.assertIn("optional", out)

    def test_index_without_j14_is_red(self) -> None:
        # Registration is the point: deleting the one index entry must be
        # loud, or the cold-start walk can be retired by an edit no gate
        # notices.
        code, out = self.check(self.index_without_j14())
        self.assertEqual(code, 1, out)
        self.assertIn("spec red: J14", out)
        self.assertIn("J14 is not in the spec", out)

    def test_paths_table_selects_j14_for_its_surfaces(self) -> None:
        # `--files` selects the journeys from the paths table, first match
        # wins. A palette, list or conversation diff that drops J14 would let
        # the cold start rot without any gate ever walking it.
        spec = load_spec()
        needles = (
            "ui/src/components/CommandPalette",
            "ui/src/pages/Sessions|ui/src/components/sessions/",
            "ui/src/components/mobile/",
            "ui/src/pages/TaskDetail|ui/src/pages/TaskSession|ui/src/components/chat/"
            "|ui/src/components/task/|ui/src/components/cards/|ui/src/components/workspace/",
        )
        for needle in needles:
            row = next((row for row in spec["paths"] if row[0] == needle), None)
            self.assertIsNotNone(row, needle)
            self.assertIn("J14", row[1], needle)
        for needle in needles[:3]:
            def drop_j14(spec: dict, needle: str = needle) -> None:
                row = next(row for row in spec["paths"] if row[0] == needle)
                row[1] = [journey for journey in row[1] if journey != "J14"]

            with self.subTest(row=needle):
                code, out = self.check(self.copy_spec_with(drop_j14))
                self.assertEqual(code, 1, out)
                self.assertIn("paths table", out)
                self.assertIn("J14", out)


class WalkJ1ContractTest(unittest.TestCase):
    """J1's phone leg: search, filter and two real decisions must stay walked.

    #359 pinned J14 and the J9/J11 composer tags but left J1 and J6 with no
    ``--check-spec`` case, so any of their shipped steps could be deleted with
    every check green and only a browser walk would notice. Same shape as
    WalkJ14ContractTest: the walker's own ``--check-spec`` is the reader, so a
    rule cannot drift between the spec and the gate. The list must be searched
    and filtered, then one card approved and a different one denied, with each
    answer's control read off the screen.
    """

    def setUp(self) -> None:
        self.tmp = tempfile.mkdtemp(prefix="j1-contract-")
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
        spec = load_spec()
        mutate(spec["journeys"]["J1"]["steps"])
        path = os.path.join(self.tmp, "resolved.json")
        with open(path, "w", encoding="utf-8") as fh:
            json.dump(spec, fh, ensure_ascii=False)
        return path

    def copy_spec_with(self, mutate) -> str:
        spec = load_spec()
        mutate(spec)
        path = os.path.join(self.tmp, "paths.json")
        with open(path, "w", encoding="utf-8") as fh:
            json.dump(spec, fh, ensure_ascii=False)
        return path

    def index_without_j1(self) -> str:
        """A copy of the shipped index with only the J1 entry deleted."""
        shutil.copytree(JOURNEYS_DIR, os.path.join(self.tmp, "journeys"))
        with open(SPEC, encoding="utf-8") as fh:
            index = json.load(fh)
        self.assertIn("J1", index["journeys"],
                      "the shipped index does not register J1")
        del index["journeys"]["J1"]
        path = os.path.join(self.tmp, "journeys.json")
        with open(path, "w", encoding="utf-8") as fh:
            json.dump(index, fh, ensure_ascii=False)
        return path

    @staticmethod
    def at(steps: list, pred, start: int = 0) -> int:
        return next(i for i, step in enumerate(steps) if i >= start and pred(step))

    @staticmethod
    def control(step: list, zh: str, en: str) -> bool:
        return step[0] in ("click", "gone") and (zh in str(step[1]) or en in str(step[1]))

    def test_shipped_j1_spec_is_ok(self) -> None:
        code, out = self.check()
        self.assertEqual(code, 0, out)
        self.assertIn("spec ok: J1 ", out)
        journey = load_spec()["journeys"]["J1"]
        self.assertEqual(journey["viewports"], ["phone"],
                         "J1 is the phone approve/deny proof")

    def test_j1_without_the_approve_proof_is_red(self) -> None:
        # The approve leg is a landing, a press and a consequence. Deleting the
        # click leaves the card unanswered; deleting the ``gone`` leaves a card
        # that may still be showing Approve after the walk says it decided.
        steps = load_spec()["journeys"]["J1"]["steps"]
        indexes = [i for i, step in enumerate(steps)
                   if self.control(step, "批准", "Approve")]
        self.assertEqual(len(indexes), 2, indexes)
        for label, index in (("the approve click", indexes[0]),
                             ("the approve gone", indexes[1])):
            with self.subTest(removed=label):
                code, out = self.check(self.copy_with(lambda steps: steps.pop(index)))
                self.assertEqual(code, 1, out)
                self.assertIn("spec red: J1", out)
                self.assertIn("approve", out)

    def test_j1_approve_gone_on_the_deny_card_is_red(self) -> None:
        # The approve ``gone`` must be read on the card it approved. Moving it
        # past the deny landing still finds no approve control there — the
        # deny card never had one — so the proof would pass without proving
        # the approved card changed.
        steps = load_spec()["journeys"]["J1"]["steps"]
        gone = self.at(steps, lambda step: step[0] == "gone"
                       and ("批准" in str(step[1]) or "Approve" in str(step[1])))
        deny = self.at(steps, lambda step: step[0] == "goto"
                       and "{deny.conversation}" in str(step[1]))

        def move_gone(steps: list) -> None:
            moved = steps.pop(gone)
            steps.insert(deny, moved)

        code, out = self.check(self.copy_with(move_gone))
        self.assertEqual(code, 1, out)
        self.assertIn("spec red: J1", out)
        self.assertIn("approve", out)

    def test_j1_without_the_deny_proof_is_red(self) -> None:
        # The deny leg is the second decision; an approve-only walk proves one
        # answer is possible, not that a card can be refused.
        steps = load_spec()["journeys"]["J1"]["steps"]
        indexes = [i for i, step in enumerate(steps)
                   if self.control(step, "拒绝", "Deny")]
        self.assertEqual(len(indexes), 2, indexes)
        for label, index in (("the deny click", indexes[0]),
                             ("the deny gone", indexes[1])):
            with self.subTest(removed=label):
                code, out = self.check(self.copy_with(lambda steps: steps.pop(index)))
                self.assertEqual(code, 1, out)
                self.assertIn("spec red: J1", out)
                self.assertIn("deny", out)

    def test_j1_deep_links_name_two_conversations(self) -> None:
        # Two decisions, two cards. A copy-paste that points both deep links at
        # one conversation approves and denies the same card, and the second
        # press lands on something already answered.
        steps = load_spec()["journeys"]["J1"]["steps"]
        approve = self.at(steps, lambda step: step[0] == "goto"
                          and "{approve.conversation}" in str(step[1]))
        deny = self.at(steps, lambda step: step[0] == "goto"
                       and "{deny.conversation}" in str(step[1]))

        def reuse_approve(steps: list) -> None:
            steps[deny][1] = str(steps[deny][1]).replace(
                "{deny.conversation}", "{approve.conversation}")

        def swap_focuses(steps: list) -> None:
            steps[approve][1] = str(steps[approve][1]).replace(
                "{approve.focus}", "{deny.focus}")
            steps[deny][1] = str(steps[deny][1]).replace(
                "{deny.focus}", "{approve.focus}")

        def deny_first(steps: list) -> None:
            steps.insert(approve, steps.pop(deny))

        for label, mutate in (
            ("the deny link reusing the approve conversation", reuse_approve),
            ("the deny link reusing the approve focus", swap_focuses),
            ("the deny leg moved before the approve leg", deny_first),
        ):
            with self.subTest(mutation=label):
                code, out = self.check(self.copy_with(mutate))
                self.assertEqual(code, 1, out)
                self.assertIn("spec red: J1", out)
                self.assertIn("conversation", out)

    def test_j1_without_the_search_leg_is_red(self) -> None:
        # Finding last week's chat is the leg's premise: the list is searched,
        # the filter sheet opened and escaped before either decision. Deleting
        # any of the three leaves the walk starting on a card, not on the list
        # a person actually uses.
        steps = load_spec()["journeys"]["J1"]["steps"]
        search = self.at(steps, lambda step: step[0] == "fill"
                         and "input[type=search]" in str(step[1]))
        filters = self.at(steps, lambda step: step[0] == "click"
                          and ("筛选" in str(step[1]) or "Filter" in str(step[1])))
        escape = self.at(steps, lambda step: step[0] == "key" and step[1] == "Escape")
        for label, index in (("the search fill", search),
                             ("the filter click", filters),
                             ("the Escape", escape)):
            with self.subTest(removed=label):
                code, out = self.check(self.copy_with(lambda steps: steps.pop(index)))
                self.assertEqual(code, 1, out)
                self.assertIn("spec red: J1", out)
                self.assertIn("search", out)

    def test_j1_optional_proof_is_red(self) -> None:
        # A `?`-prefixed proof that misses is logged as `skipped`: one optional
        # `gone` after an answer would leave the walk green while the card was
        # never decided. Only the search fill and the filter click may be
        # optional setup.
        steps = load_spec()["journeys"]["J1"]["steps"]
        indexes = [i for i, step in enumerate(steps) if step[0] == "gone"]
        self.assertEqual(len(indexes), 2, indexes)
        for index in indexes:
            def make_optional(steps: list, index: int = index) -> None:
                steps[index][1] = "?" + str(steps[index][1]).lstrip("?")

            with self.subTest(step=index):
                code, out = self.check(self.copy_with(make_optional))
                self.assertEqual(code, 1, out)
                self.assertIn("spec red: J1", out)
                self.assertIn("optional", out)

    def test_j1_mac_only_step_is_red(self) -> None:
        # The leg is phone-only: a hover is a mouse input the surface does not
        # have and Meta+k is the desktop palette chord.
        steps = load_spec()["journeys"]["J1"]["steps"]
        first_task = self.at(steps, lambda step: step[0] == "goto"
                             and "/tasks/" in str(step[1]))
        for label, step in (("a hover", ["hover", "css=button"]),
                            ("the palette chord", ["key", "Meta+k"])):
            def insert(steps: list, step: list = step) -> None:
                steps.insert(first_task, list(step))

            with self.subTest(added=label):
                code, out = self.check(self.copy_with(insert))
                self.assertEqual(code, 1, out)
                self.assertIn("spec red: J1", out)
                self.assertIn("Mac-only", out)

    def test_index_without_j1_is_red(self) -> None:
        # Registration is the point: deleting the one index entry must be
        # loud, or the phone's search/approve/deny walk can be retired by an
        # edit no gate notices.
        code, out = self.check(self.index_without_j1())
        self.assertEqual(code, 1, out)
        self.assertIn("spec red: J1", out)
        self.assertIn("J1 is not in the spec", out)

    def test_paths_table_selects_j1_for_its_surfaces(self) -> None:
        # `--files` selects the journeys from the paths table, first match
        # wins. A list or conversation diff that drops J1 would let the phone's
        # decisions rot without the gate ever walking them.
        spec = load_spec()
        needles = (
            "ui/src/pages/Sessions|ui/src/components/sessions/",
            "ui/src/components/mobile/",
            "ui/src/pages/TaskDetail|ui/src/pages/TaskSession|ui/src/components/chat/"
            "|ui/src/components/task/|ui/src/components/cards/|ui/src/components/workspace/",
        )
        for needle in needles:
            row = next((row for row in spec["paths"] if row[0] == needle), None)
            self.assertIsNotNone(row, needle)
            self.assertIn("J1", row[1], needle)
        for needle in needles:
            def drop_j1(spec: dict, needle: str = needle) -> None:
                row = next(row for row in spec["paths"] if row[0] == needle)
                row[1] = [journey for journey in row[1] if journey != "J1"]

            with self.subTest(row=needle):
                code, out = self.check(self.copy_spec_with(drop_j1))
                self.assertEqual(code, 1, out)
                self.assertIn("paths table", out)
                self.assertIn("J1", out)


class WalkJ6ContractTest(unittest.TestCase):
    """J6's settings leg: change the default agent, host it, then restore it.

    #359 pinned J14 but left J6 with no ``--check-spec`` case, so the settings
    chain — four surfaces in order, the default row read in both locales, both
    agents counted in the picker, the pick, the save, the reload that proves
    persistence, the new chat that hosts Codex, and the restore — could lose
    any step with the gate green. Same shape as WalkJ14ContractTest: the
    walker's own ``--check-spec`` is the reader.
    """

    SURFACES = ("/settings", "/settings?tab=operations", "/agents",
                "/settings?tab=providers")

    def setUp(self) -> None:
        self.tmp = tempfile.mkdtemp(prefix="j6-contract-")
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
        spec = load_spec()
        mutate(spec["journeys"]["J6"]["steps"])
        path = os.path.join(self.tmp, "resolved.json")
        with open(path, "w", encoding="utf-8") as fh:
            json.dump(spec, fh, ensure_ascii=False)
        return path

    def copy_spec_with(self, mutate) -> str:
        spec = load_spec()
        mutate(spec)
        path = os.path.join(self.tmp, "paths.json")
        with open(path, "w", encoding="utf-8") as fh:
            json.dump(spec, fh, ensure_ascii=False)
        return path

    def index_without_j6(self) -> str:
        """A copy of the shipped index with only the J6 entry deleted."""
        shutil.copytree(JOURNEYS_DIR, os.path.join(self.tmp, "journeys"))
        with open(SPEC, encoding="utf-8") as fh:
            index = json.load(fh)
        self.assertIn("J6", index["journeys"],
                      "the shipped index does not register J6")
        del index["journeys"]["J6"]
        path = os.path.join(self.tmp, "journeys.json")
        with open(path, "w", encoding="utf-8") as fh:
            json.dump(index, fh, ensure_ascii=False)
        return path

    @staticmethod
    def at(steps: list, pred, start: int = 0) -> int:
        return next(i for i, step in enumerate(steps) if i >= start and pred(step))

    @staticmethod
    def is_save(step: list) -> bool:
        return step[0] == "click" and (
            "保存默认 agent" in str(step[1]) or "Save default agent" in str(step[1]))

    @staticmethod
    def is_saved_status(step: list) -> bool:
        return step[0] == "wait" and "status" in str(step[1]) and (
            "已保存" in str(step[1]) or "Saved" in str(step[1]))

    def test_shipped_j6_spec_is_ok(self) -> None:
        code, out = self.check()
        self.assertEqual(code, 0, out)
        self.assertIn("spec ok: J6 ", out)
        journey = load_spec()["journeys"]["J6"]
        self.assertEqual(journey["viewports"], ["phone", "mac"],
                         "J6 changes and reads the default at both widths")

    def test_j6_without_the_saved_default_is_red(self) -> None:
        # The pick, the save and the status are three separate proofs: an
        # option press that never moves the trigger, a save nobody pressed and
        # a status nobody read all leave "the default changed" unproven.
        steps = load_spec()["journeys"]["J6"]["steps"]
        picker = self.at(steps, lambda step: step[0] == "click"
                         and "(codex)" in str(step[1]))
        save = self.at(steps, self.is_save)
        status = self.at(steps, self.is_saved_status)
        for label, index in (("the codex picker option", picker),
                             ("the save button", save),
                             ("the saved status", status)):
            with self.subTest(removed=label):
                code, out = self.check(self.copy_with(lambda steps: steps.pop(index)))
                self.assertEqual(code, 1, out)
                self.assertIn("spec red: J6", out)

    def test_j6_counts_before_the_picker_is_open_is_red(self) -> None:
        # The counts read the open list. Moving them before the trigger press
        # leaves the walk counting nothing visible while ``--check-spec``
        # stays green; the contract must keep the counts after the picker
        # opens.
        steps = load_spec()["journeys"]["J6"]["steps"]
        open_at = self.at(steps, lambda step: step[0] == "click"
                          and "aria-describedby" in str(step[1]))
        counts = [i for i, step in enumerate(steps)
                  if step[0] == "count" and ("(claude-code)" in str(step[1])
                                             or "(codex)" in str(step[1]))]
        self.assertEqual(len(counts), 2, counts)

        def move_counts(steps: list) -> None:
            for index in sorted(counts, reverse=True):
                steps.insert(open_at, steps.pop(index))

        code, out = self.check(self.copy_with(move_counts))
        self.assertEqual(code, 1, out)
        self.assertIn("spec red: J6", out)
        self.assertIn("picker", out)

    def test_j6_without_the_reload_persistence_is_red(self) -> None:
        # A default that only lives in the page that saved it is not
        # persisted. The reload and its trigger read are the proof; deleting
        # either must be red and name the persistence rule.
        steps = load_spec()["journeys"]["J6"]["steps"]
        status = self.at(steps, self.is_saved_status)
        reload_i = self.at(steps, lambda step: step[0] == "goto"
                           and "/settings?tab=providers" in str(step[1]), status + 1)
        trigger_i = self.at(steps, lambda step: step[0] == "wait"
                            and "(codex)" in str(step[1]), reload_i + 1)
        new_i = self.at(steps, lambda step: step[0] == "goto" and step[1] == "/new",
                        trigger_i + 1)
        self.assertLess(trigger_i, new_i,
                        "the reload proof must precede the new chat")
        for label, index in (("the reload", reload_i),
                             ("the trigger after the reload", trigger_i)):
            with self.subTest(removed=label):
                code, out = self.check(self.copy_with(lambda steps: steps.pop(index)))
                self.assertEqual(code, 1, out)
                self.assertIn("spec red: J6", out)
                self.assertTrue("persist" in out or "reload" in out, out)

    def test_j6_without_the_next_chat_hosting_is_red(self) -> None:
        # The point of changing the default is the next new chat: a walk that
        # saves and never opens one proves the row moved, not the behaviour.
        steps = load_spec()["journeys"]["J6"]["steps"]
        new_i = self.at(steps, lambda step: step[0] == "goto" and step[1] == "/new")
        host_i = self.at(steps, lambda step: step[0] == "wait"
                         and "Codex" in str(step[1]), new_i + 1)
        code, out = self.check(self.copy_with(lambda steps: steps.pop(host_i)))
        self.assertEqual(code, 1, out)
        self.assertIn("spec red: J6", out)
        self.assertIn("host", out)

    def test_j6_without_the_restore_is_red(self) -> None:
        # The leg must leave the daemon as it found it: the shipped default is
        # claude-code, and a walk that ends hosting Codex poisons every later
        # journey against the same daemon.
        steps = load_spec()["journeys"]["J6"]["steps"]
        saves = [i for i, step in enumerate(steps) if self.is_save(step)]
        statuses = [i for i, step in enumerate(steps) if self.is_saved_status(step)]
        self.assertEqual(len(saves), 2, saves)
        self.assertEqual(len(statuses), 2, statuses)
        final = self.at(steps, lambda step: step[0] == "wait"
                        and "Claude Code" in str(step[1]))
        for label, index in (("the restore save", saves[1]),
                             ("the restore status", statuses[1]),
                             ("the restored new-chat read", final)):
            with self.subTest(removed=label):
                code, out = self.check(self.copy_with(lambda steps: steps.pop(index)))
                self.assertEqual(code, 1, out)
                self.assertIn("spec red: J6", out)
                self.assertIn("restore", out)

    def test_j6_optional_step_is_red(self) -> None:
        # A `?`-prefixed step that misses is logged as `skipped`. J6 has no
        # optional step at all: every address, count, wait and click is a
        # proof, and a skipped one leaves the default unproven.
        steps = load_spec()["journeys"]["J6"]["steps"]
        for op in ("wait", "goto"):
            index = self.at(steps, lambda step: step[0] == op)

            def make_optional(steps: list, index: int = index) -> None:
                steps[index][1] = "?" + str(steps[index][1]).lstrip("?")

            with self.subTest(op=op, step=index):
                code, out = self.check(self.copy_with(make_optional))
                self.assertEqual(code, 1, out)
                self.assertIn("spec red: J6", out)
                self.assertIn("optional", out)

    def test_j6_without_the_settings_surfaces_is_red(self) -> None:
        # The chain is four addresses in order: 设置 → 运维 → the legacy
        # /agents redirect → providers. Losing one leaves the route that hosts
        # the default row unproven.
        steps = load_spec()["journeys"]["J6"]["steps"]
        for surface in self.SURFACES:
            index = self.at(steps, lambda step, surface=surface: step[0] == "goto"
                            and step[1] == surface)
            with self.subTest(surface=surface):
                code, out = self.check(self.copy_with(lambda steps: steps.pop(index)))
                self.assertEqual(code, 1, out)
                self.assertIn("spec red: J6", out)
                self.assertIn("settings surfaces", out)

    def test_index_without_j6_is_red(self) -> None:
        # Registration is the point: deleting the one index entry must be
        # loud, or the settings walk can be retired by an edit no gate notices.
        code, out = self.check(self.index_without_j6())
        self.assertEqual(code, 1, out)
        self.assertIn("spec red: J6", out)
        self.assertIn("J6 is not in the spec", out)

    def test_paths_table_selects_j6_for_settings(self) -> None:
        # `--files` selects the journeys from the paths table, first match
        # wins. A settings diff that drops J6 would let the default-agent walk
        # rot without the gate ever walking it.
        needle = "ui/src/pages/Settings|ui/src/pages/Agents|ui/src/components/settings/"
        spec = load_spec()
        row = next((row for row in spec["paths"] if row[0] == needle), None)
        self.assertIsNotNone(row, needle)
        self.assertIn("J6", row[1], needle)

        def drop_j6(spec: dict) -> None:
            row = next(row for row in spec["paths"] if row[0] == needle)
            row[1] = [journey for journey in row[1] if journey != "J6"]

        code, out = self.check(self.copy_spec_with(drop_j6))
        self.assertEqual(code, 1, out)
        self.assertIn("paths table", out)
        self.assertIn("J6", out)


class WalkJ5ContractTest(unittest.TestCase):
    """J5 must read the row menu it opens, not only photograph it.

    KIN-MANAGE-001: the walk opens the running row's own menu and asserts the
    shipped 改名 / Rename, 置顶 / Pin, 归档 / Archive and 删除 / Delete items
    plus one disabled 运行中 / Running status line, at 390 and 1100.

    A menu that quietly lost 改名, or a 运行中 line that became pressable, ships
    green today: the walk hovers a row, clicks the trigger and stops. The
    checked-in spec must open the *running* row's menu (the only one with a
    status line) and assert the shipped contents in both languages at both
    viewports. Each rule is broken in a copy below, so the gate fails before a
    browser starts.
    """

    def setUp(self) -> None:
        self.tmp = tempfile.mkdtemp(prefix="j5-contract-")
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
        spec = load_spec()
        mutate(spec["journeys"]["J5"]["steps"])
        path = os.path.join(self.tmp, "journeys.json")
        with open(path, "w", encoding="utf-8") as fh:
            json.dump(spec, fh)
        return path

    @staticmethod
    def at(steps: list, pred, start: int = 0) -> int:
        return next(i for i, step in enumerate(steps) if i >= start and pred(step))

    def test_j5_spec_pins_the_row_menu(self) -> None:
        code, out = self.check()
        self.assertEqual(code, 0, out)
        self.assertIn("spec ok: J5 ", out)
        journey = load_spec()["journeys"]["J5"]
        self.assertEqual(journey["viewports"], ["phone", "mac"])
        steps = journey["steps"]

        # The running row's own trigger: a menu opened on whichever row is
        # first has no 运行中 line to pin. aria-describedby is the trigger's
        # existing accessible description, not new scaffolding.
        clicks = [step for step in steps if step[0] == "click"]
        self.assertEqual(len(clicks), 2, steps)
        # The list folds projects now: Gamma's bucket is expanded first, and
        # that press is optional because a bucket holding the newest row is
        # already open. Only the fold may be optional.
        expand, trigger = clicks
        self.assertTrue(expand[1].startswith("?"), "the project-expand press must be optional")
        self.assertIn("[seed] Project Gamma", expand[1])
        self.assertIn("展开项目", expand[1])
        self.assertIn("Expand project", expand[1])
        self.assertFalse(trigger[1].startswith("?"), "the row-menu click is optional")
        self.assertIn("[data-row-actions]", trigger[1])
        self.assertIn("{j5.conversation}", trigger[1])

        # The shipped actions, in both languages, as required steps.
        for zh, en in (("改名", "Rename"), ("置顶", "Pin"), ("归档", "Archive"), ("删除", "Delete")):
            hits = [
                step
                for step in steps
                if step[0] in ("wait", "count")
                and not str(step[1]).startswith("?")
                and zh in str(step[1])
                and en in str(step[1])
            ]
            self.assertTrue(hits, f"J5 never asserts {zh} / {en}: {steps}")

        # The status line: present AND disabled, pinned by one visible element
        # carrying the label and either disabled marker (Mac aria-disabled,
        # phone native disabled). A wait alone would pass on an enabled item.
        counts = [step for step in steps if step[0] == "count" and "运行中" in str(step[1])]
        self.assertEqual(len(counts), 1, steps)
        self.assertIn("Running", counts[0][1])
        self.assertEqual(counts[0][2], "1")
        self.assertIn("aria-disabled", counts[0][1])
        self.assertIn("[disabled]", counts[0][1])

        # The photograph is of a menu that was read, not one that might be.
        running_at = steps.index(counts[0])
        self.assertGreater(running_at, steps.index(trigger))
        shot_at = steps.index(next(step for step in steps if step[0] == "shot" and step[1] == "row-actions"))
        self.assertGreater(shot_at, running_at)

    def test_j5_contract_rejects_a_menu_without_the_rename_item(self) -> None:
        def drop_the_rename(steps: list) -> None:
            steps.pop(self.at(steps, lambda step: step[0] == "wait" and "改名" in str(step[1])))

        code, out = self.check(self.copy_with(drop_the_rename))
        self.assertEqual(code, 1, out)
        self.assertIn("rename", out)

    def test_j5_contract_rejects_a_running_line_that_is_only_present(self) -> None:
        # Flipping the disabled assertion to a plain presence wait is the
        # regression: the label stays, a pressable status item ships.
        def enable_the_running_line(steps: list) -> None:
            at = self.at(steps, lambda step: step[0] == "count" and "运行中" in str(step[1]))
            steps[at] = ["wait", "css=[role=menuitem]:has-text('运行中'), button:has-text('运行中')"]

        code, out = self.check(self.copy_with(enable_the_running_line))
        self.assertEqual(code, 1, out)
        self.assertIn("运行中", out)
        self.assertIn("disabled", out)

    def test_j5_contract_rejects_a_viewport_scoped_menu(self) -> None:
        # A `vp` scope would leave one width's menu unread while the walk still
        # reports green.
        def scope_to_mac(steps: list) -> None:
            steps.insert(0, ["vp", "mac"])

        code, out = self.check(self.copy_with(scope_to_mac))
        self.assertEqual(code, 1, out)
        self.assertIn("scopes steps to one viewport", out)


# The folder editor's visible labels, both locales. The walk reads the cover
# the way a person does, so every control is named by what it says.
J4_EDIT = "编辑"
J4_EDIT_EN = "Edit folders"
J4_DEFAULT = "设为默认"
J4_DEFAULT_EN = "Make default"
J4_SAVE = "保存"
J4_SAVE_EN = "Save folders"
# KIN-CONTRACT-001: the collection is gone, so the cover opens from the
# conversation list's project heading. The collapse chevron beside it also
# carries the project name, but it is the aria-expanded one.
#
# The press lands on the heading's leading folder icon, not on the button's
# own centre. A fine pointer floats five 24 px project buttons over the row's
# tail (`SessionList.tsx`, `pointer-events-none` until the row is hovered); the
# heading is `flex-1`, so its box runs under that strip. Hovering the row opens
# the strip, and a centre-of-the-element press then meets the strip's first
# button (+ new session in this project) in Playwright's hit test: Playwright
# retries that hit test, never dispatches, and the 3000 ms click budget
# (walk.mjs:4241) expires. Measured, not theorised:
# state/shots/delete-pagesb2b holds "locator.click: Timeout 3000ms exceeded" at
# every J4 heading press, and the shot after the first press
# (`J4-mac-02-project-cover.png`) stays on /sessions with the strip open over
# the truncated title — nothing was dispatched, so nothing navigated. The
# element itself was present: walk.mjs:4202-4203 hard-fails a missing required
# locator instantly with its own `missing required` message, and no
# `missing required` line names the project heading in that walk. The icon's
# centre is far left of the strip, and the
# click still bubbles to the heading's own handler, which is the control a
# person sees.
J4_PROJECTS = ("Alpha", "Beta", "Gamma")
J4_ALPHA_LINK = "css=button[aria-label*='Project Alpha']:not([aria-expanded]) svg"
# A `goto` is a fresh document load; `/projects` redirects to the list now, so
# either path proves the cover re-read the store rather than React state.
J4_LIST_PATHS = ("/projects", "/sessions")


def j4_is_reload(step: list) -> bool:
    return step[0] == "goto" and str(step[1]).rstrip("/") in J4_LIST_PATHS
# The two verbs the story is made of, and the inline confirmation they meet.
J4_ADD = "添加目录"
J4_ADD_EN = "Add folder"
J4_REMOVE = "移除"
J4_REMOVE_EN = "Remove"
J4_CONFIRM = (
    "[role=dialog] [role=group][aria-label^='移除'], "
    "[role=dialog] [role=group][aria-label^='Remove']"
)
J4_PICKER_INPUT = "input[list='kin-cwd-suggestions']"


def j4_contract_problems(steps: list) -> list[str]:
    """Everything J4 must carry: the folder-editor leg and the instructions leg."""
    return (
        _j4_roots_problems(steps)
        + j4_roots_verbs_problems(steps)
        + j4_instructions_problems(steps)
    )


def j4_instructions_problems(steps: list) -> list[str]:
    """What J4 must carry to prove the cover and the agent get the same text.

    KIN-PROJECT-003. The cover's 工作方式 block is read-only and the injected
    digest is deliberately not user text in the transcript, so the leg reads
    the block, presses the launcher, reads the pre-filled composer, sends, and
    then reads the agent's own receipt inside the transcript. It edits
    ONE_PAGER.md through the one `api` PUT, re-reads the cover, reopens the
    earlier conversation, starts a new one, and finally compares the 400-rune
    cut for a section longer than the bound. Returns the problems; empty means
    the leg holds.
    """
    problems: list[str] = []
    old_line = journeys_seed.ALPHA_INSTRUCTIONS
    new_line = journeys_seed.ALPHA_INSTRUCTIONS_EDITED
    # The transcript renders a received bullet as a markdown list item, so the
    # marker is structure there, not text; the cover shows the raw file. The
    # same line therefore needs two needles, one per rendering.
    old_text = old_line[2:] if old_line.startswith("- ") else old_line
    new_text = new_line[2:] if new_line.startswith("- ") else new_line
    gamma_cut = journeys_seed.GAMMA_INSTRUCTIONS[:400] + "…"
    # The distinctive phrase straddling rune 400, as both surfaces render it.
    cut_needle = gamma_cut[-13:]
    if not cut_needle.endswith("…"):
        problems.append("the Gamma fixture's cut does not end inside a known phrase; the walk has no boundary needle")
    tail = journeys_seed.GAMMA_SENTINEL
    prompt = shipped_instructions_prompt()
    if not prompt or "ONE_PAGER.md" not in prompt:
        problems.append("ui/src/i18n/locales/zh.ts has no instructionsPrompt naming ONE_PAGER.md; the prefill assertion cannot be pinned")

    def at(pred, start: int = 0) -> int:
        for index in range(start, len(steps)):
            if pred(steps[index]):
                return index
        return -1

    def required(step: list) -> bool:
        return isinstance(step, list) and len(step) > 1 and not str(step[1]).startswith("?")

    def css_wait(step: list, needle: str) -> bool:
        return (
            isinstance(step, list)
            and step[:1] == ["wait"]
            and str(step[1]).startswith("css=")
            and needle in str(step[1])
        )

    def transcript_wait(step: list, needle: str) -> bool:
        return css_wait(step, needle) and "[role=region" in str(step[1])

    def section_wait(step: list, needle: str) -> bool:
        return (
            css_wait(step, needle)
            and "工作方式" in str(step[1])
            and "How to work here" in str(step[1])
        )

    def send_at(start: int) -> int:
        return at(lambda step: step[0] == "send" and required(step), start)

    # The launcher, in both locales, and the pre-filled composer it produces.
    launcher = at(
        lambda step: step[0] == "click"
        and required(step)
        and "让 Kin 改…" in str(step[1])
        and "Ask Kin to edit…" in str(step[1])
    )
    if launcher < 0:
        problems.append("J4 never presses the cover launcher (让 Kin 改… / Ask Kin to edit…); the pre-filled path is unwalked")
    prefill = at(
        lambda step: step[0] == "value"
        and str(step[1]) == "textarea"
        and prompt
        and str(step[2]) == prompt,
        max(launcher, 0) + 1,
    )
    if prefill < 0:
        problems.append(
            "J4 never asserts the pre-filled composer (value textarea <projects.instructionsPrompt>) after the launcher"
        )
    elif "ONE_PAGER.md" not in str(steps[prefill][2]):
        problems.append("the prefill assertion does not name ONE_PAGER.md; it could pass on unrelated text")
    first_send = send_at(max(launcher, 0) + 1)
    if first_send < 0:
        problems.append("J4 never sends the pre-filled prompt")
    elif prefill < 0 or prefill > first_send:
        problems.append("J4 sends before it asserts the composer prefill")

    # The agent's receipt, scoped to the transcript. A bare text= wait would
    # pass on the cover or the header and prove nothing about what it received.
    # The FIRST receipt read after the send is the one that belongs to the
    # first chat; a later one (the second chat's) cannot stand in for it.
    first_receipt = at(
        lambda step: step[0] == "wait" and "Project instructions received:" in str(step[1]),
        max(first_send, 0) + 1,
    )
    if first_receipt < 0:
        problems.append("J4 never waits for the agent's receipt after the first send (Project instructions received:)")
    elif "[role=region" not in str(steps[first_receipt][1]):
        problems.append("the first chat's receipt wait is not scoped to the transcript; the cover could satisfy it")
    echo_line = at(
        lambda step: transcript_wait(step, old_text), max(first_receipt, 0) + 1
    )
    if first_receipt < 0 or echo_line < 0:
        problems.append("J4 never reads the received 工作方式 line inside the transcript")

    # The edit is the one api op: a PUT to the shipped one-pager route, after
    # the first send (a PUT before it would edit the text the first chat was
    # supposed to receive) and before the post-edit cover read.
    def is_api(step: list) -> bool:
        return (
            isinstance(step, list)
            and step[:2] == ["api", "PUT"]
            and str(step[2]) == "/api/projects/{project}/one-pager"
            and len(step) > 3
            and isinstance(step[3], str)
        )

    api_steps = [index for index, step in enumerate(steps) if isinstance(step, list) and step[:1] == ["api"]]
    edit = at(is_api, max(first_send, 0) + 1)
    if edit < 0:
        problems.append("J4 never edits ONE_PAGER.md through the api PUT after the first send")
    elif steps[edit][3] != journeys_seed.FOCUS_MARKDOWN_EDITED or new_line not in steps[edit][3]:
        problems.append("the J4 edit PUT does not carry the seeded edited document byte for byte")
    if first_send >= 0 and any(index < first_send for index in api_steps):
        problems.append("J4 runs an api step before the first send; the fixture must be edited mid-walk, not before it")
    if echo_line >= 0 and edit >= 0 and echo_line > edit:
        problems.append("J4 reads the first chat's receipt only after the file is edited; that text proves nothing about what the first chat received")
    post_edit = at(lambda step: section_wait(step, new_line), max(edit, 0) + 1)
    # The first cover read after the edit is the proof that the page re-read the
    # file; a later repeat (the second launcher flow reads the cover too) cannot
    # stand in for the read the edit is supposed to have changed.
    leave_cover = at(
        lambda step: step[0] == "click"
        and required(step)
        and "data-session-row" in str(step[1]),
        max(edit, 0) + 1,
    )
    if post_edit < 0 or (leave_cover >= 0 and post_edit > leave_cover):
        problems.append("J4 never re-reads the cover after the edit (a 工作方式 wait naming the new line)")
    elif edit > post_edit:
        problems.append("J4 asserts the edited cover before it edits the file")
    old_gone = at(
        lambda step: step[0] == "count"
        and str(step[1]) == "text=" + old_line
        and str(step[2]) == "0",
        max(post_edit, 0) + 1,
    )
    if old_gone < 0 or (leave_cover >= 0 and old_gone > leave_cover):
        problems.append("J4 never proves the old line left the cover after the edit (count text=<old> 0)")

    # The earlier conversation keeps the text it started with.
    old_chat = at(
        lambda step: step[0] == "click"
        and required(step)
        and "data-session-row" in str(step[1]),
        max(old_gone, 0) + 1,
    )
    if old_chat < 0:
        problems.append("J4 never reopens the earlier conversation (click [data-session-row] …)")
    old_echo = at(
        lambda step: transcript_wait(step, "Project instructions received:"), max(old_chat, 0) + 1
    )
    old_kept = at(lambda step: transcript_wait(step, old_text), max(old_echo, 0) + 1)
    if old_chat >= 0 and old_kept < 0:
        problems.append("J4 never reads the old received line in the earlier conversation")
    old_has_new = at(
        lambda step: step[0] == "count"
        and "[role=region" in str(step[1])
        and new_text in str(step[1])
        and str(step[2]) == "0",
        max(old_kept, 0) + 1,
    )
    if old_kept >= 0 and old_has_new < 0:
        problems.append("J4 never proves the earlier conversation did not receive the new line (count … 0 in the transcript)")

    # A chat started after the edit receives the new line.
    second_send = send_at(max(old_has_new, 0) + 1)
    if second_send < 0:
        problems.append("J4 never starts a second chat after the edit")
    new_echo = at(lambda step: transcript_wait(step, new_text), max(second_send, 0) + 1)
    if second_send >= 0 and new_echo < 0:
        problems.append("J4 never reads the edited line in the new chat's receipt")

    # Restore the seeded document so the next viewport starts where this one did.
    restore = at(is_api, max(new_echo, 0) + 1)
    if restore < 0:
        problems.append("J4 never restores the seeded One-Pager after the edit (a second api PUT); the next viewport would start on the edited file")
    elif steps[restore][3] != journeys_seed.FOCUS_MARKDOWN:
        problems.append("the J4 restore PUT does not carry the seeded document byte for byte")

    # The over-400 section: the same cut on the cover and in the agent's text.
    cover_cut = at(lambda step: section_wait(step, cut_needle), max(restore, 0) + 1)
    if cover_cut < 0:
        problems.append("J4 never reads the truncated body on the cover (a 工作方式 wait naming %r)" % cut_needle)
    cover_trunc = at(
        lambda step: section_wait(step, "已截断") or section_wait(step, "Truncated"),
        max(cover_cut, 0) + 1,
    )
    if cover_trunc < 0:
        problems.append("J4 never reads the truncation footnote on the cover (已截断 / Truncated)")
    cover_tail = at(
        lambda step: step[0] == "count" and str(step[1]) == "text=" + tail and str(step[2]) == "0",
        max(cover_cut, 0) + 1,
    )
    if cover_tail < 0:
        problems.append("J4 never proves the tail beyond rune 400 is absent from the cover (count text=%s 0)" % tail)
    gamma_send = send_at(max(cover_tail, 0) + 1)
    if gamma_send < 0:
        problems.append("J4 never sends a chat in the truncated project")
    sent_cut = at(lambda step: transcript_wait(step, cut_needle), max(gamma_send, 0) + 1)
    if gamma_send >= 0 and sent_cut < 0:
        problems.append("J4 never reads the same truncated body in the agent's receipt")
    sent_tail = at(
        lambda step: step[0] == "count"
        and "[role=region" in str(step[1])
        and tail in str(step[1])
        and str(step[2]) == "0",
        max(sent_cut, 0) + 1,
    )
    if sent_cut >= 0 and sent_tail < 0:
        problems.append("J4 never proves the agent received no text beyond rune 400 (count … %s 0 in the transcript)" % tail)

    # The empty state.
    empty = at(
        lambda step: section_wait(step, "还没写工作说明") or section_wait(step, "No working instructions yet"),
        max(sent_tail, 0) + 1,
    )
    if empty < 0:
        problems.append("J4 never reads the empty state on a project with no 工作方式 section (还没写工作说明)")
    # The list row's empty state is one line by design (KIN-PROJECT-001, #590):
    # "还没写工作说明" with no not-sent footnote, so J4 has none to read.

    # The evidence the reviewer reads.
    names = [step[1] for step in steps if isinstance(step, list) and step[:1] == ["shot"]]
    for name in (
        "instructions-cover",
        "instructions-composer",
        "instructions-sent",
        "instructions-edited",
        "instructions-old-chat",
        "instructions-truncated",
        "instructions-truncated-sent",
        "instructions-empty",
    ):
        if name not in names:
            problems.append("J4 takes no `%s` shot" % name)
    if "instructions-cover" in names and "instructions-composer" in names and first_send >= 0:
        if names.index("instructions-cover") > names.index("instructions-composer"):
            problems.append("the instructions-cover shot must come before instructions-composer")
    return problems


def _j4_roots_problems(steps: list) -> list[str]:
    """What J4 must carry to prove the cover's saved folder order survives.

    `TestProjectRootsKeepSavedOrder` pins the store; nothing walked the editor
    and the reload. The leg opens the editor, moves the saved default onto
    `aaa-config` (which sorts before `alpha`, so a sorted read is visible),
    saves, restores the seeded order, then reloads the document and reads the
    folders back. Returns the problems; empty means the leg holds.
    """
    problems: list[str] = []

    def at(pred, start: int = 0, stop: int | None = None) -> int:
        end = len(steps) if stop is None else stop
        for index in range(start, end):
            if pred(steps[index]):
                return index
        return -1

    def required(step: list) -> bool:
        return not str(step[1]).startswith("?")

    def is_shot(step: list, name: str) -> bool:
        return step[:2] == ["shot", name]

    def is_edit(step: list) -> bool:
        return step[0] == "click" and J4_EDIT in str(step[1]) and J4_EDIT_EN in str(step[1])

    def is_save(step: list) -> bool:
        return step[0] == "click" and J4_SAVE in str(step[1]) and J4_SAVE_EN in str(step[1])

    def is_default(step: list) -> bool:
        return step[0] == "click" and J4_DEFAULT in str(step[1]) and J4_DEFAULT_EN in str(step[1])

    def is_gone_editor(step: list) -> bool:
        return (step[0] == "gone" and J4_SAVE in str(step[1]) and J4_SAVE_EN in str(step[1]))

    # Every press of a project heading, matched by prefix: the aim check below
    # has to see a press that lost its icon, which an equality match on the
    # aimed selector would skip in favour of a later press that kept it. The
    # press STARTS with the heading button; a folder-editor step that names the
    # heading inside a `:has()` scope is not a press of that heading.
    headings = [
        (index, step)
        for index, step in enumerate(steps)
        if step[0] == "click"
        and any(
            str(step[1]).lstrip("?").startswith("css=button[aria-label*='Project %s']" % name)
            for name in J4_PROJECTS
        )
    ]
    link = headings[0][0] if headings else -1
    if not headings:
        problems.append("J4 never opens Project Alpha by name (click %s)" % J4_ALPHA_LINK)
    else:
        # Two separate things, both measured, and both required at every press:
        # each press follows a fresh `goto /sessions`, so every one meets the
        # same cold list and the same hover strip.
        #  * the press must land left of the row's hover strip. Hovering the row
        #    opens the strip, and a centre press on the heading button then
        #    meets its first button in Playwright's hit test, which retries and
        #    times out without dispatching (walk.mjs:4241 is that 3000 ms
        #    budget). Measured: state/shots/delete-pagesb2b logs
        #    "locator.click: Timeout 3000ms exceeded" at every J4 heading press,
        #    and the shot after the first press (J4-mac-02-project-cover.png)
        #    stays on /sessions with the strip open over the truncated title.
        #    The element was present — walk.mjs:4202-4203 hard-fails a missing
        #    required locator instantly with its own `missing required` message,
        #    and no `missing required` line names the project heading in that
        #    walk. J4/phone stayed green because a coarse
        #    pointer draws no strip;
        #  * the row must have painted before the 3000 ms click budget starts, so
        #    a cold list is a wait, not a hard fail. `wait` reads with
        #    RSI_UX_WAIT_MS (15000).
        for index, step in headings:
            selector = str(step[1])
            name = next(
                name for name in J4_PROJECTS if "aria-label*='Project %s']" % name in selector
            )
            if not required(step):
                problems.append("the Project %s link click is optional" % name)
            if not selector.endswith(" svg"):
                problems.append(
                    "J4 presses the Project %s heading at its centre, where the hover strip's "
                    "first button intercepts the hit test and the click times out before "
                    "dispatch (aim at the leading icon instead)" % name
                )
            ready = steps[index - 1] if index > 0 else None
            if not (isinstance(ready, list) and ready[:1] == ["wait"] and ready[1] == selector):
                problems.append(
                    "J4 presses the Project %s link without a preceding wait for the same "
                    "selector (a 3000 ms click budget against a list that may not have painted)"
                    % name
                )
    cover = at(lambda step: is_shot(step, "project-cover"))
    if cover < 0:
        problems.append("J4 takes no project-cover shot")
    elif link >= 0 and cover < link:
        problems.append("the project-cover shot is taken before Project Alpha is open")

    # Save 1: the editor's own order control moves the default to aaa-config.
    edit = at(is_edit, cover + 1) if cover >= 0 else -1
    if edit < 0:
        problems.append("J4 never opens the folder editor (%s / %s)" % (J4_EDIT, J4_EDIT_EN))
        return problems
    if not required(steps[edit]):
        problems.append("the folder editor click is optional")
    moved = at(lambda step: is_default(step) and "aaa-config" in str(step[1]), edit + 1)
    if moved < 0:
        problems.append("J4 never moves the default off alpha (click 设为默认 / Make default on the aaa-config row)")
        return problems
    if not required(steps[moved]):
        problems.append("the aaa-config Make default click is optional")
    save = at(is_save, moved + 1)
    if save < 0:
        problems.append("J4 never saves the reordered folder list (click %s / %s)" % (J4_SAVE, J4_SAVE_EN))
        return problems
    if not required(steps[save]):
        problems.append("the folder save is optional")
    if at(is_gone_editor, save + 1) < 0:
        problems.append("J4 never proves the folder editor closed after the save (the daemon accepted the list)")
    first_saved = at(
        lambda step: step[0] == "wait"
        and "aaa-config" in str(step[1])
        and "first-child" in str(step[1]),
        save + 1,
    )
    if first_saved < 0:
        problems.append("the saved cover never shows aaa-config on its first row")
    saved_shot = at(lambda step: is_shot(step, "roots-saved"), save + 1)
    if saved_shot < 0:
        problems.append("J4 takes no roots-saved shot after the save")

    # Save 2: restore the seeded order so the next viewport starts where this
    # one did; a one-way reorder drifts the fixture across phone -> mac ->
    # mac-wide.
    second_edit = at(is_edit, saved_shot + 1) if saved_shot >= 0 else -1
    restored = (
        at(
            lambda step: is_default(step)
            and "/alpha" in str(step[1])
            and "aaa-config" not in str(step[1]),
            second_edit + 1,
        )
        if second_edit >= 0
        else -1
    )
    if restored < 0:
        problems.append("J4 never restores the seeded order (Make default on the alpha row); the fixture would drift across viewports")
    second_save = at(is_save, restored + 1) if restored >= 0 else -1
    if restored >= 0 and second_save < 0:
        problems.append("J4 never saves the restored folder order")

    # A document reload, not a client-side route change: only a fresh load
    # re-reads /api/projects and proves the store's order. Bound the search at
    # the 添加目录 leg, whose own goto /sessions and Alpha click come later.
    verbs_start = (
        at(lambda step: step[0] == "click" and J4_ADD in str(step[1]), second_save + 1)
        if second_save >= 0
        else -1
    )
    goto_bound = verbs_start if verbs_start >= 0 else len(steps)
    goto = (
        at(
            j4_is_reload,
            second_save + 1,
            goto_bound,
        )
        if second_save >= 0
        else -1
    )
    if second_save >= 0 and goto < 0:
        problems.append("J4 never reloads the document (goto /sessions) after the save; a route change reads the page, not the store")
    reload_link = (
        at(lambda step: step[0] == "click" and step[1] == J4_ALPHA_LINK, goto + 1, goto_bound)
        if goto >= 0
        else -1
    )
    if goto >= 0 and reload_link < 0:
        problems.append("J4 never reopens Project Alpha after the reload")
    elif reload_link >= 0 and not required(steps[reload_link]):
        problems.append("the post-reload Project Alpha click is optional")

    if reload_link >= 0:
        # Bound the reloaded-order proof to the cover it reloaded: the
        # 添加目录 / 移除 leg that follows reads the cover again (with
        # aaa-config last after the remove), and an unbounded search would let
        # a sorted read hide behind the later leg.
        bound = verbs_start if verbs_start >= 0 else len(steps)
        last_row = at(
            lambda step: step[0] == "wait"
            and "aaa-config" in str(step[1])
            and "last-child" in str(step[1]),
            reload_link + 1,
            bound,
        )
        if last_row < 0:
            problems.append("the reloaded cover never proves aaa-config is the LAST row (saved order, not sorted order)")
        first_row = at(
            lambda step: step[0] == "wait"
            and "/alpha" in str(step[1])
            and "first-child" in str(step[1]),
            reload_link + 1,
            bound,
        )
        if first_row < 0:
            problems.append("the reloaded cover never proves alpha is the first row")
        badge = at(
            lambda step: step[0] == "wait"
            and "默认" in str(step[1])
            and "Default" in str(step[1])
            and "first-child" in str(step[1]),
            reload_link + 1,
            bound,
        )
        if badge < 0:
            problems.append("the reloaded cover never proves the first row carries 默认 / Default")
        count = at(
            lambda step: step[0] == "count"
            and len(step) > 2
            and str(step[2]) == "2"
            and "li" in str(step[1]),
            max(last_row, first_row, badge) + 1,
            bound,
        )
        if count < 0:
            problems.append("the reloaded cover never counts exactly two folder rows")
        reloaded = at(lambda step: is_shot(step, "roots-reloaded"), reload_link + 1)
        if reloaded < 0:
            problems.append("J4 takes no roots-reloaded shot after reloading the document")
        elif saved_shot >= 0 and reloaded < saved_shot:
            problems.append("the roots-reloaded shot comes before roots-saved")
    return problems


def j4_roots_verbs_problems(steps: list) -> list[str]:
    """What J4 must carry to walk KIN-PROJECT-002's two verbs.

    The saved-order leg presses 设为默认 and reloads, but nobody has ever
    pressed 添加目录 or 移除 in a real browser — which is why the story stayed
    `approved`. This leg appends /tmp through the new-chat picker's 改为手动输入
    route, saves, leaves and returns to read three rows, then presses 移除,
    reads the inline consequence copy, cancels once (the row must stay),
    confirms, saves, and leaves and returns again to read two rows. It must end
    on the seeded alpha-first order so the next viewport replays cleanly.

    Returns the problems; empty means the leg holds.
    """
    problems: list[str] = []

    def at(pred, start: int = 0) -> int:
        for index in range(start, len(steps)):
            if pred(steps[index]):
                return index
        return -1

    def required(step: list) -> bool:
        return not str(step[1]).startswith("?")

    def is_shot(step: list, name: str) -> bool:
        return step[:2] == ["shot", name]

    def is_edit(step: list) -> bool:
        return step[0] == "click" and J4_EDIT in str(step[1]) and J4_EDIT_EN in str(step[1])

    def is_save(step: list) -> bool:
        return step[0] == "click" and J4_SAVE in str(step[1]) and J4_SAVE_EN in str(step[1])

    def is_save_wait(step: list) -> bool:
        return step[0] == "wait" and J4_SAVE in str(step[1]) and J4_SAVE_EN in str(step[1])

    def is_gone_editor(step: list) -> bool:
        return step[0] == "gone" and J4_SAVE in str(step[1]) and J4_SAVE_EN in str(step[1])

    def is_add(step: list) -> bool:
        return step[0] == "click" and J4_ADD in str(step[1]) and J4_ADD_EN in str(step[1])

    def is_remove(step: list) -> bool:
        return (
            step[0] == "click"
            and "[role=group]" not in str(step[1])
            and "/tmp" in str(step[1])
            and J4_REMOVE in str(step[1])
            and J4_REMOVE_EN in str(step[1])
        )

    def is_confirm(step: list) -> bool:
        return (
            step[0] == "click"
            and "[role=group]" in str(step[1])
            and J4_REMOVE in str(step[1])
            and J4_REMOVE_EN in str(step[1])
        )

    def is_cancel(step: list) -> bool:
        return (
            step[0] == "click"
            and "[role=group]" in str(step[1])
            and "取消" in str(step[1])
            and "Cancel" in str(step[1])
        )

    def is_confirm_group(step: list, op: str = "wait") -> bool:
        return step[0] == op and J4_CONFIRM in str(step[1])

    def cover_wait(step: list, path: str, position: str) -> bool:
        return (
            step[0] == "wait"
            and "[role=dialog]" in str(step[1])
            and path in str(step[1])
            and position in str(step[1])
        )

    def cover_first_default(step: list) -> bool:
        return (
            cover_wait(step, "/alpha", "first-child")
            and "默认" in str(step[1])
            and "Default" in str(step[1])
        )

    def draft_count(step: list, number: str) -> bool:
        return (
            step[0] == "count"
            and str(step[2]) == number
            and "[role=dialog]" in str(step[1])
            and "li" in str(step[1])
        )

    def cover_count(step: list, number: str) -> bool:
        return (
            step[0] == "count"
            and str(step[2]) == number
            and "[role=dialog]" in str(step[1])
            and "li" in str(step[1])
        )

    # The leg must leave the fixture as it found it: the next viewport replays
    # from the seeded list. The LAST cover read is the one that counts, so this
    # runs before the leg's own checks (which return early when the verb is
    # missing) — a leg that only adds leaves three roots and is caught here.
    last_cover = [
        index
        for index, step in enumerate(steps)
        if step[0] == "count" and "[role=dialog]" in str(step[1]) and "li" in str(step[1])
    ]
    if not last_cover:
        problems.append("J4 never reads the cover's folder count; the seeded list cannot be proven intact")
    elif str(steps[last_cover[-1]][2]) != "2":
        problems.append("the leg's last cover read is not two roots; the walk left the seeded list changed")
    last_first = [
        step
        for step in steps
        if step[0] == "wait" and "[role=dialog]" in str(step[1]) and "first-child" in str(step[1]) and "li" in str(step[1])
    ]
    if not last_first or "/alpha" not in str(last_first[-1][1]) or "默认" not in str(last_first[-1][1]):
        problems.append("the leg's last cover read does not show alpha first with 默认; the seeded default drifted")
    last_last = [
        step
        for step in steps
        if step[0] == "wait" and "[role=dialog]" in str(step[1]) and "last-child" in str(step[1]) and "li" in str(step[1])
    ]
    if not last_last or "/aaa-config" not in str(last_last[-1][1]) or "/tmp" in str(last_last[-1][1]):
        problems.append("the leg's last cover read does not show aaa-config last; the walk left the seeded list changed")

    anchor = at(lambda step: is_shot(step, "roots-reloaded"))
    if anchor < 0:
        problems.append("J4 takes no roots-reloaded shot; the add/remove leg has no anchor")
        return problems

    edit = at(is_edit, anchor + 1)
    if edit < 0:
        problems.append("J4 never reopens the folder editor after the roots reload; the add/remove verbs are unwalked")
        return problems
    if not required(steps[edit]):
        problems.append("the reopened folder editor click is optional")

    add = at(is_add, edit + 1)
    if add < 0:
        problems.append("J4 never presses ＋ 添加目录 / ＋ Add folder in the editor; the add verb is unwalked")
        return problems
    if not required(steps[add]):
        problems.append("the ＋ 添加目录 / ＋ Add folder click is optional")

    type_path = at(
        lambda step: step[0] == "click"
        and ("改为手动输入" in str(step[1]) or "Type a path instead" in str(step[1])),
        add + 1,
    )
    if type_path < 0:
        problems.append("J4 never opens the new-chat picker's path field (改为手动输入 / Type a path instead) after 添加目录")
    fill = at(
        lambda step: step[0] == "fill"
        and J4_PICKER_INPUT in str(step[1])
        and str(step[2]).strip() == "/tmp",
        add + 1,
    )
    if fill < 0:
        problems.append(
            "J4 clicks 添加目录 but never types a path into %s; the add could pass without the picker" % J4_PICKER_INPUT
        )
    elif type_path < 0 or type_path > fill:
        problems.append("J4 types into %s without opening the picker's path field first" % J4_PICKER_INPUT)
    if fill >= 0 and not required(steps[fill]):
        problems.append("the typed /tmp path is optional")
    if fill >= 0 and at(lambda step: step[0] == "key" and step[1] == "Enter", fill + 1) < 0:
        problems.append("J4 never commits the typed /tmp path (key Enter)")

    added_rows = at(lambda step: draft_count(step, "3"), max(fill, add) + 1)
    if added_rows < 0:
        problems.append("J4 never counts three draft rows after the add; the /tmp row was not appended")
    enabled = at(
        lambda step: step[0] == "enabled"
        and J4_SAVE in str(step[1])
        and J4_SAVE_EN in str(step[1]),
        max(fill, add) + 1,
    )
    if enabled < 0:
        problems.append("J4 never asserts the folder save is enabled after the add")

    save = at(is_save, max(added_rows, enabled, fill, add) + 1)
    if save < 0:
        problems.append("J4 never saves the three-folder list after the add")
        return problems
    if at(is_gone_editor, save + 1) < 0:
        problems.append("J4 never proves the editor closed after the add's save (the daemon accepted the list)")
    if at(cover_first_default, save + 1) < 0:
        problems.append("the saved cover never shows alpha first with 默认 / Default after the add")
    if at(lambda step: cover_wait(step, "/tmp", "last-child"), save + 1) < 0:
        problems.append("the saved cover never shows /tmp appended last after the add")
    if at(lambda step: cover_count(step, "3"), save + 1) < 0:
        problems.append("the cover never counts three folder rows after the add")

    # Leaving and returning is the persistence proof: a client-side route
    # change would read the list the save just installed, not the store.
    reload = at(j4_is_reload, save + 1)
    if reload < 0:
        problems.append("J4 never leaves the cover (goto /sessions) after the add; the append's persistence is unproven")
        return problems
    reopen = at(lambda step: step[0] == "click" and step[1] == J4_ALPHA_LINK, reload + 1)
    if reopen < 0:
        problems.append("J4 never reopens Project Alpha after the add's reload")
    else:
        if not required(steps[reopen]):
            problems.append("the post-add Project Alpha reopen is optional")
        if at(lambda step: cover_wait(step, "/tmp", "last-child"), reopen + 1) < 0:
            problems.append("the reloaded cover never shows /tmp last; the append did not persist")
        if at(cover_first_default, reopen + 1) < 0:
            problems.append("the reloaded cover never shows alpha first with 默认 / Default after the add")
        if at(lambda step: cover_count(step, "3"), reopen + 1) < 0:
            problems.append("the reloaded cover never counts three rows after the add")

    edit2 = at(is_edit, max(reopen, save) + 1)
    if edit2 < 0:
        problems.append("J4 never reopens the editor to remove the added folder")
        return problems
    if at(is_save_wait, edit2 + 1) < 0:
        problems.append("the editor reopened for the remove never shows its 保存 / Save folders control")
    remove = at(is_remove, edit2 + 1)
    if remove < 0:
        problems.append("J4 never presses 移除 / Remove on the /tmp row")
        return problems
    if not required(steps[remove]):
        problems.append("the 移除 / Remove press on the /tmp row is optional")
    if at(is_confirm_group, remove + 1) < 0:
        problems.append(
            "J4 never asserts the inline removal confirmation (%s); a remove without reading its aria-labelled group is unwalked"
            % J4_CONFIRM
        )
    if at(
        lambda step: step[0] == "wait"
        and "[role=group]" in str(step[1])
        and "不再出现在这个项目下" in str(step[1])
        and "no longer appear under this project" in str(step[1]),
        remove + 1,
    ) < 0:
        problems.append("J4 confirms a removal without reading the consequence copy (不再出现在这个项目下 / no longer appear under this project)")
    if at(lambda step: is_shot(step, "roots-remove-confirm"), remove + 1) < 0:
        problems.append("J4 takes no roots-remove-confirm shot; the confirmation was asserted but never photographed")

    cancel = at(is_cancel, remove + 1)
    if cancel < 0:
        problems.append("J4 never cancels the removal confirmation; the row keeping its place is unproven")
    else:
        if at(lambda step: is_confirm_group(step, "gone"), cancel + 1) < 0:
            problems.append("the removal confirmation never closes after 取消 / Cancel")
        if at(lambda step: draft_count(step, "3"), cancel + 1) < 0:
            problems.append("the cancelled removal does not leave the /tmp row in the draft (three rows)")

    confirm = at(is_confirm, max(cancel, remove) + 1)
    if confirm < 0:
        problems.append("J4 never presses the confirming 移除 / Remove inside the group")
        return problems
    if at(lambda step: draft_count(step, "2"), confirm + 1) < 0:
        problems.append("the confirmed removal never leaves two draft rows")
    save2 = at(is_save, confirm + 1)
    if save2 < 0:
        problems.append("J4 never saves the two-folder list after the confirm")
        return problems
    if at(is_gone_editor, save2 + 1) < 0:
        problems.append("J4 never proves the editor closed after the remove's save")
    if at(cover_first_default, save2 + 1) < 0:
        problems.append("the saved cover never shows alpha first with 默认 / Default after the remove")
    if at(lambda step: cover_wait(step, "/aaa-config", "last-child"), save2 + 1) < 0:
        problems.append("the saved cover never shows aaa-config last after the remove")
    if at(lambda step: cover_count(step, "2"), save2 + 1) < 0:
        problems.append("the cover never counts two folder rows after the remove")

    # Leave and return once more: the remove must have reached the store.
    reload2 = at(j4_is_reload, save2 + 1)
    if reload2 < 0:
        problems.append("J4 never leaves the cover (goto /sessions) after the remove; the removal's persistence is unproven")
    else:
        reopen2 = at(
            lambda step: step[0] == "click" and step[1] == J4_ALPHA_LINK,
            reload2 + 1,
        )
        if reopen2 < 0:
            problems.append("J4 never reopens Project Alpha after the remove's reload")
        else:
            if at(cover_first_default, reopen2 + 1) < 0:
                problems.append("the reloaded cover never shows alpha first with 默认 / Default after the remove")
            if at(lambda step: cover_wait(step, "/aaa-config", "last-child"), reopen2 + 1) < 0:
                problems.append("the reloaded cover never shows aaa-config last after the remove; the removal did not persist")
            if at(lambda step: cover_count(step, "2"), reopen2 + 1) < 0:
                problems.append("the reloaded cover never counts two rows after the remove")
        if at(lambda step: is_shot(step, "roots-removed-reloaded"), reopen2 + 1) < 0:
            problems.append("J4 takes no roots-removed-reloaded shot after the remove's reload")
    return problems


class WalkJ4ContractTest(unittest.TestCase):
    """J4 must walk the cover's folder editor through a save and a reload.

    KIN-PROJECT-002: the saved working-folder order is what the cover reads
    back, in both directions, after leaving the document and returning.

    Same shape as the other contract tests: the checked-in spec passes the
    guard, and a copy that regresses one rule at a time fails with a message
    naming that rule. Without this, a J4 that photographs the cover and leaves
    is green while the editor, the PATCH or the saved-order read breaks.
    """

    def setUp(self) -> None:
        self.tmp = tempfile.mkdtemp(prefix="j4-contract-")
        self.addCleanup(shutil.rmtree, self.tmp, True)

    def steps(self) -> list:
        return load_spec()["journeys"]["J4"]["steps"]

    def problems_after(self, mutate) -> list[str]:
        copy = json.loads(json.dumps(self.steps()))
        mutate(copy)
        return j4_contract_problems(copy)

    @staticmethod
    def at(steps: list, pred) -> int:
        return next(i for i, step in enumerate(steps) if pred(step))

    def test_j4_opens_the_roots_editor_and_reloads(self) -> None:
        journey = load_spec()["journeys"]["J4"]
        self.assertEqual(journey["viewports"], ["phone", "mac", "mac-wide"])
        self.assertEqual(j4_contract_problems(journey["steps"]), [])
        # The evidence the reviewer reads, in order: editor -> saved order ->
        # restored order -> reloaded order.
        names = [step[1] for step in journey["steps"] if step[0] == "shot"]
        self.assertLess(names.index("project-cover"), names.index("roots-saved"), names)
        self.assertLess(names.index("roots-saved"), names.index("roots-reloaded"), names)

    def test_j4_contract_rejects_a_cover_photo_without_the_editor(self) -> None:
        # Today's shape: goto /sessions, photograph the cover, leave for
        # /routines. No editor step means no save and no reload either.
        def drop_editor(steps: list) -> None:
            steps[:] = [
                step
                for step in steps
                if not (
                    step[0] in ("click", "wait", "gone", "count")
                    and any(
                        word in str(step[1])
                        for word in (J4_EDIT, J4_EDIT_EN, J4_DEFAULT, J4_DEFAULT_EN, J4_SAVE, J4_SAVE_EN)
                    )
                )
            ]

        problems = self.problems_after(drop_editor)
        self.assertTrue(any("folder editor" in problem for problem in problems), problems)

    def test_j4_is_selected_by_the_list_a_sessions_change_touches(self) -> None:
        # J4's first step presses a project row's title on /sessions, and that row
        # lives in ui/src/components/sessions/SessionList.tsx. Until 2026-11-23 the
        # sessions row did not name J4, so #584's rewrite of that step met no walk:
        # the PR selected J1 J2 J5 J8 J11 J12 J14 (state/shots/delete-pagesb2b2).
        spec = load_spec()
        row = next(
            (row for row in spec["paths"] if row[0] == "ui/src/pages/Sessions|ui/src/components/sessions/"),
            None,
        )
        self.assertIsNotNone(row, "no paths row owns ui/src/components/sessions/")
        self.assertIn("J4", row[1], "a sessions change does not select the journey that presses the project row")
        # The phone list keeps its own row: J4 walks three viewports, and a
        # mobile-only change is J1/J2's surface, not the desktop cover leg's.
        mobile = next((row for row in spec["paths"] if row[0] == "ui/src/components/mobile/"), None)
        self.assertIsNotNone(mobile, "no paths row owns ui/src/components/mobile/")
        self.assertNotIn("J4", mobile[1], "a phone-list change now pays for J4's desktop legs")

    def test_app_paths_row_is_a_literal_prefix_like_the_gate(self) -> None:
        """`ux-gate.sh` matches an alternative as a literal prefix, not a regex.

        The gate attributes a changed file with `path.startswith(p)` over the
        `|`-separated alternatives (`rsi/runtime/ux-gate.sh`, the attribution
        helper). A row written with regex escapes (`ui/src/App\\.tsx`) never
        matches `ui/src/App.tsx`: the gate fails closed with
        `attributed=fail-closed (unmapped ui path: ui/src/App.tsx)` and the
        confirm walk cannot say which journey the change belongs to. This
        mirrors the gate's matcher instead of trusting the row to read like
        one.
        """
        spec = load_spec()
        app_paths = ("ui/src/App.tsx", "ui/src/App.areaRoutes.tsx")
        row = next(
            (
                row
                for row in spec["paths"]
                if any(app_paths[0].startswith(alt) for alt in row[0].split("|"))
            ),
            None,
        )
        self.assertIsNotNone(row, "no paths row names ui/src/App.tsx")
        for alt in row[0].split("|"):
            for path in app_paths:
                self.assertTrue(
                    path.startswith(alt),
                    f"{alt!r} is not a literal prefix of {path}, so the gate cannot attribute it",
                )
        self.assertIn("J1", row[1], row)
        self.assertIn("J4", row[1], row)

    def test_j4_contract_rejects_a_press_behind_the_hover_strip(self) -> None:
        # A press at the heading button's own centre meets the five-button hover
        # strip the row opens over its tail, which is what
        # state/shots/delete-pagesb2b measured: "locator.click: Timeout 3000ms
        # exceeded" at every heading press (walk.mjs:4241 is the 3000 ms
        # budget), so Playwright retried the hit test and never dispatched; the
        # shot after the first press stays on /sessions with the strip open over
        # the truncated title. A missing element would have hard-failed
        # instantly at walk.mjs:4202-4203 instead.
        def press_the_centre(steps: list) -> None:
            at = next(i for i, step in enumerate(steps) if step[0] == "click" and step[1] == J4_ALPHA_LINK)
            steps[at] = ["click", J4_ALPHA_LINK[:-len(" svg")]]

        problems = self.problems_after(press_the_centre)
        self.assertTrue(any("hover strip" in problem for problem in problems), problems)

    def test_j4_contract_rejects_a_press_before_the_list_paints(self) -> None:
        # The click's own budget is 3000 ms while the readiness reads around it
        # get RSI_UX_WAIT_MS (15000), so a cold sessions list must be waited for
        # rather than charged to the press.
        def drop_the_wait(steps: list) -> None:
            steps[:] = [
                step
                for step in steps
                if not (step[0] == "wait" and step[1] == J4_ALPHA_LINK)
            ]

        problems = self.problems_after(drop_the_wait)
        self.assertTrue(any("without a preceding wait" in problem for problem in problems), problems)

    def test_j4_opens_the_folder_editor_under_both_pointer_classes(self) -> None:
        """`SessionList` gives the row's folder editor one trigger per input.

        A coarse pointer gets the project row's `⋯` (`项目操作` / `Project
        actions`) and the sheet row behind it; a fine pointer has no such
        button and instead reveals the row's hover cluster, whose `编辑工作目录`
        / `Edit folders` icon is `pointer-events-none` + `opacity-0` until the
        row is hovered or the cluster holds focus (`SessionList.tsx`, the
        `focus-within:pointer-events-auto` strip). A J4 that names only the
        `⋯` hard-fails both Mac widths with "missing required click", and a J4
        that names only the icon times out at the click because the strip is
        not hittable (state/shots/delete-pagesb2c-del). So every open reveals
        the cluster with a `focus` (a recorded skip on the phone, which draws
        no icon) and offers the `⋯` as an optional press (a recorded skip on
        the Macs), while the editor's own save wait stays mandatory: the
        trigger may skip, the dialog may not.
        """
        steps = self.steps()
        opens = [
            index
            for index, step in enumerate(steps)
            if step[0] == "click"
            and "项目操作" in str(step[1])
            and "Project actions" in str(step[1])
        ]
        self.assertTrue(
            opens, "J4 never presses the project row's coarse ⋯ (项目操作 / Project actions)"
        )
        for index in opens:
            coarse = steps[index]
            self.assertTrue(
                str(coarse[1]).startswith("?"),
                f"the coarse ⋯ press is required; a fine pointer draws no such button: {coarse}",
            )
            reveal = steps[index - 1]
            self.assertEqual(reveal[0], "focus", reveal)
            self.assertTrue(
                str(reveal[1]).startswith("?"),
                f"the fine pointer's reveal is required; the phone has no such icon: {reveal}",
            )
            self.assertIn("aria-label='编辑工作目录'", str(reveal[1]), reveal)
            self.assertIn("aria-label='Edit folders'", str(reveal[1]), reveal)
            self.assertEqual(steps[index + 1][0], "click", steps[index + 1])
            self.assertEqual(steps[index + 2][0], "wait", steps[index + 2])
            self.assertIn(J4_SAVE, str(steps[index + 2][1]), steps[index + 2])
            self.assertIn(J4_SAVE_EN, str(steps[index + 2][1]), steps[index + 2])
            # `.first()` picks the first bucket in DOM order, and the seeded
            # projects do not sort Alpha-first: an unscoped reveal or `⋯`
            # opens another project's editor and its `/aaa-config` wait then
            # fails (state/shots/delete-pagesb2c-del). Both triggers name the
            # seeded bucket. The editor step itself cannot: the coarse sheet
            # row is a modal label with no bucket in it, and the fine
            # pointer's icon resolves by its accessible name.
            for step in (reveal, coarse):
                self.assertIn("Project Alpha", str(step[1]), step)
            # The sheet row's label is a nested `<span>`, so `button:text-is(…)`
            # never matches it (walk.mjs `stepLocator` documents the same fact
            # for J13's Files row); the walker's exact-text regex does, and
            # `getByRole(…, {name: re})` is what finds the fine pointer's icon
            # on the Macs. One needle covers both pointer classes, and the
            # anchor keeps it off 编辑一句话摘要 / Edit one-line summary, which
            # the sheet draws above it.
            self.assertEqual(
                steps[index + 1][1],
                "/^(编辑工作目录|Edit folders)$/",
                steps[index + 1],
            )

        # A walker needle carries its engine prefix once, and `wait` / `gone`
        # must name one (`walk.mjs` `waitVisible`): `css=a, css=b` is a CSS
        # parse error ("Unexpected token \"=\"") and a bare selector is "wait
        # needs text=<literal> or css=<selector>". Both are hard failures that
        # do not name the surface (state/shots/delete-pagesb2c-del).
        for step in steps:
            if step[0] not in ("click", "wait", "gone", "focus", "hover"):
                continue
            needle = str(step[1]).lstrip("?")
            self.assertNotIn(", css=", needle, f"a needle repeats the css= prefix: {needle}")
            if step[0] in ("wait", "gone"):
                self.assertTrue(
                    needle.startswith(("css=", "text=")),
                    f"{step[0]} needs css= or text=: {needle}",
                )

    def test_j4_narrows_the_old_chat_read_to_the_seeded_project(self) -> None:
        """`/sessions` lists every project bucket, and the walker clicks `.first()`.

        The old-chat leg opens the conversation that predates the instructions
        edit and expects the previous line in it. Left to `.first()` across all
        buckets, the row it picks depends on bucket order: at mac-wide it
        opened a Gamma conversation and the transcript wait timed out
        (state/shots/delete-pagesb2c-del, `J4-mac-wide-07`). So the leg
        discloses Project Alpha the way the other legs do — `goto /sessions`,
        wait for its collapsed heading, click it — before it presses the
        `ONE_PAGER.md` row, which makes the first match the seeded project's
        own chat. A wait and its click must name the same row, or the wait
        proves a row other than the one the click takes.
        """
        steps = self.steps()
        presses = [
            index
            for index, step in enumerate(steps)
            if step[0] == "click" and "ONE_PAGER.md" in str(step[1])
        ]
        self.assertTrue(presses, "J4 never opens the ONE_PAGER.md chat")
        for index in presses:
            self.assertEqual(steps[index - 2][0], "wait", steps[index - 2])
            self.assertEqual(
                steps[index - 2][1], steps[index - 1][1], "the wait and its click name different rows"
            )
            for step in (steps[index - 2], steps[index - 1]):
                self.assertIn("Project Alpha", str(step[1]), step)
                self.assertIn(":not([aria-expanded])", str(step[1]), step)
            self.assertEqual(steps[index - 3][0], "goto", steps[index - 3])
            self.assertEqual(steps[index - 3][1], "/sessions", steps[index - 3])

    def test_j4_contract_rejects_a_route_change_instead_of_a_reload(self) -> None:
        # A client-side return to the cover reads the state the editor just
        # installed; only `goto` re-reads /api/projects. The mutation drops the
        # reload that follows the order-restoring save (the leg's own later
        # reloads belong to the 添加目录 / 移除 proof).
        def drop_reload(steps: list) -> None:
            saved = next(
                i for i, step in enumerate(steps) if step[:2] == ["shot", "roots-saved"]
            )
            at = next(
                i for i in range(saved + 1, len(steps))
                if j4_is_reload(steps[i])
            )
            steps.pop(at)

        problems = self.problems_after(drop_reload)
        self.assertTrue(any("reloads the document" in problem for problem in problems), problems)

    def test_j4_contract_rejects_a_sorted_read_passing_the_wait(self) -> None:
        # `wait text=aaa-config` passes whether the folder is first or last.
        # The reload proof has to name the row's position: sorted order puts
        # aaa-config first, which is exactly the regression.
        def unpin_last_row(steps: list) -> None:
            at = self.at(
                steps,
                lambda step: step[0] == "wait"
                and "aaa-config" in str(step[1])
                and "last-child" in str(step[1]),
            )
            steps[at] = ["wait", "text=aaa-config"]

        problems = self.problems_after(unpin_last_row)
        self.assertTrue(any("LAST row" in problem for problem in problems), problems)

    def test_j4_contract_rejects_a_one_way_reorder(self) -> None:
        # Saving [aaa-config, alpha] at phone and again at mac would leave the
        # next width a fixture it did not expect; the second save must restore
        # the seeded order.
        def drop_restore(steps: list) -> None:
            at = self.at(
                steps,
                lambda step: step[0] == "click"
                and J4_DEFAULT in str(step[1])
                and "/alpha" in str(step[1])
                and "aaa-config" not in str(step[1]),
            )
            steps.pop(at)

        problems = self.problems_after(drop_restore)
        self.assertTrue(any("restores the seeded order" in problem for problem in problems), problems)

    # --- KIN-PROJECT-003: the 工作方式 leg -------------------------------

    def test_j4_KIN_PROJECT_003_walks_the_cover_block_and_the_agent_echo(self) -> None:
        journey = load_spec()["journeys"]["J4"]
        self.assertEqual(j4_instructions_problems(journey["steps"]), [])
        names = [step[1] for step in journey["steps"] if step[0] == "shot"]
        order = [
            "instructions-cover",
            "instructions-composer",
            "instructions-sent",
            "instructions-edited",
            "instructions-old-chat",
            "instructions-truncated",
            "instructions-truncated-sent",
            "instructions-empty",
        ]
        self.assertEqual([name for name in names if name in order], order)

    def test_j4_KIN_PROJECT_003_rejects_a_walk_without_the_launcher(self) -> None:
        def drop_launcher(steps: list) -> None:
            steps[:] = [
                step
                for step in steps
                if not (step[0] == "click" and "让 Kin 改…" in str(step[1]))
            ]

        problems = self.problems_after(drop_launcher)
        self.assertTrue(any("never presses the cover launcher" in problem for problem in problems), problems)

    def test_j4_KIN_PROJECT_003_rejects_a_send_before_the_prefill_is_read(self) -> None:
        def send_first(steps: list) -> None:
            send = self.at(steps, lambda step: step[0] == "send")
            value = self.at(steps, lambda step: step[0] == "value" and "ONE_PAGER.md" in str(step[2]))
            steps[send], steps[value] = steps[value], steps[send]

        problems = self.problems_after(send_first)
        self.assertTrue(any("prefill" in problem for problem in problems), problems)

    def test_j4_KIN_PROJECT_003_rejects_a_receipt_read_outside_the_transcript(self) -> None:
        # The cover also says "工作方式"; a bare text= wait for the echoed line
        # would be satisfied by the cover and prove nothing about the agent.
        def unscoped_echo(steps: list) -> None:
            at = self.at(
                steps,
                lambda step: step[0] == "wait"
                and "Project instructions received:" in str(step[1]),
            )
            steps[at] = ["wait", "text=Project instructions received:"]

        problems = self.problems_after(unscoped_echo)
        self.assertTrue(any("receipt wait is not scoped to the transcript" in problem for problem in problems), problems)

    def test_j4_KIN_PROJECT_003_rejects_an_api_edit_before_the_first_send(self) -> None:
        def move_edit_first(steps: list) -> None:
            edit = self.at(steps, lambda step: step[0] == "api" and "新的工作方式" in str(step[3]))
            step = steps.pop(edit)
            first_send = self.at(steps, lambda s: s[0] == "send")
            steps.insert(first_send, step)

        problems = self.problems_after(move_edit_first)
        self.assertTrue(any("before the first send" in problem for problem in problems), problems)

    def test_j4_KIN_PROJECT_003_rejects_a_dropped_post_edit_cover_read(self) -> None:
        def drop_post_edit(steps: list) -> None:
            at = self.at(
                steps,
                lambda step: step[0] == "wait"
                and "工作方式" in str(step[1])
                and journeys_seed.ALPHA_INSTRUCTIONS_EDITED in str(step[1]),
            )
            steps.pop(at)

        problems = self.problems_after(drop_post_edit)
        self.assertTrue(any("re-reads the cover after the edit" in problem for problem in problems), problems)

    def test_j4_KIN_PROJECT_003_rejects_a_dropped_old_conversation_count(self) -> None:
        def drop_old_count(steps: list) -> None:
            at = self.at(
                steps,
                lambda step: step[0] == "count"
                and "[role=region" in str(step[1])
                and journeys_seed.ALPHA_INSTRUCTIONS_EDITED[2:] in str(step[1]),
            )
            steps.pop(at)

        problems = self.problems_after(drop_old_count)
        self.assertTrue(any("earlier conversation did not receive the new line" in problem for problem in problems), problems)

    def test_j4_KIN_PROJECT_003_rejects_a_dropped_truncation_case(self) -> None:
        def drop_truncation(steps: list) -> None:
            steps[:] = [
                step
                for step in steps
                if not (
                    "CUT-BOUNDARY" in str(step[1])
                    or (step[0] == "count" and journeys_seed.GAMMA_SENTINEL in str(step[1]))
                )
            ]

        problems = self.problems_after(drop_truncation)
        self.assertTrue(any("truncated body on the cover" in problem for problem in problems), problems)
        self.assertTrue(any("tail beyond rune 400" in problem for problem in problems), problems)

    def test_j4_KIN_PROJECT_003_rejects_a_dropped_empty_state(self) -> None:
        def drop_empty(steps: list) -> None:
            steps[:] = [
                step
                for step in steps
                if not (
                    "还没写工作说明" in str(step[1])
                    or "新对话不会收到这一段" in str(step[1])
                )
            ]

        problems = self.problems_after(drop_empty)
        self.assertTrue(any("empty state" in problem for problem in problems), problems)

    def test_j4_KIN_PROJECT_003_rejects_an_edit_body_that_drifted_from_the_seed(self) -> None:
        def drift(steps: list) -> None:
            at = self.at(steps, lambda step: step[0] == "api" and "新的工作方式" in str(step[3]))
            steps[at][3] = steps[at][3].replace(
                journeys_seed.ALPHA_INSTRUCTIONS_EDITED,
                "- 一个新的、但种子从不写入的句子。",
            )

        problems = self.problems_after(drift)
        self.assertTrue(any("does not carry the seeded edited document" in problem for problem in problems), problems)

    def test_j4_KIN_PROJECT_003_rejects_a_dropped_restore(self) -> None:
        def drop_restore(steps: list) -> None:
            at = self.at(
                steps,
                lambda step: step[0] == "api"
                and journeys_seed.ALPHA_INSTRUCTIONS in str(step[3])
                and journeys_seed.ALPHA_INSTRUCTIONS_EDITED not in str(step[3]),
            )
            steps.pop(at)

        problems = self.problems_after(drop_restore)
        self.assertTrue(any("restores the seeded One-Pager" in problem for problem in problems), problems)

    # --- KIN-PROJECT-002: the 添加目录 / 移除 verbs ----------------------

    def test_j4_adds_and_removes_a_folder_with_its_confirmation(self) -> None:
        journey = load_spec()["journeys"]["J4"]
        self.assertEqual(j4_roots_verbs_problems(journey["steps"]), [])
        names = [step[1] for step in journey["steps"] if step[0] == "shot"]
        order = [
            "roots-reloaded",
            "roots-added-reloaded",
            "roots-remove-confirm",
            "roots-removed-reloaded",
        ]
        self.assertEqual([name for name in names if name in order], order)

    def test_j4_contract_rejects_an_add_without_the_picker_path(self) -> None:
        # Pressing 添加目录 and then asserting three rows could pass on a leg
        # that never opens the picker; the typed path is the proof the add went
        # through the shipped chooser.
        def drop_picker_fill(steps: list) -> None:
            steps[:] = [
                step
                for step in steps
                if not (step[0] == "fill" and J4_PICKER_INPUT in str(step[1]))
            ]

        problems = self.problems_after(drop_picker_fill)
        self.assertTrue(
            any(J4_PICKER_INPUT in problem and "never types a path" in problem for problem in problems),
            problems,
        )

    def test_j4_contract_rejects_a_remove_without_reading_the_confirm(self) -> None:
        # The inline group is the whole point of the remove verb: it says the
        # conversations stay in the list and nothing is deleted. A confirm that
        # never reads that copy walks the API, not the promise.
        def drop_consequence(steps: list) -> None:
            steps[:] = [
                step
                for step in steps
                if not (
                    step[0] == "wait"
                    and "[role=group]" in str(step[1])
                    and "不再出现在这个项目下" in str(step[1])
                )
            ]

        problems = self.problems_after(drop_consequence)
        self.assertTrue(
            any("without reading the consequence copy" in problem for problem in problems),
            problems,
        )

    def test_j4_contract_rejects_a_leg_that_leaves_the_seeded_list_changed(self) -> None:
        # Phone -> mac -> mac-wide replay from the same seed. A leg that adds
        # /tmp and stops leaves three roots for the next width; the last cover
        # read must be the seeded two, alpha first and default.
        def drop_the_remove_leg(steps: list) -> None:
            at = self.at(
                steps,
                lambda step: step[0] == "click"
                and "[role=group]" not in str(step[1])
                and "/tmp" in str(step[1])
                and J4_REMOVE in str(step[1]),
            )
            del steps[at:]

        problems = self.problems_after(drop_the_remove_leg)
        self.assertTrue(
            any("the leg's last cover read is not two roots" in problem for problem in problems),
            problems,
        )

    def test_j4_contract_rejects_a_remove_without_the_return_trip(self) -> None:
        # The remove's persistence proof is a fresh document load: the cover
        # the save just redrew is React state, not the store.
        def drop_final_reload(steps: list) -> None:
            save = max(
                i for i, step in enumerate(steps)
                if step[0] == "click" and J4_SAVE in str(step[1])
            )
            at = next(
                i for i in range(save + 1, len(steps))
                if j4_is_reload(steps[i])
            )
            steps.pop(at)

        problems = self.problems_after(drop_final_reload)
        self.assertTrue(
            any("after the remove" in problem for problem in problems),
            problems,
        )


@unittest.skipUnless(NODE, "node is not installed; the journey walker needs it")
class WalkJ5ResolveTest(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.mkdtemp(prefix="j5-resolve-")
        self.addCleanup(shutil.rmtree, self.tmp, True)

    def resolve(self, seed: str | None) -> tuple[int, str]:
        seed_path = os.path.join(self.tmp, "seed.log")
        if seed is not None:
            with open(seed_path, "w", encoding="utf-8") as fh:
                fh.write(seed)
        done = subprocess.run(
            [NODE, WALK, "--resolve-j5", seed_path, "--spec", SPEC],
            capture_output=True,
            text=True,
            timeout=20,
        )
        return done.returncode, (done.stdout + done.stderr).strip()

    def test_the_seeded_target_resolves_the_running_rows_trigger(self) -> None:
        code, out = self.resolve(
            "journeys seed: base http://127.0.0.1:<port>\n"
            "j5 target conversation=task-9 title=[seed] Running the migration\n"
            "summary: created 1, existing 0, skipped 0\n"
        )
        self.assertEqual(code, 0, out)
        self.assertEqual(
            out, "J5 css=[data-row-actions][aria-describedby='session-row-title-task-9']"
        )

    def test_absent_target_line_skips(self) -> None:
        code, out = self.resolve("journeys seed: base http://127.0.0.1:<port>\nsummary: created 0, existing 1, skipped 0\n")
        self.assertEqual(code, 0, out)
        self.assertEqual(out, "J5 skip: no seeded running conversation")

    def test_failed_seed_skips(self) -> None:
        code, out = self.resolve("seed failed (walk continues on what exists)\n")
        self.assertEqual(code, 0, out)
        self.assertEqual(out, "J5 skip: seed failed or empty daemon")


class WalkMutantManifestTest(unittest.TestCase):
    """The J5 red proof is only real while the manifest still points at the menu.

    `rsi/runtime/tests/test-walk-mutant.sh` pins the count and the shape; this
    test is the Python-side half that runs with the rest of the walk suite, and
    compares the shell's literal count with the manifest it reads.
    """

    MANIFEST = os.path.join(ROOT, "rsi", "runtime", "ux", "walk-mutant.json")
    SHELL = os.path.join(ROOT, "rsi", "runtime", "tests", "test-walk-mutant.sh")

    def test_walk_mutant_manifest_pins_the_j5_row_actions(self) -> None:
        with open(self.MANIFEST, encoding="utf-8") as fh:
            entries = json.load(fh)
        matching = [entry for entry in entries if entry["file"].endswith("SessionRow.tsx")]
        self.assertEqual(len(matching), 1, matching)
        entry = matching[0]
        self.assertIn("--walk-once J5", entry["test"])
        self.assertIn("runningNow", entry["old"])
        # `runningNow && false` keeps the tone test referenced, so the mutant
        # build still passes tsc's noUnusedLocals while rendering no line.
        self.assertIn("runningNow && false", entry["new"])
        with open(os.path.join(ROOT, entry["file"]), encoding="utf-8") as fh:
            source = fh.read()
        self.assertEqual(source.count(entry["old"]), 1, "the mutant's `old` no longer occurs exactly once")
        with open(self.SHELL, encoding="utf-8") as fh:
            shell = fh.read()
        pinned = re.search(r"len\(entries\)\s*!=\s*(\d+)", shell)
        self.assertIsNotNone(pinned, "test-walk-mutant.sh no longer pins the entry count")
        self.assertEqual(int(pinned.group(1)), len(entries), "the manifest grew without bumping the pinned count")

    def test_walk_mutant_manifest_pins_the_j11_phone_switch(self) -> None:
        """The phone switch proof reddens on a page load, not a guess.

        J11 must have its own mutant: a manifest entry whose `test` walks J11.
        The phone's Back reloading the document throws away the shell and the
        kept-alive panes, so J11's `node` assertion is what fails. The break is
        on the phone's own Back helper, so J9 (which never presses Back) stays
        green and the phone claim has its own proof.
        """
        with open(self.MANIFEST, encoding="utf-8") as fh:
            entries = json.load(fh)
        matching = [entry for entry in entries
                    if entry["file"].endswith("ui/src/lib/phoneBack.ts")
                    and "--walk-once J11" in entry["test"]]
        self.assertEqual(len(matching), 1, matching)
        entry = matching[0]
        self.assertIn("navigate(-1)", entry["old"])
        # A full document load replaces the shell; the mutant must not leave the
        # client-side history back reachable, or the walk could stay green.
        self.assertIn('window.location.assign("/sessions")', entry["new"])
        self.assertNotIn("navigate(-1)", entry["new"])
        self.assertIn("R-f4-switch-phone", entry["new"])
        with open(os.path.join(ROOT, entry["file"]), encoding="utf-8") as fh:
            source = fh.read()
        self.assertEqual(source.count(entry["old"]), 1, "the mutant's `old` no longer occurs exactly once")
        with open(self.SHELL, encoding="utf-8") as fh:
            shell = fh.read()
        pinned = re.search(r"len\(entries\)\s*!=\s*(\d+)", shell)
        self.assertIsNotNone(pinned, "test-walk-mutant.sh no longer pins the entry count")
        self.assertEqual(int(pinned.group(1)), len(entries), "the manifest grew without bumping the pinned count")

    def test_walk_mutant_manifest_pins_the_j12_thumb_gestures(self) -> None:
        """J12's red proof: the edge back stops following the finger.

        J12 must have its own mutant: a manifest entry whose `test` walks J12.
        The edge back disabled at `begin` leaves the list a swipe away with no
        way back, so the leg's `url ^/sessions` (and the reads behind it) fail.
        The break is on the hook's own entry point, so the row swipe and the
        hold still work and the failure names the gesture that died.
        """
        with open(self.MANIFEST, encoding="utf-8") as fh:
            entries = json.load(fh)
        matching = [entry for entry in entries
                    if entry["file"].endswith("ui/src/hooks/useEdgeSwipeBack.ts")
                    and "--walk-once J12" in entry["test"]]
        self.assertEqual(len(matching), 1, matching)
        entry = matching[0]
        # The gesture is turned off before it can capture a pointer; the old
        # guard and both refs stay referenced so the mutant build typechecks.
        self.assertIn("if (!enabledRef.current || gesture.current) return;", entry["old"])
        self.assertIn("if (true || !enabledRef.current || gesture.current) return;", entry["new"])
        with open(os.path.join(ROOT, entry["file"]), encoding="utf-8") as fh:
            source = fh.read()
        self.assertEqual(source.count(entry["old"]), 1,
                         "the mutant's `old` no longer occurs exactly once")
        with open(self.SHELL, encoding="utf-8") as fh:
            shell = fh.read()
        pinned = re.search(r"len\(entries\)\s*!=\s*(\d+)", shell)
        self.assertIsNotNone(pinned, "test-walk-mutant.sh no longer pins the entry count")
        self.assertEqual(int(pinned.group(1)), len(entries),
                         "the manifest grew without bumping the pinned count")


class WalkJ15ContractTest(unittest.TestCase):
    """F2's question leg must stay walked: card, both answers, reload.

    Until R-f2-question-leg no journey touched ``UserQuestionCard`` at all, so
    a card that stopped drawing or an answer the daemon stopped persisting kept
    every gate green. Same shape as WalkJ14ContractTest: the walker's own
    ``--check-spec`` is the reader, so a rule cannot drift between the spec and
    the gate. The card must be read as visible copy (question and both option
    labels), answered by an option *and* through the Other input, and the
    reload must still show the request anchors with a zero card count.
    """

    def setUp(self) -> None:
        self.tmp = tempfile.mkdtemp(prefix="j15-contract-")
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
        spec = load_spec()
        mutate(spec["journeys"]["J15"]["steps"])
        path = os.path.join(self.tmp, "resolved.json")
        with open(path, "w", encoding="utf-8") as fh:
            json.dump(spec, fh, ensure_ascii=False)
        return path

    def copy_spec_with(self, mutate) -> str:
        spec = load_spec()
        mutate(spec)
        path = os.path.join(self.tmp, "paths.json")
        with open(path, "w", encoding="utf-8") as fh:
            json.dump(spec, fh, ensure_ascii=False)
        return path

    @staticmethod
    def steps() -> list:
        return load_spec()["journeys"]["J15"]["steps"]

    def test_shipped_j15_spec_is_ok(self) -> None:
        code, out = self.check()
        self.assertEqual(code, 0, out)
        self.assertIn("spec ok: J15", out)
        self.assertEqual(load_spec()["journeys"]["J15"]["viewports"], ["mac"],
                         "J15 is the Mac conversation proof")

    def test_j15_without_reading_the_question_is_red(self) -> None:
        # The card is proof only if the walk reads what a person reads: the
        # question and both option labels are visible text before the press.
        # A testid-only wait would pass a card that drew with no copy.
        steps = self.steps()
        question = next(i for i, step in enumerate(steps)
                        if step[0] == "wait" and str(step[1]).startswith("text=")
                        and "How should the release go out?" in str(step[1]))
        option = next(i for i, step in enumerate(steps)
                      if step[0] == "click" and "aria-label=" in str(step[1]))
        for label, index, needle in (
            ("the question text", question, "three visible strings"),
            ("the option press", option, "aria label"),
        ):
            with self.subTest(removed=label):
                code, out = self.check(self.copy_with(lambda steps: steps.pop(index)))
                self.assertEqual(code, 1, out)
                self.assertIn("spec red: J15", out)
                self.assertIn(needle, out)

    def test_j15_without_the_other_answer_is_red(self) -> None:
        # Answering an option twice would leave other_text dead and the walk
        # green, so the Other field is its own proof: the fill and the Enter.
        steps = self.steps()
        fill = next(i for i, step in enumerate(steps)
                    if step[0] == "fill" and "input[type=text]" in str(step[1]))
        enter = next(i for i, step in enumerate(steps)
                     if step[0] == "key" and step[1] == "Enter")
        for label, index, needle in (
            ("the Other input", fill, "Other input"),
            ("the Enter submit", enter, "Enter"),
        ):
            with self.subTest(removed=label):
                code, out = self.check(self.copy_with(lambda steps: steps.pop(index)))
                self.assertEqual(code, 1, out)
                self.assertIn("spec red: J15", out)
                self.assertIn(needle, out)

    def test_j15_without_the_reload_proof_is_red(self) -> None:
        # The reload is the persistence proof: the same conversation without a
        # focus query, the request anchors still on screen, and the card at
        # zero. A card that only left the DOM would come back here.
        steps = self.steps()
        reload = next(i for i, step in enumerate(steps)
                      if step[0] == "goto" and "?" not in str(step[1]))
        zeroes = [i for i, step in enumerate(steps)
                  if step[0] == "count" and "user-question-card" in str(step[1])
                  and str(step[2]) == "0" and i > reload]
        self.assertEqual(len(zeroes), 1, zeroes)
        for label, index, needle in (
            ("the reload", reload, "never reloads the conversation"),
            ("the zero card count", zeroes[0], "counts the card as 0 after the reload"),
        ):
            with self.subTest(removed=label):
                code, out = self.check(self.copy_with(lambda steps: steps.pop(index)))
                self.assertEqual(code, 1, out)
                self.assertIn("spec red: J15", out)
                self.assertIn(needle, out)

    def test_j15_paths_rows_select_it(self) -> None:
        # A diff to the card, its page or its labels must select J15: first
        # match wins, so a row that loses J15 lets the leg rot unwalked.
        def drop(spec):
            for row in spec["paths"]:
                if ("TaskDetail" in row[0] or "i18n/locales" in row[0]) and "J15" in row[1]:
                    row[1] = [journey for journey in row[1] if journey != "J15"]

        code, out = self.check(self.copy_spec_with(drop))
        self.assertEqual(code, 1, out)
        self.assertIn("spec red: J15", out)
        self.assertIn("paths table", out)


class WalkJ16ContractTest(unittest.TestCase):
    """The 820x1180 touch reading surface must stay an acceptance width.

    #537's four high findings shipped through a green gate because every
    screenshot was 390 or 1100. J16 is the gate's own walk of the width the
    owner reads on, and ``--check-spec`` is the reader, so a rule cannot drift
    between the spec and the gate. The viewport object is part of the proof:
    a bare "820x1180" string resolves to hasTouch false through the walker's
    phoneLayout rule, i.e. an iPad measured as a mouse.
    """

    def setUp(self) -> None:
        self.tmp = tempfile.mkdtemp(prefix="j16-contract-")
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
        spec = load_spec()
        mutate(spec["journeys"]["J16"]["steps"])
        path = os.path.join(self.tmp, "steps.json")
        with open(path, "w", encoding="utf-8") as fh:
            json.dump(spec, fh, ensure_ascii=False)
        return path

    def copy_spec_with(self, mutate) -> str:
        spec = load_spec()
        mutate(spec)
        path = os.path.join(self.tmp, "spec.json")
        with open(path, "w", encoding="utf-8") as fh:
            json.dump(spec, fh, ensure_ascii=False)
        return path

    @staticmethod
    def steps() -> list:
        return load_spec()["journeys"]["J16"]["steps"]

    def test_shipped_j16_spec_is_ok(self) -> None:
        code, out = self.check()
        self.assertEqual(code, 0, out)
        self.assertIn("spec ok: J16", out)
        self.assertEqual(load_spec()["journeys"]["J16"]["viewports"], ["tablet"],
                         "J16 is the 820 touch reading proof")

    def test_j16_without_either_reading_verdict_is_red(self) -> None:
        # Both verdicts are the proof: the table bottom at the reading
        # position, and the incoming state with the new-activity requirement.
        steps = self.steps()
        table = next(i for i, step in enumerate(steps)
                     if step[0] == "reading" and step[1] == "table-bottom")
        incoming = next(i for i, step in enumerate(steps)
                        if step[0] == "reading" and step[1] == "incoming")
        for label, index, needle in (
            ("the table-bottom verdict", table, "table-bottom"),
            ("the incoming verdict", incoming, "require-new-activity"),
        ):
            with self.subTest(removed=label):
                code, out = self.check(self.copy_with(lambda steps: steps.pop(index)))
                self.assertEqual(code, 1, out)
                self.assertIn("spec red: J16", out)
                self.assertIn(needle, out)

    def test_j16_without_the_held_follow_up_is_red(self) -> None:
        # Without the held reply there is no new-activity state to measure,
        # and a verdict that never runs would leave the pill's overlap
        # unproven while the gate stayed green.
        steps = self.steps()
        slow = next(i for i, step in enumerate(steps)
                    if step[0] == "fill" and "[seed] slow" in str(step[2]))
        code, out = self.check(self.copy_with(lambda steps: steps.pop(slow)))
        self.assertEqual(code, 1, out)
        self.assertIn("spec red: J16", out)
        self.assertIn("[seed] slow", out)

    def test_j16_without_the_approval_card_hygiene_is_red(self) -> None:
        # #542 proved the seeded inbox's approval card covers the table; the
        # deny/gone fixture hygiene is the difference between a reading and a
        # photograph of an overlay. Dropping the deny clicks must be loud.
        steps = self.steps()
        deny = [i for i, step in enumerate(steps)
                if step[0] == "click"
                and str(step[1]).lstrip("?").startswith("[data-kin-approval-card]")]
        self.assertEqual(len(deny), 3, steps)

        def drop_denies(steps):
            steps[:] = [step for step in steps
                        if not (step[0] == "click"
                                and str(step[1]).lstrip("?").startswith("[data-kin-approval-card]"))]

        code, out = self.check(self.copy_with(drop_denies))
        self.assertEqual(code, 1, out)
        self.assertIn("spec red: J16", out)
        self.assertIn("deny the seeded approvals", out)

        # Optional clicks all skipped on a hidden surface while `gone`
        # passed vacuously. Require at least one real dismissal, and count
        # both required and optional forms in a mixed cleanup sequence.
        def optional_denies(steps):
            for i in deny:
                steps[i][1] = "?" + steps[i][1].lstrip("?")

        code, out = self.check(self.copy_with(optional_denies))
        self.assertEqual(code, 1, out)
        self.assertIn("required [data-kin-approval-card] deny", out)

        def mixed_denies(steps):
            optional_denies(steps)
            steps[deny[0]][1] = steps[deny[0]][1].lstrip("?")

        code, out = self.check(self.copy_with(mixed_denies))
        self.assertEqual(code, 0, out)

    def test_j16_scrolls_away_before_the_follow_up_bubble_is_red(self) -> None:
        # The send pins the pane to the bottom. Without the bubble wait the
        # scroll-away races that pin and the reply lands in view, so the
        # incoming verdict measures the wrong state.
        def drop_bubble_wait(steps):
            steps[:] = [step for step in steps
                        if not (step[0] == "wait"
                                and "Reading follow-up while the reader is away" in str(step[1]))]

        code, out = self.check(self.copy_with(drop_bubble_wait))
        self.assertEqual(code, 1, out)
        self.assertIn("spec red: J16", out)
        self.assertIn("follow-up bubble", out)

    def test_j16_paths_rows_cover_layout_design_and_locales(self) -> None:
        # First match wins: a tabs/chrome diff, a CSS/token diff and a label
        # diff each stop at their own row, so J16 must be on all three or the
        # 820 width is skipped for exactly the changes #537 found.
        def drop(spec):
            for row in spec["paths"]:
                if row[0].startswith(("ui/src/components/layout/", "ui/src/components/ui/",
                                      "ui/src/i18n/locales/")):
                    row[1] = [journey for journey in row[1] if journey != "J16"]

        code, out = self.check(self.copy_spec_with(drop))
        self.assertEqual(code, 1, out)
        self.assertIn("spec red: J16", out)
        for needle in ("SessionTabs.tsx", "ui/src/index.css", "ui/src/i18n/locales/en.ts"):
            self.assertIn(needle, out)

    def test_j16_tablet_viewport_without_touch_is_red(self) -> None:
        # A bare "820x1180" string is the regression this journey exists to
        # keep out: it resolves to hasTouch false and measures a mouse.
        def strip_touch(spec):
            spec["viewports"]["tablet"] = "820x1180"

        code, out = self.check(self.copy_spec_with(strip_touch))
        self.assertEqual(code, 1, out)
        self.assertIn("spec red: J16", out)
        self.assertIn("hasTouch false", out)

    def test_j16_paths_rows_select_it_and_stop_at_settings(self) -> None:
        # First match wins: dropping J16 from the conversation row must be
        # red, and a broad row that hands a settings diff the tablet walk must
        # be red too.
        def drop(spec):
            for row in spec["paths"]:
                if "TaskDetail" in row[0] and "J16" in row[1]:
                    row[1] = [journey for journey in row[1] if journey != "J16"]

        code, out = self.check(self.copy_spec_with(drop))
        self.assertEqual(code, 1, out)
        self.assertIn("spec red: J16", out)
        self.assertIn("paths table", out)

        def broaden(spec):
            for row in spec["paths"]:
                if row[0].startswith("ui/src/pages/Settings"):
                    row[1].append("J16")

        code, out = self.check(self.copy_spec_with(broaden))
        self.assertEqual(code, 1, out)
        self.assertIn("spec red: J16", out)
        self.assertIn("settings diff", out)


class WalkJ17ContractTest(unittest.TestCase):
    """The iPad portrait resting composer is a measured box, not a class string.

    #580 fixed the 0px textarea at 768 and the 33px one at 820, but its proof
    lived in a PR body: a DOM test can assert the arrangement classes and
    cannot see the rendered width. J17 measures the un-focused box before
    anything focuses it (Watch 90), presses the card and reads the caret, types
    a 40-character draft and bounds it to two lines, hit-tests the textarea
    while the queued guide is on screen, and measures every hittable control in
    the composer card and bottom chrome against the 44px thumb floor at rest
    and again once the draft arms the send (the phone-only lint is off at
    768/820). These cases are the Python-side proof
    that ``--check-spec`` refuses a walk that lost any half.
    """

    def setUp(self) -> None:
        self.tmp = tempfile.mkdtemp(prefix="j17-contract-")
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
        spec = load_spec()
        mutate(spec["journeys"]["J17"]["steps"])
        path = os.path.join(self.tmp, "steps.json")
        with open(path, "w", encoding="utf-8") as fh:
            json.dump(spec, fh, ensure_ascii=False)
        return path

    def copy_spec_with(self, mutate) -> str:
        spec = load_spec()
        mutate(spec)
        path = os.path.join(self.tmp, "spec.json")
        with open(path, "w", encoding="utf-8") as fh:
            json.dump(spec, fh, ensure_ascii=False)
        return path

    @staticmethod
    def steps() -> list:
        return load_spec()["journeys"]["J17"]["steps"]

    def test_shipped_j17_spec_is_ok(self) -> None:
        code, out = self.check()
        self.assertEqual(code, 0, out)
        self.assertIn("spec ok: J17", out)
        self.assertEqual(
            load_spec()["journeys"]["J17"]["viewports"], ["tablet", "tablet-portrait"],
            "J17 is the 768/820 iPad portrait resting-composer proof")

    def test_j17_rejects_a_resting_measurement_after_a_fill(self) -> None:
        # Watch 90: a walk that fills first measures the raised arrangement,
        # which is `w-full` at every width, so the collapse photographs green.
        steps = self.steps()
        resting = next(i for i, step in enumerate(steps)
                       if step[0] == "restingComposer"
                       and (len(step) < 3 or step[2] in ("", "resting")))
        fill = next(i for i, step in enumerate(steps)
                    if step[0] == "fill" and "textarea" in str(step[1]))

        def fill_before_resting(steps):
            steps.insert(resting, list(steps[fill]))

        code, out = self.check(self.copy_with(fill_before_resting))
        self.assertEqual(code, 1, out)
        self.assertIn("spec red: J17", out)
        self.assertIn("measure the resting composer before anything focuses or fills it", out)

    def test_j17_rejects_a_bare_viewport_string(self) -> None:
        # A bare "768x1024" string resolves to hasTouch false through
        # phoneLayout, i.e. an iPad measured as a mouse.
        def strip_touch(spec):
            spec["viewports"]["tablet-portrait"] = "768x1024"

        code, out = self.check(self.copy_spec_with(strip_touch))
        self.assertEqual(code, 1, out)
        self.assertIn("spec red: J17", out)
        self.assertIn("hasTouch false", out)

    def test_j17_rejects_a_missing_hit_test(self) -> None:
        def drop_hit_test(steps):
            steps[:] = [step for step in steps
                        if not (step[0] == "restingComposer"
                                and len(step) > 2 and step[2] == "hit-test")]

        code, out = self.check(self.copy_with(drop_hit_test))
        self.assertEqual(code, 1, out)
        self.assertIn("spec red: J17", out)
        self.assertIn("hit-test", out)

    def test_j17_rejects_a_missing_composer_control_measurement(self) -> None:
        # #589/#595 floored the composer controls by class string, but J17's
        # tablet viewports are `isMobile: false`, so walk.mjs's phone-only
        # smallTapTargets lint never runs there. A J17 that measures only the
        # textarea leaves the send, attach and chip controls unread, and a
        # 43px send would photograph green (Watch 53, TASTE 21).
        def drop_control_measurement(steps):
            steps[:] = [step for step in steps if step[0] != "composerControls"]

        code, out = self.check(self.copy_with(drop_control_measurement))
        self.assertEqual(code, 1, out)
        self.assertIn("spec red: J17", out)
        self.assertIn("every composer control", out)

    def test_j17_rejects_a_composer_control_measurement_only_at_rest(self) -> None:
        # The resting send is `disabled` while the draft is empty, so the
        # enabled filter skips it. A J17 that measures only at rest never reads
        # the control Watch 53 is about, and a 40px send still walks green at
        # 768/820; the reading must run again once the draft arms the send.
        def drop_armed_measurement(steps):
            fill = next(i for i, step in enumerate(steps)
                        if step[0] == "fill" and len(str(step[2])) == 40)
            steps[:] = [step for i, step in enumerate(steps)
                        if not (i > fill and step[0] == "composerControls")]

        code, out = self.check(self.copy_with(drop_armed_measurement))
        self.assertEqual(code, 1, out)
        self.assertIn("spec red: J17", out)
        self.assertIn("arms the send", out)

    def test_j17_rejects_a_composer_control_measurement_after_the_card_press(self) -> None:
        # The card press focuses the textarea and raises the composer, so a
        # control reading that runs after it measures the wrong arrangement;
        # the resting reading must come first, while the box is collapsed.
        def move_resting_measurement_after_the_press(steps):
            resting = next(i for i, step in enumerate(steps)
                           if step[0] == "composerControls" and step[1] == "resting")
            press = next(i for i, step in enumerate(steps)
                         if step[0] == "pressComposerCard")
            step = steps.pop(resting)
            steps.insert(press, step)

        code, out = self.check(self.copy_with(move_resting_measurement_after_the_press))
        self.assertEqual(code, 1, out)
        self.assertIn("spec red: J17", out)
        self.assertIn("only after the card press", out)

    def test_j17_rejects_a_missing_hidden_action_row_hit_test(self) -> None:
        # The 820 hidden-actions proof: the row rests invisible AND inert, and
        # the reading is elementFromPoint plus computed style, not a class
        # string (Watch 53). Dropping the notSelf reading must be red.
        def drop_hidden_reading(steps):
            steps[:] = [step for step in steps
                        if not (step[0] == "hittest" and len(step) > 2 and step[2] == "notSelf")]

        code, out = self.check(self.copy_with(drop_hidden_reading))
        self.assertEqual(code, 1, out)
        self.assertIn("spec red: J17", out)
        self.assertIn("hidden action row", out)

    def test_j17_rejects_a_hidden_row_hit_test_with_the_row_off_screen(self) -> None:
        # The seeded conversation has grown by the time J17 runs (J2 reruns
        # it), so the first action row opens above the viewport and
        # elementFromPoint reports a miss. The walk must open the transcript
        # at the top before it reads the hidden row.
        def drop_scroll_to_top(steps):
            steps[:] = [step for step in steps
                        if not (step[0] == "scroll" and step[2] == "0")]

        code, out = self.check(self.copy_with(drop_scroll_to_top))
        self.assertEqual(code, 1, out)
        self.assertIn("spec red: J17", out)
        self.assertIn("scrolls the transcript to the top", out)

    def test_j17_rejects_a_reveal_without_a_body_tap(self) -> None:
        # A reveal that nobody asked for (or a click on the row itself) is not
        # the proof: the tap must land on the answer body, never on 重试.
        def drop_body_tap(steps):
            steps[:] = [step for step in steps
                        if not (step[0] == "click" and "[data-message-actions]) p" in str(step[1]))]

        code, out = self.check(self.copy_with(drop_body_tap))
        self.assertEqual(code, 1, out)
        self.assertIn("spec red: J17", out)
        self.assertIn("never taps the answer body", out)

    def test_j17_paths_rows_select_the_composer_and_the_dock(self) -> None:
        # First match wins: dropping J17 from the conversation row must be red
        # for both files, or a composer diff would stop walking 768/820.
        def drop(spec):
            for row in spec["paths"]:
                if row[0].startswith("ui/src/pages/TaskDetail") and "J17" in row[1]:
                    row[1] = [journey for journey in row[1] if journey != "J17"]

        code, out = self.check(self.copy_spec_with(drop))
        self.assertEqual(code, 1, out)
        self.assertIn("spec red: J17", out)
        self.assertIn("Composer.tsx", out)
        self.assertIn("TaskComposerDock.tsx", out)


class JourneyContractCoverageTest(unittest.TestCase):
    """The index, the contracts and their test classes must name the same journeys.

    `--check-spec` runs one contract per journey and this file runs one class
    per contract, but nothing compared the sets. A journey that lands with no
    contract, a contract whose definition is never dispatched, or a contract
    test class renamed away all leave `./scripts/check.sh` green while the walk
    loses a proof only a browser walk would notice. These cases are the
    set-level guard: every id in the real index (never the reduced fixture
    specs the other classes build) must have all three halves, and a spec that
    loses journeys wholesale must not pass an empty loop.
    """

    def setUp(self) -> None:
        with open(WALK, encoding="utf-8") as fh:
            self.walk = fh.read()
        with open(os.path.join(SCRIPTS, os.path.basename(__file__)), encoding="utf-8") as fh:
            self.tests = fh.read()
        with open(SPEC, encoding="utf-8") as fh:
            # The raw index is read only to count what it ships; the walker's
            # own reader (load_spec) is what the guard iterates.
            self.index = json.load(fh)["journeys"]
        self.spec = load_spec()

    def test_every_journey_has_a_contract_and_a_test_class(self) -> None:
        self.assertTrue(self.spec["journeys"], "the journey index resolves to no journeys")
        for journey in self.spec["journeys"]:
            with self.subTest(journey=journey):
                self.assertRegex(
                    journey, r"^J\d+$",
                    f"{journey} is in the journey index but is not a J<n> id, "
                    "so no contract can be named for it",
                )
                self.assertIn(
                    f"function check{journey}Contract(", self.walk,
                    f"{journey} is in the journey index but walk.mjs defines no "
                    f"check{journey}Contract; write the contract (the #359/#362 "
                    "shape), do not exempt the journey",
                )
                self.assertIn(
                    f"class Walk{journey}ContractTest(", self.tests,
                    f"{journey} is in the journey index but this file has no "
                    f"Walk{journey}ContractTest class; its contract would have no "
                    "Python-side proof",
                )

    def test_the_check_spec_dispatch_calls_every_contract(self) -> None:
        lines = self.walk.splitlines()
        starts = [
            i for i, line in enumerate(lines)
            if "process.argv.includes('--check-spec')" in line
        ]
        self.assertEqual(
            len(starts), 1,
            "walk.mjs no longer has exactly one --check-spec dispatch; the "
            "coverage guard cannot find the calls",
        )
        start = starts[0]
        ends = [i for i in range(start + 1, len(lines)) if lines[i] == "}"]
        self.assertTrue(ends, "walk.mjs's --check-spec block is never closed")
        region = "\n".join(lines[start:ends[0] + 1])
        # The definitions sit above the dispatch. If this region ever grew to
        # include them, `function checkJ<n>Contract(` would satisfy the call
        # search and a deleted call would go unseen.
        self.assertNotIn(
            "function check", region,
            "the --check-spec region starts before the contract definitions, so "
            "the call search would match the definitions themselves",
        )
        for journey in self.spec["journeys"]:
            with self.subTest(journey=journey):
                self.assertIn(
                    f"check{journey}Contract(spec)", region,
                    f"{journey}'s contract is defined but --check-spec never "
                    f"calls check{journey}Contract(spec); a dead contract proves "
                    "nothing",
                )

    def test_the_guard_is_not_vacuous(self) -> None:
        journeys = list(self.spec["journeys"])
        self.assertGreaterEqual(
            len(journeys), 12,
            f"the journey index resolves to {len(journeys)} journeys; a spec "
            "that loses journeys wholesale must fail loudly, not pass an empty loop",
        )
        self.assertEqual(
            len(journeys), len(self.index),
            "the guard dropped journey ids the index ships; a parser change must "
            "not shrink the set silently",
        )
        self.assertIn(
            "J15", journeys,
            "the guard no longer sees J15, the newest journey before this row; "
            "the journey reader is broken",
        )


TABLET_SPEC = os.path.join(ROOT, "rsi", "runtime", "ux", "tablet-reading.json")


def reading_metrics(**over: object) -> dict:
    """A measured state that passes every tablet-reading criterion.

    The shape is walk.mjs's `reading` op output, not a product fixture: the
    tests below only vary one measured field at a time so a red verdict names
    the criterion that produced it.
    """
    metrics: dict = {
        "fixture": {"marker": True, "rows": 5},
        "viewport": {"width": 820, "height": 1180},
        "chrome": {"height": 44},
        "scrollPane": {"present": True},
        "actions": [
            {"name": "workspace", "width": 44, "height": 44, "clipped": False},
            {"name": "pull-request", "width": 44, "height": 44, "clipped": False},
            {"name": "share", "width": 44, "height": 44, "clipped": False},
        ],
        "cells": [
            {"row": 0, "col": 0, "kind": "th", "visible": True, "relation": "self"},
            {"row": 0, "col": 1, "kind": "th", "visible": True, "relation": "descendant"},
            {"row": 1, "col": 0, "kind": "td", "visible": True, "relation": "descendant"},
            {"row": 4, "col": 0, "kind": "td", "visible": True, "relation": "self"},
            {"row": 4, "col": 3, "kind": "td", "visible": True, "relation": "descendant"},
            # A cell below the fold is measured, never sampled; it must not
            # turn the verdict green or red on its own.
            {"row": 5, "col": 0, "kind": "td", "visible": False},
        ],
        "lastRow": {"present": True, "visible": True, "fullyVisible": True},
        "newActivity": {"present": False, "covers": 0},
    }
    metrics.update(over)
    return metrics


@unittest.skipUnless(NODE, "node is not installed; the journey walker needs it")
class WalkTabletReadingTest(unittest.TestCase):
    """The 820 reading diagnostic is a real seam, not a renamed green walk."""

    def run_node(self, *args: str) -> subprocess.CompletedProcess[str]:
        return subprocess.run(
            [NODE, WALK, *args], capture_output=True, text=True, timeout=60
        )

    def verdict(self, metrics: dict) -> tuple[int, dict]:
        with tempfile.TemporaryDirectory() as tmp:
            path = os.path.join(tmp, "metrics.json")
            with open(path, "w", encoding="utf-8") as fh:
                json.dump(metrics, fh)
            result = self.run_node("--reading-verdict", path)
        self.assertTrue(result.stdout.strip(), result.stderr)
        return result.returncode, json.loads(result.stdout)

    def test_tablet_context_has_touch_without_phone_layout(self) -> None:
        # 820 is the owner's iPad width: a desktop layout (isMobile false) that
        # still receives a finger (hasTouch true). Asking the resolver the walk
        # itself calls, not a second copy of the numbers.
        result = self.run_node("--spec", TABLET_SPEC, "--context-options", "tablet")
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        tablet = json.loads(result.stdout)
        self.assertEqual(tablet["viewport"], {"width": 820, "height": 1180})
        self.assertTrue(tablet["hasTouch"])
        self.assertFalse(tablet["isMobile"])

        # The two acceptance widths keep their meaning: 390 is a phone (touch
        # and phone layout), 1100 is a pointer device (desktop layout).
        for name, touch, mobile in (("phone", True, True), ("mac", False, False)):
            result = self.run_node("--spec", SPEC, "--context-options", name)
            self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
            got = json.loads(result.stdout)
            self.assertEqual(got["hasTouch"], touch, name)
            self.assertEqual(got["isMobile"], mobile, name)

        # An unknown name must refuse rather than invent a context.
        result = self.run_node("--spec", TABLET_SPEC, "--context-options", "watch")
        self.assertEqual(result.returncode, 2, result.stdout + result.stderr)
        self.assertIn("watch", result.stderr)

    def test_tablet_reading_metrics_reject_empty_or_hidden_cells(self) -> None:
        # No verdict may be produced from a fixture that never rendered, from
        # samples that are all off screen, or from a page with no actions or
        # scroll pane: an empty measurement is unavailable, never 0 failures.
        cases = {
            "zero-table-rows": reading_metrics(fixture={"marker": True, "rows": 0}),
            "marker-absent": reading_metrics(fixture={"marker": False, "rows": 5}),
            "off-screen-only": reading_metrics(
                cells=[{"row": 0, "col": 0, "kind": "td", "visible": False}]
            ),
            "no-actions": reading_metrics(actions=[]),
            "no-scroll-pane": reading_metrics(scrollPane={"present": False}),
            "no-final-row": reading_metrics(lastRow={"present": False}),
        }
        for name, metrics in cases.items():
            with self.subTest(case=name):
                code, doc = self.verdict(metrics)
                self.assertEqual(code, 2, doc)
                self.assertFalse(doc["available"], doc)
                self.assertFalse(doc["ok"], doc)
                self.assertTrue(doc.get("unavailable"), doc)

    def test_tablet_reading_detects_small_action_and_occluded_cell(self) -> None:
        # The four findings, each carried by its own criterion so one failure
        # cannot suppress the others.
        red = reading_metrics(
            chrome={"height": 170},
            actions=[
                {"name": "pull-request", "width": 30, "height": 44, "clipped": True},
                {"name": "share", "width": 44, "height": 44, "clipped": False},
            ],
            cells=[
                {"row": 0, "col": 0, "kind": "th", "visible": True, "relation": "self"},
                {"row": 4, "col": 0, "kind": "td", "visible": True, "relation": "other"},
            ],
            lastRow={"present": True, "visible": True, "fullyVisible": False},
            newActivity={"present": True, "covers": 1},
        )
        code, doc = self.verdict(red)
        self.assertEqual(code, 1, doc)
        self.assertFalse(doc["ok"], doc)
        self.assertEqual(
            {name for name, value in doc["criteria"].items() if not value["ok"]},
            {"chrome", "actions", "cells", "lastRow", "newActivity"},
            doc,
        )
        text = " ".join(doc["failures"])
        for want in ("chrome", "30", "cell", "final table row", "new-activity"):
            self.assertIn(want, text, doc)

        # 44 px targets, a cell or a descendant of it under the point, a 44 px
        # chrome, and a full final row are green. An unrelated ancestor under
        # the point is not the cell and must stay red.
        green = reading_metrics(newActivity={"present": True, "covers": 0})
        code, doc = self.verdict(green)
        self.assertEqual(code, 0, doc)
        self.assertTrue(doc["ok"], doc)
        self.assertNotIn("failures", [key for key, value in doc["criteria"].items() if not value["ok"]])

        ancestor = reading_metrics(
            cells=[{"row": 0, "col": 0, "kind": "td", "visible": True, "relation": "ancestor"}]
        )
        code, doc = self.verdict(ancestor)
        self.assertEqual(code, 1, doc)
        self.assertFalse(doc["criteria"]["cells"]["ok"], doc)

        # The reported pill-over-table shape: the control geometrically
        # overlaps visible cells even when another element wins the hit test.
        overlaps_only = reading_metrics(
            newActivity={"present": True, "covers": 0, "overlaps": 2}
        )
        code, doc = self.verdict(overlaps_only)
        self.assertEqual(code, 1, doc)
        self.assertFalse(doc["criteria"]["newActivity"]["ok"], doc)
        self.assertIn("overlaps 2 visible cell", " ".join(doc["failures"]), doc)


if __name__ == "__main__":
    if sys.argv[1:] == ["--check-spec"]:
        raise SystemExit(subprocess.call([NODE, WALK, "--check-spec", "--spec", SPEC]))
    unittest.main()
