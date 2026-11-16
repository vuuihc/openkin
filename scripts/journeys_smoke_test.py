#!/usr/bin/env python3
"""Tests for scripts/journeys_smoke.py and scripts/journeys-smoke.sh.

Run directly: `python3 -B scripts/journeys_smoke_test.py`. No network, no
Chrome, no daemon: the summarizer is driven in-process against fixture
`walk.json` / `journeys.json` files, and the shell is only driven with
`--dry-run`, which must not build, boot, or read a token.
"""

from __future__ import annotations

import contextlib
import io
import json
import os
import re
import subprocess
import sys
import tempfile
import unittest

SCRIPTS = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(SCRIPTS)
SHELL = os.path.join(SCRIPTS, "journeys-smoke.sh")

sys.path.insert(0, SCRIPTS)
import journeys_smoke  # noqa: E402

# The smallest spec that still exercises every shape the real journeys.json
# has: a single-viewport journey and a journey with two viewports.
SPEC = {
    "viewports": {"phone": "390x844", "mac": "1100x760", "mac-wide": "1280x800"},
    "journeys": {
        "J1": {"viewports": ["phone"]},
        "J2": {"viewports": ["mac", "mac-wide"]},
    },
}


def screen(journey: str, viewport: str, name: str | None = None, *, body: int = 120,
           overflow: bool = False, small: int = 0, selects: int = 0) -> dict:
    """One entry of walk.json's `screens`, shaped like walk.mjs writes it."""
    return {
        "journey": journey,
        "viewport": viewport,
        "name": name or f"{journey}-{viewport}-01-step",
        "url": "/sessions",
        "lint": {
            "bodyText": body,
            "overflowX": overflow,
            "smallTapTargets": small,
            "rawSelects": selects,
        },
        "notes": [],
    }


class SummarizerTest(unittest.TestCase):
    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        self.dir = self._tmp.name
        self.spec = self.write_spec(SPEC)
        self.walk = os.path.join(self.dir, "walk.json")

    def write_spec(self, spec: dict) -> str:
        path = os.path.join(self.dir, "journeys.json")
        with open(path, "w", encoding="utf-8") as fh:
            json.dump(spec, fh)
        return path

    def write_walk(self, screens: list[dict] | None = None, hard: list[str] | None = None) -> str:
        with open(self.walk, "w", encoding="utf-8") as fh:
            json.dump({
                "base": "http://127.0.0.1:<port>",
                "journeys": ["J1", "J2"],
                "hardFail": hard or [],
                "screens": screens or [],
            }, fh)
        return self.walk

    def run_main(self, *argv: str) -> tuple[int, str, str]:
        out, err = io.StringIO(), io.StringIO()
        with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
            code = journeys_smoke.main(list(argv))
        return code, out.getvalue(), err.getvalue()

    @staticmethod
    def rows(stdout: str) -> dict[str, list[str]]:
        table = {}
        for line in stdout.splitlines():
            parts = line.split()
            if len(parts) >= 8 and re.fullmatch(r"J\d+", parts[0]) and parts[1] in SPEC["viewports"]:
                table[f"{parts[0]}/{parts[1]}"] = parts
        return table

    def test_table_covers_every_declared_journey_viewport_pair(self) -> None:
        # J2/mac-wide is declared but produced nothing: it must still be a row,
        # and an empty row is a failure rather than a blank.
        self.write_walk(screens=[screen("J1", "phone"), screen("J2", "mac")])
        code, out, _ = self.run_main("--walk-json", self.walk, "--spec", self.spec)
        rows = self.rows(out)
        self.assertEqual(code, 1, out)
        self.assertIn("J2/mac-wide", rows)
        self.assertEqual(rows["J2/mac-wide"][2], "0")
        self.assertIn("J1/phone", rows)
        self.assertIn("J2/mac", rows)
        self.assertIn("J2/mac-wide produced no screens", out)

    def test_hard_failure_exits_nonzero_and_names_journey_viewport(self) -> None:
        self.write_walk(
            screens=[screen("J1", "phone"), screen("J2", "mac"), screen("J2", "mac-wide")],
            hard=["J2/mac: missing required click button"],
        )
        code, out, _ = self.run_main("--walk-json", self.walk, "--spec", self.spec)
        rows = self.rows(out)
        self.assertEqual(code, 1, out)
        self.assertIn("J2/mac", out)
        self.assertIn("failures:", out)
        self.assertIn("J2/mac: missing required click button", out)
        self.assertEqual(rows["J2/mac"][3], "1")
        self.assertEqual(rows["J2/mac-wide"][3], "0")

    def test_missing_walk_json_exits_two_with_reason(self) -> None:
        code, out, err = self.run_main(
            "--walk-json", os.path.join(self.dir, "absent.json"), "--spec", self.spec
        )
        self.assertEqual(code, 2, out + err)
        self.assertIn("unavailable:", out + err)

    def test_overflow_and_tap_targets_are_aggregated_per_pair(self) -> None:
        self.write_spec({"viewports": SPEC["viewports"], "journeys": {"J1": {"viewports": ["phone"]}}})
        self.write_walk(screens=[
            screen("J1", "phone", "J1-phone-01-list", small=3),
            screen("J1", "phone", "J1-phone-02-search", overflow=True, small=4, selects=2),
        ])
        code, out, _ = self.run_main("--walk-json", self.walk, "--spec", self.spec)
        rows = self.rows(out)
        self.assertEqual(code, 1, out)
        self.assertEqual(rows["J1/phone"][2], "2")  # screens
        self.assertEqual(rows["J1/phone"][4], "1")  # overflowX screens
        self.assertEqual(rows["J1/phone"][5], "7")  # smallTapTargets summed
        self.assertEqual(rows["J1/phone"][6], "2")  # rawSelects summed

    def test_json_summary_is_machine_readable(self) -> None:
        self.write_walk(screens=[screen("J1", "phone"), screen("J2", "mac")])
        code, out, _ = self.run_main("--walk-json", self.walk, "--spec", self.spec, "--json")
        doc = json.loads(out)
        self.assertEqual(code, 1, out)
        self.assertFalse(doc["ok"])
        self.assertEqual(doc["fails"], [])
        self.assertEqual(
            {(row["journey"], row["viewport"]): row["screens"] for row in doc["rows"]},
            {("J1", "phone"): 1, ("J2", "mac"): 1, ("J2", "mac-wide"): 0},
        )

    def test_journeys_subset_checks_only_requested_journeys(self) -> None:
        self.write_walk(screens=[screen("J1", "phone")])
        code, out, _ = self.run_main("--walk-json", self.walk, "--spec", self.spec, "--journeys", "J1")
        rows = self.rows(out)
        self.assertEqual(code, 0, out)
        self.assertEqual(list(rows.keys()), ["J1/phone"])
        self.assertNotIn("J2/mac", rows)
        self.assertNotIn("J2/mac-wide", rows)

        bad_code, bad_out, bad_err = self.run_main(
            "--walk-json", self.walk, "--spec", self.spec, "--journeys", "J9"
        )
        self.assertEqual(bad_code, 2, bad_out + bad_err)
        self.assertIn("unavailable:", bad_out + bad_err)
        self.assertIn("J9", bad_out + bad_err)


