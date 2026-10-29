// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { t } from "../../i18n";
import type { SwitcherRow } from "../../lib/sessionSwitcher";
import SessionSwitcherSheet from "./SessionSwitcherSheet";

const rows: SwitcherRow[] = [
  { id: "a", title: "Fix the parser", project: "kin", open: true, active: true, status: "waiting" },
  { id: "b", title: "Write the docs", project: "docs", open: true, active: false, status: "running" },
  { id: "c", title: "Old session", project: "kin", open: false, active: false, status: "unread" },
  { id: "d", title: "Broken build", project: "kin", open: false, active: false, status: "failed" },
  { id: "e", title: "Quiet one", project: "", open: false, active: false, status: "idle" },
];

function setup(props: Partial<Parameters<typeof SessionSwitcherSheet>[0]> = {}) {
  const onSelect = vi.fn();
  const onClose = vi.fn();
  render(
    <SessionSwitcherSheet open onClose={onClose} rows={rows} onSelect={onSelect} {...props} />,
  );
  return { onSelect, onClose };
}

describe("the phone's session switcher", () => {
  it("splits what is open from what is merely recent", () => {
    setup();
    expect(screen.getByText(t("switcher.open"))).toBeTruthy();
    expect(screen.getByText(t("switcher.recent"))).toBeTruthy();
    expect(screen.getByText("Fix the parser")).toBeTruthy();
    expect(screen.getByText("Old session")).toBeTruthy();
  });

  it("shows the state that cannot resolve itself before the ones that can", () => {
    setup();
    // The block is a word, not a colour: "which of these needs me" is the
    // question the sheet exists to answer.
    expect(screen.getByText(t("switcher.waiting"))).toBeTruthy();
    expect(screen.getByRole("img", { name: t("switcher.running") })).toBeTruthy();
    expect(screen.getByRole("img", { name: t("switcher.unread") })).toBeTruthy();
    expect(screen.getByRole("img", { name: t("switcher.failed") })).toBeTruthy();
  });

  it("marks the session in front and switches in one tap", () => {
    const { onSelect } = setup();
    const current = screen.getByText("Fix the parser").closest("button");
    expect(current?.getAttribute("aria-current")).toBe("true");
    expect(screen.getByText("Write the docs").closest("button")?.getAttribute("aria-current")).toBe(
      null,
    );

    fireEvent.click(screen.getByText("Write the docs"));
    expect(onSelect).toHaveBeenCalledWith("b");
  });

  it("lets the row in front be tapped too, so the sheet can close", () => {
    // Switching to the session already open is a no-op navigation; the tap
    // still has to reach the host, whose handler closes the sheet.
    const { onSelect } = setup();
    fireEvent.click(screen.getByText("Fix the parser"));
    expect(onSelect).toHaveBeenCalledWith("a");
  });

  it("draws nothing while it is shut", () => {
    setup({ open: false });
    expect(screen.queryByText("Fix the parser")).toBeNull();
  });
});
