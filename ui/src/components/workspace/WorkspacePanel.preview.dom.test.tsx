// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { ApiError } from "../../api/client";
import { t } from "../../i18n";
import type { ChangedFile } from "../../lib/changedFiles";
import WorkspacePanel from "./WorkspacePanel";

// The viewer draws through monaco, which jsdom cannot resolve. The previews are
// the subject here; the code path only has to be identifiable.
vi.mock("./CodeViewer", () => ({
  default: ({ path }: { path: string }) => <div data-testid="code-viewer">{path}</div>,
}));

const readTaskSourceFile = vi.fn();
const readWorkspaceFile = vi.fn();
const fetchFileBytes = vi.fn();

vi.mock("../../api/client", async () => {
  const actual = await vi.importActual<typeof import("../../api/client")>("../../api/client");
  return {
    ...actual,
    fetchFileBytes: (...args: unknown[]) => fetchFileBytes(...args),
    readTaskSourceFile: (...args: unknown[]) => readTaskSourceFile(...args),
    readWorkspaceFile: (...args: unknown[]) => readWorkspaceFile(...args),
    listTaskSourceTree: () => Promise.resolve({ path: ".", entries: [] }),
    listWorkspaceTree: () => Promise.resolve({ path: ".", entries: [] }),
    listTaskWorkspaces: () => Promise.resolve([]),
    getTaskSourceChanges: () => Promise.resolve({ changes: [] }),
    getWorkspaceDiff: () => Promise.resolve({ files: [] }),
  };
});

const CWD = "/Users/owner/project";

Element.prototype.scrollIntoView = vi.fn();

// jsdom has no object URLs and follows no anchor clicks; these stand in for
// both so a download can be asserted without a browser.
const createObjectURL = vi.fn();
const revokeObjectURL = vi.fn();
const saved: Array<{ download: string; href: string }> = [];
const anchorClick = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (
  this: HTMLAnchorElement,
) {
  saved.push({ download: this.download, href: this.href });
});

function changedFile(name: string): ChangedFile {
  return { path: `${CWD}/${name}`, action: "write", tool: "claude-code", seq: 1 };
}

// jsdom has no layout, and the panel asks its own container how wide it is
// rather than the viewport. `clientWidth` is 0 here, so a case that cares says
// what its container measures — the same stub `WorkspacePanel.paths` uses.
function stubContainerWidth(width: number) {
  Object.defineProperty(HTMLElement.prototype, "clientWidth", {
    configurable: true,
    get: () => width,
  });
}

function restoreContainerWidth() {
  delete (HTMLElement.prototype as { clientWidth?: number }).clientWidth;
}

function openFile(
  name: string,
  content = "",
  options: { truncated?: boolean; fail?: string } = {},
) {
  if (options.fail) {
    readTaskSourceFile.mockRejectedValue(new ApiError(400, options.fail));
  } else {
    readTaskSourceFile.mockResolvedValue({
      path: name,
      content,
      binary: false,
      truncated: options.truncated ?? false,
    });
  }
  const view = render(
    <WorkspacePanel taskId="task-1" cwd={CWD} changedFiles={[changedFile(name)]} events={[]} />,
  );
  fireEvent.click(screen.getByTitle(`${CWD}/${name}`));
  return view;
}

beforeEach(() => {
  readTaskSourceFile.mockReset();
  readWorkspaceFile.mockReset();
  fetchFileBytes.mockReset();
  anchorClick.mockClear();
  saved.length = 0;
  let made = 0;
  createObjectURL.mockReset().mockImplementation(() => `blob:preview-${(made += 1)}`);
  revokeObjectURL.mockReset();
  Object.assign(URL, { createObjectURL, revokeObjectURL });
});

