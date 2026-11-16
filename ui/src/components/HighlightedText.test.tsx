// @vitest-environment jsdom
import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import HighlightedText from "./HighlightedText";

/**
 * The mark is the answer to "why is this row in my results".
 *
 * A `<mark>` per match, the original text intact, and no mark at all when
 * there is nothing to mark — a stray empty `<mark>` would draw a tinted sliver
 * next to a title that did not match.
 */
describe("HighlightedText", () => {
  it("marks every occurrence and keeps the text whole", () => {
    const { container } = render(<HighlightedText text="note the note" query="note" />);
    const marks = container.querySelectorAll("mark");
    expect(marks).toHaveLength(2);
    expect(marks[0]!.textContent).toBe("note");
    expect(container.textContent).toBe("note the note");
  });

  it("marks case-insensitively but shows the original casing", () => {
    const { container } = render(<HighlightedText text="Fix The Parser" query="the parser" />);
    expect(container.querySelector("mark")?.textContent).toBe("The Parser");
    expect(container.textContent).toBe("Fix The Parser");
  });

  it("renders plain text when the query is empty", () => {
    const { container } = render(<HighlightedText text="anything" query="  " />);
    expect(container.querySelector("mark")).toBeNull();
    expect(container.textContent).toBe("anything");
  });

  it("renders plain text when nothing matches", () => {
    const { container } = render(<HighlightedText text="anything" query="zzz" />);
    expect(container.querySelector("mark")).toBeNull();
    expect(container.textContent).toBe("anything");
  });

  it("keeps the marked run adjacent to its neighbours", () => {
    // The split must not insert whitespace: the trailing run keeps its leading
    // space exactly, and the concatenation is the original string.
    const { container } = render(<HighlightedText text="parser fix" query="parser" />);
    expect(container.querySelector("mark")?.textContent).toBe("parser");
    expect(container.querySelector("span")?.textContent).toBe(" fix");
    expect(container.textContent).toBe("parser fix");
  });
});
