// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, render, waitFor } from "@testing-library/react";
import {
  BrowserRouter,
  useLocation,
  useNavigate,
  type Location,
  type NavigateFunction,
} from "react-router-dom";
import { useEffect } from "react";
import {
  lastListUrl,
  listUrlFor,
  notePhoneLocation,
  phonePush,
  phoneTabUrl,
  resetPhoneNavigation,
  returnListUrl,
} from "./phoneNavigation";
import { synthesizePhoneParent } from "./phoneDeepLinkParent";

/**
 * The phone's "the list is already my parent" evidence, on real history.
 *
 * A marker in location state alone is not enough: it can be copied onto a
 * later entry. A bare `idx` is not enough either. The marker names a token and
 * the depth it was minted for, and a tab-scoped ledger records which list
 * token sits at which depth. The pair survives a reload and a Forward on the
 * same stack, while a copied marker or a replaced list entry is refused.
 */

type Current = { navigate: NavigateFunction; location: Location };

let current: Current | null = null;

function Probe() {
  const navigate = useNavigate();
  const location = useLocation();
  current = { navigate, location };
  // The shell's location subscription, reduced to the evidence bookkeeping it
  // performs for every route.
  useEffect(() => {
    notePhoneLocation(location);
  }, [location]);
  return null;
}

function view() {
  return render(
    <BrowserRouter>
      <Probe />
    </BrowserRouter>,
  );
}

async function mountAt(url: string): Promise<ReturnType<typeof view>> {
  window.history.replaceState({ idx: 0 }, "", url);
  const mounted = view();
  await waitFor(() => expect(current).not.toBeNull());
  return mounted;
}

async function remountCurrent(): Promise<ReturnType<typeof view>> {
  current = null;
  const mounted = view();
  await waitFor(() => expect(current).not.toBeNull());
  return mounted;
}

function pushPhone(
  to: string,
  options: { replace?: boolean; phone?: boolean; state?: unknown } = {},
): void {
  expect(current).not.toBeNull();
  act(() => {
    phonePush(current!.navigate, current!.location, to, { phone: true, ...options });
  });
}

async function backTo(pathname: string): Promise<void> {
  act(() => window.history.back());
  await waitFor(() => expect(window.location.pathname).toBe(pathname));
}

function marker(): { token: string; parentIdx: number | null } {
  const usr = (window.history.state as { usr?: Record<string, unknown> } | null)?.usr;
  expect(usr?.kinListParent).toBeTruthy();
  return usr!.kinListParent as { token: string; parentIdx: number | null };
}

function viewport(wide = false) {
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches: query === "(min-width: 768px)" ? wide : false,
    media: query,
    onchange: null,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    addListener: vi.fn(),
    removeListener: vi.fn(),
    dispatchEvent: vi.fn(),
  }));
}

beforeEach(() => {
  resetPhoneNavigation();
  window.history.replaceState({ idx: 0 }, "", "/");
  sessionStorage.clear();
  current = null;
  viewport();
  vi.unstubAllGlobals();
  viewport();
});

describe("the list as a phone screen's parent", () => {
  it("stamps a destination pushed from the list and replaces it from there", async () => {
    const mounted = await mountAt("/sessions?search=alpha");
    pushPhone("/projects/p1");
    await waitFor(() => expect(window.location.pathname).toBe("/projects/p1"));
    expect(window.history.state.idx).toBe(1);
    expect(marker()).toMatchObject({ token: expect.any(String), parentIdx: 0 });

    // From that project, pushing a conversation replaces it instead of
    // stacking the list a second time.
    pushPhone("/tasks/t1");
    await waitFor(() => expect(window.location.pathname).toBe("/tasks/t1"));
    expect(window.history.state.idx).toBe(1);

    await backTo("/sessions");
    expect(window.location.search).toBe("?search=alpha");
    expect(window.history.state.idx).toBe(0);
    mounted.unmount();
  });

  it("returns to the existing list by popping instead of stacking a second one", async () => {
    const mounted = await mountAt("/sessions");
    pushPhone("/projects/p1");
    await waitFor(() => expect(window.location.pathname).toBe("/projects/p1"));

    pushPhone("/sessions");
    await waitFor(() => expect(window.location.pathname).toBe("/sessions"));
    expect(window.history.state.idx).toBe(0);
    mounted.unmount();
  });

  it("replaces a same-view list push instead of stacking the list on itself", async () => {
    const mounted = await mountAt("/sessions");
    pushPhone("/sessions?search=beta");
    await waitFor(() => expect(window.location.search).toBe("?search=beta"));
    expect(window.history.state.idx).toBe(0);
    mounted.unmount();
  });

  it("keeps ordinary history on the Mac", async () => {
    const mounted = await mountAt("/sessions");
    pushPhone("/projects/p1", { phone: false });
    await waitFor(() => expect(window.location.pathname).toBe("/projects/p1"));
    expect(window.history.state.idx).toBe(1);

    pushPhone("/tasks/t1", { phone: false });
    await waitFor(() => expect(window.location.pathname).toBe("/tasks/t1"));
    expect(window.history.state.idx).toBe(2);
    mounted.unmount();
  });

  it("synthesizes exactly one list under a cold project with no list evidence", async () => {
    const mounted = await mountAt("/projects/p1");
    pushPhone("/tasks/t1");
    await waitFor(() => expect(window.location.pathname).toBe("/tasks/t1"));

    // [list, task]: the project's entry became the list, and the task was one
    // push above it.
    expect(window.history.state.idx).toBe(1);
    await backTo("/sessions");
    expect(window.history.state.idx).toBe(0);
    mounted.unmount();
  });
});

