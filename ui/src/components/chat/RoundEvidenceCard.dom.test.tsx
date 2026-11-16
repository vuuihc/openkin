// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import type { TaskEvent } from "../../api/client";
import { t } from "../../i18n";
import { shortPath } from "../../lib/paths";
import type { RoundEvidence } from "../../lib/roundEvidence";
import RoundEvidenceCard from "./RoundEvidenceCard";

/**
 * C4a parity guards for the round evidence card: its header and file rows are
 * disclosures on the shared facade, and the scope sentence — the line that says
 * whether this list is the workspace's answer or only what the file tools
 * reported — must survive both states.
 */

const PATH = "src/components/parser.ts";

const evidence: RoundEvidence = {
  files: [{ path: PATH, action: "edit", tool: "edit", seq: 2, additions: 1, deletions: 1 }],
  totalFiles: 1,
  additions: 1,
  deletions: 1,
  hasStats: true,
  events: [
    {
      task_id: "task-evidence",
      event_epoch: 0,
      seq: 2,
      ts: 2,
      type: "tool_use",
      payload: {
        speaker: "kin",
        name: "edit",
        input: { path: PATH, old_string: "const a = 1;", new_string: "const a = 2;" },
      },
    } as TaskEvent,
  ],
  source: "tools",
};

const disclosures = (container: HTMLElement) =>
  Array.from(container.querySelectorAll<HTMLButtonElement>("button[aria-expanded]"));
const header = (container: HTMLElement) => disclosures(container)[0];
const fileRow = (container: HTMLElement) => disclosures(container)[1];

describe("the round evidence card", () => {
  it("starts open and its header folds and unfolds the file list", () => {
    const { container } = render(<RoundEvidenceCard evidence={evidence} />);

    expect(header(container).getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByText(shortPath(PATH, 40))).toBeTruthy();

    fireEvent.click(header(container));
    expect(header(container).getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByText(shortPath(PATH, 40))).toBeNull();

    fireEvent.click(header(container));
    expect(screen.getByText(shortPath(PATH, 40))).toBeTruthy();
  });

  it("a file row expands to its preview and collapses again", () => {
    const { container } = render(<RoundEvidenceCard evidence={evidence} />);

    expect(fileRow(container).getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByText("const a = 2;")).toBeNull();

    fireEvent.click(fileRow(container));
    expect(fileRow(container).getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByText("const a = 2;")).toBeTruthy();

    fireEvent.click(fileRow(container));
    expect(fileRow(container).getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByText("const a = 2;")).toBeNull();
  });

  it("the open-file control passes the file path", () => {
    const onOpenPath = vi.fn();
    const { container } = render(<RoundEvidenceCard evidence={evidence} onOpenPath={onOpenPath} />);

    fireEvent.click(fileRow(container));
    const openFile = screen.getByRole("button", {
      name: `${t("workspace.openFile")} · ${shortPath(PATH, 48)}`,
    });
    expect(openFile.getAttribute("title")).toBe(PATH);
    fireEvent.click(openFile);

    expect(onOpenPath).toHaveBeenCalledWith(PATH);
  });

  it("the scope sentence stays visible in both states", () => {
    const { container } = render(<RoundEvidenceCard evidence={evidence} />);

    // Which answer this list is — the workspace's, or the file tools' — is the
    // one claim the card must never hide behind its own fold.
    expect(screen.getByText(t("chat.evidence.scope"))).toBeTruthy();
    fireEvent.click(header(container));
    expect(header(container).getAttribute("aria-expanded")).toBe("false");
    expect(screen.getByText(t("chat.evidence.scope"))).toBeTruthy();
  });
});
