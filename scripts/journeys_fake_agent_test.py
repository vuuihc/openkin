#!/usr/bin/env python3
"""Tests for scripts/journeys_fake_agent/claude's bounded branches.

Run directly: `python3 -B scripts/journeys_fake_agent_test.py`. Hermetic: the
fake is a shell script speaking stream-json on stdout, so each case starts the
real script with a prompt and reads its output against deadlines. No daemon,
no browser, no network.

The slow branch is what makes the J3 walk's `sent` screenshot deterministic:
the walk presses Start, photographs the pending bubble and the waiting row,
and only then waits for the reply. If the fake answered in one burst the
pending state would be a race, and the gate would flake instead of proving
anything.

The workspace branch is the fixture for P3 item 3's second round: `[seed]
change` leaves a diff to comment on, `[seed] shift` moves that line down and
`[seed] rewrite` changes its text, so a walk can prove a saved comment
re-anchors and then goes stale. Each write case runs in a throwaway directory
named with the seed prefix; the guard case proves nothing is written outside
one.
"""

from __future__ import annotations

import json
import os
import select
import shutil
import subprocess
import tempfile
import time
import unittest

SCRIPTS = os.path.dirname(os.path.abspath(__file__))
FAKE = os.path.join(SCRIPTS, "journeys_fake_agent", "claude")

SLOW_PROMPT = "Draft: summarise this week's TODOs [seed] slow"
PLAIN_PROMPT = "Draft: summarise this week's TODOs"
REPLY = "Fake reply from the journey fake agent."

# The lines the fake writes into notes.md. The shell fake and
# scripts/journeys_seed.py carry the same literals; a re-run finds them and
# leaves the file alone.
CHANGE_SENTINEL = "- [seed] change: the journey walk reads this line as a real diff."
SHIFT_LINE = "- [seed] shift: a line added above the commented one."
REWRITE_LINE = "- [seed] rewrite: this line changed after the comment was written."
NOTES = (
    "# alpha notes",
    "",
    "- Seeded for the journey walk.",
    "- The walk opens the diff the fake agent leaves in this file.",
)
SHIFT_PROMPT = "Push the notes down one line [seed] shift"
REWRITE_PROMPT = "Rewrite the commented line [seed] rewrite"


def fake_env(**extra: str) -> dict[str, str]:
    """The caller's environment with the slow override removed, then `extra`.

    A developer who exported RSI_FAKE_SLOW_SECS must not change what these
    tests assert; every case states its own value.
    """
    env = {k: v for k, v in os.environ.items() if k != "RSI_FAKE_SLOW_SECS"}
    env.update(extra)
    return env


class FakeAgentCase(unittest.TestCase):
    """Shared plumbing: start the real fake and read it against deadlines."""

    def start(self, prompt: str, cwd: str | None = None, **env: str) -> subprocess.Popen[str]:
        proc = subprocess.Popen(
            [FAKE, "-p", prompt],
            cwd=cwd,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            env=fake_env(**env),
        )
        self.addCleanup(self.stop, proc)
        return proc

    @staticmethod
    def stop(proc: subprocess.Popen[str]) -> None:
        if proc.poll() is None:
            proc.kill()
        try:
            proc.wait(timeout=10)
        except subprocess.TimeoutExpired:
            pass
        for stream in (proc.stdout, proc.stderr):
            if stream is not None:
                stream.close()

    @staticmethod
    def collect(proc: subprocess.Popen[str], seconds: float) -> list[str]:
        """Lines written to stdout within `seconds` (returns early on EOF)."""
        lines: list[str] = []
        deadline = time.monotonic() + seconds
        while True:
            left = deadline - time.monotonic()
            if left <= 0:
                break
            ready, _, _ = select.select([proc.stdout], [], [], left)
            if not ready:
                break
            line = proc.stdout.readline()
            if not line:
                break
            lines.append(line)
        return lines