describe("evidence across reload and Forward", () => {
  it("still sees the list parent after the document reloads at the child", async () => {
    const mounted = await mountAt("/sessions");
    pushPhone("/projects/p1");
    await waitFor(() => expect(window.location.pathname).toBe("/projects/p1"));
    const before = marker();
    mounted.unmount();

    // A reload keeps history state and sessionStorage, and only resets the
    // module's in-memory token.
    resetPhoneNavigation({ keepStorage: true });
    const reloaded = await remountCurrent();
    expect(marker().token).toBe(before.token);

    pushPhone("/tasks/t1");
    await waitFor(() => expect(window.location.pathname).toBe("/tasks/t1"));
    expect(window.history.state.idx).toBe(1);
    await backTo("/sessions");
    expect(window.history.state.idx).toBe(0);
    reloaded.unmount();
  });

  it("keeps the list parent when Back changes the list query and Forward returns", async () => {
    const mounted = await mountAt("/sessions");
    pushPhone("/projects/p1");
    await waitFor(() => expect(window.location.pathname).toBe("/projects/p1"));
    const before = marker();

    await backTo("/sessions");
    act(() => {
      current!.navigate("/sessions?search=beta", { replace: true });
    });
    await waitFor(() => expect(window.location.search).toBe("?search=beta"));

    act(() => window.history.forward());
    await waitFor(() => expect(window.location.pathname).toBe("/projects/p1"));
    expect(marker().token).toBe(before.token);

    pushPhone("/tasks/t1");
    await waitFor(() => expect(window.location.pathname).toBe("/tasks/t1"));
    expect(window.history.state.idx).toBe(1);
    await backTo("/sessions");
    expect(window.location.search).toBe("?search=beta");
    mounted.unmount();
  });

  it("keeps the archived root's filters across a conversation Back and Forward", async () => {
    // Archive is the same root, not a detail that gets a bare list parent.
    window.history.replaceState({ idx: 0 }, "", "/sessions?scope=archived");
    expect(synthesizePhoneParent()).toBe(false);
    const mounted = await remountCurrent();
    expect(window.history.state.idx).toBe(0);
    pushPhone("/tasks/t1");
    await waitFor(() => expect(window.location.pathname).toBe("/tasks/t1"));
    expect(window.history.state.idx).toBe(1);
    await backTo("/sessions");
    expect(window.location.search).toBe("?scope=archived");
    expect(window.history.state.idx).toBe(0);
    act(() => window.history.forward());
    await waitFor(() => expect(window.location.pathname).toBe("/tasks/t1"));
    expect(marker().token).toBeTruthy();
    await backTo("/sessions");
    expect(window.location.search).toBe("?scope=archived");
    expect(window.history.state.idx).toBe(0);
    mounted.unmount();
  });

  it("recognizes a parent synthesized before the router mounted", async () => {
    window.history.replaceState({ idx: 0 }, "", "/projects/p1");
    expect(synthesizePhoneParent()).toBe(true);
    expect(window.location.pathname).toBe("/projects/p1");
    expect(marker().parentIdx).toBe(0);

    const mounted = await remountCurrent();
    pushPhone("/tasks/t1");
    await waitFor(() => expect(window.location.pathname).toBe("/tasks/t1"));
    expect(window.history.state.idx).toBe(1);
    await backTo("/sessions");
    mounted.unmount();
  });

  it("accepts the marker alone when a browser restart restored history but not storage", async () => {
    const mounted = await mountAt("/sessions");
    pushPhone("/projects/p1");
    await waitFor(() => expect(window.location.pathname).toBe("/projects/p1"));
    const before = marker();
    mounted.unmount();

    resetPhoneNavigation();
    sessionStorage.clear();
    const restored = await remountCurrent();
    expect(marker().token).toBe(before.token);

    pushPhone("/tasks/t1");
    await waitFor(() => expect(window.location.pathname).toBe("/tasks/t1"));
    expect(window.history.state.idx).toBe(1);
    restored.unmount();
  });
});

describe("root peers on a deeper history entry", () => {
  it("does not mistake a positive index for a removed list parent", async () => {
    const mounted = await mountAt("/routines");
    // Direct navigation intentionally has no list-parent evidence. A bare
    // idx > 0 would pop back to Routines instead of switching to Chats.
    act(() => {
      current!.navigate("/tasks/t0");
    });
    await waitFor(() => expect(window.location.pathname).toBe("/tasks/t0"));
    expect(window.history.state.idx).toBe(1);

    pushPhone("/sessions");
    await waitFor(() => expect(window.location.pathname).toBe("/sessions"));
    expect(window.history.state.idx).toBe(1);
    mounted.unmount();
  });
});

