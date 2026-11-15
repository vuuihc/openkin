/**
 * Desktop-shell updater: check GitHub Releases for a newer tag, download the
 * Mac dmg, and hand it to the user to install.
 *
 * KIN-SETTINGS-002. The app is unsigned (identity: null), so macOS will not
 * let a running process replace itself — the honest end state of "one click"
 * here is: the dmg is downloaded and mounted, the shell offers to quit, and
 * dragging the new app over the old one in the Finder window that opened is
 * the install. Faking silent self-update would be lying about what an
 * unsigned bundle can do.
 *
 * Pure logic lives in the exported functions; Electron APIs (Notification,
 * shell.openPath) and network are injected by the caller so every rule is
 * testable with plain node:test.
 */

import { createWriteStream } from "node:fs";
import { mkdir, rename, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";

/** The repo whose Releases are the update channel. Only github.com, ever. */
export const RELEASES_REPO = "vuuihc/openkin";

/** One GitHub Release, as far as the updater cares. */
export type ReleaseInfo = {
  tag: string;
  /** Direct download URLs of the release's assets. */
  assets: string[];
};

export type CheckResult =
  | { kind: "dev" }
  | {
      kind: "current";
      version: string;
    }
  | {
      kind: "available";
      version: string;
      /** The arm64 dmg download URL. */
      downloadUrl: string;
    }
  | { kind: "no-mac-asset"; version: string }
  | { kind: "error"; message: string };

/** fraction is 0..1; hasTotal is false when the server declared no length. */
export type ProgressFn = (fraction: number, hasTotal: boolean) => void;

/**
 * Strip a leading v from a tag: releases are tagged v0.4.0, the app version
 * electron-builder stamps is 0.4.0, and one comparison needs both bare.
 */
export function normalizeVersion(tag: string): string {
  return tag.startsWith("v") ? tag.slice(1) : tag;
}

/**
 * Compare two dotted versions numerically. Returns >0 when a is newer, <0
 * when older, 0 when equal. Dots and numbers only — anything else counts as
 * the shortest prefix that parses. Prerelease suffixes are NOT understood
 * ("0.4.0-beta.1" parses as 0.4.0.1, i.e. newer than 0.4.0); safe today
 * because /releases/latest never returns a prerelease.
 */
export function compareVersions(a: string, b: string): number {
  const parse = (v: string) =>
    v
      .split(".")
      .map((p) => Number(p))
      .map((n) => (Number.isFinite(n) ? n : 0));
  const as = parse(a);
  const bs = parse(b);
  const len = Math.max(as.length, bs.length);
  for (let i = 0; i < len; i++) {
    const d = (as[i] ?? 0) - (bs[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

/** True when this build should participate in update checks at all. */
export function updatableBuild(appVersion: string): boolean {
  return appVersion !== "0.0.0-dev" && appVersion !== "";
}

/**
 * Pick the arm64 dmg asset URL out of a release's assets, preferring the
 * tag-named one the release workflow produces (Kin-vX.Y.Z-arm64.dmg).
 */
export function pickMacDmg(assets: string[]): string | null {
  const dmg = assets.filter((u) => u.toLowerCase().endsWith(".dmg"));
  if (dmg.length === 0) return null;
  const arm64 = dmg.find((u) => /arm64/i.test(u));
  return arm64 ?? dmg[0]!;
}

/**
 * The whole decision of one check, as a pure function: the caller supplies
 * this build's version and the best release GitHub knows about.
 */
export function decideUpdate(
  appVersion: string,
  release: ReleaseInfo | null,
): CheckResult {
  if (!updatableBuild(appVersion)) return { kind: "dev" };
  if (!release || !release.tag) return { kind: "error", message: "no release found" };
  const remote = normalizeVersion(release.tag);
  if (compareVersions(remote, appVersion) <= 0) {
    return { kind: "current", version: appVersion };
  }
  const downloadUrl = pickMacDmg(release.assets);
  if (!downloadUrl) return { kind: "no-mac-asset", version: remote };
  return { kind: "available", version: remote, downloadUrl };
}

/**
 * Query GitHub for the latest release. Throws on network/parse failure.
 * A hung connection is cut at timeoutMs (contract step 2: 10s), because
 * undici's own timeouts run to minutes and the tray would sit at
 * 正在检查 with every click ignored meanwhile.
 */
export async function fetchLatestRelease(
  fetchImpl: typeof fetch,
  repo: string = RELEASES_REPO,
  timeoutMs = 10_000,
): Promise<ReleaseInfo> {
  const res = await fetchImpl(
    `https://api.github.com/repos/${repo}/releases/latest`,
    {
      headers: {
        Accept: "application/vnd.github+json",
        // GitHub requires a UA from all API clients.
        "User-Agent": "kin-desktop-updater",
      },
      signal: AbortSignal.timeout(timeoutMs),
    },
  );
  if (!res.ok) {
    throw new Error(`GitHub API ${res.status}`);
  }
  const body = (await res.json()) as {
    tag_name?: string;
    assets?: Array<{ browser_download_url?: string }>;
  };
  return {
    tag: body.tag_name ?? "",
    assets: (body.assets ?? [])
      .map((a) => a.browser_download_url)
      .filter((u): u is string => typeof u === "string"),
  };
}

/** Where a download lands: the OS temp dir, cleaned by the OS eventually. */
export function dmgDownloadPath(version: string): string {
  return join(tmpdir(), `Kin-${version}-arm64.dmg`);
}

/**
 * Stream a download to disk. Progress is reported as a 0..1 fraction when the
 * server declares a length, and never otherwise — a spinner that lies about
 * 97% is worse than one that just spins. The file is written to `.part` and
 * renamed only when the whole body arrived, so a killed download never
 * leaves a dmg-shaped half file that Finder would happily mount.
 */
export async function downloadDmg(
  fetchImpl: typeof fetch,
  url: string,
  destPath: string,
  onProgress?: ProgressFn,
  timeoutMs = 15 * 60_000,
): Promise<string> {
  const res = await fetchImpl(url, {
    headers: { "User-Agent": "kin-desktop-updater" },
    // Release downloads are ~120MB; a generous ceiling so a wedged transfer
    // cannot pin the updater busy forever (review M2).
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok || !res.body) {
    throw new Error(`download failed: HTTP ${res.status}`);
  }
  await mkdir(join(destPath, ".."), { recursive: true });
  const partPath = `${destPath}.part`;
  const total = Number(res.headers.get("content-length") ?? 0);
  let seen = 0;
  const sink = createWriteStream(partPath);
  // Wire the sink before any chunk arrives: backpressure must be able to
  // pause the reader, not silently buffer the whole file in a pipe.
  const bridge = new PassThrough();
  bridge.on("data", (chunk: Buffer) => {
    seen += chunk.length;
    if (onProgress) {
      // hasTotal=false → fraction 0: the tray shows 下载中… with no number
      // rather than a percentage that would be a lie (review N3).
      onProgress(total > 0 ? Math.min(seen / total, 1) : 0, total > 0);
    }
  });
  bridge.pipe(sink);
  const done = new Promise<void>((resolve, reject) => {
    sink.on("finish", () => resolve());
    sink.on("error", reject);
  });
  try {
    // Node's web ReadableStream is async-iterable; the tsconfig's DOM types
    // don't know that half, hence the cast.
    for await (const chunk of res.body as unknown as AsyncIterable<Buffer>) {
      if (!bridge.write(chunk)) {
        // Race the drain wait against the sink: a disk-full sink errors
        // (done rejects) while the reader is parked on drain, and without
        // the race that rejection becomes an unhandled rejection and the
        // download hangs forever with busy=true (review M1).
        await Promise.race([
          new Promise<void>((r) => bridge.once("drain", () => r())),
          done,
        ]);
      }
    }
  } catch (err) {
    sink.destroy();
    throw err;
  }
  bridge.end();
  await done;
  await rename(partPath, destPath);
  return destPath;
}

/** Drop a downloaded dmg. Missing file is not an error. */
export async function clearDownload(path: string): Promise<void> {
  await rm(path, { force: true });
  await rm(`${path}.part`, { force: true });
}