class FakeAgentSlowTest(FakeAgentCase):

    def test_slow_prompt_stays_running_then_answers(self) -> None:
        # The walk's `sent` shot depends on this shape: the init line now, no
        # result for at least the pending window, then the reply and exit 0.
        proc = self.start(SLOW_PROMPT)
        first = self.collect(proc, 1.0)
        self.assertTrue(
            any('"type":"system"' in line and '"init"' in line for line in first),
            f"the init line must appear immediately, got {first!r}",
        )
        self.assertFalse(
            any('"type":"result"' in line for line in first),
            f"a result within 1.0s leaves no pending window to photograph: {first!r}",
        )
        # 2.5s from launch is still inside the default 3s hold, so a result
        # here would mean the branch answers in one burst.
        held = self.collect(proc, 1.5)
        self.assertFalse(
            any('"type":"result"' in line for line in held),
            f"a result within ~2.5s is not the slow branch: {held!r}",
        )
        rest = self.collect(proc, 15)
        self.assertTrue(
            any('"type":"assistant"' in line and REPLY in line for line in rest),
            f"the reply never arrived after the hold: {rest!r}",
        )
        self.assertTrue(
            any('"type":"result"' in line and '"is_error":false' in line for line in rest),
            f"the turn never finished successfully: {rest!r}",
        )
        self.assertEqual(proc.wait(timeout=15), 0)

    def test_slow_hold_covers_the_project_instructions_echo(self) -> None:
        # J3's waiting row is drawn only while nothing has streamed in the
        # round (shouldShowGenericThinking), so the [seed] slow hold must
        # cover the WHOLE answer — the project-instructions echo included.
        # An echo printed before the hold ends the pending window and turns
        # J3's waiting-row proof back into a race.
        proc = self.start(CONTEXT_PROMPT + "\nGo [seed] slow", RSI_FAKE_SLOW_SECS="2")
        first = self.collect(proc, 1.0)
        self.assertTrue(
            any('"type":"system"' in line and '"init"' in line for line in first),
            f"the init line must appear immediately, got {first!r}",
        )
        self.assertFalse(
            any('"type":"assistant"' in line for line in first),
            f"an assistant line inside the hold ends the pending window: {first!r}",
        )
        self.assertNotIn(RECEIPT, "".join(first), f"the echo must wait for the hold: {first!r}")
        rest = self.collect(proc, 15)
        self.assertEqual(proc.wait(timeout=15), 0)
        events = [json.loads(line) for line in rest if line.strip()]
        texts = [
            block.get("text", "")
            for event in events
            if event.get("type") == "assistant"
            for block in (event.get("message") or {}).get("content") or []
            if isinstance(block, dict)
        ]
        receipt = [index for index, text in enumerate(texts) if RECEIPT in text]
        reply = [index for index, text in enumerate(texts) if REPLY in text]
        self.assertTrue(receipt, f"the receipt never arrived after the hold: {texts!r}")
        self.assertTrue(reply, f"the ordinary reply never arrived after the hold: {texts!r}")
        self.assertLess(receipt[0], reply[0], f"the receipt must precede the reply: {texts!r}")

    def test_slow_sleep_is_bounded(self) -> None:
        # 0 is immediate (a person debugging by hand waits for nothing), a
        # malformed value falls back to the default, and 99 is clamped so a
        # crashed walk can never hold a turn for minutes.
        immediate = time.monotonic()
        done = subprocess.run(
            [FAKE, "-p", SLOW_PROMPT],
            capture_output=True,
            text=True,
            env=fake_env(RSI_FAKE_SLOW_SECS="0"),
            timeout=15,
        )
        self.assertEqual(done.returncode, 0, done.stderr)
        self.assertIn(REPLY, done.stdout)
        self.assertLess(time.monotonic() - immediate, 2.0, "RSI_FAKE_SLOW_SECS=0 must not sleep")

        malformed = time.monotonic()
        done = subprocess.run(
            [FAKE, "-p", SLOW_PROMPT],
            capture_output=True,
            text=True,
            env=fake_env(RSI_FAKE_SLOW_SECS="soon"),
            timeout=15,
        )
        self.assertEqual(done.returncode, 0, done.stderr)
        self.assertIn(REPLY, done.stdout)
        self.assertLess(time.monotonic() - malformed, 8.0, "a malformed value must fall back to 3s")

        clamped = time.monotonic()
        done = subprocess.run(
            [FAKE, "-p", SLOW_PROMPT],
            capture_output=True,
            text=True,
            env=fake_env(RSI_FAKE_SLOW_SECS="99"),
            timeout=15,
        )
        elapsed = time.monotonic() - clamped
        self.assertEqual(done.returncode, 0, done.stderr)
        self.assertIn(REPLY, done.stdout)
        self.assertGreaterEqual(elapsed, 8.0, "99 must still hold the turn; the clamp is 10s, not 0")
        self.assertLess(elapsed, 13.5, "99 must clamp to 10s, well under the walk's 15s wait")

    def test_plain_prompt_answers_immediately(self) -> None:
        # Control: every other prompt keeps its today behaviour.
        started = time.monotonic()
        done = subprocess.run(
            [FAKE, "-p", PLAIN_PROMPT],
            capture_output=True,
            text=True,
            env=fake_env(),
            timeout=15,
        )
        self.assertEqual(done.returncode, 0, done.stderr)
        self.assertIn(REPLY, done.stdout)
        self.assertIn('"type":"result"', done.stdout)
        self.assertLess(time.monotonic() - started, 3.0, "a plain prompt must answer without a hold")


