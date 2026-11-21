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
import journeys_seed  # noqa: E402
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

        # An id the spec will never define. J9 used to stand in here; it is a
        # real journey now (the F4 switch proof), so the fixture moved out of
        # the numbered range.
        bad_code, bad_out, bad_err = self.run_main(
            "--walk-json", self.walk, "--spec", self.spec, "--journeys", "J99"
        )
        self.assertEqual(bad_code, 2, bad_out + bad_err)
        self.assertIn("unavailable:", bad_out + bad_err)
        self.assertIn("J99", bad_out + bad_err)

    def test_split_spec_reads_a_body_file_through_the_resolver(self) -> None:
        # Once the body move lands, an index entry is a path string, not a
        # body. Reading the raw index would call .get on that string and crash
        # a clean walk into exit 1; the summarizer must resolve through
        # spec.py and still list every pair.
        os.makedirs(os.path.join(self.dir, "journeys"), exist_ok=True)
        with open(os.path.join(self.dir, "journeys", "J1.json"), "w", encoding="utf-8") as fh:
            json.dump({"viewports": ["phone"], "steps": [["goto", "/sessions"]]}, fh)
        path = self.write_spec({
            "viewports": SPEC["viewports"],
            "journeys": {
                "J1": "journeys/J1.json",
                "J2": {"viewports": ["mac", "mac-wide"]},
            },
        })
        self.write_walk(screens=[
            screen("J1", "phone"), screen("J2", "mac"), screen("J2", "mac-wide"),
        ])
        code, out, err = self.run_main("--walk-json", self.walk, "--spec", path)
        rows = self.rows(out)
        self.assertEqual(code, 0, out + err)
        self.assertEqual(rows["J1/phone"][2], "1")  # the file body's pair is listed
        self.assertEqual(sorted(rows), ["J1/phone", "J2/mac", "J2/mac-wide"])

    def test_split_spec_missing_body_is_unavailable_not_a_crash(self) -> None:
        path = self.write_spec({
            "viewports": SPEC["viewports"],
            "journeys": {"J1": "journeys/absent.json"},
        })
        self.write_walk(screens=[screen("J1", "phone")])
        code, out, err = self.run_main("--walk-json", self.walk, "--spec", path)
        self.assertEqual(code, 2, out + err)
        self.assertIn("unavailable: cannot read spec", out + err)
        self.assertIn("J1", out + err)


