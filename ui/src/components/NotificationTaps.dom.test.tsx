// @vitest-environment jsdom
import { describe, expect, it, vi, beforeEach } from "vitest";
import { fireEvent, render, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes, useLocation, Link } from "react-router-dom";
import NotificationTaps from "./NotificationTaps";
import { NOTIFICATION_EVENT, type NotificationTapSource } from "../lib/notificationRoute";
import { useAppStore } from "../store/appStore";

/**
 * KIN-NOTIFY-001: a tap has to reach the route whether the console was already
 * running (an event) or the tap is what launched it (the shell holds the link
 * until the router exists). Both are one navigation, the shell's copy is
 * acknowledged so the next launch does not replay it, and a banner for an item
 * handled elsewhere goes away.
 */

const h = vi.hoisted(() => {
  const state: {
    current: {
      loaded: boolean;
      data: { approvals: { id: string }[]; questions: { id: string }[] };
    };
  } = {
    current: { loaded: true, data: { approvals: [], questions: [] } },
  };
  return {
    state,
    refreshPending: vi.fn(),
    clearDelivered: vi.fn(),
    delivered: vi.fn(),
  };
});

vi.mock("../api/useLiveResources", () => ({
  usePendingResources: () => h.state.current,
}));

vi.mock("../api/liveResources", () => ({
  liveResources: { refreshPending: h.refreshPending },
}));

vi.mock("../lib/nativePush", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/nativePush")>();
  return {
    ...actual,
    clearDeliveredNotification: h.clearDelivered,
    deliveredNotificationTargets: h.delivered,
  };
});

beforeEach(() => {
  h.state.current = { loaded: true, data: { approvals: [], questions: [] } };
  h.refreshPending.mockReset();
  h.clearDelivered.mockReset();
  h.delivered.mockReset();
  h.delivered.mockResolvedValue([]);
  useAppStore.setState({ auth: { status: "ok" } });
});

function trackedTree(source: NotificationTapSource | null, onRender: () => void) {
  function Tracked() {
    const location = useLocation();
    onRender();
    return <div data-testid="location">{location.pathname + location.search}</div>;
  }
  return (
    <>
      <NotificationTaps source={source} />
      <Link to="/settings">settings</Link>
      <Routes>
        <Route path="*" element={<Tracked />} />
      </Routes>
    </>
  );
}

function mount(source: NotificationTapSource | null, onRender: () => void = () => {}) {
  const view = render(
    <MemoryRouter initialEntries={["/"]}>{trackedTree(source, onRender)}</MemoryRouter>,
  );
  return {
    ...view,
    rerender: () =>
      view.rerender(
        <MemoryRouter initialEntries={["/"]}>{trackedTree(source, onRender)}</MemoryRouter>,
      ),
  };
}

function tap(url: string) {
  window.dispatchEvent(new CustomEvent(NOTIFICATION_EVENT, { detail: { url } }));
}