HOLD_PROMPT = "Keep the migration going [seed] hold"

# A prompt shaped the way internal/store.BuildContinuePrompt emits it, with a
# 工作方式 section. The fake must echo the body exactly as received — already
# cut to the digest's 400 runes — or the J4 walk cannot compare the cover with
# what the agent actually got.
SECTION_BODY = "- 交付前先跑 scripts/check.sh；生成文件不要手改。"
CONTEXT_PROMPT = (
    "[Project context — living cover digest; user owns goals]\n"
    "Project: [seed] Project Alpha\n"
    "Mode: ship\n"
    "Mode focus: use cover Focus/Next; prefer the smallest useful next step (mode=ship).\n"
    "\n"
    "North Star: A walkthrough daemon that already looks lived-in.\n"
    "Current Focus: Finish the journey walk.\n"
    "How to work here:\n"
    f"{SECTION_BODY}\n"
    "\n"
    "Next:\n"
    "1. Read the J4 project cover\n"
    "---\n"
    "Edit the working instructions."
)
RECEIPT = "Project instructions received:"


class FakeAgentProjectInstructionsTest(FakeAgentCase):
    """The agent's receipt for the injected 工作方式 section (KIN-PROJECT-003).

    The transcript deliberately hides injected context from the user bubble,
    so this assistant event is the only honest evidence of what the agent
    received. It must carry the body verbatim, appear before the ordinary
    reply, and stay absent when there is no section to acknowledge.
    """

    def run_prompt(self, prompt: str) -> subprocess.CompletedProcess[str]:
        return subprocess.run(
            [FAKE, "-p", prompt],
            capture_output=True,
            text=True,
            env=fake_env(),
            timeout=15,
        )

    @staticmethod
    def events(done: subprocess.CompletedProcess[str]) -> list[dict]:
        return [json.loads(line) for line in done.stdout.splitlines() if line.strip()]

    @staticmethod
    def texts(events: list[dict]) -> list[str]:
        return [
            block.get("text", "")
            for event in events
            if event.get("type") == "assistant"
            for block in (event.get("message") or {}).get("content") or []
            if isinstance(block, dict)
        ]

    def test_echoes_the_received_section_before_the_ordinary_reply(self) -> None:
        done = self.run_prompt(CONTEXT_PROMPT)
        self.assertEqual(done.returncode, 0, done.stderr)
        events = self.events(done)
        receipts = [text for text in self.texts(events) if RECEIPT in text]
        self.assertEqual(
            receipts,
            [RECEIPT + "\n" + SECTION_BODY],
            f"the receipt must carry the section body verbatim, got {receipts!r}",
        )
        reply = [text for text in self.texts(events) if REPLY in text]
        self.assertTrue(reply, f"the ordinary reply must still follow, got {self.texts(events)!r}")
        self.assertEqual(events[-1].get("type"), "result", "the ordinary result must still close the turn")
        self.assertIs(events[-1].get("is_error"), False, done.stdout)

    def test_no_receipt_without_a_work_instructions_section(self) -> None:
        prompt = CONTEXT_PROMPT.replace("How to work here:\n" + SECTION_BODY + "\n", "")
        done = self.run_prompt(prompt)
        self.assertEqual(done.returncode, 0, done.stderr)
        self.assertNotIn(RECEIPT, done.stdout)
        self.assertIn(REPLY, done.stdout)

    def test_no_receipt_without_project_context(self) -> None:
        # The section alone is not proof the digest was injected; the fake only
        # acknowledges a prompt that carries the project-context header.
        prompt = "How to work here:\n" + SECTION_BODY + "\n---\nDo the thing."
        done = self.run_prompt(prompt)
        self.assertEqual(done.returncode, 0, done.stderr)
        self.assertNotIn(RECEIPT, done.stdout)
        self.assertIn(REPLY, done.stdout)

    def test_no_receipt_for_an_empty_section(self) -> None:
        prompt = CONTEXT_PROMPT.replace(SECTION_BODY + "\n", "")
        done = self.run_prompt(prompt)
        self.assertEqual(done.returncode, 0, done.stderr)
        self.assertNotIn(RECEIPT, done.stdout)
        self.assertIn(REPLY, done.stdout)



