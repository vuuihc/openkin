// @vitest-environment jsdom
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { useSyncExternalStore } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { setLocale } from "./i18n";
import AreaRoute from "./components/layout/AreaRoute";
import TaskSessionHost from "./pages/TaskSessionHost";

/**
 * Followup 686: `main.kin-main` has two slots and only one may contribute.
 *
 * `App` puts the keep-alive host and the route wrapper beside each other inside
 * `AppShell`'s `<main class="kin-main … flex flex-col">` (App.tsx:238/241,
 * AppShell.tsx:727). On `/tasks/:id` the route table renders `null`, so the
 * chat must own the column and the wrapper must collapse; on `/sessions` the
 * list owns the column and the host must be gone.
 *
 * The existing collapse case (AreaRoute.dom.test.tsx:208) renders a stand-in
 * host and asserts the class string. This suite renders the real host, so a
 * future change to the host's own root class ("hidden" / "flex-1" branches at
 * TaskSessionHost.tsx:265-272) is caught as a second contributor here, and the
 * CSS case reads the rule that actually performs the collapse in a browser.
 */

const live = vi.hoisted(() => {
  const listeners = new Set<() => void>();
  const state = { version: 0, list: [] as unknown[] };
  return {
    state,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    version: () => state.version,
    notify() {
      state.version += 1;
      for (const listener of listeners) listener();
    },
    reset(list: unknown[]) {
      state.version = 0;
      state.list = list;
    },
  };
});

vi.mock("./api/useLiveResources", () => ({
  useTaskList: () => {
    useSyncExternalStore(live.subscribe, live.version, live.version);
    return { data: live.state.list, loading: false, error: null, loaded: true };
  },
  usePendingResources: () => ({ data: { approvals: [], questions: [] } }),
  useTaskResource: (id: string, enabled = true) => {
    useSyncExternalStore(live.subscribe, live.version, live.version);
    if (!enabled) {
      return { loaded: false, error: null, data: { task: null, events: [], deleted: false } };
    }
    return {
      loaded: true,
      error: null,
      data: { task: task(id), events: [], deleted: false },
    };
  },
}));

vi.mock("./hooks/useMachines", () => ({
  useMachines: () => ({
    machines: [],
    agents: [],
    loading: false,
    failed: false,
    refresh: vi.fn(),
  }),
}));

vi.mock("./hooks/useAgentRoles", () => ({ useAgentRoles: () => [] }));

// The conversation page is a marker: this suite asks which slot owns the
// column, not what the transcript says.
vi.mock("./pages/TaskDetailPage", () => ({
  default: ({ taskId }: { taskId: string }) => <div data-testid="local-detail">{taskId}</div>,
}));

function task(id: string) {
  return {
    id,
    title: `Conversation ${id}`,
    status: "succeeded",
    agent: "kin",
    cwd: "/work",
    prompt: `Conversation ${id}`,
    tokens_in: 0,
    tokens_out: 0,
    event_epoch: 0,
    created_at: 1,
    finished_at: 2,
  };
}

/**
 * The column App composes: `AppShell`'s `<main>` (the class string is the one
 * AppShell.tsx:727 renders) holding the host and the route wrapper as its only
 * two element children (App.tsx:238/241). `/tasks/:id` is `null`, as there,
 * because the host beside it owns that URL.
 */
function Column() {
  return (
    <main className="kin-main flex-1 min-h-0 overflow-hidden flex flex-col">
      <TaskSessionHost />
      <AreaRoute>
        <Routes>
          <Route path="/sessions" element={<div data-testid="sessions-page">sessions</div>} />
          <Route path="/tasks/:id" element={null} />
        </Routes>
      </AreaRoute>
    </main>
  );
}

function renderAt(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Column />
    </MemoryRouter>,
  );
}

function main(): HTMLElement {
  const element = document.querySelector<HTMLElement>("main.kin-main");
  if (!element) throw new Error("no main.kin-main column");
  return element;
}

function routeWrapper(): HTMLElement {
  const element = document.querySelector<HTMLElement>(".kin-route");
  if (!element) throw new Error("no .kin-route wrapper");
  return element;
}

