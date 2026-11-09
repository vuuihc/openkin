import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { Updater, type UpdaterEnv, type UpdaterState } from "./updater-wiring.ts";

// KIN-SETTINGS-002: the updater state machine — check → available →
// downloading → downloaded, with every failure mode reported, never swallowed.

type Note = { title: string; body: string };

function makeEnv(overrides: Partial<UpdaterEnv> = {}): {
  env: UpdaterEnv;
  states: UpdaterState[];
  notes: Note[];
  opened: string[];
  cleared: string[];
  /** Live counters — the returned object shares the reference. */
  calls: { confirms: number; quits: number; answer: boolean };
} {
  const states: UpdaterState[] = [];
  const notes: Note[] = [];
  const opened: string[] = [];
  const cleared: string[] = [];
  // `answer` is the knob tests flip; the counting stays in the default
  // implementation so an override can never hide a call.
  const calls = { confirms: 0, quits: 0, answer: false };
  const env: UpdaterEnv = {
    appVersion: () => "0.3.2",
    check: async () => ({
      tag: "v0.4.0",
      assets: [
        "https://github.com/vuuihc/openkin/releases/download/v0.4.0/Kin-v0.4.0-arm64.dmg",
      ],
    }),
    download: async (_url, destPath, onProgress) => {
      onProgress?.(0.5, true);
      onProgress?.(1, true);
      return destPath;
    },
    downloadPath: (v) => `/tmp/Kin-${v}-arm64.dmg`,
    notify: (title, body) => notes.push({ title, body }),
    openPath: (p) => {
      opened.push(p);
      return Promise.resolve("");
    },
    clear: (p) => {
      cleared.push(p);
      return Promise.resolve();
    },
    confirmQuitToInstall: async () => {
      calls.confirms++;
      return calls.answer;
    },
    quitApp: () => {
      calls.quits++;
    },
    setState: (s) => states.push(s),
    ...overrides,
  };
  return { env, states, notes, opened, cleared, calls };
}

function last<T>(xs: T[]): T {
  return xs[xs.length - 1]!;
}

describe("check flow", () => {
  it("goes checking → available and announces the find", async () => {
    const { env, states, notes } = makeEnv();
    const u = new Updater(env);
    await u.checkNow();
    assert.equal(last(states).phase, "available");
    assert.equal(
      (last(states) as { version?: string }).version,
      "0.4.0",
    );
    assert.ok(notes.some((n) => n.title.includes("0.4.0")));
  });

  it("lands on current when the tags match", async () => {
    const { env, states } = makeEnv({
      check: async () => ({ tag: "v0.3.2", assets: [] }),
    });
    await new Updater(env).checkNow();
    assert.equal(last(states).phase, "current");
  });

  it("tells a dev build apart and never offers an update", async () => {
    const { env, states, notes } = makeEnv({ appVersion: () => "0.0.0-dev" });
    await new Updater(env).checkNow();
    assert.equal(last(states).phase, "idle");
    assert.ok(notes.some((n) => n.body.includes("开发构建")));
  });

  it("surfaces a network failure as an error state and a notification", async () => {
    const { env, states, notes } = makeEnv({
      check: async () => {
        throw new Error("GitHub API 403");
      },
    });
    await new Updater(env).checkNow();
    assert.equal(last(states).phase, "error");
    assert.ok(notes.some((n) => n.body.includes("GitHub")));
  });
});

describe("download flow", () => {
  it("walks downloading → downloaded and keeps the dmg path", async () => {
    const { env, states, notes } = makeEnv();
    const u = new Updater(env);
    await u.checkNow();
    await u.download();
    assert.equal(last(states).phase, "downloaded");
    assert.equal(
      (last(states) as { path?: string }).path,
      "/tmp/Kin-0.4.0-arm64.dmg",
    );
    assert.ok(notes.some((n) => n.title.includes("已下载")));
    const sawHalfway = states.some(
      (s) => s.phase === "downloading" && s.fraction === 0.5,
    );
    assert.ok(sawHalfway, "progress states must be published");
  });

  it("refuses to download before a check found anything", async () => {
    const { env } = makeEnv();
    const u = new Updater(env);
    await u.download();
    assert.equal(u.current.phase, "idle");
  });

  it("restores the download offer when a download fails (contract step 3)", async () => {
    const { env, states, notes } = makeEnv({
      download: async () => {
        throw new Error("disk full");
      },
    });
    const u = new Updater(env);
    await u.checkNow();
    await u.download();
    // Not the check-failure menu: the found version stays downloadable.
    assert.equal(last(states).phase, "available");
    assert.ok(notes.some((n) => n.body.includes("下载失败")));
  });

  it("a failed download can be retried with one click", async () => {
    let fail = true;
    const { env, states } = makeEnv({
      download: async (_url, destPath, onProgress) => {
        if (fail) throw new Error("connection reset");
        onProgress?.(1, true);
        return destPath;
      },
    });
    const u = new Updater(env);
    await u.checkNow();
    await u.download(); // fails → back to available
    fail = false;
    await u.download(); // one click again, succeeds
    assert.equal(last(states).phase, "downloaded");
  });
});