describe("previewing a file the editor cannot show", () => {
  it("draws an image fetched as bytes instead of reading it as text", async () => {
    const png = new Blob([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], { type: "image/png" });
    fetchFileBytes.mockResolvedValue(png);
    openFile("shot.png");

    const img = await screen.findByRole("img", { name: `${CWD}/shot.png` });
    // The daemon refuses a PNG through the text read — it is not UTF-8 — so the
    // image is fetched as bytes through the same route with `raw=1`.
    expect(fetchFileBytes).toHaveBeenCalledWith(
      "/api/tasks/task-1/source/file?path=shot.png&raw=1",
    );
    expect(createObjectURL).toHaveBeenCalledWith(png);
    expect(img.getAttribute("src")).toBe("blob:preview-1");
    expect(readTaskSourceFile).not.toHaveBeenCalled();
  });

  it("announces the wait while the bytes are on their way", () => {
    fetchFileBytes.mockReturnValue(new Promise<Blob>(() => {}));
    openFile("shot.png");

    expect(
      screen
        .getAllByRole("status")
        .some((el) => el.textContent?.includes(t("workspace.viewer.loading"))),
    ).toBe(true);
  });

  it("shows why an image failed, and the download still tries a different route", async () => {
    // A workspace on another machine answers the preview with its refusal. The
    // download is a separate request, so it gets to answer for itself.
    fetchFileBytes
      .mockRejectedValueOnce(
        new ApiError(501, "raw preview and download are not available for a remote workspace"),
      )
      .mockResolvedValueOnce(new Blob(["bytes"]));
    openFile("shot.png");

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("remote workspace");

    const button = screen.getByRole("button", { name: t("workspace.viewer.download") });
    fireEvent.click(button);

    await waitFor(() => expect(saved).toHaveLength(1));
    expect(fetchFileBytes).toHaveBeenLastCalledWith(
      "/api/tasks/task-1/source/file?path=shot.png&download=1",
    );
    // The saved file is named for the file, not for its path.
    expect(anchorClick).toHaveBeenCalled();
    expect(saved[0]).toEqual({ download: "shot.png", href: "blob:preview-1" });
  });

  it("does not read a binary at all, and downloads it under its own name", async () => {
    const pdf = new Blob(["%PDF-"], { type: "application/pdf" });
    fetchFileBytes.mockResolvedValue(pdf);
    openFile("report.pdf");

    expect(screen.getByText(t("workspace.viewer.binaryHint"))).toBeTruthy();
    expect(readTaskSourceFile).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: t("workspace.viewer.download") }));
    await waitFor(() => expect(saved).toHaveLength(1));
    expect(fetchFileBytes).toHaveBeenCalledWith(
      "/api/tasks/task-1/source/file?path=report.pdf&download=1",
    );
    expect(createObjectURL).toHaveBeenCalledWith(pdf);
    expect(saved[0].download).toBe("report.pdf");
  });

  it("says why a download failed instead of saving the refusal", async () => {
    // The old link saved whatever came back, so a 400 wrote a JSON error page
    // to disk under the file's name. The failure belongs on screen.
    fetchFileBytes.mockRejectedValue(new ApiError(400, "file exceeds 4 MiB"));
    openFile("report.pdf");

    fireEvent.click(screen.getByRole("button", { name: t("workspace.viewer.download") }));

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("file exceeds 4 MiB");
    expect(anchorClick).not.toHaveBeenCalled();
    expect(saved).toHaveLength(0);
  });

  it("does not carry one file's download state to the next", async () => {
    // The button's busy/error state is per file. Reusing the instance across
    // two binaries showed the first file's refusal under the second, and left
    // its button disabled while the first save was still in flight.
    fetchFileBytes.mockRejectedValue(new ApiError(501, "remote workspace"));
    render(
      <WorkspacePanel
        taskId="task-1"
        cwd={CWD}
        changedFiles={[changedFile("report.pdf"), changedFile("notes.docx")]}
        events={[]}
      />,
    );
    fireEvent.click(screen.getByTitle(`${CWD}/report.pdf`));
    fireEvent.click(screen.getByRole("button", { name: t("workspace.viewer.download") }));
    expect((await screen.findByRole("alert")).textContent).toContain("remote workspace");

    fireEvent.click(screen.getByTitle(`${CWD}/notes.docx`));
    expect(screen.queryByRole("alert")).toBeNull();
    const button = screen.getByRole("button", { name: t("workspace.viewer.download") });
    expect((button as HTMLButtonElement).disabled).toBe(false);
  });

  it("fetches the image again when the same file is reopened", async () => {
    // An agent may have rewritten the screenshot since it was last drawn; the
    // click is a request to look again.
    fetchFileBytes.mockResolvedValue(new Blob(["png"]));
    openFile("shot.png");
    await screen.findByRole("img", { name: `${CWD}/shot.png` });
    expect(fetchFileBytes).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByTitle(`${CWD}/shot.png`));
    await waitFor(() => expect(fetchFileBytes).toHaveBeenCalledTimes(2));
  });

  it("revokes the preview's object URL when the file is closed", async () => {
    fetchFileBytes.mockResolvedValue(new Blob(["png"]));
    const { unmount } = openFile("shot.png");
    const img = await screen.findByRole("img", { name: `${CWD}/shot.png` });
    const url = img.getAttribute("src");
    expect(url).toBe("blob:preview-1");

    unmount();
    expect(revokeObjectURL).toHaveBeenCalledWith(url);
  });

  it("lays a CSV out as a table", async () => {
    openFile("inventory.csv", "name,qty\napple,3\npear,5\n");

    await waitFor(() => expect(screen.getByRole("table")).toBeTruthy());
    expect(readTaskSourceFile).toHaveBeenCalledWith("task-1", "inventory.csv");
    expect(screen.getByRole("columnheader", { name: "name" })).toBeTruthy();
    expect(screen.getByRole("cell", { name: "apple" })).toBeTruthy();
    // The file is shown as a table, not as its source.
    expect(screen.queryByTestId("code-viewer")).toBeNull();
  });

  it("says when a table was cut short by the parser's bounds", async () => {
    const rows = Array.from({ length: 201 }, (_, i) => `row${i},${i}`).join("\n");
    openFile("big.csv", rows);

    await waitFor(() =>
      expect(
        screen.getByText(t("workspace.viewer.tableTruncated", { rows: 200, columns: 30 })),
      ).toBeTruthy(),
    );
    expect(screen.queryByRole("cell", { name: "row199" })).toBeTruthy();
  });

  it("says when the read itself was cut short", async () => {
    // The parser stopped at the end of what it was given, but the daemon did
    // not give it the whole file: a table that hides that lies about the data.
    openFile("big.csv", "name,qty\napple,3\n", { truncated: true });

    await waitFor(() => expect(screen.getByRole("table")).toBeTruthy());
    expect(screen.getByText(t("workspace.viewer.tableIncomplete"))).toBeTruthy();
  });

  it("says it is loading, empty, or failed when the table is not there", async () => {
    readTaskSourceFile.mockReturnValue(new Promise(() => {}));
    render(
      <WorkspacePanel
        taskId="task-1"
        cwd={CWD}
        changedFiles={[changedFile("slow.csv")]}
        events={[]}
      />,
    );
    fireEvent.click(screen.getByTitle(`${CWD}/slow.csv`));
    expect(
      screen
        .getAllByRole("status")
        .some((el) => el.textContent?.includes(t("workspace.viewer.loading"))),
    ).toBe(true);
  });

  it("says a table is empty when the file has no rows", async () => {
    openFile("empty.csv", "");

    await waitFor(() => expect(screen.getByText(t("workspace.viewer.tableEmpty"))).toBeTruthy());
    expect(screen.queryByRole("table")).toBeNull();
  });

  it("shows the daemon's refusal when the read failed", async () => {
    openFile("broken.csv", "", { fail: "file is not valid UTF-8" });

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("not valid UTF-8");
    expect(screen.queryByRole("table")).toBeNull();
  });

  it("keeps the source one click away from the table", async () => {
    // A writable generation can edit a CSV only as text, and the table is a
    // reading view. The switch hands the file back to the editor, which reads
    // the content that was already fetched.
    openFile("inventory.csv", "name,qty\napple,3\n");
    await waitFor(() => expect(screen.getByRole("table")).toBeTruthy());

    fireEvent.click(screen.getByRole("button", { name: t("workspace.viewer.code") }));

    await waitFor(() => expect(screen.getByTestId("code-viewer")).toBeTruthy());
    expect(screen.queryByRole("table")).toBeNull();
    expect(readTaskSourceFile).toHaveBeenCalledTimes(1);
  });

  it("keeps SVG in the code viewer", async () => {
    // Text, and a document that can carry script: it is read and shown as
    // source, never drawn as an image.
    openFile("logo.svg", "<svg/>");

    await waitFor(() => expect(screen.getByTestId("code-viewer")).toBeTruthy());
    expect(readTaskSourceFile).toHaveBeenCalledWith("task-1", "logo.svg");
    expect(screen.queryByRole("img")).toBeNull();
  });
});

