// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ApiError } from "../../api/client";
import { t } from "../../i18n";
import type { ChangedFile } from "../../lib/changedFiles";
import type { ExternalApp } from "../../lib/desktop";
import WorkspacePanel from "./WorkspacePanel";

// The viewer draws through monaco, which jsdom cannot resolve. The previews are
// the subject here; the code path only has to be identifiable.
vi.mock("./CodeViewer", () => ({
  default: ({ path }: { path: string }) => <div data-testid="code-viewer">{path}</div>,
}));

// The desktop bridge is the only place the open-in menu can exist, so the test
// stands in for Electron the way OpenInMenu.dom.test.tsx does.
const desktop = vi.hoisted(() => ({
  isKinDesktop: vi.fn(() => true),
  listExternalApps: vi.fn(),
  openInExternalApp: vi.fn(),
}));

vi.mock("../../lib/desktop", async () => {
  const actual = await vi.importActual<typeof import("../../lib/desktop")>("../../lib/desktop");
  return {
    ...actual,
    isKinDesktop: desktop.isKinDesktop,
    listExternalApps: desktop.listExternalApps,
    openInExternalApp: desktop.openInExternalApp,
  };
});

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

/**
 * The changed-files flow hands the panel an absolute path; the row title is
 * how the existing tests open one. That absolute form is the trap this suite
 * exists to catch — the open-in menu refuses absolute "relative" paths.
 */
function openFile(name: string) {
  readTaskSourceFile.mockResolvedValue({
    path: name,
    content: "",
    binary: false,
    truncated: false,
  });
  const view = render(
    <WorkspacePanel taskId="task-1" cwd={CWD} changedFiles={[changedFile(name)]} events={[]} />,
  );
  fireEvent.click(screen.getByTitle(`${CWD}/${name}`));
  return view;
}

beforeEach(() => {
  desktop.isKinDesktop.mockReset().mockReturnValue(true);
  desktop.listExternalApps.mockReset().mockResolvedValue([]);
  desktop.openInExternalApp.mockReset().mockResolvedValue({ ok: true });
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

const openInTrigger = () => screen.getByRole("button", { name: t("workspace.openWith.button") });
const downloadButton = () => screen.getByRole("button", { name: t("workspace.viewer.download") });

describe("a file the console cannot draw", () => {
  it("offers the desktop open-in menu beside Download for an undrawable file", async () => {
    desktop.listExternalApps.mockResolvedValue([
      { id: "finder", label: "Finder", labelKey: "finder" } satisfies ExternalApp,
    ]);
    fetchFileBytes.mockResolvedValue(new Blob(["%PDF-"], { type: "application/pdf" }));

    // The changed-files rail reports the file as an absolute path, and the
    // menu's bridge call must still land on the file inside the workspace.
    openFile("report.pdf");

    expect(downloadButton()).toBeTruthy();
    const trigger = openInTrigger();

    await userEvent.click(trigger);
    await userEvent.click(await screen.findByRole("menuitem", { name: "Finder" }));

    await waitFor(() => expect(desktop.openInExternalApp).toHaveBeenCalledTimes(1));
    expect(desktop.openInExternalApp).toHaveBeenCalledWith(`${CWD}/report.pdf`, "finder");
    await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
    expect(document.activeElement).toBe(trigger);
  });

  it("keeps Download alone in the browser and on the phone", async () => {
    desktop.isKinDesktop.mockReturnValue(false);
    fetchFileBytes.mockResolvedValue(new Blob(["%PDF-"], { type: "application/pdf" }));

    openFile("report.pdf");

    expect(screen.queryByRole("button", { name: t("workspace.openWith.button") })).toBeNull();
    expect(screen.getByText(t("workspace.viewer.binaryHint"))).toBeTruthy();

    fireEvent.click(downloadButton());
    await waitFor(() => expect(saved).toHaveLength(1));
    expect(fetchFileBytes).toHaveBeenCalledWith(
      "/api/tasks/task-1/source/file?path=report.pdf&download=1",
    );
  });

  it("names both desktop routes in the undrawable hint", () => {
    openFile("report.pdf");

    expect(screen.getByText(t("workspace.viewer.binaryHintDesktop"))).toBeTruthy();
    expect(screen.queryByText(t("workspace.viewer.binaryHint"))).toBeNull();
  });
});

describe("a failed image preview", () => {
  it("does not offer open-in", async () => {
    // The shared DownloadPreview caller for a failed image has no workspace
    // path to open — it must not sprout a menu just because Electron is here.
    fetchFileBytes.mockRejectedValue(
      new ApiError(501, "raw preview and download are not available for a remote workspace"),
    );

    openFile("shot.png");

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("remote workspace");
    expect(screen.queryByRole("button", { name: t("workspace.openWith.button") })).toBeNull();
  });
});
