#!/usr/bin/env python3
"""Tests for scripts/ui_lint_guard.py, in throwaway git repositories."""

from __future__ import annotations

import contextlib
import io
import os
import subprocess
import sys
import tempfile
import textwrap
import unittest
from pathlib import Path
from unittest import mock

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import ui_lint_guard as guard  # noqa: E402

REAL_UI = HERE.parent / "ui"
JOB = HERE / "ui-lint-guard.sh"
RAW = "export const C = () => <button />;\n"
CI_WORKFLOW = HERE.parent / ".github" / "workflows" / "ci.yml"
BASE_BLOCK = ("# BEGIN ui-lint-base", "# END ui-lint-base")


def ci_base(**fixtures: str) -> str:
    """Run the workflow's own base-selection block with fixture inputs."""
    lines = CI_WORKFLOW.read_text(encoding="utf-8").splitlines()
    start = next(i for i, line in enumerate(lines) if BASE_BLOCK[0] in line)
    end = next(i for i in range(start + 1, len(lines)) if BASE_BLOCK[1] in lines[i])
    proc = subprocess.run(
        ["bash", "-c", textwrap.dedent("\n".join(lines[start + 1 : end]))],
        capture_output=True,
        text=True,
        env={
            **os.environ,
            "PR_BASE_SHA": "", "EVENT_BEFORE": "",
            "REF_NAME": "", "DEFAULT_BRANCH": "",
            **fixtures,
        },
    )
    if proc.returncode != 0:
        raise AssertionError(proc.stderr)
    return proc.stdout


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
        # A rename is scoped by its new path, so an old spelling cannot stay exempt.
        self.assertNotIn("ui/src/Old.tsx", names)
        self.assertNotIn("ui/src/Gone.tsx", names)
        out = io.StringIO()
        with contextlib.redirect_stdout(out):
            self.assertEqual(guard.run_lint(self.root, base), 0)
        # The reproduce line quotes the spaced path; a raw control there fails.
        self.assertIn("'src/New Name.tsx'", out.getvalue())
        self.write("ui/src/Bad Name.tsx", RAW)
        self.assertNotEqual(guard.run_lint(self.root, base), 0)

    def test_committed_moves_with_violations_are_linted_at_new_paths(self):
        """A similar move is R, a rewrite is A; both new paths are in scope."""
        kept = "".join(f"export const V{i} = () => <Button />;\n" for i in range(8))
        self.write("ui/src/Old.tsx", kept)
        self.write("ui/src/Rewrite.tsx", "export const O = () => <Button />;\n")
        base = self.commit()
        self.git("mv", "ui/src/Old.tsx", "ui/src/Moved.tsx")
        self.git("mv", "ui/src/Rewrite.tsx", "ui/src/Replaced.tsx")
        self.write("ui/src/Moved.tsx", RAW + kept.split("\n", 1)[1])
        self.write("ui/src/Replaced.tsx", RAW)
        self.commit("move and edit")
        statuses = {
            line.split("\t")[0][0]
            for line in self.git(
                "diff", "--name-status", "-M", "--diff-filter=AR", base, "--", "ui/src"
            ).splitlines()
        }
        self.assertEqual(statuses, {"A", "R"})
        self.assertEqual(
            guard.selected_files(self.root, base), ["ui/src/Moved.tsx", "ui/src/Replaced.tsx"]
        )
        self.assertNotEqual(guard.run_lint(self.root, base), 0)

    def test_kin_btn_and_overlay_role_are_banned_in_added_files(self):
        """The two ordinary-lint bans also hold for a newly added file."""
        self.write("ui/src/Legacy.tsx", "export const L = () => <div />;\n")
        base = self.commit()
        source = (
            "export const C = () => "
            '<div className="kin-btn-primary" role="dialog" />;\n'
        )
        self.write("ui/src/components/New.tsx", source)
        self.assertEqual(guard.selected_files(self.root, base), ["ui/src/components/New.tsx"])
        self.assertNotEqual(guard.run_lint(self.root, base), 0)
        (self.root / "ui/src/components/New.tsx").unlink()
        # The facade, test files and generated types keep their exemptions.
        for name in (
            "ui/src/components/ui/Button.tsx",
            "ui/src/Thing.test.tsx",
            "ui/src/api/generated/api.ts",
        ):
            self.write(name, source)
        self.assertEqual(guard.selected_files(self.root, base), [])
        self.assertEqual(guard.run_lint(self.root, base), 0)

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

    def test_unrelated_history_fails_closed(self):
        self.write("ui/src/Legacy.tsx", "export const L = () => <div />;\n")
        base = self.commit()
        self.git("update-ref", "refs/remotes/origin/main", base)
        self.git("checkout", "-q", "--orphan", "stranger")
        self.write("ui/src/New.tsx", RAW)
        self.commit("unrelated root")
        # Neither the explicit base nor origin/main shares history with HEAD.
        for explicit in (None, base):
            with mock.patch.dict(os.environ, {"UI_LINT_BASE": ""}):
                with self.assertRaisesRegex(guard.GuardError, "no merge-base"):
                    guard.resolve_base(self.root, explicit)
        with mock.patch.dict(os.environ, {"UI_LINT_BASE": ""}):
            self.assertEqual(guard.main(["--list"], root=self.root), 2)

    def test_ci_base_policy_selects_pr_default_and_feature_inputs(self):
        self.assertEqual(
            ci_base(
                PR_BASE_SHA="pr-base",
                EVENT_BEFORE="previous-tip",
                REF_NAME="123/merge",
                DEFAULT_BRANCH="main",
            ),
            "pr-base",
        )
        self.assertEqual(
            ci_base(
                PR_BASE_SHA="",
                EVENT_BEFORE="previous-tip",
                REF_NAME="main",
                DEFAULT_BRANCH="main",
            ),
            "previous-tip",
        )
        # A feature push ignores the event's before and the format step's
        # BASE_SHA: the guard stays cumulative against origin/main.
        self.assertEqual(
            ci_base(
                PR_BASE_SHA="",
                EVENT_BEFORE="previous-tip",
                REF_NAME="feature",
                DEFAULT_BRANCH="main",
                BASE_SHA="previous-tip",
            ),
            "",
        )

    def test_ci_zero_before_fails_closed(self):
        self.write("ui/src/Legacy.tsx", "export const L = () => <div />;\n")
        self.commit()
        zero = "0" * 40
        base = ci_base(PR_BASE_SHA="", EVENT_BEFORE=zero, REF_NAME="main", DEFAULT_BRANCH="main")
        self.assertEqual(base, zero)
        err = io.StringIO()
        with mock.patch.dict(os.environ, {"UI_LINT_BASE": base}), contextlib.redirect_stderr(err):
            self.assertEqual(guard.main(["--list"], root=self.root), 2)
        self.assertIn("UI_LINT_BASE", err.getvalue())
        self.assertIn("not a commit", err.getvalue())

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