/**
 * KIN-RESULT-002 「手机」: a failed read keeps the reason in the detail and
 * offers the one action that can change it. Before this, the pane said what
 * went wrong and left the reader on a phone with no way back to the file
 * except leaving the detail and finding the row again.
 */
describe("a read that failed", () => {
  it("says why, and reads the same file again when asked", async () => {
    readTaskSourceFile.mockRejectedValueOnce(new ApiError(400, "file is not valid UTF-8"));
    readTaskSourceFile.mockResolvedValueOnce({
      path: "notes.md",
      content: "the second read",
      binary: false,
    });
    render(
      <WorkspacePanel
        taskId="task-1"
        cwd={CWD}
        changedFiles={[changedFile("notes.md")]}
        events={[]}
      />,
    );
    fireEvent.click(screen.getByTitle(`${CWD}/notes.md`));

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("not valid UTF-8");

    fireEvent.click(screen.getByRole("button", { name: t("workspace.viewer.retry") }));

    await waitFor(() => expect(readTaskSourceFile).toHaveBeenCalledTimes(2));
    expect(readTaskSourceFile).toHaveBeenLastCalledWith("task-1", "notes.md");
    // The second answer replaces the refusal instead of sitting beside it.
    await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
    expect(screen.getByTestId("code-viewer").textContent).toBe(`${CWD}/notes.md`);
  });

  it("offers no retry for a path this panel cannot ask for", async () => {
    render(
      <WorkspacePanel
        taskId="task-1"
        cwd={CWD}
        changedFiles={[{ ...changedFile("a.ts"), path: "/Users/owner/elsewhere/a.ts" }]}
        events={[]}
      />,
    );
    fireEvent.click(screen.getByTitle("/Users/owner/elsewhere/a.ts"));

    expect(await screen.findByRole("alert")).toBeTruthy();
    // The refusal happens before any request, so a retry could only repeat it.
    expect(screen.queryByRole("button", { name: t("workspace.viewer.retry") })).toBeNull();
  });
});

