#!/usr/bin/env python3
"""Tests for the console UI inventory ratchet.

Run directly: `python3 -B scripts/check-ui-inventory.test.py`. Every verdict
case runs the real checker against a temporary fixture tree and baseline;
counts come from `ui_inventory.measure`, not a second copy of the regexes.
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
from pathlib import Path

SCRIPTS = Path(__file__).resolve().parent
ROOT = SCRIPTS.parent
CHECKER = SCRIPTS / "check-ui-inventory.py"
SHIPPED_BASELINE = SCRIPTS / "ui-inventory-baseline.json"

sys.path.insert(0, str(SCRIPTS))
import ui_inventory  # noqa: E402

LABELS = {metric.key: metric.label for metric in ui_inventory.METRICS}

# One occurrence of every tracked metric, so "all rows are compared" can be
# proved for the whole set rather than only the three newest categories.
SAMPLES = {
    "raw_button": '<button type="button">Save</button>',
    "kin_btn_class": '"kin-btn"',
    "raw_input": '<input aria-label="name" />',
    "kin_input_class": '"kin-input"',
    "raw_textarea": "<textarea />",
    "native_select": "<select />",
    "raw_label": "<label>Name</label>",
    "role_menu": 'role="menu"',
    "role_listbox": 'role="listbox"',
    "role_dialog": 'role="dialog"',
    "role_tab": 'role="tab"',
    "role_status": 'role="status"',
    "role_alert": 'role="alert"',
    "use_anchored_panel": "useAnchoredPanel(ref)",
    "create_portal": "createPortal(null, document.body)",
    "push_toast": "pushToast({ title: 'saved' })",
    "rounded_border_surface": '"rounded-lg border"',
    "magic_z": '"z-[60]"',
}


class Fixture:
    """A throwaway `ui/src` tree plus a baseline beside it."""

    def __init__(self) -> None:
        self.root = Path(tempfile.mkdtemp(prefix="kin-ui-inventory-"))
        self.src = self.root / "src"
        self.src.mkdir()
        self.baseline = self.root / "baseline.json"

    def write(self, relative: str, body: str) -> None:
        path = self.src / relative
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(body, encoding="utf-8")

    def measured(self) -> dict[str, dict[str, int]]:
        return ui_inventory.measure(self.src)

    def write_baseline(self, metrics: dict[str, dict[str, int]] | str) -> None:
        if isinstance(metrics, str):
            self.baseline.write_text(metrics, encoding="utf-8")
            return
        rows = {
            key: {
                "label": LABELS[key],
                "occurrences": row["occurrences"],
                "files": row["files"],
            }
            for key, row in metrics.items()
        }
        self.baseline.write_text(
            json.dumps({"note": "fixture", "metrics": rows}, indent=2), encoding="utf-8"
        )

    def cleanup(self) -> None:
        shutil.rmtree(self.root, ignore_errors=True)


class CheckerTest(unittest.TestCase):
    def setUp(self) -> None:
        self.fixture = Fixture()
        self.addCleanup(self.fixture.cleanup)

    def run_checker(self, *extra: str) -> subprocess.CompletedProcess[str]:
        return subprocess.run(
            [
                sys.executable,
                "-B",
                str(CHECKER),
                "--source",
                str(self.fixture.src),
                "--baseline",
                str(self.fixture.baseline),
                *extra,
            ],
            capture_output=True,
            text=True,
        )

    def measure_samples(self, *lines: str) -> dict[str, dict[str, int]]:
        self.fixture.write("components/Probe.tsx", "\n".join(lines))
        return self.fixture.measured()

    def assert_fails_on(self, key: str) -> None:
        result = self.run_checker()
        self.assertNotEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertIn(key, result.stdout + result.stderr)

    def test_increase_fails(self) -> None:
        self.fixture.write("components/A.tsx", SAMPLES["raw_button"])
        self.fixture.write("components/B.tsx", SAMPLES["create_portal"])
        self.fixture.write("components/C.tsx", SAMPLES["magic_z"])
        self.fixture.write_baseline(self.fixture.measured())

        # One more file and one more occurrence for each of the three
        # categories the new lint rule also refuses in a new file.
        self.fixture.write("components/D.tsx", SAMPLES["raw_button"])
        self.fixture.write("components/E.tsx", SAMPLES["create_portal"])
        self.fixture.write("components/F.tsx", SAMPLES["magic_z"])

        result = self.run_checker()
        self.assertEqual(result.returncode, 1, result.stdout + result.stderr)
        for key in ("raw_button", "create_portal", "magic_z"):
            self.assertIn(key, result.stdout)

    def test_re_added_raw_button_fails_against_the_shipped_baseline(self) -> None:
        # The durable file the gate reads, not a hand-written fixture baseline:
        # a re-added raw <button> must be refused by exactly that file. Build a
        # tree that measures to the shipped numbers by reading them, so this
        # case tightens with the baseline instead of pinning today's counts.
        shipped = json.loads(SHIPPED_BASELINE.read_text(encoding="utf-8"))["metrics"]
        for key, row in shipped.items():
            occurrences, files = row["occurrences"], row["files"]
            spread, extra = divmod(occurrences, files) if files else (0, 0)
            for index in range(files):
                body = "\n".join([SAMPLES[key]] * (spread + (1 if index < extra else 0)))
                self.fixture.write(f"shipped/{key}/{index}.tsx", body)

        self.assertEqual(
            self.fixture.measured(),
            {
                key: {"occurrences": row["occurrences"], "files": row["files"]}
                for key, row in shipped.items()
            },
        )
        self.fixture.baseline.write_text(
            SHIPPED_BASELINE.read_text(encoding="utf-8"), encoding="utf-8"
        )

        # Exactly at the shipped numbers the gate is green...
        result = self.run_checker()
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertIn("UI_INVENTORY_OK", result.stdout)

        # ...and one more raw button in a file that already has some must fail,
        # naming the row, while no metric's file count moves.
        target = self.fixture.src / "shipped" / "raw_button" / "0.tsx"
        target.write_text(
            target.read_text(encoding="utf-8") + "\n" + SAMPLES["raw_button"] + "\n",
            encoding="utf-8",
        )
        result = self.run_checker()
        self.assertEqual(result.returncode, 1, result.stdout + result.stderr)
        self.assertIn("raw_button", result.stdout)

    def test_equal_counts_pass(self) -> None:
        self.fixture.write("components/A.tsx", SAMPLES["raw_button"] + "\n" + SAMPLES["magic_z"])
        self.fixture.write_baseline(self.fixture.measured())
        result = self.run_checker()
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertIn("UI_INVENTORY_OK", result.stdout)

    def test_decrease_passes(self) -> None:
        self.fixture.write("components/A.tsx", SAMPLES["raw_button"])
        self.fixture.write("components/B.tsx", SAMPLES["raw_button"])
        self.fixture.write_baseline(self.fixture.measured())
        (self.fixture.src / "components" / "B.tsx").unlink()
        result = self.run_checker()
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertIn("UI_INVENTORY_OK", result.stdout)

    def test_missing_or_malformed_baseline_fails_closed(self) -> None:
        self.fixture.write("components/A.tsx", SAMPLES["raw_button"])

        result = self.run_checker()  # no baseline file at all
        self.assertNotEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertIn("baseline", (result.stdout + result.stderr).lower())

        for body in (
            "{not json",
            "{}",
            '{"metrics": {}}',
            '{"metrics": {"raw_button": {"occurrences": "many", "files": 1}}}',
            '{"metrics": {"raw_button": {"occurrences": 1}}}',
            '{"metrics": {"not_a_metric": {"occurrences": 1, "files": 1}}}',
        ):
            with self.subTest(body=body):
                self.fixture.write_baseline(body)
                result = self.run_checker()
                self.assertNotEqual(result.returncode, 0, result.stdout + result.stderr)
                self.assertNotIn("UI_INVENTORY_OK", result.stdout)

        measured = self.fixture.measured()  # a baseline missing a tracked row
        del measured["magic_z"]
        self.fixture.write_baseline(measured)
        result = self.run_checker()
        self.assertNotEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertIn("magic_z", result.stdout + result.stderr)

    def test_all_tracked_metrics_are_compared(self) -> None:
        # One file with every shape, so a one-count increase is representable.
        self.fixture.write("components/All.tsx", "\n".join(SAMPLES.values()))
        measured = self.fixture.measured()
        self.assertEqual(set(measured), set(LABELS))
        for key, row in measured.items():
            self.assertGreater(row["occurrences"], 0, key)

        for key in LABELS:
            with self.subTest(metric=key):
                lowered = {k: dict(v) for k, v in measured.items()}
                lowered[key]["occurrences"] -= 1
                self.fixture.write_baseline(lowered)
                self.assert_fails_on(key)

    def test_measure_reports_numeric_z_spellings(self) -> None:
        self.fixture.write(
            "components/Z.tsx",
            'const A = () => <div className="z-[60]" />;\n'
            'const B = () => <div className={"z-[90]"} />;\n'
            "const C = () => <div className={`z-[100] ${x}`} />;\n"
            'const D = () => <div className="z-10 z-auto" />;\n',
        )
        self.fixture.write("components/Z.test.tsx", 'const T = () => <div className="z-[999]" />;')
        measured = self.fixture.measured()
        self.assertEqual(measured["magic_z"], {"occurrences": 3, "files": 1})

    def test_rounded_surface_class_order_does_not_bypass_ratchet(self) -> None:
        # Baseline one surface written one way, then add the same surface with
        # the classes in the other order: detection must not depend on order,
        # so the second occurrence has to fail the ratchet.
        self.fixture.write("components/A.tsx", '"rounded-lg border"')
        self.fixture.write_baseline(self.fixture.measured())
        self.fixture.write("components/B.tsx", '"border rounded-lg"')
        self.assert_fails_on("rounded_border_surface")

    def test_rounded_surface_counts_both_orders_with_standalone_classes(self) -> None:
        measured = self.measure_samples(
            '"border rounded-lg"',
            '"rounded-xl border"',
            '"sm:rounded-2xl border"',
            '"border-t rounded-lg"',
            '"border-2 rounded-lg"',
            '"border"',
            '"rounded-lg"',
            '"rounded-full border"',
        )
        # The three real surfaces count once each; a border or rounded variant
        # on its own line does not complete a surface.
        self.assertEqual(
            measured["rounded_border_surface"], {"occurrences": 3, "files": 1}
        )

    def test_kin_btn_variants_are_not_standalone_adoption(self) -> None:
        # The sanctioned CSS component API is kin-btn-primary/secondary/
        # approve/deny. Only a bare kin-btn is hand-written adoption.
        self.fixture.write(
            "components/A.tsx",
            '"kin-btn-primary kin-btn-secondary kin-btn-approve kin-btn-deny"',
        )
        measured = self.fixture.measured()
        self.assertEqual(measured["kin_btn_class"], {"occurrences": 0, "files": 0})

        self.fixture.write_baseline(measured)
        result = self.run_checker()
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)

        self.fixture.write("components/B.tsx", '"kin-btn"')
        self.assert_fails_on("kin_btn_class")

    def test_kin_btn_class_counts_only_the_standalone_token(self) -> None:
        measured = self.measure_samples(
            '"kin-btn"',
            '"kin-btn-primary"',
            '"data-kin-btn"',
            '"kin-btn kin-btn-deny"',
        )
        self.assertEqual(measured["kin_btn_class"], {"occurrences": 2, "files": 1})

    def test_unreadable_source_is_a_concise_error(self) -> None:
        self.fixture.write("components/A.tsx", SAMPLES["raw_button"])
        self.fixture.write_baseline(self.fixture.measured())
        (self.fixture.src / "components" / "Bad.tsx").write_bytes(b"\xff\xfe not utf-8")

        result = self.run_checker()
        self.assertEqual(result.returncode, 2, result.stdout + result.stderr)
        self.assertIn("UI_INVENTORY_ERROR", result.stderr)
        self.assertNotIn("Traceback", result.stdout + result.stderr)
        self.assertNotIn("UI_INVENTORY_OK", result.stdout)

    def test_update_does_not_rewrite_baseline_after_source_error(self) -> None:
        self.fixture.write("components/A.tsx", SAMPLES["raw_button"])
        self.fixture.write_baseline(self.fixture.measured())
        before = self.fixture.baseline.read_bytes()
        (self.fixture.src / "components" / "Bad.tsx").write_bytes(b"\xff\xfe not utf-8")

        result = self.run_checker("--update")
        self.assertEqual(result.returncode, 2, result.stdout + result.stderr)
        self.assertIn("UI_INVENTORY_ERROR", result.stderr)
        self.assertNotIn("Traceback", result.stdout + result.stderr)
        self.assertEqual(self.fixture.baseline.read_bytes(), before)

    def test_file_count_increase_fails_when_occurrences_are_constant(self) -> None:
        body = SAMPLES["raw_button"]
        self.fixture.write("components/A.tsx", body + "\n" + body)
        self.fixture.write_baseline(self.fixture.measured())
        # Same two occurrences, now spread across two files: the file count is
        # part of the contract and must fail on its own.
        self.fixture.write("components/A.tsx", body)
        self.fixture.write("components/B.tsx", body)

        result = self.run_checker()
        self.assertEqual(result.returncode, 1, result.stdout + result.stderr)
        self.assertIn("raw_button", result.stdout)
        self.assertIn("files: 2 > baseline 1", result.stdout)

    def run_inventory_job(self, test_status: int, checker_status: int) -> subprocess.CompletedProcess[str]:
        """Run check.sh's real job_ui_inventory body with stubbed python3 exits.

        The body is extracted from check.sh rather than copied, so the job that
        actually runs at the gate is the one under test. A `python3` stub on
        PATH lets each of the job's two commands pass or fail independently.
        """
        script = (SCRIPTS / "check.sh").read_text(encoding="utf-8")
        body = re.search(r"(?ms)^job_ui_inventory\(\) \{(.*?)^\}", script)
        self.assertIsNotNone(body, "check.sh has no job_ui_inventory")
        assert body is not None

        with tempfile.TemporaryDirectory(prefix="kin-ui-inventory-job-") as raw:
            work = Path(raw)
            bin_dir = work / "bin"
            bin_dir.mkdir()
            stub = bin_dir / "python3"
            stub.write_text(
                "#!/usr/bin/env bash\n"
                'for arg in "$@"; do\n'
                '  case "$arg" in\n'
                f"    *check-ui-inventory.test.py) exit {test_status} ;;\n"
                f"    *check-ui-inventory.py) exit {checker_status} ;;\n"
                "  esac\n"
                "done\n"
                "exit 0\n",
                encoding="utf-8",
            )
            stub.chmod(0o755)
            job = work / "job.sh"
            job.write_text(
                "#!/usr/bin/env bash\n"
                "set -uo pipefail\n"
                "job_ui_inventory() {" + body.group(1) + "}\n"
                "job_ui_inventory\n",
                encoding="utf-8",
            )
            env = {
                **os.environ,
                "PATH": f"{bin_dir}{os.pathsep}{os.environ.get('PATH', '')}",
            }
            return subprocess.run(
                ["bash", str(job)], capture_output=True, text=True, env=env, cwd=work
            )

    def test_check_script_job_fails_when_guard_tests_fail(self) -> None:
        # The job runs the guard tests, then the checker, and its status must
        # reflect both. A passing checker used to mask a failing guard test
        # locally, so the first case is the regression this harness protects.
        self.assertEqual(self.run_inventory_job(0, 0).returncode, 0)
        self.assertNotEqual(self.run_inventory_job(1, 0).returncode, 0)
        self.assertNotEqual(self.run_inventory_job(0, 1).returncode, 0)

    def test_check_script_starts_inventory_job_only_in_all_block(self) -> None:
        # CI runs the ratchet and its own test on every push (.github/workflows/
        # ci.yml), so the default gate leaves them out (R-gate-ci-dedupe). --all
        # must still start them, from inside the marked block so the default
        # list cannot pick them up again.
        script = (SCRIPTS / "check.sh").read_text(encoding="utf-8")
        block = re.search(
            r"(?ms)^# BEGIN all-only jobs\n(.*?)^# END all-only jobs$", script
        )
        self.assertIsNotNone(block, "check.sh has no all-only jobs block")
        assert block is not None
        self.assertRegex(
            block.group(1), r"(?m)^[ \t]+start ui-inventory job_ui_inventory$"
        )
        self.assertNotRegex(
            script.replace(block.group(0), ""),
            r"(?m)^[ \t]*start ui-inventory job_ui_inventory$",
        )
        body = re.search(r"(?ms)^job_ui_inventory\(\) \{(.*?)^\}", script)
        self.assertIsNotNone(body, "check.sh has no job_ui_inventory")
        assert body is not None
        self.assertIn("check-ui-inventory.py", body.group(1))
        self.assertIn("check-ui-inventory.test.py", body.group(1))
        self.assertNotIn("changed_ui_files", body.group(1))


if __name__ == "__main__":
    unittest.main(verbosity=2)
