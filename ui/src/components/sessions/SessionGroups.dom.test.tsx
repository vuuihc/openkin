// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { Task } from "../../api/client";
import type { Machine } from "../../lib/devices";
import type {
  PhoneDeviceGroup,
  PhoneProjectBucket,
  PhoneSessionRow,
} from "../../lib/phoneSessionBuckets";
import { setLocale } from "../../i18n";
import {
  DeviceSection,
  ProjectBucket,
  SessionListEmpty,
  type ProjectBucketProps,
  type SessionListEmptyKind,
  type SessionListEmptyView,
} from "./SessionGroups";

/**
 * The list's grouping and empty states moved out of `SessionList` unchanged.
 * These tests pin the new boundary: the device → project hierarchy the sidebar
 * draws, a folded project that still says how many rows it holds, and every
 * empty/error body with its one retry action.
 */

const NOW = new Date("2026-11-15T12:00:00Z").getTime();

function task(id: string): Task {
  return {
    id,
    title: id,
    cwd: "/work/alpha",
    agent: "kin",
    prompt: "",
    status: "succeeded",
    tokens_in: 0,
    tokens_out: 0,
    event_epoch: 0,
    created_at: 1,
  } as Task;
}

function row(id: string, title: string): PhoneSessionRow {
  return {
    key: `task:${id}`,
    at: NOW - 60_000,
    title,
    agentId: "claude-code",
    status: "succeeded",
    remote: false,
    task: task(id),
  };
}

function bucket(overrides: Partial<PhoneProjectBucket> = {}): PhoneProjectBucket {
  return {
    key: "/work/alpha",
    label: "Alpha",
    cwd: "/work/alpha",
    rows: [row("alpha-1", "Fix the build")],
    lastActivityAt: NOW,
    createdAt: 1,
    hasActiveTask: false,
    ...overrides,
  };
}

function group(overrides: Partial<PhoneDeviceGroup> = {}): PhoneDeviceGroup {
  return {
    id: "mac-1",
    label: "MacBook",
    isSelf: true,
    online: true,
    buckets: [bucket()],
    lastActivityAt: NOW,
    count: 1,
    ...overrides,
  };
}

function bucketProps(overrides: Partial<ProjectBucketProps> = {}): ProjectBucketProps {
  return {
    bucket: bucket(),
    machines: [] as Machine[],
    now: NOW,
    viewedIds: new Set<string>(),
    pendingByTask: new Map<string, number>(),
    collapsed: false,
    showAll: true,
    canToggle: true,
    onToggle: vi.fn(),
    onToggleShowAll: vi.fn(),
    onOpen: vi.fn(),
    shell: "sidebar",
    coarse: false,
    activeTaskId: null,
    selectionMode: false,
    selectionLocked: false,
    selectedIds: new Set<string>(),
    onToggleSelect: vi.fn(),
    onLongPress: vi.fn(),
    swipeOpen: null,
    onSwipeOpenChange: vi.fn(),
    pinnedIds: new Set<string>(),
    pinnedProjects: [],
    onPin: vi.fn(),
    onArchive: vi.fn(),
    onDelete: vi.fn(),
    onRestore: vi.fn(),
    scope: "active",
    query: "",
    archived: false,
    local: true,
    onOpenProject: vi.fn(),
    onNewSession: vi.fn(),
    onArchiveProject: vi.fn(),
    onProjectMenu: vi.fn(),
    ...overrides,
  };
}

function emptyView(overrides: Partial<SessionListEmptyView> = {}): SessionListEmptyView {
  return {
    icon: <span data-testid="empty-icon" />,
    title: "No chats yet",
    hint: "Start one from the composer.",
    ...overrides,
  };
}

beforeEach(() => {
  setLocale("en");
  localStorage.clear();
  sessionStorage.clear();
});

describe("DeviceSection", () => {
  it("renders a device section with its project buckets", () => {
    render(
      <DeviceSection
        label="This machine"
        shell="sidebar"
        group={group({
          buckets: [
            bucket(),
            bucket({ key: "/work/beta", label: "Beta", cwd: "/work/beta", rows: [] }),
          ],
        })}
        renderBucket={(item, stateKey) => (
          <ProjectBucket key={stateKey} {...bucketProps({ bucket: item })} />
        )}
      />,
    );

    const section = screen.getByRole("region", { name: "This machine" });
    expect(within(section).getByRole("button", { name: "Alpha" })).toBeTruthy();
    expect(within(section).getByRole("button", { name: "Beta" })).toBeTruthy();
    expect(within(section).getByText("Fix the build")).toBeTruthy();
    // The device's own count and a screen-reader-only online state.
    const deviceHeading = within(section).getByRole("heading", { name: /This machine/ });
    expect(within(deviceHeading.parentElement!).getByText("1")).toBeTruthy();
    expect(within(section).getByText(/Online/)).toBeTruthy();
  });
});

describe("ProjectBucket", () => {
  it("collapsed project bucket hides rows and still shows its count", () => {
    const rows = [row("alpha-1", "Fix the build"), row("alpha-2", "Ship it")];
    const { rerender } = render(<ProjectBucket {...bucketProps({ bucket: bucket({ rows }) })} />);

    // Expanded: both rows and the bucket's count are on screen.
    expect(screen.getByText("Fix the build")).toBeTruthy();
    expect(screen.getByText("Ship it")).toBeTruthy();

    rerender(<ProjectBucket {...bucketProps({ bucket: bucket({ rows }), collapsed: true })} />);

    expect(screen.queryByText("Fix the build")).toBeNull();
    expect(screen.queryByText("Ship it")).toBeNull();
    const heading = screen.getByRole("button", { name: "Alpha" });
    expect(within(heading).getByText("2")).toBeTruthy();
  });
});

describe("SessionListEmpty", () => {
  const cases: ReadonlyArray<[SessionListEmptyKind, string]> = [
    ["loading", "Loading chats…"],
    ["pending", "Searching…"],
    ["load-error", "Could not load chats"],
    ["imports-error", "Could not load imported sessions"],
    ["empty", "No chats yet"],
  ];

  it.each(cases)("renders the %s body", (kind, label) => {
    render(<SessionListEmpty kind={kind} emptyView={emptyView()} onRetry={vi.fn()} />);

    expect(screen.getByText(label)).toBeTruthy();
    // Only the two error bodies offer the one next action; the rest are copy.
    expect(screen.queryAllByRole("button", { name: "Retry" })).toHaveLength(
      kind === "load-error" || kind === "imports-error" ? 1 : 0,
    );
  });

  it("retry calls back without retrying anything else", async () => {
    const onRetry = vi.fn();
    render(<SessionListEmpty kind="load-error" emptyView={emptyView()} onRetry={onRetry} />);

    await userEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it("renders the empty view's own title and hint", () => {
    render(
      <SessionListEmpty
        kind="empty"
        emptyView={emptyView({ title: "Nothing archived", hint: "Put-away chats wait here." })}
        onRetry={vi.fn()}
      />,
    );

    expect(screen.getByText("Nothing archived")).toBeTruthy();
    expect(screen.getByText("Put-away chats wait here.")).toBeTruthy();
    expect(screen.getByTestId("empty-icon")).toBeTruthy();
  });
});