class FakeAgentHoldTest(FakeAgentCase):
    """The still-working branch J5's row menu is photographed against.

    `[seed] hold` must never print a result: the moment one arrives the task
    leaves `running` and the shipped 运行中 line disappears from the menu. It
    prints one assistant line so the transcript is not empty, and it must ask
    for no tool_use — a tool_use in a non-yolo mode would produce an approval
    card and turn the row into `waiting_approval`, which is the tone this
    fixture exists to avoid.
    """

    def test_hold_prints_no_result_and_exits_at_the_hold_bound(self) -> None:
        proc = self.start(HOLD_PROMPT, RSI_FAKE_HOLD_SECS="2")
        first = self.collect(proc, 1.0)
        self.assertTrue(
            any('"type":"system"' in line and '"init"' in line for line in first),
            f"the init line must appear immediately, got {first!r}",
        )
        self.assertTrue(
            any("still working" in line for line in first),
            f"the one assistant line must appear before the hold, got {first!r}",
        )
        self.assertFalse(
            any('"type":"result"' in line for line in first),
            f"a result inside the hold would end the running state: {first!r}",
        )
        self.assertFalse(
            any("tool_use" in line for line in first),
            f"a tool_use could ask for an approval card: {first!r}",
        )
        rest = self.collect(proc, 10)
        self.assertEqual(proc.wait(timeout=15), 0)
        self.assertFalse(
            any('"type":"result"' in line for line in rest),
            f"the hold branch must never print a result, got {rest!r}",
        )

    def test_hold_sleep_is_bounded(self) -> None:
        # 0 releases at once (a person debugging by hand waits for nothing).
        immediate = time.monotonic()
        done = subprocess.run(
            [FAKE, "-p", HOLD_PROMPT],
            capture_output=True,
            text=True,
            env=fake_env(RSI_FAKE_HOLD_SECS="0"),
            timeout=15,
        )
        self.assertEqual(done.returncode, 0, done.stderr)
        self.assertLess(time.monotonic() - immediate, 2.0, "RSI_FAKE_HOLD_SECS=0 must not sleep")
        self.assertNotIn('"type":"result"', done.stdout)

        # A malformed value falls back to the 600s default, and an oversized
        # one clamps to 900: both are far longer than this window, so "still
        # alive" is the observable proof that neither became 0.
        for label, value in (("malformed", "soon"), ("oversized", "99999")):
            with self.subTest(value=label):
                proc = self.start(HOLD_PROMPT, RSI_FAKE_HOLD_SECS=value)
                time.sleep(1.5)
                self.assertIsNone(proc.poll(), f"{value} must hold the turn, not release it")
                self.assertNotIn(
                    '"type":"result"',
                    "".join(self.collect(proc, 0.2)),
                    "the hold branch must not print a result",
                )


