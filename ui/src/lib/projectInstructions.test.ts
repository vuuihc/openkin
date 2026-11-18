import { describe, expect, it } from "vitest";
import { PROJECT_INSTRUCTIONS_MAX, projectInstructions } from "./projectInstructions";

/**
 * KIN-PROJECT-003: the cover shows exactly the text a new chat receives.
 *
 * The rule mirrors `internal/store/onepager.go`: read `## 工作方式` (or one of
 * its aliases), keep the body's own line breaks, cut at 400 code points, and
 * report truncation instead of hiding the cut. An absent, empty or placeholder
 * section is empty — never the heading.
 */

const DOC = [
  "# alpha",
  "",
  "## North Star",
  "why it exists",
  "",
  "## 工作方式",
  "先跑 make test",
  "不要手改 generated/",
  "",
  "- 先读 docs/README.md",
  "- 再看 ADR 0013",
  "",
  "## 下一步（你写的）",
  "1. ship it",
  "",
].join("\n");

describe("projectInstructions (KIN-PROJECT-003)", () => {
  it("returns the section body with its line breaks and list markers", () => {
    expect(projectInstructions(DOC)).toEqual({
      text: "先跑 make test\n不要手改 generated/\n\n- 先读 docs/README.md\n- 再看 ADR 0013",
      truncated: false,
    });
  });

  it("reads both English aliases and ignores another section", () => {
    expect(projectInstructions("# a\n\n## How to work here\nrun tests\n").text).toBe("run tests");
    expect(projectInstructions("# a\n\n## Instructions\nrun tests\n").text).toBe("run tests");
    expect(projectInstructions("# a\n\n## North Star\nwhy\n").text).toBe("");
  });

  it("returns empty for empty, placeholder and whitespace-only sections", () => {
    expect(projectInstructions("# a\n\n## 工作方式\n\n## Next\n- one\n")).toEqual({
      text: "",
      truncated: false,
    });
    expect(projectInstructions("# a\n\n## 工作方式\n-\n")).toEqual({ text: "", truncated: false });
    expect(projectInstructions("# a\n\n## 工作方式\n—\n")).toEqual({ text: "", truncated: false });
    expect(projectInstructions("# a\n\n## 工作方式\n \n\t\n")).toEqual({
      text: "",
      truncated: false,
    });
    expect(projectInstructions("")).toEqual({ text: "", truncated: false });
  });

  it("keeps exactly 400 code points and cuts 401 to 400 plus an ellipsis", () => {
    const atLimit = "工".repeat(PROJECT_INSTRUCTIONS_MAX);
    const overLimit = "工".repeat(PROJECT_INSTRUCTIONS_MAX + 1);

    expect(projectInstructions(`# a\n\n## 工作方式\n${atLimit}\n`)).toEqual({
      text: atLimit,
      truncated: false,
    });
    expect(projectInstructions(`# a\n\n## 工作方式\n${overLimit}\n`)).toEqual({
      text: "工".repeat(PROJECT_INSTRUCTIONS_MAX) + "…",
      truncated: true,
    });
  });

  it("counts code points, not UTF-16 units", () => {
    // Each emoji is one code point and two UTF-16 units; a length check on the
    // string would cut this at 200 emoji.
    const emoji = "😀".repeat(PROJECT_INSTRUCTIONS_MAX + 1);
    const got = projectInstructions(`# a\n\n## 工作方式\n${emoji}\n`);
    expect(got.truncated).toBe(true);
    expect(Array.from(got.text)).toHaveLength(PROJECT_INSTRUCTIONS_MAX + 1);
    expect(got.text).toBe("😀".repeat(PROJECT_INSTRUCTIONS_MAX) + "…");
  });

  it("stops at the next heading and at the managed block", () => {
    const withNext = "# a\n\n## 工作方式\nrun tests\n\n## Next\n- one\n";
    expect(projectInstructions(withNext).text).toBe("run tests");

    const withAuto =
      "# a\n\n## 工作方式\nrun tests\n\n<!-- kin:auto:start -->\n## Pulse\n_stats_\n";
    expect(projectInstructions(withAuto).text).toBe("run tests");
  });
});
