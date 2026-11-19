// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { checkConsoleVersion, type ConsoleVersionDeps } from "./consoleVersion";

/**
 * The check is a conversation between the running document and the server's
 * index. Both sides are injected: a fetch that answers whatever the server
 * would, and a storage object standing in for the document's sessionStorage,
 * so "a second document" is simply a second wrapper over the same backing map.
 */

type TestStorage = ConsoleVersionDeps["storage"];

function memoryStorage(backing = new Map<string, string>()): TestStorage {
  return {
    getItem: (key: string) => backing.get(key) ?? null,
    setItem: (key: string, value: string) => {
      backing.set(key, value);
    },
  };
}

/** Private mode or a sandboxed frame: every storage access throws. */
function brokenStorage(): TestStorage {
  return {
    getItem: (): string | null => {
      throw new Error("storage unavailable");
    },
    setItem: (): void => {
      throw new Error("storage unavailable");
    },
  };
}

const index = (entry: string) => `<script type="module" src="${entry}"></script>`;

function setup(
  overrides: {
    current?: string | null;
    html?: string;
    ok?: boolean;
    reject?: boolean;
    storage?: TestStorage;
  } = {},
) {
  const fetchImpl = vi.fn(async () => {
    if (overrides.reject) throw new TypeError("network error");
    return {
      ok: overrides.ok ?? true,
      text: async () => overrides.html ?? index("/assets/index-new.js"),
    };
  });
  const reload = vi.fn<() => void>();
  const storage = overrides.storage ?? memoryStorage();
  const deps: ConsoleVersionDeps = {
    fetchImpl,
    currentEntry: overrides.current === undefined ? "/assets/index-old.js" : overrides.current,
    reload,
    storage,
  };
  return { deps, fetchImpl, reload, storage };
}

describe("checkConsoleVersion", () => {
  it("reloads once when the served entry chunk differs", async () => {
    const { deps, reload } = setup();
    await expect(checkConsoleVersion(deps)).resolves.toBe("stale");
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it("asks for the entry with cache no-store", async () => {
    const { deps, fetchImpl } = setup();
    await checkConsoleVersion(deps);
    expect(fetchImpl).toHaveBeenCalledWith("/", expect.objectContaining({ cache: "no-store" }));
  });

  it("does nothing when the entry matches", async () => {
    const { deps, reload } = setup({
      current: "/assets/index-same.js",
      html: index("/assets/index-same.js"),
    });
    await expect(checkConsoleVersion(deps)).resolves.toBe("current");
    expect(reload).not.toHaveBeenCalled();
  });

  it("does not reload on a failed fetch", async () => {
    const rejected = setup({ reject: true });
    await expect(checkConsoleVersion(rejected.deps)).resolves.toBe("skipped");
    expect(rejected.reload).not.toHaveBeenCalled();

    const failed = setup({ ok: false });
    await expect(checkConsoleVersion(failed.deps)).resolves.toBe("skipped");
    expect(failed.reload).not.toHaveBeenCalled();
  });

  it("does not reload twice for the same stale entry", async () => {
    // Two resumes of the same document: the first reloads, the second must not
    // queue a second navigation before the first one takes effect. Storage that
    // refuses access is the case where only the in-memory guard is left, so the
    // loop must still not happen there.
    const { deps, reload } = setup({ storage: brokenStorage() });
    await checkConsoleVersion(deps);
    await checkConsoleVersion(deps);
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it("does not reload again in a new document for the same stale entry", async () => {
    // The server can keep serving the old index after the reload (a cache in
    // front of it). The sessionStorage marker is what stops that from looping.
    const backing = new Map<string, string>();
    const first = setup({ storage: memoryStorage(backing) });
    await checkConsoleVersion(first.deps);
    const second = setup({ storage: memoryStorage(backing) });
    await checkConsoleVersion(second.deps);
    expect(first.reload.mock.calls.length + second.reload.mock.calls.length).toBe(1);
  });

  it("skips the check on the dev server", async () => {
    const { deps, fetchImpl, reload } = setup({ current: "/src/main.tsx" });
    await expect(checkConsoleVersion(deps)).resolves.toBe("skipped");
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(reload).not.toHaveBeenCalled();
  });
});
