import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * `applyVisitGate` is the one piece of the gate that is not a pure decision: it
 * reads the address bar and writes the store. It gets a test because both entry
 * points call it, and the bug it was extracted for was a caller deciding the
 * gate for itself -- an invitation link that rendered a sign-in screen while
 * every unit test stayed green.
 *
 * vitest runs here without a DOM, so `window` is stubbed the way the other
 * tests that need one do it, and the module is imported after the stub is in
 * place.
 */
const win = {
  location: { search: "", href: "https://kin.example.com/" },
  history: { replaceState: vi.fn() },
};
vi.stubGlobal("window", win);

const push = vi.hoisted(() => ({
  disableNativePushOnSignOut: vi.fn(
    async (_api: { deletePushDevice(id: string): Promise<void> }): Promise<void> => {},
  ),
}));
vi.mock("../lib/nativePush", () => push);

const { applyVisitGate, signOut } = await import("./account");
const { NO_ACCOUNT, useAppStore } = await import("../store/appStore");

const INVITE = "?invite=HZ9EW-V3DPK-4MNQB-7RTXS";

/** Set both halves of the address bar the way a real navigation would. */
function visit(search: string): void {
  win.location.search = search;
  win.location.href = `https://kin.example.com/${search}`;
}

/** The URL `history.replaceState` was last asked to install, or null. */
function replacedURL(): string | null {
  const calls = win.history.replaceState.mock.calls;
  return calls.length ? (calls[calls.length - 1][2] as string) : null;
}

function hub(over: { needsBootstrap: boolean }): void {
  useAppStore.getState().setAccount({
    ...NO_ACCOUNT,
    enabled: true,
    providers: [{ id: "password", label: "password", kind: "password" }],
    ...over,
  });
}

function gate(): string {
  const auth = useAppStore.getState().auth;
  return auth.status === "need_account" ? auth.mode : auth.status;
}

describe("applyVisitGate", () => {
  beforeEach(() => {
    // Each case starts from a visitor who has been let through, so a case that
    // changes nothing is distinguishable from one that was already there.
    useAppStore.getState().setAuthOk();
    useAppStore.getState().setAccount(NO_ACCOUNT);
    visit("");
    win.history.replaceState.mockClear();
  });

  it("sends somebody who followed an invitation to the join screen", () => {
    hub({ needsBootstrap: false });
    visit(INVITE);

    applyVisitGate();

    expect(gate()).toBe("join");
  });

  it("asks a hub with no owner to be claimed", () => {
    hub({ needsBootstrap: true });

    applyVisitGate();

    expect(gate()).toBe("claim");
  });

  it("asks a hub with no owner to be claimed even with an invitation in the URL", () => {
    // The screen for this combination has to be the claim screen: an invitation
    // is issued by an owner, so on a hub with no owner the join form could only
    // ever fail -- and it would hide the one route that produces a working hub.
    hub({ needsBootstrap: true });
    visit(INVITE);

    applyVisitGate();

    expect(gate()).toBe("claim");
  });

  it("asks a claimed hub to sign in", () => {
    hub({ needsBootstrap: false });

    applyVisitGate();

    expect(gate()).toBe("login");
  });

  it("leaves a daemon with no accounts alone", () => {
    // NO_ACCOUNT is the state refreshAccount leaves behind for a standalone
    // daemon. There is no join screen to send anybody to, and closing the gate
    // here would replace the token screen with a form that cannot be served.
    visit(INVITE);

    applyVisitGate();

    expect(gate()).toBe("ok");
  });

  it("leaves a visitor who is already signed in alone", () => {
    hub({ needsBootstrap: false });
    useAppStore.getState().setAccount({
      ...useAppStore.getState().account,
      authenticated: true,
    });
    visit(INVITE);

    applyVisitGate();

    expect(gate()).toBe("ok");
  });

  it("takes a live invitation out of a signed-in visitor's URL", () => {
    // The invitation did not get spent by this visit, and it is good for seven
    // days. Left in the address bar it is left in the history and in whatever
    // gets bookmarked from here, so a signed-in visitor loses it.
    hub({ needsBootstrap: false });
    useAppStore.getState().setAccount({
      ...useAppStore.getState().account,
      authenticated: true,
    });
    visit(INVITE);

    applyVisitGate();

    expect(replacedURL()).toBe("https://kin.example.com/");
  });

  it("leaves the invitation in place for the person it was sent to", () => {
    // The stripping above must not reach an unauthenticated visitor: the join
    // screen reads the code out of the URL to fill the field in, and a link
    // that erases itself before it is used is worse than one that lingers.
    hub({ needsBootstrap: false });
    visit(INVITE);

    applyVisitGate();

    expect(gate()).toBe("join");
    expect(win.history.replaceState).not.toHaveBeenCalled();
  });

  it("does not touch the URL of a signed-in visitor who has no invitation", () => {
    hub({ needsBootstrap: false });
    useAppStore.getState().setAccount({
      ...useAppStore.getState().account,
      authenticated: true,
    });

    applyVisitGate();

    expect(win.history.replaceState).not.toHaveBeenCalled();
  });
});

