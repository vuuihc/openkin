// @vitest-environment jsdom
import { fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
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
    onStatusChange: vi.fn(),
    onCwdChange: vi.fn(),
    onClearFilters: vi.fn(),
  };
  const utils = render(
    <RoutineList
      routines={[morning, evening]}
      query=""
      status=""
      cwd=""
      directories={[]}
      selectedId={null}
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

  it("puts every routine list action on the shared button facade", () => {
    const actions = setup({ routines: [morning], hasMore: true });
    const facade = (name: string, variant: string) => {
      const el = screen.getByRole("button", { name }) as HTMLButtonElement;
      expect(el.classList.contains("kin-btn")).toBe(true);
      expect(el.classList.contains(variant)).toBe(true);
      return el;
    };
    facade(t("routines.runNow"), "kin-btn-secondary");
    facade(t("routines.editRoutine", { title: morning.title }), "kin-btn-secondary");
    facade(t("routines.pause"), "kin-btn-secondary");
    facade(t("routines.loadMore"), "kin-btn-secondary");
    // Delete is quiet with red ink: no fill, no border weight of its own.
    // It must not also carry the quiet variant's `text-kin-text`: both are
    // utilities, and the one emitted later in the shipped CSS wins, so the
    // presence of both would render the destructive action in body colour.
    const del = screen.getByRole("button", { name: t("routines.delete") });
    expect(del.classList.contains("kin-btn")).toBe(true);
    expect(del.classList.contains("text-kin-red-ink")).toBe(true);
    expect(del.classList.contains("text-kin-text")).toBe(false);
    expect(del.classList.contains("kin-btn-primary")).toBe(false);
    expect(del.classList.contains("kin-btn-secondary")).toBe(false);
    actions.unmount();

    // With no routines, the empty state's create is the one filled action.
    setup({ routines: [] });
    const create = screen.getByRole("button", { name: t("routines.createEntry") });
    expect(create.classList.contains("kin-btn")).toBe(true);
    expect(create.classList.contains("kin-btn-primary")).toBe(true);
  });

  it("keeps the row select a labelled pressed control", () => {
    // The full-row select is a bare hit area, not a facade control. It is never
    // disabled by busy/creating/offline state; only a click on a routine.
    const { onSelect } = setup({
      selectedId: morning.id,
      busy: { [morning.id]: true },
      creating: true,
      machineOffline: true,
    });
    const name = t("routines.openRoutine", { title: morning.title });
    const select = screen.getByRole("button", { name }) as HTMLButtonElement;
    expect(select.getAttribute("aria-pressed")).toBe("true");
    expect(select.getAttribute("aria-label")).toBe(name);
    expect(select.disabled).toBe(false);
    fireEvent.click(select);
    expect(onSelect).toHaveBeenCalledWith(morning);
  });

  it("keeps busy, creating and offline disabling every row action", () => {
    const rowActions = () => [
      t("routines.runNow"),
      t("routines.editRoutine", { title: morning.title }),
      t("routines.pause"),
      t("routines.delete"),
    ];
    const matrix = (
      props: Partial<RoutineListProps>,
      rowsDisabled: boolean,
      loadMoreDisabled: boolean,
    ) => {
      const view = setup({ routines: [morning], hasMore: true, ...props });
      for (const name of rowActions()) {
        expect((screen.getByRole("button", { name }) as HTMLButtonElement).disabled).toBe(
          rowsDisabled,
        );
      }
      // The label flips while the next page is loading, so match the one on
      // screen for this state.
      const loadMore = screen.getByRole("button", {
        name: props.loadingMore ? t("tree.loadingMore") : t("routines.loadMore"),
      }) as HTMLButtonElement;
      expect(loadMore.disabled).toBe(loadMoreDisabled);
      view.unmount();
    };
    matrix({}, false, false);
    matrix({ busy: { [morning.id]: true } }, true, false);
    matrix({ creating: true }, true, false);
    matrix({ machineOffline: true }, true, false);
    // Load more answers only to its own loading state.
    matrix({ loadingMore: true }, false, true);
  });

  const trigger = (label: string) => screen.getByRole("button", { name: new RegExp(`^${label}`) });

  it("renders the status and directory filters on 全部", () => {
    setup();
    expect(trigger(t("routines.filterStatus")).textContent).toBe(t("routines.filterAll"));
    expect(trigger(t("routines.filterDirectory")).textContent).toBe(t("routines.filterAllDirs"));
  });

  it("reports a status choice", async () => {
    const { onStatusChange } = setup();
    await userEvent.click(trigger(t("routines.filterStatus")));
    await userEvent.click(screen.getByRole("menuitemradio", { name: t("routines.paused") }));
    expect(onStatusChange).toHaveBeenCalledWith("paused");
  });

  it("reports a directory choice and shows the active one on the trigger", async () => {
    const { onCwdChange } = setup({
      cwd: "/work/alpha",
      directories: [
        { id: "/work/alpha", label: "alpha" },
        { id: "/work/beta", label: "beta" },
      ],
    });
    expect(trigger(t("routines.filterDirectory")).textContent).toBe("alpha");
    await userEvent.click(trigger(t("routines.filterDirectory")));
    await userEvent.click(screen.getByRole("menuitemradio", { name: "beta" }));
    expect(onCwdChange).toHaveBeenCalledWith("/work/beta");
  });

  it("names a directory the machine no longer offers instead of showing a raw menu row", () => {
    setup({ cwd: "/gone/missing" });
    expect(trigger(t("routines.filterDirectory")).textContent).toBe("missing");
  });

  it("offers clear only while a filter is set", async () => {
    const plain = setup();
    expect(screen.queryByRole("button", { name: t("routines.filterClear") })).toBeNull();
    plain.unmount();
    const { onClearFilters } = setup({ status: "paused" });
    await userEvent.click(screen.getByRole("button", { name: t("routines.filterClear") }));
    expect(onClearFilters).toHaveBeenCalledTimes(1);
  });

  it("shows the filtered empty state, not the create call to action", () => {
    setup({ routines: [], status: "failed" });
    expect(screen.getByText(t("routines.filterEmpty"))).toBeTruthy();
    expect(screen.getByText(t("routines.filterEmptyHint"))).toBeTruthy();
    expect(screen.queryByRole("button", { name: t("routines.createEntry") })).toBeNull();
    expect(
      screen.getAllByRole("button", { name: t("routines.filterClear") }).length,
    ).toBeGreaterThan(0);
  });

  it("shows the plain empty state and create when no filter is set", () => {
    setup({ routines: [] });
    expect(screen.getByText(t("routines.emptyList"))).toBeTruthy();
    expect(screen.queryByText(t("routines.filterEmpty"))).toBeNull();
    expect(screen.getByRole("button", { name: t("routines.createEntry") })).toBeTruthy();
  });
});
