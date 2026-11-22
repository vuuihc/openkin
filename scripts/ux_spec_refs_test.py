#!/usr/bin/env python3
"""Tests for the journey spec-ref checker.

Run directly: `python3 -B scripts/ux_spec_refs_test.py`. Every verdict case
runs the real checker against a throwaway tree and spec. Three cases also read
the checked-in spec and this working tree, because the point of the guard is
the real refs: a journey step that names a retired area, an unregistered route
or a `data-kin-*` hook nothing renders must turn the real checker red even when
no fixture changes. The checked-in spec is pinned green for the same reason the
sibling removed-surfaces suite pins its record: the guard ships to this tree,
so a red here is a defect in the guard, not a discovery (STATUS Watch 76).
"""

from __future__ import annotations

import json
import re
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

SCRIPTS = Path(__file__).resolve().parent
ROOT = SCRIPTS.parent
CHECKER = SCRIPTS / "ux_spec_refs.py"
SPEC = ROOT / "rsi" / "runtime" / "ux" / "journeys.json"
SPEC_READER = ROOT / "rsi" / "runtime" / "ux" / "spec.py"

KIN_ATTR = re.compile(r"data-kin-([a-z0-9-]+)")


class Fixture:
    """A throwaway tree with the three console facts and a journey spec.

    The default tree is a clean one: three live areas, the routes the shipped
    console registers (catch-all included), one rendered `data-kin-*` hook and
    a journey that only visits a live route.
    """

    def __init__(self) -> None:
        self._tmp = tempfile.TemporaryDirectory(prefix="kin-ux-spec-refs-")
        self.root = Path(self._tmp.name)
        self.write_areas("conversations", "routines", "settings")
        self.write_routes(
            "/", "/new", "/sessions", "/tasks/:id", "/routines", "/settings", "*"
        )
        self.write_kin("bottom-chrome")
        self.write_journey([["goto", "/sessions"]])

    def write(self, relative: str, body: str) -> None:
        path = self.root / relative
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(body, encoding="utf-8")

    def write_areas(self, *ids: str) -> None:
        rows = "\n".join(
            f'  {{ id: "{area}", labelKey: "nav.{area}" }},' for area in ids
        )
        self.write(
            "ui/src/lib/areas.ts",
            "type AreaRow = { readonly id: string };\n\n"
            "export const AREAS = [\n"
            f"{rows}\n"
            "] as const satisfies readonly AreaRow[];\n",
        )

    def write_routes(self, *paths: str) -> None:
        rows = "\n".join(
            f'              <Route path="{path}" element={{null}} />' for path in paths
        )
        self.write(
            "ui/src/App.tsx",
            "export function App() {\n  return (\n    <Routes>\n"
            f"{rows}\n"
            "    </Routes>\n  );\n}\n",
        )

    def write_kin(self, *names: str) -> None:
        attrs = " ".join(f'data-kin-{name}="true"' for name in names)
        self.write(
            "ui/src/components/BottomChrome.tsx",
            f"export function BottomChrome() {{\n  return <div {attrs} />;\n}}\n",
        )

    def write_journey(self, steps: list[list[str]], jid: str = "J1") -> None:
        self.write_spec({jid: {"steps": steps}})

    def write_spec(self, journeys: dict) -> None:
        self.write(
            "rsi/runtime/ux/journeys.json",
            json.dumps({"journeys": journeys}, ensure_ascii=False, indent=2) + "\n",
        )

    def run_checker(self, *extra: str) -> subprocess.CompletedProcess[str]:
        return subprocess.run(
            [sys.executable, "-B", str(CHECKER), "--root", str(self.root), *extra],
            capture_output=True,
            text=True,
        )

    def cleanup(self) -> None:
        self._tmp.cleanup()


