import { describe, expect, it, jest } from "@jest/globals";
import { act, fireEvent, render, waitFor } from "@testing-library/react-native";
import { SectionList, StyleSheet } from "react-native";
import type { Task } from "../../../ui/src/api/contract";
import type { Machine } from "../../../ui/src/lib/devices";
import {
  pendingApprovalsPath,
  pendingQuestionsPath,
} from "../approvals/approvalsModel";
import { listTasksPath } from "../api/transport";
import type { Session } from "../auth/tokenStore";
import { t } from "../i18n";
import { createListMemory, createMemoryFoldStore } from "../list/listModel";
import {
  MAX_RESUME_ATTEMPTS,
  RESUME_THRESHOLD_MS,
  RETRY_CAP_MS,
  type AppStateLike,
  type AppStateStatus,
} from "../lifecycle/resume";
import ListScreen from "./ListScreen";

/**
 * KIN-MOBILE-001 R3 — the list route wired to the stored session.
 *
 * The model's grouping, folds and request state are proven in
 * `listModel.test.ts`; this suite is about the container: does a stored
 * session reach the pure screen, does a row report its task id, does a missing
 * session ask for pairing, and does a failed refresh keep what was read.
 * The Keychain and the network are injected, so nothing here touches either.
 */

const ORIGIN = "https://kin.example.com";
const TOKEN = "test-token";

const MACHINES: Machine[] = [
  { id: "dev-a", label: "Laptop", isSelf: true, online: true, roots: [], agents: [] },
];

function task(overrides: Partial<Task> = {}): Task {
  return {
    id: "task-1",
    title: "First conversation",
    agent: "kin",
    cwd: "/work/alpha",
    prompt: "hello",
    model: "model-x",
    status: "succeeded",
    tokens_in: 0,
    tokens_out: 0,
    created_at: 1000,
    started_at: 1000,
    finished_at: 1000,
    executing_device_id: "dev-a",
    event_epoch: 0,
    ...overrides,
  };
}

function storedSession(): Promise<Session | null> {
  return Promise.resolve({ origin: ORIGIN, token: TOKEN });
}

function noSession(): Promise<Session | null> {
  return Promise.resolve(null);
}

function ok(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as unknown as Response;
}

type Reply = { status?: number; body: unknown };
type Router = (url: string, init?: RequestInit) => Reply | Promise<Reply>;

function routedFetch(route: Router): typeof fetch {
  return jest.fn(async (input: string, init?: RequestInit) => {
    const reply = await route(input, init);
    return ok(reply.body, reply.status ?? 200);
  }) as unknown as typeof fetch;
}

function formatTime(at: number): string {
  return `t${at}`;
}

async function renderList(
  props: Partial<Parameters<typeof ListScreen>[0]> = {},
) {
  return render(
    <ListScreen
      fetchImpl={routedFetch(() => ({ body: [task()] }))}
      formatTime={formatTime}
      machines={MACHINES}
      memory={createListMemory()}
      onNeedsPairing={jest.fn()}
      onOpen={jest.fn()}
      readSessionImpl={storedSession}
      selfDeviceId="dev-a"
      {...props}
    />,
  );
}

/** The slice of `AppState` the resume controller subscribes to. */
function fakeAppState(): {
  port: AppStateLike;
  emit: (status: AppStateStatus) => void;
} {
  const listeners = new Set<(status: AppStateStatus) => void>();
  return {
    port: {
      addEventListener(_type, listener) {
        listeners.add(listener);
        return {
          remove() {
            listeners.delete(listener);
          },
        };
      },
    },
    emit(status) {
      for (const listener of [...listeners]) listener(status);
    },
  };
}

