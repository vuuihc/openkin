import { describe, expect, it, jest } from "@jest/globals";
import { fireEvent, render, waitFor } from "@testing-library/react-native";
import type { Task } from "../../../ui/src/api/contract";
import type { Machine } from "../../../ui/src/lib/devices";
import type { Session } from "../auth/tokenStore";
import { t } from "../i18n";
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
      onNeedsPairing={jest.fn()}
      onOpen={jest.fn()}
      readSessionImpl={storedSession}
      selfDeviceId="dev-a"
      {...props}
    />,
  );
}

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
    const fetchImpl = routedFetch(() => {
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