describe("install action", () => {  it("opens the dmg, asks the quit-confirm, and quits when confirmed", async () => {
    const { env, opened, calls } = makeEnv();
    calls.answer = true;
    const u = new Updater(env);
    await u.checkNow();
    await u.download();
    await u.installDownloaded();
    assert.deepEqual(opened, ["/tmp/Kin-0.4.0-arm64.dmg"]);
    assert.equal(calls.confirms, 1);
    assert.equal(calls.quits, 1);
  });

  it("leaves the app running and marks the item as offered when deferred", async () => {
    const { env, states, calls } = makeEnv();
    const u = new Updater(env);
    await u.checkNow();
    await u.download();
    await u.installDownloaded();
    assert.equal(calls.quits, 0);
    assert.equal(last(states).phase, "downloaded");
    assert.ok(
      (last(states) as { offered?: boolean }).offered,
      "deferred install must mark the menu item as offered",
    );
  });

  it("reopens the dmg without asking again once offered", async () => {
    const { env, opened, calls } = makeEnv();
    const u = new Updater(env);
    await u.checkNow();
    await u.download();
    await u.installDownloaded();
    await u.installDownloaded();
    assert.equal(calls.confirms, 1, "the second click must not re-ask");
    assert.deepEqual(opened, [
      "/tmp/Kin-0.4.0-arm64.dmg",
      "/tmp/Kin-0.4.0-arm64.dmg",
    ]);
  });

  it("is a no-op when nothing has been downloaded", async () => {
    const { env, opened } = makeEnv();
    await new Updater(env).installDownloaded();
    assert.equal(opened.length, 0);
  });

  it("reports a dmg that will not open instead of silently failing", async () => {
    const { env, notes, calls } = makeEnv({
      openPath: async () => "dmg is corrupt",
    });
    const u = new Updater(env);
    await u.checkNow();
    await u.download();
    await u.installDownloaded();
    assert.ok(notes.some((n) => n.body.includes("安装包打不开")));
    assert.equal(calls.confirms, 0, "a failed open must not ask to quit");
  });

  it("clearing the download returns the menu to idle", async () => {
    const { env, states, cleared } = makeEnv();
    const u = new Updater(env);
    await u.checkNow();
    await u.download();
    await u.clearDownloaded();
    assert.deepEqual(cleared, ["/tmp/Kin-0.4.0-arm64.dmg"]);
    assert.equal(last(states).phase, "idle");
  });

  it("a failed clear still leaves the menu idle — the file is the OS's problem now", async () => {
    const { env, states } = makeEnv({
      clear: async () => {
        throw new Error("EBUSY");
      },
    });
    const u = new Updater(env);
    await u.checkNow();
    await u.download();
    await u.clearDownloaded();
    assert.equal(last(states).phase, "idle");
  });

  it("re-checking after a download cleans the stale dmg (review N5)", async () => {
    const { env, states, cleared } = makeEnv();
    const u = new Updater(env);
    await u.checkNow();
    await u.download();
    await u.checkNow();
    assert.deepEqual(cleared, ["/tmp/Kin-0.4.0-arm64.dmg"]);
    assert.equal(last(states).phase, "available");
  });
});

describe("concurrency guard", () => {
  it("ignores a second check while the first is in flight", async () => {
    let releaseFirst: (() => void) | null = null;
    const gate = new Promise<void>((r) => (releaseFirst = r));
    const { env, states } = makeEnv({
      check: async () => {
        await gate;
        return { tag: "v0.4.0", assets: [] };
      },
    });
    const u = new Updater(env);
    const first = u.checkNow();
    const second = u.checkNow();
    releaseFirst!();
    await Promise.all([first, second]);
    const checks = states.filter((s) => s.phase === "checking").length;
    assert.equal(checks, 1, "the second check must not restart the flow");
  });

  it("serializes installs: a second click waits, no double dialog (review N8)", async () => {
    let releaseFirst: (() => void) | null = null;
    const gate = new Promise<void>((r) => (releaseFirst = r));
    const { env, opened, calls } = makeEnv({
      openPath: async (p) => {
        opened.push(p);
        await gate;
        return "";
      },
    });
    const u = new Updater(env);
    await u.checkNow();
    await u.download();
    const first = u.installDownloaded();
    const second = u.installDownloaded();
    releaseFirst!();
    await Promise.all([first, second]);
    assert.equal(calls.confirms, 1, "only one confirm dialog may ask");
    assert.equal(opened.length, 1, "the second click must not re-open the dmg");
  });
});
