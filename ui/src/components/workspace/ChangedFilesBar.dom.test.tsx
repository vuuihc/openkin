// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { DEFAULT_LOCALE, setLocale, t } from "../../i18n";
import type { ChangedFile } from "../../lib/changedFiles";
import ChangedFilesBar from "./ChangedFilesBar";

// Assert against the copy the component reads, not a copy of it: a wording
// change must not turn a behaviour test red. Read at call time — `t` resolves
// the locale when it runs, and the locale is switched per test.
const reviewTitle = () => t("workspace.changed.reviewTitle", { count: 2 });
const expand = () => t("workspace.changed.expand");

beforeEach(() => {
  setLocale("en");
});

afterEach(() => {
  setLocale(DEFAULT_LOCALE);
});

function changed(path: string, seq: number): ChangedFile {
  return { path, action: "write", tool: "claude-code", seq, additions: 3, deletions: 1 };
}

const twoFiles = [changed("src/a.ts", 1), changed("src/b.ts", 2)];

describe("KIN-RESULT-001: the changed-files summary row is one shared Button", () => {
  it("bar: the summary row is the shared Button and opens the workspace panel", async () => {
    const user = userEvent.setup();
    const onOpenPath = vi.fn();
    const onOpenPanel = vi.fn();
    render(<ChangedFilesBar files={twoFiles} onOpenPath={onOpenPath} onOpenPanel={onOpenPanel} />);

    const summary = screen.getByRole("button", { name: new RegExp(reviewTitle()) });
    expect(summary.className).toContain("kin-btn");
    expect(summary.getAttribute("aria-label")).toContain(reviewTitle());
    expect(summary.getAttribute("aria-label")).toContain(expand());

    await user.click(summary);

    expect(onOpenPanel).toHaveBeenCalledTimes(1);
    // The bar's summary opens the panel; it does not name a file.
    expect(onOpenPath).toHaveBeenCalledTimes(1);
    expect(onOpenPanel.mock.calls[0]).toEqual([]);
  });

  it("card: the summary row is the shared Button and opens the workspace panel", async () => {
    const user = userEvent.setup();
    const onOpenPath = vi.fn();
    const onOpenPanel = vi.fn();
    render(
      <ChangedFilesBar
        files={twoFiles}
        onOpenPath={onOpenPath}
        onOpenPanel={onOpenPanel}
        variant="card"
      />,
    );

    const summary = screen.getByRole("button", { name: new RegExp(reviewTitle()) });
    expect(summary.className).toContain("kin-btn");
    expect(summary.getAttribute("aria-label")).toContain(reviewTitle());
    expect(summary.getAttribute("aria-label")).toContain(expand());

    await user.click(summary);
    expect(onOpenPanel).toHaveBeenCalledTimes(1);

    // The dismiss X keeps its name and still dismisses the card.
    const dismiss = screen.getByRole("button", { name: t("workspace.changed.dismiss") });
    expect(dismiss.className).toContain("kin-btn");
    await user.click(dismiss);
    expect(screen.queryByRole("button", { name: new RegExp(reviewTitle()) })).toBeNull();
  });

  it("file row: opens that file's diff and is still a list row", async () => {
    const user = userEvent.setup();
    const onOpenPath = vi.fn();
    const onOpenPanel = vi.fn();
    render(
      <ChangedFilesBar
        files={twoFiles}
        onOpenPath={onOpenPath}
        onOpenPanel={onOpenPanel}
        variant="card"
      />,
    );

    const row = screen.getByTitle("src/a.ts");
    // A list row, not an action button: the row is the hit area.
    expect(row.tagName).toBe("BUTTON");
    expect(row.className).not.toContain("kin-btn");

    await user.click(row);
    expect(onOpenPath).toHaveBeenCalledWith("src/a.ts");
    expect(onOpenPanel).toHaveBeenCalledTimes(1);

    // The suppression this row needs is written, not implied: `kin/no-raw-button`
    // runs as an error on any file a PR touches.
    const source = readFileSync(
      resolve(process.cwd(), "src/components/workspace/ChangedFilesBar.tsx"),
      "utf8",
    );
    const lines = source.split("\n");
    const rawRows = lines
      .map((line, index) => ({ line, index }))
      .filter(({ line }) => line.includes("<button"));
    for (const { index } of rawRows) {
      const reasonLine = lines[index - 1];
      expect(
        reasonLine,
        `raw <button at ChangedFilesBar.tsx:${index + 1} needs an eslint-disable-next-line kin/no-raw-button`,
      ).toContain("eslint-disable-next-line kin/no-raw-button");
      const reason = reasonLine.split("--").slice(1).join("--").trim();
      expect(reason, `the suppression at line ${index + 1} needs a written reason`).not.toBe("");
    }
    // Only the file row is left: both summary rows are the shared Button.
    expect(rawRows).toHaveLength(1);
  });
});