describe("KIN-MOBILE-001 R7 resume on the list route", () => {
  it("KIN-MOBILE-001 R7: a long absence re-reads the list and leaves the rows in place", async () => {
    let calls = 0;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const fetchImpl = jest.fn(async (input: string) => {
      // Only the task page is counted; the pending lists answer empty here.
      if (!input.endsWith(listTasksPath())) return ok([]);
      calls += 1;
      // The initial read answers at once; the resume read is held so the
      // screen can be inspected while it is still re-reading.
      if (calls === 2) await gate;
      return ok([task()]);
    }) as unknown as typeof fetch;
    const app = fakeAppState();
    let clock = 1_000;

    const screen = await renderList({
      fetchImpl,
      appState: app.port,
      now: () => clock,
    });
    await waitFor(() =>
      expect(screen.getByText("First conversation")).toBeTruthy(),
    );
    expect(calls).toBe(1);

    await act(async () => {
      app.emit("background");
    });
    clock += RESUME_THRESHOLD_MS;
    await act(async () => {
      app.emit("active");
    });
    await waitFor(() => expect(calls).toBe(2));

    // Cached rows stay on screen while the list re-reads, and the band says so.
    expect(screen.getByText("First conversation")).toBeTruthy();
    expect(screen.getByText(t("app.reconnecting"))).toBeTruthy();

    release();
    await waitFor(() =>
      expect(screen.queryByText(t("app.reconnecting"))).toBeNull(),
    );
    expect(screen.getByText("First conversation")).toBeTruthy();
  });

  it("KIN-MOBILE-001 R7: a 20 s glance does not re-read the list", async () => {
    let calls = 0;
    const fetchImpl = routedFetch((url) => {
      if (!url.endsWith(listTasksPath())) return { body: [] };
      calls += 1;
      return { body: [task()] };
    });
    const app = fakeAppState();
    let clock = 1_000;

    const screen = await renderList({
      fetchImpl,
      appState: app.port,
      now: () => clock,
    });
    await waitFor(() =>
      expect(screen.getByText("First conversation")).toBeTruthy(),
    );
    expect(calls).toBe(1);

    await act(async () => {
      app.emit("background");
    });
    clock += 20_000;
    await act(async () => {
      app.emit("active");
    });
    await act(async () => {});

    expect(calls).toBe(1);
    expect(screen.queryByText(t("app.reconnecting"))).toBeNull();
  });

  it("KIN-MOBILE-001 R7: a failed resume shows the offline band with one 44pt retry, and retrying re-reads", async () => {
    jest.useFakeTimers();
    try {
      let calls = 0;
      let failing = false;
      const fetchImpl = routedFetch((url) => {
        if (!url.endsWith(listTasksPath())) return { body: [] };
        calls += 1;
        return failing ? { status: 500, body: {} } : { body: [task()] };
      });
      const app = fakeAppState();
      let clock = 1_000;

      const screen = await renderList({
        fetchImpl,
        appState: app.port,
        now: () => clock,
      });
      await waitFor(() =>
        expect(screen.getByText("First conversation")).toBeTruthy(),
      );
      expect(calls).toBe(1);

      failing = true;
      await act(async () => {
        app.emit("background");
      });
      clock += RESUME_THRESHOLD_MS;
      await act(async () => {
        app.emit("active");
      });
      // Drive the whole bounded backoff series to `offline`.
      for (let i = 0; i < MAX_RESUME_ATTEMPTS; i += 1) {
        await act(async () => {
          await jest.advanceTimersByTimeAsync(RETRY_CAP_MS);
        });
      }

      expect(screen.getByText(t("pairing.unreachable"))).toBeTruthy();
      const retry = screen.getByTestId("list-resume-retry");
      const style = StyleSheet.flatten(retry.props.style);
      expect(style.minHeight).toBeGreaterThanOrEqual(44);
      expect(screen.getByText("First conversation")).toBeTruthy();
      expect(calls).toBe(MAX_RESUME_ATTEMPTS + 1);

      // The manual retry is the one extra read the story asks for.
      failing = false;
      await act(async () => {
        fireEvent.press(retry);
      });
      await act(async () => {
        await jest.advanceTimersByTimeAsync(0);
      });
      await waitFor(() =>
        expect(screen.queryByText(t("pairing.unreachable"))).toBeNull(),
      );
      expect(calls).toBe(MAX_RESUME_ATTEMPTS + 2);
      expect(screen.getByText("First conversation")).toBeTruthy();
    } finally {
      jest.useRealTimers();
    }
  });

  it("KIN-MOBILE-001 R7: a successful pull-to-refresh clears the offline band", async () => {
    jest.useFakeTimers();
    try {
      let calls = 0;
      let failing = false;
      const fetchImpl = routedFetch((url) => {
        if (!url.endsWith(listTasksPath())) return { body: [] };
        calls += 1;
        return failing ? { status: 500, body: {} } : { body: [task()] };
      });
      const app = fakeAppState();
      let clock = 1_000;

      const screen = await renderList({
        fetchImpl,
        appState: app.port,
        now: () => clock,
      });
      await waitFor(() =>
        expect(screen.getByText("First conversation")).toBeTruthy(),
      );

      failing = true;
      await act(async () => {
        app.emit("background");
      });
      clock += RESUME_THRESHOLD_MS;
      await act(async () => {
        app.emit("active");
      });
      for (let i = 0; i < MAX_RESUME_ATTEMPTS; i += 1) {
        await act(async () => {
          await jest.advanceTimersByTimeAsync(RETRY_CAP_MS);
        });
      }
      expect(screen.getByText(t("pairing.unreachable"))).toBeTruthy();
      const root = screen.root;
      if (!root) throw new Error("the list rendered no root");

      // A manual read that also fails keeps the band: it is still true.
      await act(async () => {
        fireEvent(root, "refresh");
        await jest.advanceTimersByTimeAsync(0);
      });
      expect(screen.getByText(t("pairing.unreachable"))).toBeTruthy();
      expect(calls).toBe(MAX_RESUME_ATTEMPTS + 2);

      // The network is back and the reader pulls again: one good read is proof
      // the band's claim (no network / node offline) is no longer true.
      failing = false;
      await act(async () => {
        fireEvent(root, "refresh");
        await jest.advanceTimersByTimeAsync(0);
      });

      await waitFor(() =>
        expect(screen.queryByText(t("pairing.unreachable"))).toBeNull(),
      );
      expect(screen.queryByTestId("list-resume-retry")).toBeNull();
      expect(screen.getByText("First conversation")).toBeTruthy();
      expect(calls).toBe(MAX_RESUME_ATTEMPTS + 3);
    } finally {
      jest.useRealTimers();
    }
  });

  it("KIN-MOBILE-001 R7: an expired session during resume asks for pairing instead of retrying", async () => {
    let calls = 0;
    const fetchImpl = routedFetch((url) => {
      if (!url.endsWith(listTasksPath())) return { body: [] };
      calls += 1;
      return calls === 1 ? { body: [task()] } : { status: 401, body: {} };
    });
    const onNeedsPairing = jest.fn();
    const app = fakeAppState();
    let clock = 1_000;

    const screen = await renderList({
      fetchImpl,
      onNeedsPairing,
      appState: app.port,
      now: () => clock,
    });
    await waitFor(() =>
      expect(screen.getByText("First conversation")).toBeTruthy(),
    );

    await act(async () => {
      app.emit("background");
    });
    clock += RESUME_THRESHOLD_MS;
    await act(async () => {
      app.emit("active");
    });

    await waitFor(() => expect(onNeedsPairing).toHaveBeenCalledTimes(1));
    // The band stays off: an expired token is a pairing trip, not a reconnect.
    expect(screen.queryByText(t("app.reconnecting"))).toBeNull();
    expect(screen.queryByTestId("list-resume-retry")).toBeNull();
    expect(calls).toBe(2);

    // No backoff was scheduled behind the reader's back.
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(calls).toBe(2);
  });

  it("KIN-MOBILE-001 R7: unmounting drops a late resume answer", async () => {
    let calls = 0;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const fetchImpl = jest.fn(async (input: string) => {
      if (!input.endsWith(listTasksPath())) return ok([]);
      calls += 1;
      if (calls === 1) return ok([task()]);
      await gate;
      // The reader is long gone by the time the token is refused.
      return ok({}, 401);
    }) as unknown as typeof fetch;
    const onNeedsPairing = jest.fn();
    const app = fakeAppState();
    let clock = 1_000;

    const screen = await renderList({
      fetchImpl,
      onNeedsPairing,
      appState: app.port,
      now: () => clock,
    });
    await waitFor(() =>
      expect(screen.getByText("First conversation")).toBeTruthy(),
    );

    await act(async () => {
      app.emit("background");
    });
    clock += RESUME_THRESHOLD_MS;
    await act(async () => {
      app.emit("active");
    });
    await waitFor(() => expect(calls).toBe(2));

    await screen.unmount();
    release();
    // A dropped answer schedules no React update and no navigation, so this
    // flush needs no act(): there is nothing left to render.
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    // No navigation from an answer that lands after the screen is gone.
    expect(onNeedsPairing).not.toHaveBeenCalled();
  });
});

