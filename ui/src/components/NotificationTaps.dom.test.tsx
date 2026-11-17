// @vitest-environment jsdom
import { useEffect, useState } from "react";
import { describe, expect, it, vi, beforeEach } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { BrowserRouter, MemoryRouter, Route, Routes, useLocation, Link } from "react-router-dom";
import NotificationTaps from "./NotificationTaps";
import { NOTIFICATION_EVENT, type NotificationTapSource } from "../lib/notificationRoute";
import { useAppStore } from "../store/appStore";
import { useLeaveGuard } from "../hooks/useLeaveGuard";
import { resetLeaveGuard } from "../lib/leaveGuard";
import {
  forgetNativeDevice,
  forgetPendingNativeDelete,
  rememberedNativeDevice,
  rememberPendingNativeDelete,
  type NativePushApi,
  type NativePushPlugin,
} from "../lib/nativePush";
import { notePhoneLocation, resetPhoneNavigation } from "../lib/phoneNavigation";
import { resetSheetExits } from "../lib/sheetExit";
import Sheet from "./mobile/Sheet";

/**
 * KIN-NOTIFY-001: a tap has to reach the route whether the console was already
 * running (an event) or the tap is what launched it (the shell holds the link
 * until the router exists). Both are one navigation, the shell's copy is
 * acknowledged so the next launch does not replay it, and a banner for an item
 * handled elsewhere goes away.
 *
 * KIN-CONTINUE-003 rows 7–8: the original target survives until resolution and
 * acceptance, not just until the URL is consumed.
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
  forgetNativeDevice();
  forgetPendingNativeDelete();
  useAppStore.setState({ auth: { status: "ok" } });
  resetLeaveGuard();
  resetPhoneNavigation();
  resetSheetExits();
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
  function grantedPlugin(): NativePushPlugin {
    return {
      permission: vi.fn(async () => ({ status: "granted" as const })),
      requestPermission: vi.fn(async () => ({ status: "granted" as const })),
      register: vi.fn(async () => ({
        installId: "install-0001",
        token: ["token", "0001"].join("-"),
        environment: "sandbox" as const,
        name: "iPhone",
      })),
      unregister: vi.fn(async () => undefined),
      openSettings: vi.fn(async () => undefined),
    };
  }

  function pushApi(events: string[] = []) {
    return {
      registerPushDevice: vi.fn(async () => {
        events.push("register");
        return { id: "row-new" };
      }),
      deletePushDevice: vi.fn(async (id: string) => {
        events.push(`delete:${id}`);
      }),
    } satisfies NativePushApi;
  }

  it("refreshes a remembered phone token on launch after flushing a pending deletion", async () => {
    const plugin = grantedPlugin();
    const events: string[] = [];
    const api = pushApi(events);
    rememberPendingNativeDelete("row-old");

    render(
      <MemoryRouter initialEntries={["/"]}>
        <NotificationTaps source={null} pushPlugin={plugin} pushApi={api} />
      </MemoryRouter>,
    );

    await waitFor(() => expect(api.registerPushDevice).toHaveBeenCalledTimes(1));
    expect(events).toEqual(["delete:row-old", "register"]);
    expect(rememberedNativeDevice()).toBe("row-new");
  });

  it("refreshes the phone token after returning to the foreground and after reconnect", async () => {
    const plugin = grantedPlugin();
    const api = pushApi();
    render(
      <MemoryRouter initialEntries={["/"]}>
        <NotificationTaps source={null} pushPlugin={plugin} pushApi={api} />
      </MemoryRouter>,
    );

    await waitFor(() => expect(api.registerPushDevice).toHaveBeenCalledTimes(1));
    document.dispatchEvent(new Event("visibilitychange"));
    await waitFor(() => expect(api.registerPushDevice).toHaveBeenCalledTimes(2));
    act(() => useAppStore.setState({ reconnectGen: 1 }));
    await waitFor(() => expect(api.registerPushDevice).toHaveBeenCalledTimes(3));
  });

  it("does not make the phone addressable while an old row is still undeleted", async () => {
    const plugin = grantedPlugin();
    const api = pushApi();
    api.deletePushDevice.mockRejectedValue(new Error("offline"));
    rememberPendingNativeDelete("row-old");

    render(
      <MemoryRouter initialEntries={["/"]}>
        <NotificationTaps source={null} pushPlugin={plugin} pushApi={api} />
      </MemoryRouter>,
    );

    await waitFor(() => expect(api.deletePushDevice).toHaveBeenCalledWith("row-old"));
    expect(api.registerPushDevice).not.toHaveBeenCalled();
  });

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

describe("a tap on a phone with real browser history", () => {
  function phoneViewport() {
    vi.stubGlobal("matchMedia", (query: string) => ({
      matches: query === "(min-width: 768px)" ? false : false,
      media: query,
      onchange: null,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(),
    }));
  }

  function wideViewport() {
    vi.stubGlobal("matchMedia", (query: string) => ({
      matches: query === "(min-width: 768px)" ? true : false,
      media: query,
      onchange: null,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(),
    }));
  }

  function RouteProbe() {
    const location = useLocation();
    useEffect(() => {
      notePhoneLocation(location);
    }, [location]);
    return null;
  }

  function RoutinesView() {
    const location = useLocation();
    return <div data-testid="routines-location">{location.pathname + location.search}</div>;
  }

  function DirtySettings() {
    const [text, setText] = useState("");
    useLeaveGuard(
      () =>
        typeof window.confirm === "function" ? window.confirm("Discard settings draft?") : true,
      text.trim() !== "",
    );
    return (
      <input
        aria-label="settings draft"
        value={text}
        onChange={(event) => setText(event.target.value)}
      />
    );
  }

  function SheetPage() {
    const [open, setOpen] = useState(true);
    return (
      <Sheet open={open} onClose={() => setOpen(false)} title="Agents">
        <p>agent rows</p>
      </Sheet>
    );
  }

  function SlowSheetPage() {
    const [open, setOpen] = useState(true);
    const [closing, setClosing] = useState(false);
    return (
      <Sheet open={open} onClose={() => setClosing(true)} title="Agents">
        <p>agent rows</p>
        {closing ? (
          <button type="button" onClick={() => setOpen(false)}>
            finish close
          </button>
        ) : null}
      </Sheet>
    );
  }

  function browserApp(source: NotificationTapSource | null) {
    return (
      <BrowserRouter>
        <RouteProbe />
        <NotificationTaps source={source} />
        <Routes>
          <Route
            path="/sessions"
            element={
              <div>
                list page
                <Link to="/settings">settings</Link>
                <Link to="/agents">agents</Link>
                <Link to="/slow-agents">slow agents</Link>
              </div>
            }
          />
          <Route path="/settings" element={<DirtySettings />} />
          <Route path="/agents" element={<SheetPage />} />
          <Route path="/slow-agents" element={<SlowSheetPage />} />
          <Route path="/routines" element={<RoutinesView />} />
          <Route path="/tasks/:id" element={<div>conversation page</div>} />
        </Routes>
      </BrowserRouter>
    );
  }

  function openAt(entries: string[], source: NotificationTapSource | null) {
    window.history.replaceState({ idx: 0 }, "", entries[0]);
    entries.slice(1).forEach((url, index) => {
      window.history.pushState({ idx: index + 1 }, "", url);
    });
    return render(browserApp(source));
  }

  it("asks a dirty Settings before a tap can discard its draft", async () => {
    phoneViewport();
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
    try {
      openAt(["/sessions"], { takePendingURL: async () => null });
      fireEvent.click(await screen.findByText("settings"));
      const draft = await screen.findByLabelText("settings draft");
      fireEvent.change(draft, { target: { value: "unsaved settings words" } });
      await waitFor(() =>
        expect(
          (window.history.state as { kinLeaveGuard?: string } | null)?.kinLeaveGuard,
        ).toBeTruthy(),
      );

      tap("/tasks/task-1");
      await waitFor(() => expect(confirm).toHaveBeenCalledWith("Discard settings draft?"));
      expect(window.location.pathname).toBe("/settings");
      expect((screen.getByLabelText("settings draft") as HTMLInputElement).value).toBe(
        "unsaved settings words",
      );

      confirm.mockReturnValue(true);
      tap("/tasks/task-1");
      await waitFor(() => expect(window.location.pathname).toBe("/tasks/task-1"));
      // The settings entry is replaced: Back reaches the list, not an earlier
      // copy of the screen the tap left.
      expect(window.history.state.idx).toBe(1);
      await act(async () => window.history.back());
      await waitFor(() => expect(window.location.pathname).toBe("/sessions"));
    } finally {
      confirm.mockRestore();
    }
  });

  it("closes an open sheet before pushing and leaves no Agents entry behind", async () => {
    phoneViewport();
    openAt(["/sessions"], { takePendingURL: async () => null });
    fireEvent.click(await screen.findByText("agents"));
    expect(await screen.findByRole("dialog", { name: "Agents" })).toBeTruthy();

    tap("/tasks/task-1");
    await waitFor(() => expect(window.location.pathname).toBe("/tasks/task-1"));
    expect(screen.queryByRole("dialog", { name: "Agents" })).toBeNull();

    // [list, target]: the sheet's own entry and the Agents screen beneath it
    // are both gone, so one Back is the list.
    expect(window.history.state.idx).toBe(1);
    await act(async () => window.history.back());
    await waitFor(() => expect(window.location.pathname).toBe("/sessions"));
  });

  it("delivers the newer of two different taps while a sheet closes slowly", async () => {
    phoneViewport();
    openAt(["/sessions"], { takePendingURL: async () => null });
    fireEvent.click(await screen.findByText("slow agents"));
    expect(await screen.findByRole("dialog", { name: "Agents" })).toBeTruthy();

    tap("/tasks/task-1");
    expect(await screen.findByRole("button", { name: "finish close" })).toBeTruthy();
    tap("/tasks/task-2");

    fireEvent.click(screen.getByRole("button", { name: "finish close" }));

    // The second tap is the one the reader asked for last; it must not be
    // swallowed because the first was already waiting on the sheet.
    await waitFor(() => expect(window.location.pathname).toBe("/tasks/task-2"));
    expect(window.history.state.idx).toBe(1);
  });

  it("still ignores a second tap of the same target while it is being delivered", async () => {
    phoneViewport();
    openAt(["/sessions"], { takePendingURL: async () => null });
    fireEvent.click(await screen.findByText("slow agents"));
    expect(await screen.findByRole("dialog", { name: "Agents" })).toBeTruthy();

    tap("/tasks/task-1");
    expect(await screen.findByRole("button", { name: "finish close" })).toBeTruthy();
    tap("/tasks/task-1");

    fireEvent.click(screen.getByRole("button", { name: "finish close" }));

    await waitFor(() => expect(window.location.pathname).toBe("/tasks/task-1"));
    expect(window.history.state.idx).toBe(1);
  });

  it("merges a held native tap and a newer in-app tap into the latest target", async () => {
    phoneViewport();
    let resolveNative!: (value: { url: string }) => void;
    const takePendingURL = vi.fn(
      () =>
        new Promise<{ url: string }>((resolve) => {
          resolveNative = resolve;
        }),
    );
    openAt(["/sessions"], { takePendingURL });
    fireEvent.click(await screen.findByText("slow agents"));
    expect(await screen.findByRole("dialog", { name: "Agents" })).toBeTruthy();

    // The cold-start link arrives first and starts the slow close.
    resolveNative({ url: "/tasks/task-1" });
    expect(await screen.findByRole("button", { name: "finish close" })).toBeTruthy();
    // A live event for another task is newer and must win.
    tap("/tasks/task-2");

    fireEvent.click(screen.getByRole("button", { name: "finish close" }));

    await waitFor(() => expect(window.location.pathname).toBe("/tasks/task-2"));
    expect(window.history.state.idx).toBe(1);
  });

  it("pushes a Mac routines query change so Back returns to the first machine", async () => {
    wideViewport();
    openAt(["/routines?device=node-a"], { takePendingURL: async () => null });
    await waitFor(() =>
      expect(screen.getByTestId("routines-location").textContent).toBe("/routines?device=node-a"),
    );
    expect(window.history.state.idx).toBe(0);

    tap("/routines?device=node-b");

    await waitFor(() =>
      expect(screen.getByTestId("routines-location").textContent).toBe("/routines?device=node-b"),
    );
    // The Mac keeps ordinary nested history: B is a push above A, so one Back
    // shows the machine the reader came from. A replace here erased A.
    expect(window.history.state.idx).toBe(1);
    await act(async () => window.history.back());
    await waitFor(() =>
      expect(screen.getByTestId("routines-location").textContent).toBe("/routines?device=node-a"),
    );
    expect(window.history.state.idx).toBe(0);
  });
});