/**
 * F3 on a tablet: the changed-file row is the way into the diff. Measured
 * 2026-11-24 at 820×1180 coarse, the panel is a 756px full-bleed overlay, so
 * the two-pane split draws; narrower containers (the 380px column beside a
 * conversation, a split window) stack and must bring the file to the front.
 * Both cases tap the row *inside the panel*: the transcript's round card draws
 * its own `notes.md` row behind the overlay, and a selector that picks that one
 * measures a control the reader cannot reach.
 */
describe("a changed row tapped on a tablet", () => {
  afterEach(() => restoreContainerWidth());

  const panes = (container: HTMLElement) => container.querySelector("[data-panes]");
  const hasClass = (el: Element | null | undefined, token: string) =>
    (el?.className ?? "").split(/\s+/).includes(token);

  it("keeps both panes and selects the file in the 756px split", async () => {
    stubContainerWidth(756);
    readTaskSourceFile.mockResolvedValue({ path: "notes.md", content: "hi", binary: false });
    const { container } = render(
      <WorkspacePanel
        taskId="task-1"
        cwd={CWD}
        changedFiles={[changedFile("notes.md")]}
        events={[]}
      />,
    );

    const row = screen.getByTitle(`${CWD}/notes.md`);
    expect(panes(container)?.getAttribute("data-panes")).toBe("split");

    fireEvent.click(row);

    await waitFor(() => expect(readTaskSourceFile).toHaveBeenCalledWith("task-1", "notes.md"));
    // The tap is a selection, not a pane switch: the list stays beside the diff.
    expect(panes(container)?.getAttribute("data-panes")).toBe("split");
    expect(row.getAttribute("data-selected")).toBe("true");
    expect(hasClass(container.querySelector('[data-pane="viewer"]'), "hidden")).toBe(false);
    await waitFor(() =>
      expect(screen.getByTestId("code-viewer").textContent).toBe(`${CWD}/notes.md`),
    );
  });

  it("brings the file pane to the front when the panel is narrower than the split", async () => {
    stubContainerWidth(620);
    readTaskSourceFile.mockResolvedValue({ path: "notes.md", content: "hi", binary: false });
    const { container } = render(
      <WorkspacePanel
        taskId="task-1"
        cwd={CWD}
        changedFiles={[changedFile("notes.md")]}
        events={[]}
      />,
    );

    fireEvent.click(screen.getByTitle(`${CWD}/notes.md`));

    await waitFor(() => expect(readTaskSourceFile).toHaveBeenCalledWith("task-1", "notes.md"));
    expect(panes(container)?.getAttribute("data-panes")).toBe("stacked");
    expect(panes(container)?.getAttribute("data-phone-view")).toBe("file");
    expect(hasClass(container.querySelector("aside"), "hidden")).toBe(true);
    expect(hasClass(container.querySelector('[data-pane="viewer"]'), "hidden")).toBe(false);
    expect(screen.getByRole("button", { name: t("workspace.backToFiles") })).toBeTruthy();
  });
});
