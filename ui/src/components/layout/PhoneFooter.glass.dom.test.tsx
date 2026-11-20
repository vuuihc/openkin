// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import PhoneFooter from "./PhoneFooter";
import AppShell from "./AppShell";
import { SettingsLayout } from "../settings/SettingsPrimitives";
import { setLocale, t } from "../../i18n";
import { useAppStore } from "../../store/appStore";
import type { Approval, UserQuestion } from "../../api/client";

/**
 * KIN-CONTINUE-005: the phone footer is one floating glass surface with four
 * icon-only entries.
 *
 * The bar has to stay the same navigation object it was in KIN-CONTINUE-002 —
 * four links, the same four accessible names, one current area, the waiting
 * count inside the Chats link. These cases pin only what the material change
 * promised, so a future skin cannot quietly drop a name, grow a second control,
 * or turn the current area back into a tint.
 */

const fixtures = vi.hoisted(() => ({
  pending: { approvals: [] as Approval[], questions: [] as UserQuestion[] },
  viewport: { width: 1100 },
}));

vi.mock("../../api/useLiveResources", () => ({
  usePendingResources: () => ({
    data: fixtures.pending,
    loaded: true,
    error: null,
  }),
  // `AppShell` reads both; the ancestor case below renders it whole so the
  // footer's containing block is the real column, not a test wrapper.
  useTaskList: () => ({ data: [], loaded: true, error: null, pageFull: false, loading: false }),
  useTaskResource: () => ({ data: { task: undefined }, loaded: true, error: null }),
}));

// The shell answers `useMinWidth(768)` and `useMinWidth(1280)` from one number,
// so a case can say "phone" and get the phone shell.
vi.mock("../../hooks/useMinWidth", () => ({
  useMinWidth: (px: number) => fixtures.viewport.width >= px,
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
      { id: "node-1", label: "workstation", isSelf: true, online: true, roots: [], agents: [] },
    ],
    loading: false,
    failed: false,
  }),
}));

vi.mock("../../hooks/useApprovalDecision", () => ({
  useApprovalDecision: () => ({ busy: {}, decide: vi.fn() }),
}));
vi.mock("../../lib/desktop", () => ({ isKinDesktop: vi.fn(() => false) }));
vi.mock("../terminal/TerminalPanel", () => ({ default: () => null }));

function approval(id: string, taskId: string): Approval {
  return {
    id,
    task_id: taskId,
    kind: "tool",
    payload: {},
    decision: "pending",
    created_at: 1,
  };
}

function footer(initialEntry = "/sessions") {
  return render(
    <MemoryRouter initialEntries={[initialEntry]}>
      <PhoneFooter />
    </MemoryRouter>,
  );
}

beforeEach(() => {
  setLocale("en");
  fixtures.pending = { approvals: [], questions: [] };
  fixtures.viewport.width = 1100;
  useAppStore.getState().setWSStatus("connected");
  useAppStore.setState({ shownPanel: null });
});