class FakeAgentWorkspaceWriteTest(FakeAgentCase):
    """The rerun fixtures: `[seed] shift` and `[seed] rewrite` edit notes.md.

    P3 item 3's second round needs a line that moves and then a line whose text
    changes: a saved diff comment must re-anchor to the moved line, and read as
    stale (该行已变化) once its quote is gone. Each case writes the seeded
    notes.md itself, so the asserted bytes are the whole contract rather than a
    side effect of an earlier turn.
    """

    def seed_root(self, prefix: str = "kin-journeys-seed-") -> str:
        root = tempfile.mkdtemp(prefix=prefix)
        self.addCleanup(shutil.rmtree, root, True)
        return root

    @staticmethod
    def write_notes(root: str, *lines: str) -> None:
        with open(os.path.join(root, "notes.md"), "w", encoding="utf-8") as fh:
            fh.write("".join(line + "\n" for line in lines))

    @staticmethod
    def notes(root: str) -> str:
        with open(os.path.join(root, "notes.md"), encoding="utf-8") as fh:
            return fh.read()

    def run_marker(self, root: str, prompt: str) -> subprocess.CompletedProcess[str]:
        return subprocess.run(
            [FAKE, "-p", prompt],
            cwd=root,
            capture_output=True,
            text=True,
            env=fake_env(),
            timeout=15,
        )

    def test_shift_inserts_one_line_above_the_sentinel(self) -> None:
        root = self.seed_root()
        self.write_notes(root, *NOTES, CHANGE_SENTINEL)
        done = self.run_marker(root, SHIFT_PROMPT)
        self.assertEqual(done.returncode, 0, done.stderr)
        expected = "".join(line + "\n" for line in (*NOTES, SHIFT_LINE, CHANGE_SENTINEL))
        self.assertEqual(self.notes(root), expected, "the shift line must sit immediately above the sentinel")

        before = self.notes(root)
        again = self.run_marker(root, SHIFT_PROMPT)
        self.assertEqual(again.returncode, 0, again.stderr)
        self.assertEqual(self.notes(root), before, "a second [seed] shift must leave the file byte-identical")

    def test_rewrite_changes_the_sentinel_line_once(self) -> None:
        root = self.seed_root()
        self.write_notes(root, *NOTES, CHANGE_SENTINEL)
        done = self.run_marker(root, REWRITE_PROMPT)
        self.assertEqual(done.returncode, 0, done.stderr)
        content = self.notes(root)
        self.assertNotIn(CHANGE_SENTINEL, content, "the quoted text must be gone: that is the stale case")
        expected = "".join(line + "\n" for line in (*NOTES, REWRITE_LINE))
        self.assertEqual(content, expected)

        again = self.run_marker(root, REWRITE_PROMPT)
        self.assertEqual(again.returncode, 0, again.stderr)
        self.assertEqual(self.notes(root), content, "a second [seed] rewrite must leave the file byte-identical")

    def test_markers_write_nothing_outside_a_seed_root(self) -> None:
        # The prefix is the whole safety boundary: this fake can be selected by
        # path, so a marker must never edit a real repository's notes.md.
        root = self.seed_root(prefix="kin-not-a-seed-")
        self.write_notes(root, *NOTES, CHANGE_SENTINEL)
        before = self.notes(root)
        for prompt in (SHIFT_PROMPT, REWRITE_PROMPT):
            done = self.run_marker(root, prompt)
            self.assertEqual(done.returncode, 0, done.stderr)
            self.assertEqual(self.notes(root), before, f"{prompt!r} wrote outside a seed root")

    def test_marker_reply_still_streams(self) -> None:
        # The write turns must keep the adapter's protocol shape: init first,
        # then the assistant reply, then a successful result. The write
        # assertion is deliberate: a prompt that fell through to the plain tail
        # without doing anything would stream just as happily.
        for prompt, written in ((SHIFT_PROMPT, SHIFT_LINE), (REWRITE_PROMPT, REWRITE_LINE)):
            root = self.seed_root()
            self.write_notes(root, *NOTES, CHANGE_SENTINEL)
            done = self.run_marker(root, prompt)
            self.assertEqual(done.returncode, 0, done.stderr)
            self.assertIn(written, self.notes(root), f"{prompt!r} did not take its write branch")

            events = [json.loads(line) for line in done.stdout.splitlines() if line.strip()]
            kinds = [str(event.get("type") or "") for event in events]
            self.assertEqual(kinds[0], "system", f"the init line must come first: {events!r}")
            self.assertIn("assistant", kinds, f"the reply never arrived: {events!r}")
            self.assertIn("result", kinds, f"the turn never finished: {events!r}")
            self.assertLess(kinds.index("assistant"), kinds.index("result"), f"result before assistant: {events!r}")
            replies = [
                block.get("text", "")
                for event in events
                if event.get("type") == "assistant"
                for block in (event.get("message") or {}).get("content") or []
                if isinstance(block, dict)
            ]
            self.assertTrue(any(REPLY in text for text in replies), f"no assistant text carried the reply: {events!r}")
            self.assertIs(events[kinds.index("result")].get("is_error"), False, f"the turn did not succeed: {events!r}")


if __name__ == "__main__":
    unittest.main()