describe("NotificationTaps", () => {
  it("lands on the item named by a warm tap and acknowledges it", async () => {
    const takePendingURL = vi.fn(async () => null);
    const { getByTestId } = mount({ takePendingURL });
    await waitFor(() => expect(takePendingURL).toHaveBeenCalled());

    tap("/inbox?focus=appr-1");

    await waitFor(() => expect(getByTestId("location").textContent).toBe("/inbox?focus=appr-1"));
    // Once for the mount drain, once to clear the shell's copy of the tap.
    await waitFor(() => expect(takePendingURL).toHaveBeenCalledTimes(2));
  });

  it("drains a tap that launched the app before the console was ready", async () => {
    const takePendingURL = vi.fn(async () => ({ url: "/tasks/task-1" }));
    const { getByTestId } = mount({ takePendingURL });
    await waitFor(() => expect(getByTestId("location").textContent).toBe("/tasks/task-1"));
  });

  it("delivers one navigation when a cold-start tap also arrives as an event", async () => {
    const takePendingURL = vi.fn(async () => ({ url: "/tasks/task-1" }));
    let renders = 0;
    const { getByTestId } = mount({ takePendingURL }, () => {
      renders += 1;
    });
    await waitFor(() => expect(getByTestId("location").textContent).toBe("/tasks/task-1"));
    const afterColdStart = renders;

    // The shell's event for the same tap. The target is already on screen, so
    // this must not push a second history entry.
    tap("/tasks/task-1");
    await waitFor(() => expect(takePendingURL).toHaveBeenCalledTimes(3));
    expect(renders).toBe(afterColdStart);
    expect(getByTestId("location").textContent).toBe("/tasks/task-1");
  });

  it("ignores the same tap while its target is on screen", async () => {
    let renders = 0;
    const { getByTestId } = mount(null, () => {
      renders += 1;
    });
    tap("/routines");
    await waitFor(() => expect(getByTestId("location").textContent).toBe("/routines"));
    const afterFirstTap = renders;

    tap("/routines");
    // Give a stray navigation a chance to land before asserting it did not.
    await waitFor(() => expect(getByTestId("location").textContent).toBe("/routines"));
    expect(renders).toBe(afterFirstTap);
  });

  it("delivers the same target again after the reader leaves it", async () => {
    const { getByTestId, getByText } = mount(null);
    tap("/tasks/task-1");
    await waitFor(() => expect(getByTestId("location").textContent).toBe("/tasks/task-1"));

    fireEvent.click(getByText("settings"));
    await waitFor(() => expect(getByTestId("location").textContent).toBe("/settings"));

    // A later tap naming the same task is a fresh invitation, not a replay.
    tap("/tasks/task-1");
    await waitFor(() => expect(getByTestId("location").textContent).toBe("/tasks/task-1"));
  });

  it("runs in a browser with no native plugin", async () => {
    const { getByTestId } = mount(null);
    tap("/inbox?focus=a1");
    await waitFor(() => expect(getByTestId("location").textContent).toBe("/inbox?focus=a1"));
  });

  it("takes away banners for items that are no longer pending", async () => {
    h.state.current = {
      loaded: true,
      data: { approvals: [{ id: "appr-1" }, { id: "appr-2" }], questions: [{ id: "q-1" }] },
    };
    const { rerender } = mount(null);
    // The first answer is the baseline, not a disappearance.
    expect(h.clearDelivered).not.toHaveBeenCalled();

    h.state.current = {
      loaded: true,
      data: { approvals: [{ id: "appr-1" }], questions: [] },
    };
    rerender();

    expect(h.clearDelivered).toHaveBeenCalledTimes(2);
    expect(h.clearDelivered).toHaveBeenCalledWith("approval", "appr-2");
    expect(h.clearDelivered).toHaveBeenCalledWith("question", "q-1");
  });

  it("clears banners left over from before this launch, without touching other kinds", async () => {
    h.state.current = {
      loaded: true,
      data: { approvals: [{ id: "still-pending" }], questions: [] },
    };
    h.delivered.mockResolvedValue([
      { kind: "approval", id: "still-pending" },
      { kind: "approval", id: "handled-elsewhere" },
      { kind: "question", id: "answered-elsewhere" },
      { kind: "task", id: "finished-task" },
      { kind: "routine", id: "routine-report" },
    ]);

    mount(null);

    await waitFor(() => expect(h.clearDelivered).toHaveBeenCalledTimes(2));
    expect(h.clearDelivered).toHaveBeenCalledWith("approval", "handled-elsewhere");
    expect(h.clearDelivered).toHaveBeenCalledWith("question", "answered-elsewhere");
  });

  it("asks for a fresh pending list when the phone comes back to the app", () => {
    mount({ takePendingURL: async () => null });
    document.dispatchEvent(new Event("visibilitychange"));
    expect(h.refreshPending).toHaveBeenCalledTimes(1);
  });

  it("does not poll pending state in a browser that has no banners", () => {
    mount(null);
    document.dispatchEvent(new Event("visibilitychange"));
    expect(h.refreshPending).not.toHaveBeenCalled();
  });

  it("does not poll pending state before the reader is signed in", () => {
    useAppStore.setState({ auth: { status: "need_token", reason: "missing" } });
    mount({ takePendingURL: async () => null });
    document.dispatchEvent(new Event("visibilitychange"));
    expect(h.refreshPending).not.toHaveBeenCalled();
  });
});
