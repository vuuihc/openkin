import { beforeEach, describe, expect, it, vi } from "vitest";

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
  location: { search: "", hash: "", href: "https://kin.example.com/" },
  history: { replaceState: vi.fn() },
};
vi.stubGlobal("window", win);

// The network layer is replaced, not stubbed: these cases assert the request
// the console sends to the Hub, which is the contract a server change would
// break.
vi.mock("./client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./client")>();
  return { ...actual, apiFetch: vi.fn() };
});

const { applyVisitGate, clearAuthErrorFromURL, cleanVisitCredentials, signInWithLink } =
  await import("./account");
const { apiFetch, ApiError } = await import("./client");
const { NO_ACCOUNT, useAppStore } = await import("../store/appStore");

const INVITE = "?invite=HZ9EW-V3DPK-4MNQB-7RTXS";
const CLAIM_IN_QUERY = "?claim=abcde23456";
const CLAIM_IN_FRAGMENT = "#claim=abcde23456";

/** Set every half of the address bar the way a real navigation would. */
function visit(search: string, hash = ""): void {
  win.location.search = search;
  win.location.hash = hash;
  win.location.href = `https://kin.example.com/${search}${hash}`;
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
    // A dead one-time link trips the API layer's global 401 gate; an
    // authenticated visitor has to come back out of it, not sit on a sign-in
    // screen until App's mount effect runs.
    useAppStore.getState().requireAccount("login");
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

  it("takes a claim code out of a signed-in visitor's fragment", () => {
    // Current claim links carry the code in the fragment, where only the console
    // sees it. Once the visitor turns out to be signed in it has no use, and
    // history would keep it.
    hub({ needsBootstrap: false });
    useAppStore.getState().setAccount({
      ...useAppStore.getState().account,
      authenticated: true,
    });
    visit("", CLAIM_IN_FRAGMENT);

    applyVisitGate();

    expect(replacedURL()).toBe("https://kin.example.com/");
  });

  it("takes a claim code out of a signed-in visitor's query string too", () => {
    // Links printed by older versions still carry `?claim=`.
    hub({ needsBootstrap: false });
    useAppStore.getState().setAccount({
      ...useAppStore.getState().account,
      authenticated: true,
    });
    visit(CLAIM_IN_QUERY);

    applyVisitGate();

    expect(replacedURL()).toBe("https://kin.example.com/");
  });

  it("leaves the claim code for the visitor who has to spend it", () => {
    hub({ needsBootstrap: true });
    visit("", CLAIM_IN_FRAGMENT);

    applyVisitGate();

    expect(gate()).toBe("claim");
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

describe("cleanVisitCredentials", () => {
  beforeEach(() => {
    useAppStore.getState().setAuthOk();
    useAppStore.getState().setAccount(NO_ACCOUNT);
    visit("");
    win.history.replaceState.mockClear();
  });

  it("cleans the URL of a device-token visitor, who never reaches the gate", () => {
    // main.tsx calls this when a device token is present instead of
    // applyVisitGate. The token visitor also must not keep a live invitation or
    // claim code in the address bar.
    visit(`?invite=HZ9EW-V3DPK-4MNQB-7RTXS&claim=abcde23456`, CLAIM_IN_FRAGMENT);

    cleanVisitCredentials();

    expect(replacedURL()).toBe("https://kin.example.com/");
  });

  it("does nothing when there is no credential to remove", () => {
    visit("?room=r1", "#section");

    cleanVisitCredentials();

    expect(win.history.replaceState).not.toHaveBeenCalled();
  });
});

describe("signInWithLink", () => {
  beforeEach(() => {
    vi.mocked(apiFetch).mockReset();
  });

  it("posts the token to the one-time link route", async () => {
    vi.mocked(apiFetch).mockResolvedValue(undefined);
    const token = "ab".repeat(32);

    await signInWithLink(token);

    expect(apiFetch).toHaveBeenCalledWith("/api/auth/login-link", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token }),
    });
  });

  it("keeps the server's stable code for the login screen", async () => {
    // The screen translates by code; losing it would fall back to whatever
    // English sentence the server happened to send.
    vi.mocked(apiFetch).mockRejectedValue(
      new ApiError(401, "this link is gone", { code: "login_link_invalid" }),
    );

    await expect(signInWithLink("ab".repeat(32))).rejects.toMatchObject({
      code: "login_link_invalid",
    });
  });
});

describe("clearAuthErrorFromURL", () => {
  beforeEach(() => {
    visit("");
    win.history.replaceState.mockClear();
  });

  it("removes a link failure a signed-in visitor will never be shown", () => {
    // main.tsx reports a dead sign-in link through the same parameters an OIDC
    // callback uses. With a device token the account screen never renders, so
    // leaving them behind would show a stale failure after the next reload.
    visit("?auth_error_code=login_link_invalid&auth_error=This+link+is+dead&room=r1");

    clearAuthErrorFromURL();

    expect(replacedURL()).toBe("https://kin.example.com/?room=r1");
  });

  it("does nothing when no failure was reported", () => {
    visit("?room=r1", "#section");

    clearAuthErrorFromURL();

    expect(win.history.replaceState).not.toHaveBeenCalled();
  });
});