/**
 * Whether a slot asks the flex column for space.
 *
 * The raw class lists alone are not enough: both slots legitimately carry
 * `flex-1` (the host supplies it on its shown branch, the wrapper always
 * does). The wrapper's `empty:hidden` plus the `.kin-route:empty` rule is what
 * withdraws the request when it has no page. jsdom computes neither Tailwind
 * nor index.css, so the predicate reads the same two authored facts a browser
 * uses — empty *and* marked to hide when empty — and test 3 pins the CSS half.
 */
function contributes(el: HTMLElement): boolean {
  if (!el.classList.contains("flex-1")) return false;
  if (el.classList.contains("hidden")) return false;
  return !(el.matches(":empty") && el.classList.contains("empty:hidden"));
}

/**
 * `index.css` from the console root. jsdom gives `import.meta.url` an http
 * origin, so `fileURLToPath` (the pattern node-environment suites use) is not
 * available here; the console is `ui/` whether vitest was started there or
 * from the repository root.
 */
function consoleFile(relative: string): string {
  for (const base of [process.cwd(), join(process.cwd(), "ui")]) {
    const candidate = join(base, relative);
    if (existsSync(candidate)) return readFileSync(candidate, "utf8");
  }
  throw new Error(`cannot find ${relative} from ${process.cwd()}`);
}

class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}

beforeEach(() => {
  vi.stubGlobal("ResizeObserver", ResizeObserverStub);
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    addListener: vi.fn(),
    removeListener: vi.fn(),
    dispatchEvent: vi.fn(),
  }));
  setLocale("en");
  localStorage.clear();
  live.reset([task("task-1")]);
});

describe("main.kin-main's two slots", () => {
  it("gives the live chat the column and collapses the empty route on /tasks/:id", () => {
    renderAt("/tasks/task-1");

    const slots = Array.from(main().children) as HTMLElement[];
    expect(slots).toHaveLength(2);
    const [host, route] = slots;

    // The chat is drawn, and its root asks for the column.
    expect(within(host).getByTestId("local-detail").textContent).toBe("task-1");
    expect(host.classList.contains("hidden")).toBe(false);
    expect(host.classList.contains("flex-1")).toBe(true);

    // The wrapper holds no page at this URL, and says so in both belts.
    expect(route).toBe(routeWrapper());
    expect(route.childNodes).toHaveLength(0);
    expect(route.matches(":empty")).toBe(true);
    expect(route.classList.contains("empty:hidden")).toBe(true);

    // Exactly one slot may compete for the column, and it is the chat.
    expect(slots.map(contributes)).toEqual([true, false]);
  });

  it("hides the session host when no conversation is open", () => {
    renderAt("/sessions");

    const slots = Array.from(main().children) as HTMLElement[];
    expect(slots).toHaveLength(2);
    const [host, route] = slots;

    // No conversation on the URL and no tabs restored: the host draws nothing.
    expect(host.classList.contains("hidden")).toBe(true);
    expect(contributes(host)).toBe(false);

    // The list is the one slot with content, so the wrapper stays.
    expect(within(route).getByTestId("sessions-page")).toBeTruthy();
    expect(route.matches(":empty")).toBe(false);
    expect(route.classList.contains("empty:hidden")).toBe(true);
    expect(contributes(route)).toBe(true);

    expect(slots.map(contributes)).toEqual([false, true]);
  });

  it("collapses an empty route wrapper from CSS, not only from its class list", () => {
    // The class string says what should happen; this rule is what does it in a
    // browser (index.css:659-661). Deleting the rule leaves `empty:hidden` in
    // the DOM and this suite's class-list assertions green, so it is read here
    // the way phoneFooterGlass.test.ts reads its rules. Comments are stripped
    // first: a commented-out rule is not a rule.
    const css = consoleFile("src/index.css").replace(/\/\*[\s\S]*?\*\//g, "");
    expect(css).toMatch(/\.kin-route:empty\s*\{\s*display:\s*none\s*;?\s*\}/);
  });
});