describe("KIN-CONTINUE-005 phone footer", () => {
  it("KIN-CONTINUE-005 keeps four icon-only entries with the four accessible names", () => {
    footer();

    const links = screen.getAllByRole("link");
    expect(links).toHaveLength(4);
    for (const name of ["Chats", "Routines", "Agent Ops", "Settings"]) {
      expect(screen.getByRole("link", { name })).toBeTruthy();
    }

    // The name is carried by `sr-only`, so it reaches the screen reader and the
    // role query without taking a line of the bar (design decision D2).
    const settings = screen.getByRole("link", { name: "Settings" });
    const label = within(settings).getByText("Settings");
    expect(label.className).toContain("sr-only");
    // No other text is rendered inside the link: the glyph is the whole face.
    const textCarriers = [...settings.querySelectorAll("span")].filter(
      (span) => (span.textContent ?? "").trim() !== "" && span.querySelector("svg") === null,
    );
    expect(textCarriers.map((span) => span.className)).toEqual([
      expect.stringContaining("sr-only"),
    ]);

    expect(document.querySelectorAll("[data-phone-footer] a[aria-current='page']")).toHaveLength(1);
  });

  it("KIN-CONTINUE-005 every footer entry is at least a 48px tap target", () => {
    footer();

    const links = [...document.querySelectorAll("[data-phone-footer] a")];
    expect(links).toHaveLength(4);
    // `min-h-12` is 3rem, the 48px TASTE asks of a phone control. The bar's own
    // `min-h-[var(--phone-footer-bar)]` is the surface height; this row is the
    // one a thumb lands on, so it is pinned on every entry rather than on one.
    for (const link of links) {
      expect(link.className.split(/\s+/)).toContain("min-h-12");
    }
  });

  it("KIN-CONTINUE-005 positions the footer against the shell column, not the viewport", () => {
    fixtures.viewport.width = 390;
    render(
      <MemoryRouter initialEntries={["/sessions"]}>
        <AppShell pendingApprovals={[]}>
          <div />
        </AppShell>
      </MemoryRouter>,
    );

    const bar = document.querySelector("[data-phone-footer]") as HTMLElement;
    expect(bar).toBeTruthy();
    // `absolute` is only meaningful relative to the nearest positioned
    // ancestor. That ancestor has to be the shell's content column, which is
    // `relative`; with the bar anchored to the viewport instead, a phone
    // keyboard or a browser chrome resize would leave it floating over the
    // wrong edge. The mutant that moves `relative` off this column is the
    // proof this case is load-bearing.
    expect(bar.className).toContain("absolute");
    const column = bar.parentElement as HTMLElement;
    expect(column).toBeTruthy();
    const classes = column.className.split(/\s+/);
    for (const name of ["relative", "flex", "flex-1", "flex-col", "min-w-0", "min-h-0"]) {
      expect(classes, `the footer's containing block is the content column (${name})`).toContain(
        name,
      );
    }
    // Directly inside it: a wrapper between the two would become the offset
    // parent for anything positioned inside the column. And the column itself
    // is the shell root's child, the one that spends the safe-area inset.
    expect(column.parentElement?.className).toContain("safe-pad");
  });

  it("KIN-CONTINUE-005 leaves the Mac shell without a footer", () => {
    fixtures.viewport.width = 1100;
    render(
      <MemoryRouter initialEntries={["/sessions"]}>
        <AppShell pendingApprovals={[]}>
          <div />
        </AppShell>
      </MemoryRouter>,
    );

    // Acceptance row 3, Mac half: the footer belongs to the phone shell, and a
    // Mac keeps its area rail instead (story `各面差异`). Asserting the rail
    // first keeps this case from passing on a tree that rendered nothing.
    expect(screen.getByRole("navigation", { name: t("nav.areas") })).toBeTruthy();
    expect(document.querySelector("[data-phone-footer]")).toBeNull();
  });

  it("KIN-CONTINUE-005 draws the bar as one floating glass surface over the content", () => {
    footer();

    const bar = document.querySelector("[data-phone-footer]") as HTMLElement;
    expect(bar).toBeTruthy();
    expect(bar.className).toContain("kin-glass");
    expect(bar.className).toContain("absolute");
    // The 22px corner is the footer's own rule in `index.css`; the radius
    // ladder has no word for it, so it must not be an arbitrary class here.
    expect(bar.className).not.toMatch(/rounded-\[/);
    // Pinned above the safe area by the shared footer geometry, not a magic
    // number repeated in the page's clearance.
    expect(bar.className).toContain("bottom-[var(--phone-footer-gap)]");
    expect(bar.className).toContain("inset-x-[var(--phone-footer-gap)]");
    // The opaque strip is gone; one surface, still four links, no new control.
    expect(bar.className).not.toContain("bg-kin-sidebar");
    expect(bar.querySelectorAll("a")).toHaveLength(4);
    expect(bar.querySelectorAll("button")).toHaveLength(0);
    expect(bar.querySelector("[role='dialog']")).toBeNull();
  });

  it("KIN-CONTINUE-005 clears the Settings directory after the General body", () => {
    Element.prototype.scrollIntoView = vi.fn();
    render(
      <SettingsLayout
        title="Settings"
        tabs={[
          { id: "general", label: "General", description: "General settings" },
          { id: "advanced", label: "Advanced", description: "Advanced settings" },
        ]}
        activeTab="general"
        onTabChange={() => undefined}
      >
        <p>General body</p>
      </SettingsLayout>,
    );

    const lastRow = screen.getByRole("button", { name: /Advanced/ });
    const scroller = lastRow.closest(".overflow-y-auto");
    expect(scroller).toBeTruthy();
    expect(scroller?.classList.contains("phone-footer-clearance")).toBe(true);
    expect(screen.getByText("General body").closest(".phone-footer-clearance")).toBe(scroller);
    expect(document.querySelectorAll(".phone-footer-clearance")).toHaveLength(1);
  });

  it("KIN-CONTINUE-005 marks the waiting count on Chats and drops it at zero", () => {
    fixtures.pending = {
      approvals: Array.from({ length: 9 }, (_, index) => approval(`a${index}`, `t${index}`)),
      questions: Array.from(
        { length: 3 },
        (_, index) =>
          ({
            id: `q${index}`,
            task_id: `t${index}`,
            payload: { question: "Which way?" },
            status: "pending",
            created_at: 1,
          }) as UserQuestion,
      ),
    };
    footer();

    const chats = screen.getByRole("link", { name: /Chats/ });
    // The visible cap is a layout decision; the accessible name keeps the fact.
    expect(chats.textContent).toContain("9+");
    expect(within(chats).getByText("12 waiting for you")).toBeTruthy();
    expect(chats.querySelectorAll("button")).toHaveLength(0);

    cleanup();
    fixtures.pending = { approvals: [], questions: [] };
    footer();
    const quiet = screen.getByRole("link", { name: "Chats" });
    expect(quiet.textContent).not.toContain("waiting for you");
    expect(quiet.textContent).not.toContain("0");
  });

  it("KIN-CONTINUE-005 shows a single waiting count as itself, not a cap", () => {
    fixtures.pending = {
      approvals: [approval("a1", "t1"), approval("a2", "t2"), approval("a3", "t3")],
      questions: [],
    };
    footer();

    const chats = screen.getByRole("link", { name: /Chats/ });
    // Acceptance row 2 says a waiting count of 3 renders "3"; the 9+ cap is a
    // separate layout decision and must not swallow the single digit.
    expect(within(chats).getByText("3")).toBeTruthy();
    expect(within(chats).getByText("3 waiting for you")).toBeTruthy();
    expect(chats.textContent).not.toContain("9+");
    // Still a mark inside the link, never a second control.
    expect(chats.querySelectorAll("button")).toHaveLength(0);
  });

  it("KIN-CONTINUE-005 keeps the current area as a filled capsule and the rest linear", () => {
    footer("/settings");

    const current = document.querySelector(
      "[data-phone-footer] a[aria-current='page']",
    ) as HTMLElement;
    expect(current).toBeTruthy();
    expect(current.getAttribute("href")).toBe("/settings");
    const capsule = current.querySelector("[data-phone-tab-icon]") as HTMLElement;
    expect(capsule.className).toContain("bg-kin-blue");
    // `bg-kin-blue` is assigned `--kin-on-brand` in `design/colors.ts`.
    expect(capsule.className).toContain("text-kin-on-brand");
    expect(capsule.className).toContain("rounded-full");

    for (const link of document.querySelectorAll("[data-phone-footer] a")) {
      if (link === current) continue;
      const marker = link.querySelector("[data-phone-tab-icon]") as HTMLElement;
      expect(marker.className).not.toContain("bg-kin-blue");
    }
    expect(document.querySelectorAll("[data-phone-footer] a[aria-current='page']")).toHaveLength(1);
  });
});