describe("each phone tab's last view", () => {
  it("remembers each phone root's last URL, params included", () => {
    notePhoneLocation({ pathname: "/routines", search: "?device=m2" });
    notePhoneLocation({ pathname: "/settings", search: "?tab=providers" });
    notePhoneLocation({ pathname: "/settings", search: "?tab=operations" });

    expect(phoneTabUrl("routines")).toBe("/routines?device=m2");
    // Agent Ops is its own footer entry even though it lives on Settings: the
    // operations URL belongs to that entry, and Settings keeps its own view.
    expect(phoneTabUrl("agents")).toBe("/settings?tab=operations");
    expect(phoneTabUrl("settings")).toBe("/settings?tab=providers");
    // A root the reader has not visited opens at its own root.
    expect(phoneTabUrl("sessions")).toBe("/sessions");
  });

  it("refuses an operations URL remembered under Settings", () => {
    // A value written before Agent Ops got its own entry must not make the
    // Settings tab reopen the operations panel.
    sessionStorage.setItem(
      "kin.phoneTabUrls",
      JSON.stringify({ settings: "/settings?tab=operations", agents: "/settings?tab=operations" }),
    );

    expect(phoneTabUrl("settings")).toBe("/settings");
    // The same URL is still Agent Ops' own destination.
    expect(phoneTabUrl("agents")).toBe("/settings?tab=operations");
  });

  it("refuses a remembered URL that is not that root", () => {
    // A stale or foreign value — a detail path, another root's URL, or an
    // absolute URL — must not become a footer destination.
    sessionStorage.setItem(
      "kin.phoneTabUrls",
      JSON.stringify({
        routines: "/routines/today?device=m2",
        agents: "/settings#x",
        settings: "https://evil.example",
      }),
    );

    expect(phoneTabUrl("routines")).toBe("/routines");
    expect(phoneTabUrl("agents")).toBe("/agents");
    expect(phoneTabUrl("settings")).toBe("/settings");
  });
});

describe("evidence that must not be trusted", () => {
  it("refuses a marker copied onto a deeper entry", async () => {
    const mounted = await mountAt("/sessions");
    pushPhone("/projects/p1");
    await waitFor(() => expect(window.location.pathname).toBe("/projects/p1"));
    const copied = (window.history.state as { usr?: unknown }).usr;

    act(() => {
      current!.navigate("/projects/p2", { state: copied });
    });
    await waitFor(() => expect(window.location.pathname).toBe("/projects/p2"));
    expect(window.history.state.idx).toBe(2);

    pushPhone("/tasks/t1");
    await waitFor(() => expect(window.location.pathname).toBe("/tasks/t1"));
    // The marker names depth 0, but this entry is at depth 2: the list was
    // synthesized at depth 2 rather than trusted from the copied marker.
    expect(window.history.state.idx).toBe(3);
    await backTo("/sessions");
    expect(window.history.state.idx).toBe(2);
    mounted.unmount();
  });

  it("forgets a list record once that depth is replaced by another screen", async () => {
    const mounted = await mountAt("/sessions");
    pushPhone("/projects/p1");
    await waitFor(() => expect(window.location.pathname).toBe("/projects/p1"));
    await backTo("/sessions");

    act(() => {
      current!.navigate("/settings", { replace: true });
    });
    await waitFor(() => expect(window.location.pathname).toBe("/settings"));
    expect(window.history.state.idx).toBe(0);

    pushPhone("/tasks/t1");
    await waitFor(() => expect(window.location.pathname).toBe("/tasks/t1"));
    // The settings entry became the list (one replacement), then the task was
    // pushed above it. The old list record at depth 0 did not survive.
    expect(window.history.state.idx).toBe(1);
    mounted.unmount();
  });
});

describe("the list URL a return carries", () => {
  it("keeps the project narrowing alongside the other list filters", () => {
    // A draft opened from a narrowed list carries this URL back to the list
    // (`draftEntryState`), and a conversation's return rebuilds it the same
    // way. A missing key would drop `?project=` and land on the full list.
    const search =
      "?q=prefill&project=p-alpha&routine=r1&scope=archived&status=running&search=note";
    const narrowed =
      "/sessions?search=note&status=running&scope=archived&routine=r1&project=p-alpha";
    expect(listUrlFor(search)).toBe(narrowed);
    expect(returnListUrl({ pathname: "/sessions", search })).toBe(narrowed);
  });

  it("does not remember the session sheet's transient agent parameter", () => {
    // `?agent=` names the sheet over the list, and the sheet's continue flow
    // never commits a clean list location. Remembering it as the list URL
    // would reopen the closed sheet from the rail's Chats entry, ⌘K → Chats,
    // or a draft close (`lastListUrl`). Only `agent` goes; the list's own
    // filters stay, `attention` included.
    notePhoneLocation({ pathname: "/sessions", search: "?agent=s1" });
    expect(lastListUrl()).toBe("/sessions");

    notePhoneLocation({ pathname: "/sessions", search: "?agent=s1&attention=needs-you" });
    expect(lastListUrl()).toBe("/sessions?attention=needs-you");
  });
});
