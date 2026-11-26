// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { render } from "@testing-library/react";
import Markdown from "./Markdown";

/**
 * R-shared-markdown-table — the web surface's table contract.
 *
 * `Markdown.tsx` used to carry its own four predicates and row walk; they now
 * live in `ui/src/lib/markdownTable.ts` so the phone runs the same parse. The
 * table JSX did not move, so these cases pin the four properties the
 * extraction had to preserve: a GFM table is a real `<table>`, a prose pipe
 * stays prose, and a fenced code sample stays code on this surface too.
 */

const TABLE = [
  "Here is the plan:",
  "| step | state |",
  "| --- | --- |",
  "| open | done |",
  "| closed | skipped |",
  "That is all.",
].join("\n");

describe("R-shared-markdown-table web rendering", () => {
  it("R-shared-markdown-table: a GFM table renders one th per header cell and one td per body cell, in order", () => {
    const { container } = render(<Markdown text={TABLE} />);

    expect(container.querySelectorAll("table")).toHaveLength(1);
    const headers = [...container.querySelectorAll("th")].map((cell) => cell.textContent);
    expect(headers).toEqual(["step", "state"]);
    const cells = [...container.querySelectorAll("td")].map((cell) => cell.textContent);
    expect(cells).toEqual(["open", "done", "closed", "skipped"]);
  });

  it("R-shared-markdown-table: a prose line that merely contains a pipe stays a paragraph", () => {
    const text = "Use the a | b operator when the shell needs both.";
    const { container } = render(<Markdown text={text} />);

    expect(container.querySelectorAll("table")).toHaveLength(0);
    expect(container.querySelector("p")?.textContent).toBe(text);
  });

  it("R-shared-markdown-table: a fenced code block containing a table stays pre/code and renders no table", () => {
    const text = [
      "Run this sample:",
      "```",
      "| step | state |",
      "| --- | --- |",
      "| open | done |",
      "```",
    ].join("\n");
    const { container } = render(<Markdown text={text} />);

    expect(container.querySelectorAll("table")).toHaveLength(0);
    const pre = container.querySelector("pre");
    expect(pre).not.toBeNull();
    expect(pre?.textContent).toContain("| step | state |");
    expect(pre?.textContent).toContain("| --- | --- |");
  });
});
