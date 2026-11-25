// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { render } from "@testing-library/react";
import SessionRow, { type SessionRowProps } from "./SessionRow";
import { setLocale } from "../../i18n";
import { FONT_SIZE, LEADING } from "../../design/type";
import type { Task } from "../../api/client";

/**
 * KIN-CONTINUE-007: a two-line row still obeys the 44px floor.
 *
 * The 820×1180 portrait iPad runs the desktop shell under a thumb, so the row
 * and its trailing action must stay 44px. A mouse at 1100 keeps the compact
 * padding, but the two lines must not shrink the row under 44px either — jsdom
 * has no layout, so that half is proven from the type ladder and the padding
 * the row actually emits, not from a fake height.
 */

const NOW = 1_700_000_000_000;

function taskRow(): SessionRowProps["row"] {
  const task = {
    id: "row-1",
    title: "Fix the build",
    cwd: "/work/alpha",
    agent: "kin",
    prompt: "",
    status: "succeeded",
    tokens_in: 0,
    tokens_out: 0,
    event_epoch: 0,
    created_at: NOW - 120_000,
    finished_at: NOW - 120_000,
  } as Task;
  return {
    key: "task:row-1",
    at: NOW - 120_000,
    title: "Fix the build",
    agentId: "kin",
    remote: false,
    status: "succeeded",
    task,
  };
}

function props(overrides: Partial<SessionRowProps> = {}): SessionRowProps {
  return {
    row: taskRow(),
    deviceLabel: "",
    query: "",
    now: NOW,
    viewedIds: new Set(),
    pendingCount: 0,
    active: false,
    onOpen: vi.fn(),
    shell: "sidebar",
    coarse: false,
    selectionMode: false,
    selectionLocked: false,
    selected: false,
    onToggleSelect: vi.fn(),
    onStartSelection: vi.fn(),
    onExitSelection: vi.fn(),
    swipeOpen: false,
    onSwipeOpenChange: vi.fn(),
    pinned: false,
    onPin: vi.fn(),
    onRename: vi.fn(),
    onArchive: vi.fn(),
    onDelete: vi.fn(),
    onRestore: vi.fn(),
    scope: "active",
    ...overrides,
  };
}

function roleLineHeight(role: string): number {
  return parseFloat(FONT_SIZE[role][0]) * parseFloat(LEADING.ui);
}

beforeEach(() => {
  setLocale("en");
  localStorage.clear();
  sessionStorage.clear();
});

describe("the row's touch floor", () => {
  it("keeps a 44px row and actions at 820 coarse", () => {
    // 820×1180 coarse: the desktop shell, a finger.
    const { container } = render(<SessionRow {...props({ coarse: true })} />);

    const row = container.querySelector<HTMLElement>("[data-session-row]");
    expect(row).not.toBeNull();
    expect(row?.className).toContain("min-h-11");
    expect(row?.className).toContain("py-2.5");
    expect(row?.className).not.toContain("min-h-9");

    // The trailing action is a finger target too: 44×44, not the mouse's 24.
    const trigger = container.querySelector<HTMLElement>("[data-row-actions]");
    expect(trigger).not.toBeNull();
    expect(trigger?.className).toContain("h-11");
    expect(trigger?.className).toContain("w-11");

    // The two-line shape is what the height is paying for.
    expect(row?.querySelector("[data-session-title]")).not.toBeNull();
    expect(row?.querySelector("[data-session-meta]")).not.toBeNull();
  });

  it("keeps the compact pointer density without going under 44px", () => {
    // 1100×760 fine: a mouse. Compact padding stays, the two lines do not
    // shrink away.
    const { container } = render(<SessionRow {...props({ coarse: false })} />);

    const row = container.querySelector<HTMLElement>("[data-session-row]");
    expect(row).not.toBeNull();
    expect(row?.className).toContain("min-h-9");
    expect(row?.className).toContain("py-1.5");

    const title = row?.querySelector<HTMLElement>("[data-session-title]");
    const meta = row?.querySelector<HTMLElement>("[data-session-meta]");
    expect(title?.className).toContain("text-body");
    expect(title?.className).toContain("leading-ui");
    expect(meta?.className).toContain("text-caption");
    expect(meta?.className).toContain("leading-ui");

    // py-1.5 = 6px a side; the two line boxes come from the same ladder the
    // classes name. 14×1.375 + 12×1.375 + 12 = 47.75px ≥ 44.
    const height = roleLineHeight("body") + roleLineHeight("caption") + 6 * 2;
    expect(height).toBeGreaterThanOrEqual(44);
  });
});
