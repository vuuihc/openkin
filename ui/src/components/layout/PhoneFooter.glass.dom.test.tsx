// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import PhoneFooter from "./PhoneFooter";
import { setLocale } from "../../i18n";
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
}));

vi.mock("../../api/useLiveResources", () => ({
  usePendingResources: () => ({
    data: fixtures.pending,
    loaded: true,
    error: null,
  }),
}));

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

    expect(document.querySelectorAll("[data-phone-footer] a[aria-current='page']")).toHaveLength(
      1,
    );
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
    expect(document.querySelectorAll("[data-phone-footer] a[aria-current='page']")).toHaveLength(
      1,
    );
  });
});
