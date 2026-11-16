// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { t } from "../../i18n";
import type { TerminalSession } from "../../api/client";
import TerminalTabs from "./TerminalTabs";

/**
 * W2: the tab strip is on the shared button facade without losing what a tab
 * is. The roving tab stop, the arrow keys and the close control's refusal to
 * select its own tab are the contract; the facade is only the ink.
 */

const sessions: TerminalSession[] = [
  {
    id: "s1",
    profile_id: "p1",
    name: "bash",
    cwd: "/tmp/work",
    status: "running",
    created_at: 1,
  },
  {
    id: "s2",
    profile_id: "p1",
    name: "zsh",
    cwd: "/tmp/work",
    status: "running",
    created_at: 2,
  },
];

describe("TerminalTabs", () => {
  it("renders each tab as a role=tab button on the facade and keeps one tab stop", () => {
    render(
      <TerminalTabs
        sessions={sessions}
        activeSessionId="s1"
        onSelectSession={vi.fn()}
        onCloseSession={vi.fn()}
      />,
    );

    const tabs = screen.getAllByRole("tab");
    expect(tabs).toHaveLength(2);
    for (const tab of tabs) expect(tab.className).toContain("kin-btn");
    expect(tabs[0]!.getAttribute("aria-selected")).toBe("true");
    expect(tabs[0]!.getAttribute("tabindex")).toBe("0");
    expect(tabs[1]!.getAttribute("aria-selected")).toBe("false");
    expect(tabs[1]!.getAttribute("tabindex")).toBe("-1");
  });

  it("closes a session from its own control without selecting the tab", () => {
    const onSelectSession = vi.fn();
    const onCloseSession = vi.fn();
    render(
      <TerminalTabs
        sessions={sessions}
        activeSessionId="s1"
        onSelectSession={onSelectSession}
        onCloseSession={onCloseSession}
      />,
    );

    const closes = screen.getAllByRole("button", { name: t("terminal.closeSession") });
    fireEvent.click(closes[0]!);

    expect(onCloseSession).toHaveBeenCalledTimes(1);
    expect(onCloseSession).toHaveBeenCalledWith("s1");
    expect(onSelectSession).not.toHaveBeenCalled();
  });

  it("moves selection with the arrow keys", async () => {
    const onSelectSession = vi.fn();
    render(
      <TerminalTabs
        sessions={sessions}
        activeSessionId="s1"
        onSelectSession={onSelectSession}
        onCloseSession={vi.fn()}
      />,
    );

    const tabs = screen.getAllByRole("tab");
    tabs[0]!.focus();
    fireEvent.keyDown(tabs[0]!, { key: "ArrowRight" });

    expect(onSelectSession).toHaveBeenCalledWith("s2");
    // The next tab is focused after a frame, as it was before the migration.
    await waitFor(() => expect(document.activeElement).toBe(tabs[1]));
  });
});