class SpecRefVerdictTest(unittest.TestCase):
    def setUp(self) -> None:
        self.fixture = Fixture()
        self.addCleanup(self.fixture.cleanup)

    def test_area_selector_naming_a_retired_area_fails(self) -> None:
        # #584's sendback: J9 clicked [data-area="projects"] after the same PR
        # retired that area. The gate must name the journey, the step and the
        # retired area in seconds, without a browser.
        self.fixture.write_journey(
            [
                ["goto", "/sessions"],
                ["click", 'css=[data-area="projects"]'],
            ]
        )
        result = self.fixture.run_checker()
        self.assertEqual(result.returncode, 1, result.stdout + result.stderr)
        self.assertIn("J1", result.stderr)
        self.assertIn("step 2", result.stderr)
        self.assertIn("projects", result.stderr)

    def test_every_live_area_id_passes(self) -> None:
        for area in ("conversations", "routines", "settings"):
            with self.subTest(area=area):
                self.fixture.write_journey([["click", f'css=[data-area="{area}"]']])
                result = self.fixture.run_checker()
                self.assertEqual(
                    result.returncode, 0, result.stdout + result.stderr
                )

    def test_goto_of_a_retired_route_fails(self) -> None:
        # The fixture's App.tsx carries the real tree's catch-all `*` route:
        # a catch-all is the fallback a retired path lands on, not a
        # registration, so it must not make /projects look live.
        self.fixture.write_journey([["goto", "/projects"]])
        result = self.fixture.run_checker()
        self.assertEqual(result.returncode, 1, result.stdout + result.stderr)
        self.assertIn("/projects", result.stderr)

    def test_goto_of_a_registered_route_with_a_placeholder_passes(self) -> None:
        self.fixture.write_journey(
            [["goto", "/tasks/{conversation}?focus=chat#reply"]]
        )
        result = self.fixture.run_checker()
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)

    def test_url_expectation_of_a_retired_prefix_fails(self) -> None:
        self.fixture.write_journey([["url", "^/projects/"]])
        result = self.fixture.run_checker()
        self.assertEqual(result.returncode, 1, result.stdout + result.stderr)
        self.assertIn("projects", result.stderr)

    def test_url_expectation_of_a_live_prefix_passes(self) -> None:
        self.fixture.write_journey(
            [
                ["url", "^/tasks/"],
                ["url", "^/settings$"],
                # An escaped `?` is a literal character, not regex syntax: the
                # prefix is still /settings.
                ["url", "^/settings\\?tab=providers"],
            ]
        )
        result = self.fixture.run_checker()
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)

    def test_a_commented_out_area_row_is_not_live(self) -> None:
        # A retired id left in a comment is a mention, not a row.
        self.fixture.write(
            "ui/src/lib/areas.ts",
            "type AreaRow = { readonly id: string };\n\n"
            "export const AREAS = [\n"
            '  { id: "conversations", labelKey: "nav.sessions" },\n'
            '  // { id: "projects", labelKey: "nav.projects" },\n'
            "] as const satisfies readonly AreaRow[];\n",
        )
        self.fixture.write_journey([["click", 'css=[data-area="projects"]']])
        result = self.fixture.run_checker()
        self.assertEqual(result.returncode, 1, result.stdout + result.stderr)
        self.assertIn("projects", result.stderr)

    def test_a_rendered_data_kin_selector_passes(self) -> None:
        self.fixture.write_journey([["wait", "css=[data-kin-bottom-chrome]"]])
        result = self.fixture.run_checker()
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)

    def test_a_css_selector_mentioning_a_hook_is_not_a_render(self) -> None:
        # A dead stylesheet rule is how a retired hook stays mentioned after
        # its component stops rendering it; it must not keep the hook live.
        self.fixture.write(
            "ui/src/index.css",
            ".kin-main[data-kin-ghost-card] { outline: none; }\n",
        )
        self.fixture.write_journey([["wait", "css=[data-kin-ghost-card]"]])
        result = self.fixture.run_checker()
        self.assertEqual(result.returncode, 1, result.stdout + result.stderr)
        self.assertIn("ghost-card", result.stderr)

    def test_a_test_file_fabricating_a_hook_is_not_a_render(self) -> None:
        # A test's fixture attribute is not a render: no reader can click it.
        self.fixture.write(
            "ui/src/components/BottomChrome.test.tsx",
            'it("renders", () => render(<div data-kin-ghost-card="true" />));\n',
        )
        self.fixture.write_journey([["wait", "css=[data-kin-ghost-card]"]])
        result = self.fixture.run_checker()
        self.assertEqual(result.returncode, 1, result.stdout + result.stderr)
        self.assertIn("ghost-card", result.stderr)

    def test_a_commented_out_data_kin_attribute_is_not_a_render(self) -> None:
        self.fixture.write(
            "ui/src/components/Comments.tsx",
            "// <div data-kin-ghost-card />\n"
            "/* data-kin-spectre */\n"
            "export const Comments = () => null;\n",
        )
        self.fixture.write_journey([["wait", "css=[data-kin-ghost-card]"]])
        result = self.fixture.run_checker()
        self.assertEqual(result.returncode, 1, result.stdout + result.stderr)
        self.assertIn("ghost-card", result.stderr)

    def test_data_kin_selector_nothing_renders_fails(self) -> None:
        self.fixture.write_journey([["wait", "css=[data-kin-ghost-card]"]])
        result = self.fixture.run_checker()
        self.assertEqual(result.returncode, 1, result.stdout + result.stderr)
        self.assertIn("ghost-card", result.stderr)

    def test_a_dynamic_data_kin_selector_cannot_be_checked(self) -> None:
        # A hook built at runtime (`data-kin-${role}`) cannot be held against a
        # literal scan; passing it silently is the hole this guard closes.
        self.fixture.write_journey([["wait", "css=[data-kin-${role}]"]])
        result = self.fixture.run_checker()
        self.assertEqual(result.returncode, 2, result.stdout + result.stderr)
        self.assertIn("UX_SPEC_REFS_ERROR", result.stderr)

    def test_a_dynamic_area_selector_cannot_be_checked(self) -> None:
        # The same rule for the area hook: an unquoted selector the literal
        # scan cannot read must not pass as if it had been checked.
        self.fixture.write_journey([["click", "css=[data-area=projects]"]])
        result = self.fixture.run_checker()
        self.assertEqual(result.returncode, 2, result.stdout + result.stderr)
        self.assertIn("UX_SPEC_REFS_ERROR", result.stderr)


