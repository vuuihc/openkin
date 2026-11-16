import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  clearDownload,
  compareVersions,
  decideUpdate,
  dmgDownloadPath,
  downloadDmg,
  fetchLatestRelease,
  normalizeVersion,
  pickMacDmg,
  updatableBuild,
  type ReleaseInfo,
} from "./updater.ts";

// KIN-SETTINGS-002: the desktop shell's one-click update — check GitHub
// Releases, compare against the running build, download the Mac dmg.

describe("version comparison", () => {
  it("strips the leading v from tags", () => {
    assert.equal(normalizeVersion("v0.4.0"), "0.4.0");
    assert.equal(normalizeVersion("0.4.0"), "0.4.0");
  });

  it("compares numerically, not lexically", () => {
    // 0.10.0 is newer than 0.9.0, but "0.10" < "0.9" as strings.
    assert.ok(compareVersions("0.10.0", "0.9.0") > 0);
    assert.ok(compareVersions("0.3.2", "0.3.10") < 0);
    assert.equal(compareVersions("0.4.0", "0.4.0"), 0);
    assert.ok(compareVersions("1.0.0", "0.9.9") > 0);
  });
});

describe("which builds check for updates", () => {
  it("refuses the dev placeholder", () => {
    assert.equal(updatableBuild("0.0.0-dev"), false);
    assert.equal(updatableBuild(""), false);
    assert.equal(updatableBuild("0.4.0"), true);
  });
});

describe("deciding from one release", () => {
  const release = (tag: string, assets: string[] = []): ReleaseInfo => ({
    tag,
    assets,
  });
  const dmg = (tag: string) =>
    `https://github.com/vuuihc/openkin/releases/download/${tag}/Kin-${tag}-arm64.dmg`;

  it("finds a newer version and its dmg", () => {
    const r = decideUpdate("0.3.2", release("v0.4.0", [dmg("v0.4.0")]));
    assert.deepEqual(r, {
      kind: "available",
      version: "0.4.0",
      downloadUrl: dmg("v0.4.0"),
    });
  });

  it("reports current when the tags match", () => {
    const r = decideUpdate("0.3.2", release("v0.3.2", [dmg("v0.3.2")]));
    assert.deepEqual(r, { kind: "current", version: "0.3.2" });
  });

  it("does not downgrade to an older tag", () => {
    const r = decideUpdate("0.3.2", release("v0.2.0", [dmg("v0.2.0")]));
    assert.deepEqual(r, { kind: "current", version: "0.3.2" });
  });

  it("refuses to check on a dev build", () => {
    const r = decideUpdate("0.0.0-dev", release("v0.4.0"));
    assert.deepEqual(r, { kind: "dev" });
  });

  it("says so when the release has no mac dmg", () => {
    const r = decideUpdate("0.3.2", release("v0.4.0", [
      "https://github.com/vuuihc/openkin/releases/download/v0.4.0/kin-linux-amd64",
    ]));
    assert.deepEqual(r, { kind: "no-mac-asset", version: "0.4.0" });
  });

  it("errors when GitHub has nothing", () => {
    assert.deepEqual(decideUpdate("0.3.2", null), {
      kind: "error",
      message: "no release found",
    });
  });
});

describe("picking the dmg asset", () => {
  it("prefers the arm64 dmg when several exist", () => {
    const picked = pickMacDmg([
      "https://x/Kin-v0.4.0-x64.dmg",
      "https://x/Kin-v0.4.0-arm64.dmg",
      "https://x/kin-darwin-arm64",
    ]);
    assert.equal(picked, "https://x/Kin-v0.4.0-arm64.dmg");
  });

  it("returns null when there is no dmg at all", () => {
    assert.equal(pickMacDmg(["https://x/kin-linux-amd64"]), null);
  });
});

describe("the GitHub query", () => {
  it("maps the API body to tag + asset URLs", async () => {
    const fake = (async () =>
      ({
        ok: true,
        status: 200,
        json: async () => ({
          tag_name: "v0.4.0",
          assets: [
            { browser_download_url: "https://x/a.dmg" },
            {}, // a broken entry must not break the mapping
          ],
        }),
      }) as unknown as Response) as typeof fetch;
    const r = await fetchLatestRelease(fake as typeof fetch);
    assert.deepEqual(r, { tag: "v0.4.0", assets: ["https://x/a.dmg"] });
  });

  it("throws on a non-2xx answer", async () => {
    const fake = (async () =>
      ({ ok: false, status: 403 }) as unknown as Response) as typeof fetch;
    await assert.rejects(
      fetchLatestRelease(fake as typeof fetch),
      /GitHub API 403/,
    );
  });

  it("cuts a hung check at the timeout (contract step 2, review M2)", async () => {
    // A fetch that never responds must be cut by the AbortSignal, not pin
    // 正在检查 for undici's ~5-minute default.
    const fake = (async (_url: string, init?: RequestInit) => {
      const signal = init?.signal;
      await new Promise<never>((_, reject) => {
        signal?.addEventListener("abort", () =>
          reject(new Error("aborted: timed out")),
        );
      });
    }) as unknown as typeof fetch;
    const keepAlive = setInterval(() => {}, 50);
    try {
      await assert.rejects(
        fetchLatestRelease(fake, "vuuihc/openkin", 100),
        /aborted|timed out|TimeoutError/i,
      );
    } finally {
      clearInterval(keepAlive);
    }
  });
});

