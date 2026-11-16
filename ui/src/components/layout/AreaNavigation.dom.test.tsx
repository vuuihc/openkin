// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, render, screen } from "@testing-library/react";
import { MemoryRouter, useLocation } from "react-router-dom";
import AreaNav, { railCompact } from "./AreaNav";
import AppShell from "./AppShell";
import { setLocale, t } from "../../i18n";
import { AREAS, areaById } from "../../lib/areas";
import { resolveArea } from "../../lib/areaNavigation";
import { useAppStore } from "../../store/appStore";
import { refreshMachines } from "../../hooks/useMachines";

/**
 * S1: the Mac four-area rail.
 *
 * The rail is a view of `AREAS`, so these tests read the table rather than a
 * second list of names: a destination added to the table has to turn up here,
 * and one removed has to disappear. What is pinned beyond the table is the
 * geometry decision (`railCompact`), the needs-you badge surviving both rail
 * widths, and the keyboard entry points into the same four roots.
 */

vi.mock("../../api/useLiveResources", () => ({
  useTaskList: () => ({
    data: [],
    loaded: true,
    error: null,
    pageFull: false,
    loading: false,
  }),
  useTaskResource: () => ({ data: { task: undefined }, loaded: true, error: null }),
  usePendingResources: () => ({
    data: { approvals: [], questions: [] },
    loaded: true,
    error: null,
  }),
}));

vi.mock("../../api/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../api/client")>();
  return {
    ...actual,
    listAgentSessionsPage: vi.fn(async () => ({ items: [], next_cursor: undefined })),
    listProjects: vi.fn(async () => []),
    ensureProject: vi.fn(async () => ({ id: "project-1", name: "alpha" })),
    getSettings: vi.fn(async () => ({})),
    getUsageSummary: vi.fn(async () => []),
    listAgents: vi.fn(async () => []),
    serverVersion: vi.fn().mockResolvedValue({ desktop_id: "desktop-hub", desktop_name: "hub" }),
    listMachines: vi.fn().mockResolvedValue([]),
  };
});

vi.mock("../../hooks/useMachines", () => ({
  useMachines: () => ({
    machines: [
      { id: "mac-1", label: "MacBook", isSelf: true, online: true, roots: [], agents: [] },
    ],
    loading: false,
    failed: false,
  }),
  refreshMachines: vi.fn(async () => []),
}));

vi.mock("../../hooks/useMinWidth", () => ({ useMinWidth: () => true }));
vi.mock("../../hooks/useApprovalDecision", () => ({
  useApprovalDecision: () => ({ busy: {}, decide: vi.fn() }),
}));
vi.mock("../../lib/desktop", () => ({ isKinDesktop: () => false }));
vi.mock("../terminal/TerminalPanel", () => ({ default: () => null }));

function viewport() {
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches: query.includes("min-width: 768px"),
    media: query,
    onchange: null,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    addListener: vi.fn(),
    removeListener: vi.fn(),
    dispatchEvent: vi.fn(),
  }));
}

function nav(compact = false, pendingCount = 0, initialEntry = "/sessions") {
  return render(
    <MemoryRouter initialEntries={[initialEntry]}>
      <AreaNav compact={compact} pendingCount={pendingCount} onOpenPalette={() => {}} />
    </MemoryRouter>,
  );
}

function LocationProbe() {
  const location = useLocation();
  return (
    <output data-testid="location">
      {location.pathname}
      {location.search}
    </output>
  );
}

function shell(initialEntry = "/sessions") {
  return render(
    <MemoryRouter initialEntries={[initialEntry]}>
      <AppShell pendingApprovals={[]}>
        <LocationProbe />
      </AppShell>
    </MemoryRouter>,
  );
}

function press(init: KeyboardEventInit) {
  act(() => {
    window.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, ...init }));
  });
}

beforeEach(() => {
  setLocale("en");
  sessionStorage.clear();
  localStorage.clear();
  useAppStore.getState().setWSStatus("connected");
  viewport();
  vi.mocked(refreshMachines).mockReset().mockResolvedValue([]);
});