class FailClosedTest(unittest.TestCase):
    def setUp(self) -> None:
        self.fixture = Fixture()
        self.addCleanup(self.fixture.cleanup)

    def test_an_unreadable_journey_body_fails_closed(self) -> None:
        # The sibling reader (rsi/runtime/ux/spec.py) exits 2 on a missing body;
        # the checker must carry that verdict, never turn it into a pass.
        spec = self.fixture.root / "elsewhere" / "spec.json"
        spec.parent.mkdir(parents=True)
        spec.write_text(
            json.dumps({"journeys": {"J1": "journeys/J1.json"}}), encoding="utf-8"
        )
        result = self.fixture.run_checker("--spec", str(spec))
        self.assertEqual(result.returncode, 2, result.stdout + result.stderr)
        self.assertIn("J1", result.stderr)

    def test_a_tree_with_no_area_ids_fails_closed(self) -> None:
        self.fixture.write_areas()
        result = self.fixture.run_checker()
        self.assertEqual(result.returncode, 2, result.stdout + result.stderr)
        self.assertIn("UX_SPEC_REFS_ERROR", result.stderr)
        self.assertIn("area", result.stderr)

    def test_a_tree_with_no_routes_fails_closed(self) -> None:
        self.fixture.write_routes()
        result = self.fixture.run_checker()
        self.assertEqual(result.returncode, 2, result.stdout + result.stderr)
        self.assertIn("UX_SPEC_REFS_ERROR", result.stderr)
        self.assertIn("route", result.stderr)

    def test_a_tree_with_only_the_catch_all_route_fails_closed(self) -> None:
        # The catch-all is a fallback, not a named route: a route set made only
        # of it cannot prove any goto is live.
        self.fixture.write_routes("*")
        result = self.fixture.run_checker()
        self.assertEqual(result.returncode, 2, result.stdout + result.stderr)
        self.assertIn("UX_SPEC_REFS_ERROR", result.stderr)
        self.assertIn("catch-all", result.stderr)

    def test_a_tree_with_no_data_kin_names_fails_closed(self) -> None:
        self.fixture.write_kin()
        result = self.fixture.run_checker()
        self.assertEqual(result.returncode, 2, result.stdout + result.stderr)
        self.assertIn("UX_SPEC_REFS_ERROR", result.stderr)
        self.assertIn("data-kin", result.stderr)


class RealTreeTest(unittest.TestCase):
    def test_the_real_journey_spec_is_green(self) -> None:
        # Watch 76: the guard ships to this tree, so it must be green here.
        result = subprocess.run(
            [sys.executable, "-B", str(CHECKER)],
            cwd=ROOT,
            capture_output=True,
            text=True,
        )
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertIn("UX_SPEC_REFS_OK", result.stdout)

    def test_every_data_kin_selector_in_the_real_journeys_is_rendered(self) -> None:
        # An independent read of the same fact the checker judges: the resolved
        # journeys name at least one data-kin hook, and every one of them is a
        # literal in ui/src. Proves the checker's green is not an empty scan.
        resolved = subprocess.run(
            [sys.executable, "-B", str(SPEC_READER), "--resolve", str(SPEC)],
            cwd=ROOT,
            capture_output=True,
            text=True,
        )
        self.assertEqual(resolved.returncode, 0, resolved.stdout + resolved.stderr)
        spec = json.loads(resolved.stdout)
        named: set[str] = set()
        for journey in spec["journeys"].values():
            for step in journey["steps"]:
                for argument in step:
                    if isinstance(argument, str):
                        named.update(KIN_ATTR.findall(argument))
        rendered: set[str] = set()
        for path in (ROOT / "ui" / "src").rglob("*"):
            if not path.is_file() or path.suffix not in (".ts", ".tsx"):
                continue
            if ".test." in path.name or ".spec." in path.name:
                continue
            source = path.read_text(encoding="utf-8")
            # Comments and stylesheets mention hooks; only a component renders
            # one. Same fact the checker judges, read independently here.
            source = re.sub(r"\{\/\*[\s\S]*?\*\/\}", "", source)
            source = re.sub(r"/\*[\s\S]*?\*/", "", source)
            source = re.sub(r"//[^\n]*", "", source)
            rendered.update(KIN_ATTR.findall(source))
        self.assertTrue(named, "the journeys name no data-kin selector; scan broken")
        self.assertLessEqual(named, rendered)


class GateWiringTest(unittest.TestCase):
    def test_check_sh_runs_the_checker_on_every_gate(self) -> None:
        # AGENTS.md §12: a guard nobody wires is a green light for the
        # regression. The job must be unconditional, and the suite runs before
        # the checker so a broken guard is reported as the guard.
        text = (SCRIPTS / "check.sh").read_text(encoding="utf-8")
        self.assertIn("job_ux_spec_refs()", text)
        self.assertIn("python3 -B scripts/ux_spec_refs_test.py", text)
        self.assertIn("python3 -B scripts/ux_spec_refs.py", text)
        self.assertIn("start ux-spec-refs job_ux_spec_refs", text)


if __name__ == "__main__":
    unittest.main()
