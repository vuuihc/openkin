#!/usr/bin/env python3
"""Tests for scripts/ui_lint_guard.py, in throwaway git repositories."""

from __future__ import annotations

import contextlib
import io
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import ui_lint_guard as guard  # noqa: E402

REAL_UI = HERE.parent / "ui"
JOB = HERE / "ui-lint-guard.sh"
RAW = "export const C = () => <button />;\n"


class GuardTest(unittest.TestCase):
    def setUp(self):
        tmp = tempfile.TemporaryDirectory(prefix="kin-ui-lint-")
        self.addCleanup(tmp.cleanup)
        self.root = Path(tmp.name)
        self.git("init", "-q", "-b", "trunk")
        self.git("config", "user.email", "test@example.com")
        self.git("config", "user.name", "test")
        self.git("config", "commit.gpgsign", "false")
        ui = self.root / "ui"
        ui.mkdir()
        (ui / "node_modules").symlink_to(REAL_UI / "node_modules", target_is_directory=True)
        (ui / "eslint.guard.config.js").symlink_to(REAL_UI / "eslint.guard.config.js")

    def git(self, *args: str) -> str:
        proc = subprocess.run(["git", "-C", str(self.root), *args], capture_output=True)
        self.assertEqual(proc.returncode, 0, proc.stderr.decode("utf-8", "replace"))
        return proc.stdout.decode("utf-8", "replace").strip()

    def write(self, name: str, text: str) -> Path:
        path = self.root / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(text, encoding="utf-8")
        return path

    def commit(self, message: str = "c") -> str:
        self.git("add", "-A")
        self.git("commit", "-q", "-m", message)
        return self.git("rev-parse", "HEAD")

    def test_added_source_is_linted_but_existing_legacy_is_not(self):
        self.write("ui/src/Legacy.tsx", RAW)
        base = self.commit()
        self.write("ui/src/New.tsx", RAW)
        self.write("ui/src/Good.tsx", "export const G = () => <Button />;\n")
        self.assertEqual(guard.selected_files(self.root, base), ["ui/src/Good.tsx", "ui/src/New.tsx"])
        self.assertNotEqual(guard.run_lint(self.root, base), 0)
        (self.root / "ui/src/New.tsx").unlink()
        self.assertEqual(guard.run_lint(self.root, base), 0)

    def test_second_feature_push_keeps_first_added_file_in_scope(self):
        self.write("ui/src/Legacy.tsx", "export const L = () => <div />;\n")
        first = self.commit()
        self.git("update-ref", "refs/remotes/origin/main", first)
        self.git("checkout", "-q", "-b", "feature")
        self.write("ui/src/First.tsx", "export const F = () => <Button />;\n")
        push_one = self.commit("push one")
        self.write("ui/src/First.tsx", RAW)
        self.commit("push two")
        # Format's previous-push base must not scope this lint.
        with mock.patch.dict(os.environ, {"BASE_SHA": push_one, "UI_LINT_BASE": ""}):
            base, _ = guard.resolve_base(self.root, None)
        self.assertEqual(base, first)
        self.assertIn("ui/src/First.tsx", guard.selected_files(self.root, base))
        self.assertNotEqual(guard.run_lint(self.root, base), 0)

    def test_local_staged_untracked_and_renamed_sources(self):
        self.write("ui/src/Legacy.tsx", RAW)
        self.write("ui/src/Old.tsx", "export const O = () => <Button />;\n")
        self.write("ui/src/Gone.tsx", RAW)
        base = self.commit()
        self.write("ui/src/Staged.tsx", "export const S = () => <Button />;\n")
        self.git("add", "ui/src/Staged.tsx")
        self.write("ui/src/Untracked.tsx", "export const U = () => <Button />;\n")
        self.git("mv", "ui/src/Old.tsx", "ui/src/New Name.tsx")
        self.write("ui/src/New Name.tsx", "export const O = () => <Button />; // moved\n")
        (self.root / "ui/src/Gone.tsx").unlink()
        names = guard.selected_files(self.root, base)
        for name in ("ui/src/Staged.tsx", "ui/src/Untracked.tsx", "ui/src/New Name.tsx"):
            self.assertIn(name, names)
        # A rename is scoped by its new path, so a move cannot carry a legacy
        # spelling to a new name and keep it exempt.
        self.assertNotIn("ui/src/Old.tsx", names)
        self.assertNotIn("ui/src/Gone.tsx", names)
        out = io.StringIO()
        with contextlib.redirect_stdout(out):
            self.assertEqual(guard.run_lint(self.root, base), 0)
        # The reproduction line quotes a path with a space.
        self.assertIn("'src/New Name.tsx'", out.getvalue())

    def test_facade_generated_and_test_files_are_exempt(self):
        self.write("ui/src/Legacy.tsx", "export const L = () => <div />;\n")
        base = self.commit()
        for name in (
            "ui/src/components/ui/Button.tsx",
            "ui/src/api/generated/api.ts",
            "ui/src/Thing.test.tsx",
        ):
            self.write(name, RAW)
        self.assertEqual(guard.selected_files(self.root, base), [])
        self.assertEqual(guard.run_lint(self.root, base), 0)
        self.write("ui/src/page/Widget.tsx", RAW)
        self.assertEqual(guard.selected_files(self.root, base), ["ui/src/page/Widget.tsx"])
        self.assertNotEqual(guard.run_lint(self.root, base), 0)

    def test_invalid_explicit_base_fails_closed(self):
        self.write("ui/src/Legacy.tsx", "export const L = () => <div />;\n")
        self.commit()
        with self.assertRaisesRegex(guard.GuardError, "not a commit"):
            guard.resolve_base(self.root, "no-such-ref")
        with mock.patch.dict(os.environ, {"UI_LINT_BASE": "no-such-ref"}):
            with self.assertRaisesRegex(guard.GuardError, "not a commit"):
                guard.resolve_base(self.root, None)
        self.assertEqual(guard.main(["--base", "no-such-ref"], root=self.root), 2)

    def test_missing_automatic_base_reports_diagnostic(self):
        self.write("ui/src/Legacy.tsx", "export const L = () => <div />;\n")
        self.commit()
        with mock.patch.dict(os.environ, {"UI_LINT_BASE": ""}):
            with self.assertRaisesRegex(guard.GuardError, "origin/main"):
                guard.resolve_base(self.root, None)

    def test_local_job_propagates_rule_test_failure(self):
        fake_bin = self.root / "bin"
        fake_bin.mkdir()
        fake_npx = fake_bin / "npx"
        fake_npx.write_text("#!/bin/sh\nexit 1\n", encoding="utf-8")
        fake_npx.chmod(0o755)
        env = dict(
            os.environ,
            PATH=f"{fake_bin}{os.pathsep}{os.environ['PATH']}",
            UI_LINT_BASE="HEAD",
        )
        proc = subprocess.run([str(JOB)], env=env, capture_output=True, text=True)
        self.assertNotEqual(proc.returncode, 0, proc.stdout + proc.stderr)


if __name__ == "__main__":
    unittest.main()
