#!/usr/bin/env python3
"""Tests for the removed-surfaces checker.

Run directly: `python3 -B scripts/check-removed-surfaces.test.py`. Every verdict
case runs the real checker against a throwaway manifest and tree. Two cases
also read the checked-in manifest and this working tree, because the point of
the gate is the real deletion: a resurrected surface must turn the real checker
red even when no fixture changes.
"""

from __future__ import annotations

import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

SCRIPTS = Path(__file__).resolve().parent
ROOT = SCRIPTS.parent
CHECKER = SCRIPTS / "check-removed-surfaces.py"
MANIFEST = SCRIPTS / "removed-surfaces.txt"

# The four surfaces the 2026-11-10 audit deleted and a later merge restored.
# Tests 7 and 8 pin the checked-in record, not a copy of it.
RESURRECTED = (
    "ui/src/pages/ApprovalsPage.tsx",
    "ui/src/components/cards/RunningTaskCard.tsx",
    "ui/src/lib/inboxFocus.ts",
    "ui/src/lib/inboxKeyboard.ts",
)

# The project cover KIN-CONTRACT-001 retired (2026-11-24): the page, its four
# blocks and the heat scale only the cover drew. A merge that brings one back
# must turn the real tree red, not only a fixture.
RETIRED_COVER = (
    "ui/src/pages/ProjectDetailPage.tsx",
    "ui/src/pages/ProjectDetailPage.dom.test.tsx",
    "ui/src/components/project/Heatmap.tsx",
    "ui/src/components/project/ProjectInstructionsBlock.tsx",
    "ui/src/components/project/ProjectInstructionsBlock.dom.test.tsx",
    "ui/src/components/project/ProjectOnePager.tsx",
    "ui/src/components/project/ProjectOnePager.dom.test.tsx",
    "ui/src/components/project/ProjectRootsBlock.tsx",
    "ui/src/design/heat.ts",
)

# The imported-session full page and its two suites (2026-11-24). #672 replaced
# the page's URL with the list's sheet; part 1 deleted the suites, part 2
# deleted the page itself.
RETIRED_IMPORTED_PAGE = (
    "ui/src/pages/AgentSessionDetailPage.dom.test.tsx",
    "ui/src/pages/AgentSessionDetailPage.historyBudget.dom.test.tsx",
    "ui/src/pages/AgentSessionDetailPage.tsx",
)


class Fixture:
    """A throwaway source root plus a manifest beside it."""

    def __init__(self) -> None:
        self._tmp = tempfile.TemporaryDirectory(prefix="kin-removed-surfaces-")
        self.root = Path(self._tmp.name)
        self.source = self.root / "tree"
        self.source.mkdir()
        self.manifest = self.root / "removed.txt"

    def write_manifest(self, body: str) -> None:
        self.manifest.write_text(body, encoding="utf-8")

    def write_path(self, relative: str, body: str = "export {};\n") -> None:
        path = self.source / relative
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(body, encoding="utf-8")

    def cleanup(self) -> None:
        self._tmp.cleanup()


class ResurrectedPathTest(unittest.TestCase):
    def setUp(self) -> None:
        self.fixture = Fixture()
        self.addCleanup(self.fixture.cleanup)

    def run_checker(self) -> subprocess.CompletedProcess[str]:
        return subprocess.run(
            [
                sys.executable,
                "-B",
                str(CHECKER),
                "--source",
                str(self.fixture.source),
                "--manifest",
                str(self.fixture.manifest),
            ],
            capture_output=True,
            text=True,
        )

    def test_listed_file_that_exists_turns_red(self) -> None:
        self.fixture.write_manifest("ui/src/lib/inboxFocus.ts\n")
        self.fixture.write_path("ui/src/lib/inboxFocus.ts")
        result = self.run_checker()
        self.assertEqual(result.returncode, 1, result.stdout + result.stderr)
        self.assertIn("REMOVED_SURFACES_FAIL", result.stdout)
        self.assertIn("ui/src/lib/inboxFocus.ts", result.stdout)

    def test_listed_directory_that_exists_turns_red(self) -> None:
        # The audit could delete a whole surface, not only files; a directory at
        # a listed path is a resurrection even when the named file is gone.
        self.fixture.write_manifest("ui/src/dead-surface\n")
        self.fixture.write_path("ui/src/dead-surface/child.ts")
        result = self.run_checker()
        self.assertEqual(result.returncode, 1, result.stdout + result.stderr)
        self.assertIn("ui/src/dead-surface", result.stdout)

    def test_absent_paths_pass_and_report_the_count(self) -> None:
        self.fixture.write_manifest(
            "# deleted by the 2026-11-10 audit\n"
            "ui/src/pages/ApprovalsPage.tsx\n"
            "ui/src/lib/inboxFocus.ts\n"
            "ui/src/dead-surface\n"
        )
        result = self.run_checker()
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertIn("REMOVED_SURFACES_OK (3 paths absent)", result.stdout)


