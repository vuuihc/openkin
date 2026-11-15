import { describe, expect, it } from "vitest";
import { onePagerFocus, setOnePagerFocus } from "./onePagerSummary";

/**
 * KIN-PROJECT-001, step 5: the cover edits one line, and only that line.
 *
 * The stored document is the One-Pager, whose other sections belong to the
 * reader and whose `kin:auto` block belongs to the refresh. A save that
 * re-serialised the whole file would be a quiet way to lose both.
 */

const DOC = [
  "# alpha",
  "",
  "## 项目描述",
  "a small project",
  "",
  "## North Star",
  "why it exists",
  "",
  "## Current Focus",
  "ship the first slice",
  "",
  "## 下一步（你写的）",
  "1. write the test",
  "",
  "<!-- kin:auto:start -->",
  "## Pulse（自动）",
  "_stats_",
  "<!-- kin:auto:end -->",
  "",
].join("\n");

describe("onePagerFocus (KIN-PROJECT-001)", () => {
  it("reads the focus section and collapses it to one line", () => {
    expect(onePagerFocus(DOC)).toBe("ship the first slice");
    expect(onePagerFocus(DOC.replace("ship the first slice", "one\n  two"))).toBe("one two");
  });

  it("reads nothing when the section is absent or empty", () => {
    expect(onePagerFocus("# alpha\n\n## North Star\nwhy\n")).toBe("");
    expect(onePagerFocus(DOC.replace("ship the first slice", ""))).toBe("");
  });

  it("does not borrow another section's text", () => {
    expect(onePagerFocus(DOC)).not.toContain("why it exists");
    expect(onePagerFocus(DOC)).not.toContain("write the test");
  });
});

describe("setOnePagerFocus (KIN-PROJECT-001)", () => {
  it("replaces the focus body and leaves every other section byte for byte", () => {
    const next = setOnePagerFocus(DOC, "ship the second slice");
    expect(onePagerFocus(next)).toBe("ship the second slice");
    expect(next).toContain("## North Star\nwhy it exists");
    expect(next).toContain("## 下一步（你写的）\n1. write the test");
    expect(next).toContain(
      "<!-- kin:auto:start -->\n## Pulse（自动）\n_stats_\n<!-- kin:auto:end -->",
    );
    expect(next.startsWith("# alpha\n\n## 项目描述\na small project")).toBe(true);
  });

  it("empties the section without deleting its heading", () => {
    const next = setOnePagerFocus(DOC, "   ");
    expect(next).toContain("## Current Focus\n\n## 下一步（你写的）");
    expect(onePagerFocus(next)).toBe("");
    expect(next).toContain("## North Star\nwhy it exists");
  });

  it("accepts the Chinese heading the parser also reads", () => {
    const zh = "# alpha\n\n## 当前焦点\n旧的\n\n## 下一步\n- one\n";
    const next = setOnePagerFocus(zh, "新的方向");
    expect(onePagerFocus(next)).toBe("新的方向");
    expect(next).toContain("## 下一步\n- one");
  });

  it("adds the section before the managed block when the document has none", () => {
    const bare =
      "# alpha\n\n## North Star\nwhy\n\n<!-- kin:auto:start -->\n## Pulse\n<!-- kin:auto:end -->\n";
    const next = setOnePagerFocus(bare, "one line");
    expect(next).toContain(
      "## North Star\nwhy\n\n## Current Focus\none line\n\n<!-- kin:auto:start -->",
    );
    expect(onePagerFocus(next)).toBe("one line");
  });

  it("appends the section to a document without one or a managed block", () => {
    const next = setOnePagerFocus("# alpha\n\n## North Star\nwhy\n", "one line");
    expect(next.endsWith("## Current Focus\none line\n")).toBe(true);
    expect(onePagerFocus(next)).toBe("one line");
  });

  it("leaves a document alone when there is nothing to write and no section", () => {
    const bare = "# alpha\n\n## North Star\nwhy\n";
    expect(setOnePagerFocus(bare, "  ")).toBe(bare);
  });

  it("is stable when the same line is saved twice", () => {
    const once = setOnePagerFocus(DOC, "steady");
    expect(setOnePagerFocus(once, "steady")).toBe(once);
  });
});