describe("the Mac area rail", () => {
  it("lists the four areas in table order and marks the current one", () => {
    // A detail route, not the area root: the mark follows `resolveArea`, which
    // is what makes `/projects/p-1` still read as Projects rather than nothing.
    const pathname = "/projects/p-1";
    nav(false, 0, pathname);

    const links = screen.getAllByRole("link");
    expect(links.map((link) => link.getAttribute("aria-label"))).toEqual(
      AREAS.map((area) => t(area.labelKey)),
    );
    expect(links.map((link) => link.getAttribute("href"))).toEqual(AREAS.map((area) => area.root));

    const current = links.filter((link) => link.getAttribute("aria-current") === "page");
    expect(current).toHaveLength(1);
    const area = resolveArea({ pathname, search: "" });
    expect(area).not.toBeNull();
    expect(current[0].textContent).toContain(t(areaById(area!).labelKey));
  });

  it("compacts to an icon rail when the right panel is open or the window is narrower than 1280", () => {
    expect(railCompact(true, true)).toBe(true);
    expect(railCompact(false, false)).toBe(true);
    expect(railCompact(false, true)).toBe(false);
    expect(railCompact(true, false)).toBe(true);

    const { rerender } = nav(false);
    let rail = screen.getByRole("navigation", { name: t("nav.areas") });
    expect(rail.getAttribute("data-compact")).toBe("false");
    expect(rail.className).toContain("w-rail");

    rerender(
      <MemoryRouter initialEntries={["/sessions"]}>
        <AreaNav compact pendingCount={0} onOpenPalette={() => {}} />
      </MemoryRouter>,
    );
    rail = screen.getByRole("navigation", { name: t("nav.areas") });
    expect(rail.getAttribute("data-compact")).toBe("true");
    expect(rail.className).toContain("w-rail-compact");

    // The label is out of the visual layout, but the link keeps a name: the
    // rail is usable by touch and by screen reader at 64px.
    for (const area of AREAS) {
      const link = screen.getByRole("link", { name: t(area.labelKey) });
      const label = link.querySelector("[data-area-label]");
      expect(label?.className).toContain("hidden");
    }
  });

  it("keeps the needs-you badge on Chats in both rail widths", () => {
    const { rerender } = nav(false, 3);
    let chats = screen.getByRole("link", {
      name: t("nav.withCount", { label: t("nav.sessions"), count: "3" }),
    });
    expect(chats.textContent).toContain("3");
    expect(chats.textContent).not.toContain("⌘1");

    rerender(
      <MemoryRouter initialEntries={["/sessions"]}>
        <AreaNav compact pendingCount={3} onOpenPalette={() => {}} />
      </MemoryRouter>,
    );
    chats = screen.getByRole("link", {
      name: t("nav.withCount", { label: t("nav.sessions"), count: "3" }),
    });
    expect(chats.textContent).toContain("3");
    expect(chats.textContent).not.toContain("⌘1");
  });

  it("points Chats at the last list view, and leaves the list alone when it is already open", () => {
    // Off the list, the entry goes back to the exact view that was left,
    // including the params the view is made of.
    sessionStorage.setItem("kin.listUrl", "/sessions?attention=needs-you&search=alpha");
    const { unmount } = nav(false, 0, "/projects");
    expect(screen.getByRole("link", { name: t("nav.sessions") }).getAttribute("href")).toBe(
      "/sessions?attention=needs-you&search=alpha",
    );
    unmount();

    // Already on the list: the target is the current URL, so pressing Chats
    // does not reset a search or a scope the reader chose.
    nav(false, 0, "/sessions?scope=archived&search=beta");
    expect(screen.getByRole("link", { name: t("nav.sessions") }).getAttribute("href")).toBe(
      "/sessions?scope=archived&search=beta",
    );
  });
});

describe("the area shortcuts", () => {
  it("jumps between areas with Cmd+1..4", () => {
    shell();
    const here = () => screen.getByTestId("location").textContent;

    press({ key: "2", metaKey: true });
    expect(here()).toBe("/projects");
    press({ key: "3", metaKey: true });
    expect(here()).toBe("/routines");
    press({ key: "4", metaKey: true });
    expect(here()).toBe("/settings");
    press({ key: "1", metaKey: true });
    expect(here()).toBe("/sessions");

    // The same guards as the list's ⌘F: a shifted or composed chord is not
    // this shortcut, and must leave the reader where they are.
    press({ key: "2", metaKey: true, shiftKey: true });
    expect(here()).toBe("/sessions");
    press({ key: "3", metaKey: true, isComposing: true });
    expect(here()).toBe("/sessions");
  });
});
