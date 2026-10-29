// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, useLocation } from "react-router-dom";
import { t } from "../i18n";
import CommandPalette from "./CommandPalette";

const listTasks = vi.fn();
const listProjects = vi.fn();
const searchTranscript = vi.fn();

vi.mock("../api/client", async () => {
  const actual = await vi.importActual<typeof import("../api/client")>("../api/client");
  return {
    ...actual,
    isAuthenticated: () => true,
    listTasks: (...args: unknown[]) => listTasks(...args),
    listProjects: (...args: unknown[]) => listProjects(...args),
    searchTranscript: (...args: unknown[]) => searchTranscript(...args),
  };
});

function LocationProbe() {
  const location = useLocation();
  return <div data-testid="location">{location.pathname + location.search}</div>;
}

function renderPalette() {
  return render(
    <MemoryRouter initialEntries={["/sessions"]}>
      <CommandPalette
        open
        onClose={vi.fn()}
        onNewChat={vi.fn()}
        onTogglePanel={vi.fn()}
        panelCtx={{ taskId: null, remote: false, desktop: false }}
      />
      <LocationProbe />
    </MemoryRouter>,
  );
}

const searchBox = () => screen.getByPlaceholderText(t("palette.search"));

function hit(overrides: Record<string, unknown> = {}) {
  return {
    task_id: "task-9",
    task_title: "Deploy notes",
    seq: 4,
    ts: 1,
    role: "assistant",
    snippet: "rotate the release token on Monday",
    ...overrides,
  };
}

describe("the palette's message search", () => {
  beforeEach(() => {
    listTasks.mockReset().mockResolvedValue([]);
    listProjects.mockReset().mockResolvedValue([]);
    searchTranscript.mockReset().mockResolvedValue({ matches: [], truncated: false });
  });

  it("asks once typing settles, and opens the match in its conversation", async () => {
    searchTranscript.mockResolvedValue({ matches: [hit()], truncated: false });
    renderPalette();

    // Two keystrokes in one burst are one question: the first timer is cleared.
    fireEvent.change(searchBox(), { target: { value: "release" } });
    fireEvent.change(searchBox(), { target: { value: "release token" } });
    // Not per keystroke: the answer is asked for once the word is finished.
    expect(searchTranscript).not.toHaveBeenCalled();

    await screen.findByText(t("palette.messages"));
    expect(searchTranscript).toHaveBeenCalledTimes(1);
    expect(searchTranscript).toHaveBeenCalledWith("release token");

    // The snippet is the row (the query is highlighted inside it, so the row
    // is addressed as a button rather than by its text).
    fireEvent.click(screen.getByRole("button"));
    expect(screen.getByTestId("location").textContent).toBe("/tasks/task-9?find=release%20token");
  });

  it("opens the conversation on the query when the row is chosen with Enter", async () => {
    searchTranscript.mockResolvedValue({ matches: [hit({ seq: 1 })], truncated: false });
    renderPalette();
    fireEvent.change(searchBox(), { target: { value: "monday" } });
    await screen.findByText(t("palette.messages"));

    // Walk down to the message row, which is the last section's last row.
    const rows = screen.getAllByRole("button");
    for (let i = 0; i < rows.length - 1; i += 1) {
      fireEvent.keyDown(window, { key: "ArrowDown" });
    }
    fireEvent.keyDown(window, { key: "Enter" });
    expect(screen.getByTestId("location").textContent).toBe("/tasks/task-9?find=monday");
  });

  it("never draws an answer to a query that has been typed past", async () => {
    let first: (value: unknown) => void = () => {};
    let second: (value: unknown) => void = () => {};
    searchTranscript.mockImplementation((query: string) =>
      query === "old"
        ? new Promise((resolve) => (first = resolve))
        : new Promise((resolve) => (second = resolve)),
    );
    renderPalette();

    fireEvent.change(searchBox(), { target: { value: "old" } });
    await waitFor(() => expect(searchTranscript).toHaveBeenCalledTimes(1));
    fireEvent.change(searchBox(), { target: { value: "new" } });
    await waitFor(() => expect(searchTranscript).toHaveBeenCalledTimes(2));

    await act(async () => {
      second({ matches: [hit({ snippet: "the new answer" })], truncated: false });
    });
    await screen.findByText(t("palette.messages"));
    const rowText = () =>
      screen
        .getAllByRole("button")
        .map((b) => b.textContent ?? "")
        .join(" | ");

    // The first answer arrives late. It answers a word the person typed past,
    // so its row must not appear under the newer query.
    await act(async () => {
      first({
        matches: [hit({ task_id: "task-old", task_title: "Old notes", snippet: "the old answer" })],
        truncated: false,
      });
    });
    expect(rowText()).toContain("the new answer");
    expect(rowText()).not.toContain("the old answer");
  });

  it("offers no section when nothing matched", async () => {
    renderPalette();
    fireEvent.change(searchBox(), { target: { value: "nothing" } });
    await waitFor(() => expect(searchTranscript).toHaveBeenCalledTimes(1));
    expect(screen.queryByText(t("palette.messages"))).toBeNull();
  });

  it("says when the list is only the newest matches", async () => {
    searchTranscript.mockResolvedValue({ matches: [hit()], truncated: true });
    renderPalette();
    fireEvent.change(searchBox(), { target: { value: "release" } });
    // The section shows a page of results; saying so is better than letting a
    // reader conclude those are all the matches there are.
    await screen.findByText(t("palette.messagesTruncated"));
    expect(screen.getByText(t("palette.messages"))).toBeTruthy();
  });
});