describe("KIN-MOBILE-001 R5 pending counts on the list route", () => {
  it("KIN-MOBILE-001 R5: returning to the list re-reads the server and the approved row's badge is gone", async () => {
    let approved = false;
    let taskReads = 0;
    let approvalReads = 0;
    const fetchImpl = routedFetch((url) => {
      if (url.endsWith(listTasksPath())) {
        taskReads += 1;
        return { body: [task()] };
      }
      if (url.endsWith(pendingApprovalsPath)) {
        approvalReads += 1;
        return {
          body: approved ? [] : [{ id: "ap-1", task_id: "task-1" }],
        };
      }
      if (url.endsWith(pendingQuestionsPath)) return { body: [] };
      throw new Error(`unexpected request: ${url}`);
    });
    const props = {
      fetchImpl,
      formatTime,
      machines: MACHINES,
      memory: createListMemory(),
      onNeedsPairing: jest.fn(),
      onOpen: jest.fn(),
      readSessionImpl: storedSession,
      selfDeviceId: "dev-a",
    };
    const screen = await render(<ListScreen {...props} focusEpoch={0} />);

    const badge = t("sessions.pendingApprovals", { count: 1 });
    await waitFor(() => expect(screen.getByLabelText(badge)).toBeTruthy());
    expect(taskReads).toBe(1);
    expect(approvalReads).toBe(1);

    // The approval is decided inside the pushed conversation; Back refocuses
    // this mounted list and the route bumps the epoch. The badge must fall
    // because the second read says so, not because anything decremented it.
    approved = true;
    await screen.rerender(<ListScreen {...props} focusEpoch={1} />);

    await waitFor(() => expect(screen.queryByLabelText(badge)).toBeNull());
    expect(taskReads).toBe(2);
    expect(approvalReads).toBe(2);
  });

  it("KIN-MOBILE-001 R5: the mount focus does not cause a second initial read", async () => {
    let taskReads = 0;
    const fetchImpl = routedFetch((url) => {
      if (url.endsWith(listTasksPath())) {
        taskReads += 1;
        return { body: [task()] };
      }
      return { body: [] };
    });

    // A route that bumped its epoch before this screen mounted (a focus event
    // during the boot read): the value is the baseline, not a return.
    const screen = await renderList({ fetchImpl, focusEpoch: 1 });
    await waitFor(() =>
      expect(screen.getByText("First conversation")).toBeTruthy(),
    );
    await act(async () => {});

    expect(taskReads).toBe(1);
  });
});