describe("downloading the dmg", () => {
  it("streams to disk and reports monotone progress", async () => {
    const payload = Buffer.alloc(64 * 1024, 7);
    const fake = (async () =>
      ({
        ok: true,
        status: 200,
        headers: new Map([
          ["content-length", String(payload.length)],
        ]) as unknown as Headers,
        body: (async function* () {
          const half = payload.length / 2;
          yield payload.subarray(0, half);
          yield payload.subarray(half);
        })(),
      }) as unknown as Response) as typeof fetch;

    const dir = await mkdtemp(join(tmpdir(), "kin-updater-"));
    const dest = join(dir, "Kin-0.4.0-arm64.dmg");
    const seen: number[] = [];
    const out = await downloadDmg(fake as typeof fetch, "https://x/a.dmg", dest, (f) =>
      seen.push(f),
    );
    assert.equal(out, dest);
    assert.deepEqual(await readFile(dest), payload);

    // Monotone, strictly increasing, ends at 1.
    for (let i = 1; i < seen.length; i++) {
      assert.ok(seen[i]! > seen[i - 1]!, "progress must increase");
    }
    assert.equal(seen[seen.length - 1], 1);

    await rm(dir, { recursive: true, force: true });
  });

  it("leaves no dmg-shaped file when the stream dies mid-download", async () => {
    const fake = (async () =>
      ({
        ok: true,
        status: 200,
        headers: new Map([["content-length", "999999"]]) as unknown as Headers,
        body: (async function* () {
          yield Buffer.alloc(1024, 1);
          throw new Error("connection reset");
        })(),
      }) as unknown as Response) as typeof fetch;

    const dir = await mkdtemp(join(tmpdir(), "kin-updater-"));
    const dest = join(dir, "Kin-0.4.0-arm64.dmg");
    await assert.rejects(
      downloadDmg(fake as typeof fetch, "https://x/a.dmg", dest),
      /connection reset/,
    );
    // The rename never happened: no dmg Finder would happily mount. A .part
    // may remain by design; clearDownload removes both halves.
    const m = await import("node:fs");
    assert.equal(m.existsSync(dest), false, "no final dmg may appear");
    await writeFile(`${dest}.part`, "x");
    await clearDownload(dest);
    assert.equal(m.existsSync(`${dest}.part`), false);
    await rm(dir, { recursive: true, force: true });
  });

  it("reports a sink failure instead of hanging on drain (review M1)", async () => {
    // Sink errors mid-stream (disk full topology): the write stream's open
    // fails asynchronously while the reader is parked waiting for drain.
    // Before the race this became an unhandled rejection and the download
    // hung forever with the updater permanently busy.
    const fake = (async () =>
      ({
        ok: true,
        status: 200,
        headers: new Map([["content-length", "999999999"]]) as unknown as Headers,
        body: (async function* () {
          // More than the PassThrough highWaterMark, so the reader parks.
          while (true) {
            yield Buffer.alloc(64 * 1024, 1);
          }
        })(),
      }) as unknown as Response) as typeof fetch;

    const dir = await mkdtemp(join(tmpdir(), "kin-updater-"));
    // The .part itself is a directory: the sink's open fails with EISDIR
    // while the reader is parked on drain — the real mid-stream topology
    // (a dest-as-directory would leave .part a perfectly writable file and
    // the sink would never error).
    const blocked = join(dir, "Kin-0.4.0-arm64.dmg");
    await mkdir(`${blocked}.part`);
    const res = downloadDmg(fake as typeof fetch, "https://x/a.dmg", blocked).then(
      (out) => ({ out }),
      (err) => ({ err }),
    );
    // Must settle (reject) rather than hang.
    const keepAlive = setInterval(() => {}, 50);
    const settled = await Promise.race([
      res,
      new Promise<{ timeout: true }>((r) =>
        setTimeout(() => r({ timeout: true } as const), 3_000)),
    ]).finally(() => clearInterval(keepAlive));
    assert.ok(!("timeout" in settled), "downloadDmg must not hang on a sink error");
    await rm(dir, { recursive: true, force: true });
  });

  it("cuts a hung download at the timeout (review M2)", async () => {
    const fake = (async (_url: string, init?: RequestInit) => {
      const signal = init?.signal;
      const body = (async function* () {
        yield Buffer.alloc(1024, 1);
        // Never yields again; only the AbortSignal ends the wait — a fake
        // fetch must honor it the way undici does.
        await new Promise<never>((_, reject) => {
          signal?.addEventListener("abort", () =>
            reject(new Error("aborted: timed out")),
          );
        });
      })();
      return {
        ok: true,
        status: 200,
        headers: new Map([]) as unknown as Headers,
        body,
      } as unknown as Response;
    }) as typeof fetch;
    const dir = await mkdtemp(join(tmpdir(), "kin-updater-"));
    const dest = join(dir, "Kin-0.4.0-arm64.dmg");
    // AbortSignal.timeout's timer is unref'd, so it does not keep the event
    // loop alive by itself; hold the loop open until the cut lands.
    const keepAlive = setInterval(() => {}, 50);
    try {
      await assert.rejects(
        downloadDmg(fake as typeof fetch, "https://x/a.dmg", dest, undefined, 150),
        /TimeoutError|aborted|timed out/i,
      );
    } finally {
      clearInterval(keepAlive);
    }
    await rm(dir, { recursive: true, force: true });
  });

  it("resolves the download path inside the OS temp dir", () => {
    const p = dmgDownloadPath("0.4.0");
    assert.ok(p.startsWith(tmpdir()));
    assert.ok(p.endsWith("Kin-0.4.0-arm64.dmg"));
  });
});