describe("signOut", () => {
  const stored = new Map<string, string>();
  const stubLocalStorage = (key: string, value: string): void => {
    stored.clear();
    stored.set(key, value);
    vi.stubGlobal("localStorage", {
      getItem: (k: string) => stored.get(k) ?? null,
      setItem: (k: string, v: string) => {
        stored.set(k, v);
      },
      removeItem: (k: string) => {
        stored.delete(k);
      },
    });
  };

  // KIN-NOTIFY-001: signing out stops this phone before the session ends.
  beforeEach(() => {
    push.disableNativePushOnSignOut.mockClear();
    useAppStore.getState().setAuthOk();
    useAppStore.getState().setAccount(NO_ACCOUNT);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.stubGlobal("window", win);
  });

  it("drops the stored token before the network can hang", async () => {
    // The token is a second way in. A request that never settles must not
    // leave it in localStorage for the next reload to pick up.
    stubLocalStorage("kin_token", "t-1");
    push.disableNativePushOnSignOut.mockImplementationOnce(() => new Promise<void>(() => {}));

    void signOut();

    expect(stored.has("kin_token")).toBe(false);
  });

  it("unregisters with the token it just dropped", async () => {
    // Clearing first is only safe because the requests carry the captured
    // token themselves; otherwise the phone's row could never be deleted.
    stubLocalStorage("kin_token", "t-1");
    push.disableNativePushOnSignOut.mockImplementationOnce(async (api) => {
      await api.deletePushDevice("row-1");
    });
    const fetchMock = vi.fn(
      async (_input: RequestInfo | URL, _init?: RequestInit) =>
        new Response(null, { status: 204 }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await signOut();

    const call = fetchMock.mock.calls.find((c) =>
      String(c[0]).includes("/api/push/devices/row-1"),
    );
    expect(call).toBeTruthy();
    const init = call?.[1] as RequestInit | undefined;
    expect(new Headers(init?.headers).get("Authorization")).toBe("Bearer t-1");
  });

  it("still ends the session when this phone's cleanup fails", async () => {
    // Leaving is the point. The node deletes session-bound rows on logout, so
    // a broken local unregister must not strand the person on the old account.
    const fetchMock = vi.fn(async () => new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetchMock);
    push.disableNativePushOnSignOut.mockRejectedValueOnce(new Error("boom"));

    await signOut();

    expect(fetchMock).toHaveBeenCalled();
    expect(useAppStore.getState().account.authenticated).toBe(false);
  });

  it("stops this phone before revoking the session it registered under", async () => {
    // The delete is authorized by the cookie logout revokes, so the order is
    // the contract: unregister first, then end the session.
    const order: string[] = [];
    push.disableNativePushOnSignOut.mockImplementation(async () => {
      order.push("push");
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        order.push("logout");
        return new Response(null, { status: 204 });
      }),
    );

    await signOut();

    expect(order).toEqual(["push", "logout"]);
    expect(useAppStore.getState().account.authenticated).toBe(false);
  });
});