describe("KIN-MOBILE-001 R3 list route", () => {
  it("KIN-MOBILE-001 R3: a stored session draws device, project and rows", async () => {
    const screen = await renderList();
    await waitFor(() => expect(screen.getByText("First conversation")).toBeTruthy());
    expect(screen.getByText("Laptop")).toBeTruthy();
    expect(screen.getByText("▾ alpha")).toBeTruthy();
    // The row's metadata line is the agent, the injected clock, and the
    // catalogue word for the status (never a status code).
    expect(
      screen.getByText(`kin · t1000 · ${t("sessions.statusSucceeded")}`),
    ).toBeTruthy();
  });

  it("KIN-MOBILE-001 R3: tapping a row reports its task id", async () => {
    const onOpen = jest.fn();
    const screen = await renderList({ onOpen });
    await waitFor(() => expect(screen.getByTestId("row:task-1")).toBeTruthy());
    await fireEvent.press(screen.getByTestId("row:task-1"));
    expect(onOpen).toHaveBeenCalledTimes(1);
    expect(onOpen).toHaveBeenCalledWith("task-1");
  });

  it("KIN-MOBILE-001 R3: no stored session asks for pairing", async () => {
    const onNeedsPairing = jest.fn();
    const screen = await renderList({ onNeedsPairing, readSessionImpl: noSession });
    await waitFor(() => expect(onNeedsPairing).toHaveBeenCalledTimes(1));
    // Nothing pretends a list was read: no rows, no empty-list words.
    expect(screen.queryByText(t("sessions.empty"))).toBeNull();
    expect(screen.queryByText(t("sessions.loading"))).toBeNull();
    expect(screen.queryByTestId("row:task-1")).toBeNull();
  });

  it("KIN-MOBILE-001 R3: a failed refresh keeps the rows and offers a retry", async () => {
    let calls = 0;
    const fetchImpl = routedFetch((url) => {
      if (!url.endsWith(listTasksPath())) return { body: [] };
      calls += 1;
      return calls === 1 ? { body: [task()] } : { status: 500, body: {} };
    });
    const screen = await renderList({ fetchImpl });
    await waitFor(() => expect(screen.getByText("First conversation")).toBeTruthy());

    // Pull-to-refresh: the list's own gesture, fired on the scroll view that
    // owns the handler (RNTL stops bubbling a non-native event next major).
    // Pull-to-refresh: fire the list's own refresh handler on the element that
    // carries it rather than bubbling a non-native event up from a row (RNTL
    // stops that bubbling in its next major).
    const root = screen.root;
    if (!root) throw new Error("the list rendered no root");
    await fireEvent(root, "refresh");
    await waitFor(() => expect(calls).toBe(2));
    await waitFor(() =>
      expect(screen.getByText(t("pairing.unreachable"))).toBeTruthy(),
    );
    expect(screen.getByText("First conversation")).toBeTruthy();

    await fireEvent.press(screen.getByText(t("pairing.retry")));
    await waitFor(() => expect(calls).toBe(3));
    expect(screen.getByText("First conversation")).toBeTruthy();
  });

  it("KIN-MOBILE-001 R3: folding a project hides its rows", async () => {
    const readSessionImpl = jest.fn(storedSession);
    const fetchImpl = routedFetch(() => ({ body: [task()] }));
    const element = (
      <ListScreen
        fetchImpl={fetchImpl}
        formatTime={formatTime}
        machines={MACHINES}
        memory={createListMemory()}
        onNeedsPairing={jest.fn()}
        onOpen={jest.fn()}
        readSessionImpl={readSessionImpl}
        selfDeviceId="dev-a"
      />
    );
    const screen = await render(element);
    await waitFor(() => expect(screen.getByText("First conversation")).toBeTruthy());

    await fireEvent.press(screen.getByTestId("project:/work/alpha"));
    expect(screen.queryByText("First conversation")).toBeNull();

    // The fold is the reader's state, not a render artifact: a repaint of the
    // same mounted screen keeps it closed.
    await screen.rerender(element);
    expect(screen.queryByText("First conversation")).toBeNull();
    expect(screen.getByText("▸ alpha")).toBeTruthy();
  });
});

