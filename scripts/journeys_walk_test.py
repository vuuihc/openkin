#!/usr/bin/env python3
"""Tests for the spec contracts in rsi/runtime/ux/walk.mjs.

Run directly: `python3 -B scripts/journeys_walk_test.py`. Pure: fixture
seed.log and spec files, no browser, no daemon, no network. The walker's
`--resolve-j1` / `--resolve-j7` modes run the same read/apply functions the
real walk uses, so a green case here is the resolution that walk would take.
`--check-spec` runs the J2 review-loop, J3 send, J8 phone-tap, J9 Mac switch
and J11 phone switch contracts through the same parser, so a spec that
regressed to photographing the diff, to merely asserting Start is usable, to
pressing a desktop chord on the phone, or to leaving the shell, the scroll and
the draft unread, fails before a browser starts.
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
        self.assertEqual(len(clicks), 1, steps)
        self.assertFalse(clicks[0][1].startswith("?"), "the row-menu click is optional")
        self.assertIn("[data-row-actions]", clicks[0][1])
        self.assertIn("{j5.conversation}", clicks[0][1])

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
        self.assertGreater(running_at, steps.index(clicks[0]))
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
J4_ALPHA_LINK = "css=a[href^='/projects/']:has-text('Project Alpha')"


def j4_contract_problems(steps: list) -> list[str]:
    """Everything J4 must carry: the folder-editor leg and the instructions leg."""
    return _j4_roots_problems(steps) + j4_instructions_problems(steps)


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
    empty_note = at(
        lambda step: section_wait(step, "新对话不会收到这一段")
        or section_wait(step, "New chats will not receive this section"),
        max(empty, 0) + 1,
    )
    if empty >= 0 and empty_note < 0:
        problems.append("J4 never reads the empty state footnote (新对话不会收到这一段)")

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

    def is_default(step: list) -> bool:
        return step[0] == "click" and J4_DEFAULT in str(step[1]) and J4_DEFAULT_EN in str(step[1])

    def is_gone_editor(step: list) -> bool:
        return (step[0] == "gone" and J4_SAVE in str(step[1]) and J4_SAVE_EN in str(step[1]))

    link = at(lambda step: step[0] == "click" and step[1] == J4_ALPHA_LINK)
    if link < 0:
        problems.append("J4 never opens Project Alpha by name (click %s)" % J4_ALPHA_LINK)
    elif not required(steps[link]):
        problems.append("the Project Alpha link click is optional")
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
    # re-reads /api/projects and proves the store's order.
    goto = (
        at(lambda step: step[0] == "goto" and str(step[1]).rstrip("/") == "/projects", second_save + 1)
        if second_save >= 0
        else -1
    )
    if second_save >= 0 and goto < 0:
        problems.append("J4 never reloads the document (goto /projects) after the save; a route change reads the page, not the store")
    reload_link = (
        at(lambda step: step[0] == "click" and step[1] == J4_ALPHA_LINK, goto + 1) if goto >= 0 else -1
    )
    if goto >= 0 and reload_link < 0:
        problems.append("J4 never reopens Project Alpha after the reload")
    elif reload_link >= 0 and not required(steps[reload_link]):
        problems.append("the post-reload Project Alpha click is optional")

    if reload_link >= 0:
        last_row = at(
            lambda step: step[0] == "wait"
            and "aaa-config" in str(step[1])
            and "last-child" in str(step[1]),
            reload_link + 1,
        )
        if last_row < 0:
            problems.append("the reloaded cover never proves aaa-config is the LAST row (saved order, not sorted order)")
        first_row = at(
            lambda step: step[0] == "wait"
            and "/alpha" in str(step[1])
            and "first-child" in str(step[1]),
            reload_link + 1,
        )
        if first_row < 0:
            problems.append("the reloaded cover never proves alpha is the first row")
        badge = at(
            lambda step: step[0] == "wait"
            and "默认" in str(step[1])
            and "Default" in str(step[1])
            and "first-child" in str(step[1]),
            reload_link + 1,
        )
        if badge < 0:
            problems.append("the reloaded cover never proves the first row carries 默认 / Default")
        count = at(
            lambda step: step[0] == "count"
            and len(step) > 2
            and str(step[2]) == "2"
            and "li" in str(step[1]),
            max(last_row, first_row, badge) + 1,
        )
        if count < 0:
            problems.append("the reloaded cover never counts exactly two folder rows")
        reloaded = at(lambda step: is_shot(step, "roots-reloaded"), reload_link + 1)
        if reloaded < 0:
            problems.append("J4 takes no roots-reloaded shot after reloading the document")
        elif saved_shot >= 0 and reloaded < saved_shot:
            problems.append("the roots-reloaded shot comes before roots-saved")
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
        # Today's shape: goto /projects, photograph the cover, leave for
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

    def test_j4_contract_rejects_a_route_change_instead_of_a_reload(self) -> None:
        # A client-side return to the cover reads the state the editor just
        # installed; only `goto` re-reads /api/projects.
        def drop_reload(steps: list) -> None:
            save = max(
                i for i, step in enumerate(steps)
                if step[0] == "click" and J4_SAVE in str(step[1])
            )
            at = next(
                i for i in range(save + 1, len(steps))
                if steps[i][0] == "goto" and str(steps[i][1]).rstrip("/") == "/projects"
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


if __name__ == "__main__":
    unittest.main()