class ManifestFailureTest(unittest.TestCase):
    def setUp(self) -> None:
        self.fixture = Fixture()
        self.addCleanup(self.fixture.cleanup)

    def run_checker(self) -> subprocess.CompletedProcess[str]:
        return subprocess.run(
            [
                sys.executable,
                "-B",
                str(CHECKER),
                "--source",
                str(self.fixture.source),
                "--manifest",
                str(self.fixture.manifest),
            ],
            capture_output=True,
            text=True,
        )

    def test_empty_manifest_fails_closed(self) -> None:
        # An empty record guards nothing, so it must not report success.
        self.fixture.write_manifest("# only a comment\n\n")
        result = self.run_checker()
        self.assertNotEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertIn("REMOVED_SURFACES_ERROR", result.stderr)
        self.assertIn("no paths", result.stderr)

    def test_malformed_manifest_fails_closed(self) -> None:
        # A trailing slash is neither a normalized file path nor a directory:
        # refuse the record instead of silently checking the wrong path.
        self.fixture.write_manifest("ui/src/gone/\n")
        result = self.run_checker()
        self.assertNotEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertIn("REMOVED_SURFACES_ERROR", result.stderr)
        self.assertIn("normalized", result.stderr)

    def test_manifest_rejects_absolute_and_parent_paths(self) -> None:
        for body, needle in (
            ("/etc/passwd\n", "absolute"),
            ("ui/../outside.ts\n", "parent"),
        ):
            with self.subTest(body=body):
                self.fixture.write_manifest(body)
                result = self.run_checker()
                self.assertNotEqual(
                    result.returncode, 0, result.stdout + result.stderr
                )
                self.assertIn("REMOVED_SURFACES_ERROR", result.stderr)
                self.assertIn(needle, result.stderr)


class CheckedInManifestTest(unittest.TestCase):
    def test_checked_in_manifest_names_the_resurrected_and_retired_surfaces(self) -> None:
        paths = [
            line.strip()
            for line in MANIFEST.read_text(encoding="utf-8").splitlines()
            if line.strip() and not line.strip().startswith("#")
        ]
        self.assertEqual(len(paths), 24, paths)
        for path in RESURRECTED:
            self.assertIn(path, paths)
        for path in RETIRED_COVER:
            self.assertIn(path, paths)
        for path in RETIRED_IMPORTED_PAGE:
            self.assertIn(path, paths)

    def test_checked_in_manifest_paths_are_absent_on_this_tree(self) -> None:
        # The real gate, on the real tree: no fixture can hide a file that a
        # merge put back in `ui/src`.
        result = subprocess.run(
            [sys.executable, "-B", str(CHECKER)],
            cwd=ROOT,
            capture_output=True,
            text=True,
        )
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertIn("REMOVED_SURFACES_OK (24 paths absent)", result.stdout)

    def test_a_restored_cover_component_turns_the_real_tree_red(self) -> None:
        """Put one retired cover file back and run the checked-in gate.

        The fixture tests prove the checker's verdict; this one proves the
        record names the paths this tree actually deleted. A component that a
        merge restored must fail the real gate even though nothing else moved.
        """
        restored = ROOT / "ui/src/design/heat.ts"
        self.assertFalse(restored.exists(), restored)
        try:
            restored.write_text("export {};\n", encoding="utf-8")
            result = subprocess.run(
                [sys.executable, "-B", str(CHECKER)],
                cwd=ROOT,
                capture_output=True,
                text=True,
            )
            self.assertEqual(result.returncode, 1, result.stdout + result.stderr)
            self.assertIn("REMOVED_SURFACES_FAIL", result.stdout)
            self.assertIn("ui/src/design/heat.ts", result.stdout)
        finally:
            restored.unlink(missing_ok=True)


class GateWiringTest(unittest.TestCase):
    def test_check_sh_runs_the_checker_on_every_gate(self) -> None:
        # AGENTS.md §12: a guard nobody wires is a green light for the
        # regression. The job must be unconditional, with no changed-file glob.
        text = (SCRIPTS / "check.sh").read_text(encoding="utf-8")
        self.assertIn("job_removed_surfaces()", text)
        self.assertIn("python3 -B scripts/check-removed-surfaces.test.py", text)
        self.assertIn("python3 -B scripts/check-removed-surfaces.py", text)
        self.assertIn("start removed-surfaces job_removed_surfaces", text)


if __name__ == "__main__":
    unittest.main()
