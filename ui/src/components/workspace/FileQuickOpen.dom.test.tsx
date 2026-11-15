// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { act } from "react";
import { ApiError } from "../../api/client";
import { t } from "../../i18n";
import FileQuickOpen, {
  QUICK_OPEN_DEBOUNCE_MS,
  queryTooLong,
  splitFilePath,
} from "./FileQuickOpen";

const searchTaskSourceFiles = vi.fn();

vi.mock("../../api/client", async () => {
  const actual = await vi.importActual<typeof import("../../api/client")>("../../api/client");
  return {
    ...actual,
    searchTaskSourceFiles: (...args: unknown[]) => searchTaskSourceFiles(...args),
  };
});

// jsdom has no layout, so the row's scroll-into-view has nothing to call.
Element.prototype.scrollIntoView = vi.fn();

function answer(files: string[], truncated = false) {
  return Promise.resolve({ view: "source", files, truncated });
}

function renderFinder(onOpenPath = vi.fn(), onClose = vi.fn()) {
  const view = render(
    <FileQuickOpen taskId="task-1" open onClose={onClose} onOpenPath={onOpenPath} />,
  );
  return { ...view, onOpenPath, onClose };
}

const input = () => screen.getByPlaceholderText(t("workspace.find.placeholder"));

describe("the file finder", () => {
  beforeEach(() => {
    searchTaskSourceFiles.mockReset();
    searchTaskSourceFiles.mockImplementation(() => answer([]));
  });

  it("asks nothing until a name is typed, then asks the source search", async () => {
    renderFinder();
    // Past the debounce, not just immediately: an empty field is not a question
    // about every file in the checkout, and the daemon would refuse it anyway.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, QUICK_OPEN_DEBOUNCE_MS + 80));
    });
    expect(searchTaskSourceFiles).not.toHaveBeenCalled();

    fireEvent.change(input(), { target: { value: "a" } });
    fireEvent.change(input(), { target: { value: "ap" } });
    await waitFor(() => expect(searchTaskSourceFiles).toHaveBeenCalledTimes(1));
    // The burst is one question, and it is the last one typed.
    expect(searchTaskSourceFiles).toHaveBeenCalledWith("task-1", "ap");
  });

  it("opens the highlighted row with the keyboard", async () => {
    searchTaskSourceFiles.mockImplementation(() => answer(["src/a.ts", "docs/b.md"]));
    const { onOpenPath, onClose } = renderFinder();

    fireEvent.change(input(), { target: { value: "b" } });
    await screen.findByText("b.md");

    fireEvent.keyDown(input(), { key: "ArrowDown" });
    fireEvent.keyDown(input(), { key: "Enter" });

    expect(onOpenPath).toHaveBeenCalledWith("docs/b.md");
    expect(onClose).toHaveBeenCalled();
  });

  it("opens the row that was tapped", async () => {
    searchTaskSourceFiles.mockImplementation(() => answer(["src/a.ts", "docs/b.md"]));
    const { onOpenPath } = renderFinder();

    fireEvent.change(input(), { target: { value: "a" } });
    fireEvent.click(await screen.findByText("a.ts"));

    expect(onOpenPath).toHaveBeenCalledWith("src/a.ts");
  });

  it("keeps Escape for the layer that holds focus, and closes from the page", () => {
    const { onClose } = renderFinder();

    // A sheet on top of the finder: while focus is inside it, the key is its.
    const sheet = document.createElement("div");
    sheet.setAttribute("role", "dialog");
    sheet.tabIndex = -1;
    document.body.appendChild(sheet);
    sheet.focus();
    fireEvent.keyDown(sheet, { key: "Escape" });
    expect(onClose).not.toHaveBeenCalled();

    // The layer above closed and left focus on the page. The finder is now the
    // only thing on screen, so the next Escape has to close it — a modal that
    // ignores its only exit is worse than one that closes too eagerly.
    sheet.remove();
    expect(document.activeElement).toBe(document.body);
    fireEvent.keyDown(document.body, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("leaves Escape to a handler that already claimed it", () => {
    const { onClose } = renderFinder();
    const claimed = new KeyboardEvent("keydown", {
      key: "Escape",
      bubbles: true,
      cancelable: true,
    });
    claimed.preventDefault();
    input().dispatchEvent(claimed);
    expect(onClose).not.toHaveBeenCalled();
  });

  it("keeps Tab inside the dialog", async () => {
    searchTaskSourceFiles.mockRejectedValue(new ApiError(400, "not a git repository"));
    renderFinder();
    fireEvent.change(input(), { target: { value: "a" } });
    const retry = await screen.findByText(t("workspace.find.retry"));

    // Nothing in the dialog holds focus. Tab must land in the dialog, not walk
    // into the page behind it, which answers single letters.
    (document.activeElement as HTMLElement | null)?.blur?.();
    expect(document.activeElement).toBe(document.body);
    fireEvent.keyDown(document.body, { key: "Tab" });
    expect(document.activeElement).toBe(input());

    // The last focusable wraps back to the field rather than leaving.
    retry.focus();
    fireEvent.keyDown(retry, { key: "Tab" });
    expect(document.activeElement).toBe(input());

    // And backwards from the first, to the last.
    fireEvent.keyDown(input(), { key: "Tab", shiftKey: true });
    expect(document.activeElement).toBe(retry);
  });

  it("says when there is no match, and when the answer stopped early", async () => {
    searchTaskSourceFiles.mockImplementation(() => answer([]));
    const { unmount } = renderFinder();
    fireEvent.change(input(), { target: { value: "zzz" } });
    await screen.findByText(t("workspace.find.noMatches"));
    unmount();

    searchTaskSourceFiles.mockImplementation(() => answer(["src/a.ts"], true));
    renderFinder();
    fireEvent.change(input(), { target: { value: "a" } });
    await screen.findByText(t("workspace.find.truncated"));
    expect(screen.getByText(t("workspace.find.resultCount", { count: 1 }))).toBeTruthy();
  });

  it("does not ask a query the daemon would refuse for its byte length", async () => {
    renderFinder();
    // 100 CJK characters = 300 bytes: inside the field's 200-character cap and
    // past the daemon's 200-byte one. Asking would paint a server complaint
    // with a Retry button that could only fail again.
    fireEvent.change(input(), { target: { value: "文".repeat(100) } });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, QUICK_OPEN_DEBOUNCE_MS + 80));
    });
    expect(searchTaskSourceFiles).not.toHaveBeenCalled();
    expect(screen.getAllByText(t("workspace.find.tooLong")).length).toBeGreaterThan(0);
  });

  it("shows the daemon's refusal, announces it, and tries again on request", async () => {
    // The shape `apiFetch` throws: the `{error}` sentence is already the message.
    searchTaskSourceFiles.mockRejectedValue(new ApiError(400, "not a git repository"));
    renderFinder();

    fireEvent.change(input(), { target: { value: "a" } });
    // Twice on purpose: once on screen, once in the status region.
    await waitFor(() => expect(screen.getAllByText("not a git repository").length).toBe(2), {
      timeout: 2000,
    });
    // The one state with an action to take has to reach a screen reader too.
    expect(screen.getByRole("status").textContent).toContain("not a git repository");

    fireEvent.click(screen.getByText(t("workspace.find.retry")));
    await waitFor(() => expect(searchTaskSourceFiles).toHaveBeenCalledTimes(2), { timeout: 2000 });
  });

  it("never draws an answer to a query that has been typed past", async () => {
    let resolveFirst: (value: { view: string; files: string[] }) => void = () => {};
    let resolveSecond: (value: { view: string; files: string[] }) => void = () => {};
    searchTaskSourceFiles.mockImplementation((_id: string, query: string) =>
      query === "a"
        ? new Promise((resolve) => (resolveFirst = resolve))
        : new Promise((resolve) => (resolveSecond = resolve)),
    );
    renderFinder();

    fireEvent.change(input(), { target: { value: "a" } });
    await waitFor(() => expect(searchTaskSourceFiles).toHaveBeenCalledTimes(1));
    fireEvent.change(input(), { target: { value: "ab" } });
    await waitFor(() => expect(searchTaskSourceFiles).toHaveBeenCalledTimes(2));

    await act(async () => {
      resolveSecond({ view: "source", files: ["src/ab.ts"] });
    });
    await screen.findByText("ab.ts");

    // The first query's answer lands now. It answers a question the person has
    // already moved past, so it must not replace the rows on screen.
    await act(async () => {
      resolveFirst({ view: "source", files: ["src/a.ts"] });
    });
    await waitFor(() => expect(screen.queryByText("a.ts")).toBeNull());
    expect(screen.getByText("ab.ts")).toBeTruthy();
  });

  it("starts clean each time it opens", async () => {
    searchTaskSourceFiles.mockImplementation(() => answer(["src/a.ts"]));
    const onClose = vi.fn();
    const onOpenPath = vi.fn();
    const view = render(
      <FileQuickOpen taskId="task-1" open onClose={onClose} onOpenPath={onOpenPath} />,
    );
    fireEvent.change(input(), { target: { value: "a" } });
    await screen.findByText("a.ts");

    view.rerender(
      <FileQuickOpen taskId="task-1" open={false} onClose={onClose} onOpenPath={onOpenPath} />,
    );
    view.rerender(<FileQuickOpen taskId="task-1" open onClose={onClose} onOpenPath={onOpenPath} />);
    expect((input() as HTMLInputElement).value).toBe("");
    expect(screen.queryByText("a.ts")).toBeNull();
  });
  it("gives focus back to whatever opened it", async () => {
    const opener = document.createElement("button");
    document.body.appendChild(opener);
    opener.focus();

    const onClose = vi.fn();
    const onOpenPath = vi.fn();
    const view = render(
      <FileQuickOpen taskId="task-1" open={false} onClose={onClose} onOpenPath={onOpenPath} />,
    );
    view.rerender(<FileQuickOpen taskId="task-1" open onClose={onClose} onOpenPath={onOpenPath} />);
    // The field takes focus on a timer — before it is laid out.
    await waitFor(() => expect(document.activeElement).toBe(input()));
    view.rerender(
      <FileQuickOpen taskId="task-1" open={false} onClose={onClose} onOpenPath={onOpenPath} />,
    );
    expect(document.activeElement).toBe(opener);
    opener.remove();
  });
});

describe("queryTooLong", () => {
  it("draws the line at the daemon's byte cap, not the field's character cap", () => {
    expect(queryTooLong("a".repeat(200))).toBe(false);
    expect(queryTooLong("a".repeat(201))).toBe(true);
    // 67 CJK characters: 201 bytes, though only 67 of the field's 200 slots.
    expect(queryTooLong("文".repeat(67))).toBe(true);
  });
});

describe("splitFilePath", () => {
  it("splits at the last slash, and copes with a bare name", () => {
    expect(splitFilePath("src/components/a.tsx")).toEqual({
      dir: "src/components",
      name: "a.tsx",
    });
    expect(splitFilePath("a.ts")).toEqual({ dir: "", name: "a.ts" });
    expect(splitFilePath("src/a.ts")).toEqual({ dir: "src", name: "a.ts" });
  });
});