class SeedSkipContractTest(unittest.TestCase):
    """The walk's skip list must only name states nothing can seed yet."""

    def test_waiting_approval_is_no_longer_unproducible(self) -> None:
        report = journeys_seed.Report(dry_run=True)
        out = io.StringIO()
        with contextlib.redirect_stdout(out):
            journeys_seed.report_unproducible(report)
        states = [
            line[len("skip "):].split(":", 1)[0]
            for line in out.getvalue().splitlines()
            if line.startswith("skip ")
        ]
        self.assertEqual(states, ["routine-failed"], out.getvalue())
        self.assertNotIn("waiting-approval", states, out.getvalue())


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
        # J9 is a real journey now (the F4 switch proof); the unknown-id
        # fixture must stay outside the spec's numbered range.
        result = self.run_shell("--journeys", "J99", "--dry-run")
        combined = result.stdout + result.stderr
        self.assertEqual(result.returncode, 2, combined)
        self.assertIn("unavailable:", combined)
        self.assertIn("J99", combined)
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

    def test_slow_agent_hold_default_is_pinned(self) -> None:
        # J3 types a second message while the first round is still open, so the
        # fake agent's 3 s default hold has to be stretched to 10 s; this export
        # is the only thing that does it. Dropping or retuning it would surface
        # as an intermittent walk failure, not a red test, so pin the exact line
        # (the dry run exits before it, so the resolved value cannot be read).
        with open(SHELL, encoding="utf-8") as fh:
            lines = [
                line.strip()
                for line in fh
                if line.strip().startswith("export RSI_FAKE_SLOW_SECS=")
            ]
        self.assertEqual(
            lines,
            ['export RSI_FAKE_SLOW_SECS="${RSI_FAKE_SLOW_SECS:-10}"'],
            "scripts/journeys-smoke.sh must export RSI_FAKE_SLOW_SECS with a 10 s default",
        )

    def test_tablet_spec_is_forwarded_to_walk_and_summary(self) -> None:
        # The opt-in diagnostic is one spec for the browser and the summarizer.
        # A --spec that reached only one of them would summarize a different
        # matrix than the one that was walked.
        tablet = os.path.join(ROOT, "rsi", "runtime", "ux", "tablet-reading.json")
        result = self.run_shell("--spec", tablet, "--dry-run")
        combined = result.stdout + result.stderr
        self.assertEqual(result.returncode, 0, combined)
        walk_line = next(line for line in result.stdout.splitlines() if line.startswith("walk: "))
        sum_line = next(
            line for line in result.stdout.splitlines() if line.startswith("summarize: ")
        )
        self.assertIn(f"--spec {tablet}", walk_line, walk_line)
        self.assertIn(f"--spec {tablet}", sum_line, sum_line)
        self.assertIn("JT1 tablet 820x1180", result.stdout)
        # A dry run reads no token and writes no out dir; it may only *plan*
        # a build.
        self.assertIsNone(re.search(r"\b[0-9a-fA-F]{32,}\b", combined), combined)

        # The old default invocation is byte-identical: no --spec is invented
        # when the caller did not ask for one.
        default = self.run_shell("--dry-run")
        self.assertEqual(default.returncode, 0, default.stdout + default.stderr)
        self.assertIn(
            "walk: node rsi/runtime/ux/walk.mjs --base http://127.0.0.1:<port> "
            "--token <token> --out <out>\n",
            default.stdout,
        )
        self.assertIn(
            "summarize: python3 scripts/journeys_smoke.py --walk-json <out>/walk.json\n",
            default.stdout,
        )

        # A missing spec is a refusal, not an empty green walk of nothing.
        missing = self.run_shell("--spec", os.path.join(ROOT, "no-such-spec.json"), "--dry-run")
        self.assertEqual(missing.returncode, 2, missing.stdout + missing.stderr)
        self.assertIn("unavailable:", missing.stderr)

        # A selection the supplied spec does not declare is refused too; the
        # diagnostic spec carries only JT1.
        unknown = self.run_shell("--spec", tablet, "--journeys", "J1", "--dry-run")
        self.assertEqual(unknown.returncode, 2, unknown.stdout + unknown.stderr)
        self.assertIn("unknown journey id: J1", unknown.stderr)

    def test_summarizer_reads_the_supplied_tablet_spec(self) -> None:
        # The same --spec the runner forwards must decide the summarizer's
        # declared pairs; otherwise the walk is red/green against one matrix
        # and the table is printed from another.
        tablet = os.path.join(ROOT, "rsi", "runtime", "ux", "tablet-reading.json")
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        walk = os.path.join(tmp.name, "walk.json")
        with open(walk, "w", encoding="utf-8") as fh:
            json.dump({
                "screens": [
                    {"journey": "JT1", "viewport": "tablet", "name": "JT1-tablet-01-reading",
                     "lint": {"bodyText": 400, "overflowX": False,
                              "smallTapTargets": 0, "rawSelects": 0}},
                    {"journey": "JT1", "viewport": "mac", "name": "JT1-mac-01-reading",
                     "lint": {"bodyText": 400, "overflowX": False,
                              "smallTapTargets": 0, "rawSelects": 0}},
                ],
                "hardFail": [],
            }, fh)
        code, out, err = self.run_summary("--walk-json", walk, "--spec", tablet)
        self.assertEqual(code, 0, out + err)
        self.assertIn("JT1", out)
        self.assertIn("tablet", out)

    def run_summary(self, *argv: str) -> tuple[int, str, str]:
        out, err = io.StringIO(), io.StringIO()
        with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
            code = journeys_smoke.main(list(argv))
        return code, out.getvalue(), err.getvalue()


if __name__ == "__main__":
    unittest.main(verbosity=2)