describe("KIN-MOBILE-001 R3 list search and place", () => {
  it("KIN-MOBILE-001 R3: a query opens a folded project without writing the fold store, and clearing restores the fold", async () => {
    const store = createMemoryFoldStore();
    const write = jest.spyOn(store, "write");
    const fetchImpl = routedFetch((url) => {
      if (!url.endsWith(listTasksPath())) return { body: [] };
      return {
        body: [
          task({
            id: "task-1",
            title: "First conversation",
            cwd: "/work/alpha",
            created_at: 1000,
          }),
          task({
            id: "task-2",
            title: "Second conversation",
            cwd: "/work/beta",
            created_at: 900,
          }),
        ],
      };
    });
    const screen = await renderList({ fetchImpl, memory: createListMemory(), store });
    await waitFor(() => expect(screen.getByText("First conversation")).toBeTruthy());

    // Only the newest project opens by default; beta's row is folded away.
    expect(screen.queryByText("Second conversation")).toBeNull();
    expect(screen.getByText("▸ beta")).toBeTruthy();

    await fireEvent.changeText(screen.getByTestId("list-search"), "SECOND");
    // The match is visible because the query opens its project for the
    // duration of the search...
    expect(screen.getByText("Second conversation")).toBeTruthy();
    expect(screen.getByText("▾ beta")).toBeTruthy();
    // ...without touching the reader's folds: clearing must hand them back.
    expect(write).not.toHaveBeenCalled();

    await fireEvent.press(screen.getByTestId("list-search-clear"));
    expect(screen.queryByText("Second conversation")).toBeNull();
    expect(screen.getByText("▸ beta")).toBeTruthy();
  });

  it("KIN-MOBILE-001 R3: remounting the container restores the query and offset with no extra list reads", async () => {
    let taskReads = 0;
    const fetchImpl = routedFetch((url) => {
      if (!url.endsWith(listTasksPath())) return { body: [] };
      taskReads += 1;
      return { body: [task()] };
    });
    const memory = createListMemory();
    const scrollTo = jest.fn();
    const spy = jest
      .spyOn(SectionList.prototype, "getScrollResponder")
      .mockReturnValue({
        scrollTo,
      } as unknown as ReturnType<
        SectionList<never, never>["getScrollResponder"]
      >);
    try {
      const first = await renderList({ fetchImpl, memory });
      await waitFor(() => expect(first.getByText("First conversation")).toBeTruthy());
      expect(taskReads).toBe(1);

      await fireEvent.changeText(first.getByTestId("list-search"), "first");
      // A real scroll writes this field; `ConversationList.test.tsx` proves
      // the scroll → callback wiring, and this case measures the remount.
      memory.write({ offset: 180 });
      await first.unmount();

      const second = await renderList({ fetchImpl, memory });
      await waitFor(() =>
        expect(second.getByTestId("list-search").props.value).toBe("first"),
      );
      expect(second.getByText("First conversation")).toBeTruthy();
      // The stored page answers the remount: the reader does not pay for the
      // same read again.
      expect(taskReads).toBe(1);

      await fireEvent(second.getByTestId("list-scroller"), "contentSizeChange", 390, 4000);
      expect(scrollTo).toHaveBeenCalledWith({ x: 0, y: 180, animated: false });

      // A content-size change schedules VirtualizedList's own update on a
      // 50ms timer. Let it land inside act and take the screen down, so the
      // next case starts with no open act scope.
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 150));
      });
      await second.unmount();
    } finally {
      spy.mockRestore();
    }
  });

  it("KIN-MOBILE-001 R3: a late answer from an old generation does not clobber the restored query or page", async () => {
    let taskReads = 0;
    let releaseOld!: () => void;
    const oldGate = new Promise<void>((resolve) => {
      releaseOld = resolve;
    });
    const fetchImpl = jest.fn(async (input: string) => {
      if (!String(input).endsWith(listTasksPath())) return ok([]);
      taskReads += 1;
      if (taskReads === 2) {
        // The refresh in flight when the reader leaves.
        await oldGate;
        return ok([task({ id: "late", title: "alpha late", created_at: 500 })]);
      }
      return ok([task({ id: "new", title: "alpha page", created_at: 1000 })]);
    }) as unknown as typeof fetch;
    const memory = createListMemory();

    const first = await renderList({ fetchImpl, memory });
    await waitFor(() => expect(first.getByText("alpha page")).toBeTruthy());
    await fireEvent.changeText(first.getByTestId("list-search"), "alpha");
    expect(first.getByTestId("list-search").props.value).toBe("alpha");
    expect(taskReads).toBe(1);

    // The reader pulls to refresh and leaves before the answer lands.
    const root = first.root;
    if (!root) throw new Error("the list rendered no root");
    await fireEvent(root, "refresh");
    await waitFor(() => expect(taskReads).toBe(2));
    await first.unmount();

    // The remount restores the stored page and the query without a read.
    const second = await renderList({ fetchImpl, memory });
    await waitFor(() => expect(second.getByText("alpha page")).toBeTruthy());
    expect(second.getByTestId("list-search").props.value).toBe("alpha");
    expect(taskReads).toBe(2);

    // The old refresh lands long after its screen is gone. Neither the screen
    // nor the memory may take it.
    releaseOld();
    await act(async () => {});
    expect(second.getByText("alpha page")).toBeTruthy();
    expect(second.queryByText("alpha late")).toBeNull();
    expect(second.getByTestId("list-search").props.value).toBe("alpha");
    // The stored page — what a later remount would restore — is still the
    // second mount's, not the dead refresh's.
    const snapshot = memory.readSnapshot(ORIGIN);
    const titles =
      snapshot?.groups.flatMap((device) =>
        device.projects.flatMap((project) =>
          project.rows.map((item) => item.title),
        ),
      ) ?? [];
    expect(titles).toContain("alpha page");
    expect(titles).not.toContain("alpha late");
    expect(memory.read().query).toBe("alpha");
    expect(taskReads).toBe(2);
  });
});
