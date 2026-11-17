#!/usr/bin/env python3
"""Tests for scripts/journeys_fake_agent/claude's bounded `[seed] slow` branch.

Run directly: `python3 -B scripts/journeys_fake_agent_test.py`. Hermetic: the
fake is a shell script speaking stream-json on stdout, so each case starts the
real script with a prompt and reads its output against deadlines. No daemon,
no browser, no network.

The slow branch is what makes the J3 walk's `sent` screenshot deterministic:
the walk presses Start, photographs the pending bubble and the waiting row,
and only then waits for the reply. If the fake answered in one burst the
pending state would be a race, and the gate would flake instead of proving
anything.
"""

from __future__ import annotations

import os
import select
import shutil
import subprocess
import time
import unittest

SCRIPTS = os.path.dirname(os.path.abspath(__file__))
FAKE = os.path.join(SCRIPTS, "journeys_fake_agent", "claude")

SLOW_PROMPT = "Draft: summarise this week's TODOs [seed] slow"
PLAIN_PROMPT = "Draft: summarise this week's TODOs"
REPLY = "Fake reply from the journey fake agent."


def fake_env(**extra: str) -> dict[str, str]:
    """The caller's environment with the slow override removed, then `extra`.

    A developer who exported RSI_FAKE_SLOW_SECS must not change what these
    tests assert; every case states its own value.
    """
    env = {k: v for k, v in os.environ.items() if k != "RSI_FAKE_SLOW_SECS"}
    env.update(extra)
    return env


class FakeAgentSlowTest(unittest.TestCase):
    def start(self, prompt: str, **env: str) -> subprocess.Popen[str]:
        proc = subprocess.Popen(
            [FAKE, "-p", prompt],
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


if __name__ == "__main__":
    unittest.main()
