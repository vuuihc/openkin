// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { ApiError } from "../../api/client";
import { t } from "../../i18n";
import type { ChangedFile } from "../../lib/changedFiles";
import WorkspacePanel from "./WorkspacePanel";

// The viewer draws through monaco, which jsdom cannot resolve. The preview is
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

function changedFile(name: string): ChangedFile {
  return { path: `${CWD}/${name}`, action: "write", tool: "claude-code", seq: 1 };
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

// The changed-file row carries the same title, so the frame is the match that
// is an iframe — and the row appears before the async read does, so the wait is
// for the frame itself.
function queryPreviewFrame(name: string): HTMLIFrameElement | null {
  const matches = screen.queryAllByTitle(`${CWD}/${name}`);
  return (matches.find((element) => element.tagName === "IFRAME") as HTMLIFrameElement) ?? null;
}

async function previewFrame(name: string): Promise<HTMLIFrameElement> {
  await waitFor(() => expect(queryPreviewFrame(name)).not.toBeNull());
  const frame = queryPreviewFrame(name);
  if (!frame) throw new Error(`no preview frame for ${name}`);
  return frame;
}

beforeEach(() => {
  readTaskSourceFile.mockReset();
  readWorkspaceFile.mockReset();
  fetchFileBytes.mockReset();
  Object.assign(URL, {
    createObjectURL: vi.fn(() => "blob:preview"),
    revokeObjectURL: vi.fn(),
  });
});

describe("previewing an HTML file", () => {
  it("KIN-RESULT-002: an .html file opens as a sandboxed preview", async () => {
    openFile("design.html", "<style>h1 { font-size: 21px; }</style><h1>Hello</h1>");

    const frame = await previewFrame("design.html");
    // An empty sandbox attribute is every restriction: no scripts, no forms,
    // no same-origin, no popups, no top navigation.
    expect(frame.getAttribute("sandbox")).toBe("");
    const srcdoc = frame.getAttribute("srcdoc") ?? "";
    expect(srcdoc).toContain("font-size: 21px");
    const parsed = new DOMParser().parseFromString(srcdoc, "text/html");
    expect(parsed.body.querySelector("h1")?.textContent).toBe("Hello");
    expect(parsed.head.firstElementChild?.getAttribute("http-equiv")).toBe(
      "Content-Security-Policy",
    );
    // The page is built from bytes the pane already read; there is no second
    // request for it.
    expect(readTaskSourceFile).toHaveBeenCalledTimes(1);
  });

  it("KIN-RESULT-002: the frame has no scripts and no same-origin", async () => {
    openFile(
      "design.html",
      '<script>alert(1)</script><a href="https://example.com">out</a><p onclick="alert(2)">Hi</p>',
    );

    const frame = await previewFrame("design.html");
    const srcdoc = frame.getAttribute("srcdoc") ?? "";
    expect(frame.getAttribute("sandbox")).toBe("");
    expect(srcdoc).not.toContain("allow-same-origin");
    expect(srcdoc.toLowerCase()).not.toContain("<script");
    expect(srcdoc).not.toContain("https://example.com");
    expect(srcdoc).not.toContain("onclick");
    const parsed = new DOMParser().parseFromString(srcdoc, "text/html");
    expect(parsed.body.textContent).toContain("Hi");
  });

  it("KIN-RESULT-002: 源码 shows the code viewer and comes back", async () => {
    openFile("design.html", "<h1>Hello</h1>");
    await previewFrame("design.html");

    fireEvent.click(screen.getByRole("button", { name: t("workspace.viewer.code") }));
    expect(await screen.findByTestId("code-viewer")).toBeTruthy();
    await waitFor(() => {
      expect(queryPreviewFrame("design.html")).toBeNull();
    });

    fireEvent.click(screen.getByRole("button", { name: t("workspace.viewer.preview") }));
    await previewFrame("design.html");
  });

  it("KIN-RESULT-002: a truncated read shows the notice, not a page", async () => {
    openFile("design.html", "<h1>Half a page</h1>", { truncated: true });

    expect(await screen.findByText(t("workspace.viewer.htmlIncomplete"))).toBeTruthy();
    expect(queryPreviewFrame("design.html")).toBeNull();
    // The source is still one click away.
    expect(screen.getByRole("button", { name: t("workspace.viewer.code") })).toBeTruthy();
  });

  it("KIN-RESULT-002: an empty HTML file says so instead of drawing a blank frame", async () => {
    openFile("design.html", "");

    expect(await screen.findByText(t("workspace.viewer.htmlEmpty"))).toBeTruthy();
    expect(queryPreviewFrame("design.html")).toBeNull();
  });

  it("KIN-RESULT-002: the view toggle keeps its 44px touch floor", async () => {
    openFile("design.html", "<h1>Hello</h1>");
    await previewFrame("design.html");

    // The facade's own `sm:min-h-0` would drop the floor on a wide touch
    // screen, so the caller's floor carries `!`, like the composer pickers.
    for (const name of [t("workspace.viewer.preview"), t("workspace.viewer.code")]) {
      expect(screen.getByRole("button", { name }).className).toContain("min-h-11!");
    }
  });
});
