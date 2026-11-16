// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { AgentInfo, LimitHit } from "../../api/client";
import { setLocale, t } from "../../i18n";
import LimitCard from "./LimitCard";

/**
 * The limit card is where a stopped run is either resumed, handed to another
 * agent, or dismissed. Every action must reach its own handler, say which one
 * is working, and leave exactly one filled action on screen — the one that
 * moves the run forward.
 */

const fallback: AgentInfo = {
  id: "claude-code",
  name: "Claude Code",
  installed: true,
  available: true,
  default: false,
  model_list_source: "none",
  model_list_status: "unavailable",
};

const openHit: LimitHit = {
  status: "open",
  agent: "kin",
  message: "The provider returned a rate-limit / quota error.",
  // An hour out, so the card offers the early continue rather than the
  // "quota is ready" wording.
  reset_at: Math.floor(Date.now() / 1000) + 3600,
  window: "5h",
};

beforeEach(() => setLocale("en"));

function handlers() {
  return {
    onWait: vi.fn(),
    onContinue: vi.fn(),
    onSwitch: vi.fn(),
    onDismiss: vi.fn(),
  };
}

type Handlers = ReturnType<typeof handlers>;

function view(hit: LimitHit, busy: string | null, h: Handlers) {
  return (
    <LimitCard
      hit={hit}
      hostAgentId="kin"
      agents={[fallback]}
      busy={busy}
      onWait={h.onWait}
      onContinue={h.onContinue}
      onSwitch={h.onSwitch}
      onDismiss={h.onDismiss}
    />
  );
}

function button(name: string): HTMLButtonElement {
  return screen.getByRole("button", { name }) as HTMLButtonElement;
}

describe("the limit card", () => {
  it("wait, continue, switch and dismiss reach their callbacks with the right busy labels", async () => {
    const user = userEvent.setup();
    const h = handlers();
    const { rerender } = render(view(openHit, null, h));

    await user.click(button(t("limit.wait")));
    await user.click(button(t("limit.continueNow")));
    await user.click(button(t("limit.switchTo", { agent: "Claude Code" })));
    await user.click(button(t("limit.dismiss")));
    expect(h.onWait).toHaveBeenCalledTimes(1);
    expect(h.onContinue).toHaveBeenCalledTimes(1);
    expect(h.onSwitch).toHaveBeenCalledWith("claude-code");
    expect(h.onDismiss).toHaveBeenCalledTimes(1);

    // Each action reports its own busy key, and every action is disabled while
    // one is in flight.
    const actions = [
      { busy: "wait", label: t("limit.wait") },
      { busy: "continue", label: t("limit.continueNow") },
      { busy: "switch:claude-code", label: t("limit.switchTo", { agent: "Claude Code" }) },
      { busy: "dismiss", label: t("limit.dismiss") },
    ];
    for (const action of actions) {
      rerender(view(openHit, action.busy, h));
      // The busy action reports progress in place; the other three keep their
      // names, and all four must be disabled.
      expect(button(t("limit.working")).disabled).toBe(true);
      for (const other of actions) {
        if (other.label !== action.label) {
          expect(button(other.label).disabled).toBe(true);
        }
      }
    }
  });

  it("exactly one filled approve-variant action is on screen in each state", () => {
    const h = handlers();
    const { container, rerender } = render(view(openHit, null, h));

    expect(container.querySelectorAll(".kin-btn-approve")).toHaveLength(1);
    expect(button(t("limit.wait")).className).toContain("kin-btn-approve");

    // Waiting flips which action is primary — continue — without adding a
    // second filled button.
    rerender(view({ ...openHit, status: "waiting" }, null, h));
    expect(container.querySelectorAll(".kin-btn-approve")).toHaveLength(1);
    expect(button(t("limit.continueEarly")).className).toContain("kin-btn-approve");
  });

  it("a terminal hit shows the status sentence and no actions", () => {
    const h = handlers();
    render(view({ ...openHit, status: "continued" }, null, h));

    expect(screen.getByText(t("limit.statusContinued"))).toBeTruthy();
    expect(screen.queryAllByRole("button")).toHaveLength(0);
    expect(screen.queryByText(t("limit.wait"))).toBeNull();
  });
});