class ShellTest(unittest.TestCase):
    """The shell is exercised only in --dry-run: no Chrome, daemon or build."""

    def run_shell(self, *args: str) -> subprocess.CompletedProcess[str]:
        env = {
            key: os.environ[key]
            for key in ("PATH", "TMPDIR", "LANG", "LC_ALL")
            if key in os.environ
        }
        return subprocess.run(
            ["bash", SHELL, *args],
            cwd=ROOT,
            capture_output=True,
            text=True,
            env=env,
            timeout=120,
        )

    def test_unknown_journey_id_is_rejected(self) -> None:
        result = self.run_shell("--journeys", "J9", "--dry-run")
        combined = result.stdout + result.stderr
        self.assertEqual(result.returncode, 2, combined)
        self.assertIn("unavailable:", combined)
        self.assertIn("J9", combined)
        self.assertIn("J1", combined)
        self.assertIn("J7", combined)

    def test_dry_run_needs_no_chrome_and_prints_the_matrix(self) -> None:
        result = self.run_shell("--dry-run")
        combined = result.stdout + result.stderr
        self.assertEqual(result.returncode, 0, combined)
        for want in ("J1 phone", "J2 mac", "J4 mac-wide"):
            self.assertIn(want, result.stdout)
        # No token is read in a dry run, and none may be printed.
        self.assertIsNone(re.search(r"\b[0-9a-fA-F]{32,}\b", combined), combined)
        self.assertIsNone(re.search(r"(?i)(?:token|bearer)[=: ]+[A-Za-z0-9._~+/-]{16,}", combined), combined)

    def test_dry_run_forwards_journeys_to_summarizer(self) -> None:
        result = self.run_shell("--journeys", "J1", "--dry-run")
        combined = result.stdout + result.stderr
        self.assertEqual(result.returncode, 0, combined)
        self.assertIn(
            "summarize: python3 scripts/journeys_smoke.py --walk-json <out>/walk.json --journeys J1",
            result.stdout,
        )


if __name__ == "__main__":
    unittest.main(verbosity=2)
