// @vitest-environment jsdom
import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { Routine } from "../../api/client";
import { t } from "../../i18n";
import RoutineList, { type RoutineListProps } from "./RoutineList";

/**
 * The routines list is controlled: the page owns the query, the selection and
 * every request, and the list reports what the reader did. These tests pin the
 * four things that make it usable — choosing a row, the unread badge, creating
 * from an empty machine, and the search box — plus the row actions.
 */

function routine(id: string, title: string, overrides: Partial<Routine> = {}): Routine {
  return {
    id,
    cwd: "/tmp/kin",
    agent: "codex",
    model: "",
    permission_mode: "default",
    prompt: "check things",
    interval_secs: 86400,
    enabled: true,
    next_due_at: Date.now() + 60_000,
    consec_failures: 0,
    created_at: Date.now(),
    title,
    missed_run_policy: "skip",
    lane: "default",
    recurrence: "",
    ...overrides,
  };
}

const morning = routine("routine-1", "Morning review");
const evening = routine("routine-2", "Evening review");

function setup(props: Partial<RoutineListProps> = {}) {
  const handlers = {
    onQueryChange: vi.fn(),
    onSelect: vi.fn(),
    onCreate: vi.fn(),
    onRunNow: vi.fn(),
    onEdit: vi.fn(),
    onToggle: vi.fn(),
    onDelete: vi.fn(),
    onLoadMore: vi.fn(),
  };
  const utils = render(
    <RoutineList
      routines={[morning, evening]}
      query=""
      selectedId={null}
      unreadByRoutine={{}}
      busy={{}}
      creating={false}
      machineOffline={false}
      hasMore={false}
      loadingMore={false}
      renderRowExtra={() => null}
      tr={t}
      {...handlers}
      {...props}
    />,
  );
  return { ...utils, ...handlers };
}

const rowButton = (title: string) => screen.getByText(title).closest("button") as HTMLButtonElement;

describe("RoutineList", () => {
  it("selects a routine and marks the selected row with aria-pressed", () => {
    const { onSelect } = setup({ selectedId: morning.id });
    expect(rowButton("Morning review").getAttribute("aria-pressed")).toBe("true");
    expect(rowButton("Evening review").getAttribute("aria-pressed")).toBe("false");
    fireEvent.click(rowButton("Evening review"));
    expect(onSelect).toHaveBeenCalledWith(evening);
  });

  it("shows the unread badge only when a routine has unread runs", () => {
    setup({ unreadByRoutine: { [morning.id]: 2 } });
    const morningRow = rowButton("Morning review").closest("li") as HTMLLIElement;
    const eveningRow = rowButton("Evening review").closest("li") as HTMLLIElement;
    expect(within(morningRow).getByText(t("routines.unreadCount", { count: 2 }))).toBeTruthy();
    expect(within(eveningRow).queryByText(t("routines.unreadCount", { count: 2 }))).toBeNull();
  });

  it("offers create from the empty list", () => {
    const { onCreate } = setup({ routines: [] });
    fireEvent.click(screen.getByRole("button", { name: t("routines.createEntry") }));
    expect(onCreate).toHaveBeenCalledTimes(1);
  });

  it("does not offer create while the machine is offline", () => {
    setup({ routines: [], machineOffline: true });
    expect(
      (screen.getByRole("button", { name: t("routines.createEntry") }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
  });

  it("renders the search box with its accessible name and reports typing", () => {
    const { onQueryChange } = setup({ query: "morn" });
    const search = screen.getByLabelText(t("routines.searchPlaceholder")) as HTMLInputElement;
    expect(search.value).toBe("morn");
    fireEvent.change(search, { target: { value: "evening" } });
    expect(onQueryChange).toHaveBeenCalledWith("evening");
  });

  it("reports each row action against its own routine", () => {
    const { onRunNow, onEdit, onToggle, onDelete } = setup({
      routines: [morning],
    });
    fireEvent.click(screen.getByRole("button", { name: t("routines.runNow") }));
    expect(onRunNow).toHaveBeenCalledWith(morning);
    fireEvent.click(
      screen.getByRole("button", { name: t("routines.editRoutine", { title: morning.title }) }),
    );
    expect(onEdit).toHaveBeenCalledWith(morning);
    fireEvent.click(screen.getByRole("button", { name: t("routines.pause") }));
    expect(onToggle).toHaveBeenCalledWith(morning);
    fireEvent.click(screen.getByRole("button", { name: t("routines.delete") }));
    expect(onDelete).toHaveBeenCalledWith(morning);
  });

  it("renders the page's row extra inside the row it belongs to", () => {
    // The phone layout mounts the run-history panel under the selected row;
    // the page owns that state, so the list only gives it a slot.
    setup({
      selectedId: morning.id,
      renderRowExtra: (r) => (r.id === morning.id ? <p>history for {r.title}</p> : null),
    });
    const morningRow = rowButton("Morning review").closest("li") as HTMLLIElement;
    const eveningRow = rowButton("Evening review").closest("li") as HTMLLIElement;
    expect(within(morningRow).getByText("history for Morning review")).toBeTruthy();
    expect(within(eveningRow).queryByText(/history for/)).toBeNull();
  });

  it("asks the page for more routines only when it says more exist", () => {
    const first = setup();
    expect(screen.queryByRole("button", { name: t("routines.loadMore") })).toBeNull();
    first.unmount();
    const { onLoadMore } = setup({ hasMore: true });
    fireEvent.click(screen.getByRole("button", { name: t("routines.loadMore") }));
    expect(onLoadMore).toHaveBeenCalledTimes(1);
  });
});
