#!/usr/bin/env node
/**
 * Measure how long the console the daemon embeds takes to become usable on a
 * phone-sized screen, under two cache/network conditions.
 *
 * P15 ("the phone opens on its bundled console") needs the number its fix will
 * be judged against. The premise is a field anecdote: on 2026-11-20 the 1.9 MB
 * entry chunk returned complete in 49 ms over the LAN, but the first tunnel
 * attempt received 74 KB in 20 s and stalled, then took 2.9-5.3 s three times.
 * This script measures the same console in Chrome at 390x844:
 *
 *   cold      a fresh context with the HTTP cache disabled
 *   throttled cold, plus Network.emulateNetworkConditions at PHONE_WEAK
 *
 * Each run reports, on the measuring document's own clock:
 *
 *   navigation-start       performance.timeOrigin (stamped before any page script)
 *   entry-chunk-bytes      resource-timing transferSize / encodedBodySize / URL
 *   console-usable         the first animation frame after .kin-boot has left
 *                          #root and one more frame has shown a non-splash child
 *   shell-total            navigation loadEventEnd (reported, not the headline)
 *
 * What a run refuses to do (exit 2, `GUARD <name>: <detail>` on stderr):
 *
 *   daemon-never-healthy       /api/health did not answer within 60 s
 *   splash-never-left          console-usable did not arrive within 60 s
 *   boot-guard-reloaded        the boot guard reloaded, or showed 重新加载
 *   entry-not-from-this-origin transferSize 0 on a cold run, or a foreign origin
 *   stale-dist                 the served chunk name differs from web/dist/index.html
 *   console-blank-or-error     #root empty, or a visible error surface, at the
 *                              frame console-usable would have been stamped
 *
 * It builds nothing by surprise: the console must already be built (run
 * `npm --prefix ui run build`); only ./kin is rebuilt when it is older than the
 * Go tree or the embedded web/dist. It boots a throwaway daemon on a reserved
 * port with a mktemp state dir, never touches the live node on :7777 or
 * ~/.kin, and kills only the process group it started.
 *
 * Usage:
 *   node scripts/phone-console-startup.mjs [--runs N]
 *
 * The warm (populated-cache) condition, first-contentful-paint, `--json` and
 * the synthetic `--self-check` guard harness are the deferred second slice.
 * Playwright is resolved the way rsi/runtime/ux/walk.mjs resolves it:
 * $PW_CORE, else ~/.kin/ux-proto-tools/node_modules/playwright-core; missing
 * means exit 2.
 */
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
const DIST = path.join(ROOT, "web", "dist");
const INDEX_HTML = path.join(DIST, "index.html");
const BIN = path.join(ROOT, "kin");

const VIEWPORT = { width: 390, height: 844 };
const HEALTH_DEADLINE_MS = 60_000;
const USABLE_DEADLINE_MS = 60_000;
const LOAD_DEADLINE_MS = 15_000;

/**
 * The throttled profile is named, not implied: a result is only comparable to
 * another result taken at the same setting. 250 KB/s keeps the 1.9 MB entry
 * near 7.7 s of transfer, comfortably inside the boot guard's 12 s deadline —
 * a profile that reliably trips P14's bound would measure the reload, not the
 * first load. The latency applies to every request, as it does on a phone.
 */
const PHONE_WEAK = {
  name: "phone-weak",
  latencyMs: 150,
  downloadBytesPerSecond: 250 * 1024,
  uploadBytesPerSecond: 750 * 1024,
};

const CONDITIONS = ["cold", "throttled"];
const METRICS = ["console-usable", "shell-total"];

class GuardFailure extends Error {
  constructor(guardName, detail) {
    super(`${guardName}: ${detail}`);
    this.guardName = guardName;
    this.detail = detail;
  }
}

function guard(guardName, detail) {
  throw new GuardFailure(guardName, detail);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function say(line = "") {
  process.stdout.write(`${line}\n`);
}

function parseArgs(argv) {
  const opts = { runs: 3, help: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--runs" || arg.startsWith("--runs=")) {
      const value = arg === "--runs" ? argv[++i] : arg.slice("--runs=".length);
      if (value === undefined || !/^[0-9]+$/.test(value) || Number(value) < 1) {
        throw new Error(`--runs must be a positive integer, got '${value ?? ""}'`);
      }
      opts.runs = Number(value);
    } else if (arg === "-h" || arg === "--help") {
      opts.help = true;
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }
  return opts;
}

/* ------------------------------------------------------------------ */
/* Guards                                                             */
/* ------------------------------------------------------------------ */

/**
 * One place where a sample becomes a number or a guard. A real run and the
 * (deferred) self-check build the same sample shape, so the guards a
 * measurement goes through are the guards proven there.
 */
function runGuards(sample) {
  if (!sample.daemonHealthy) {
    guard("daemon-never-healthy", sample.daemonDetail || "the daemon did not answer /api/health");
  }
  if (sample.bootGuardReloaded) {
    guard(
      "boot-guard-reloaded",
      sample.reloadDetail || "the boot guard reloaded or offered its visible reload control",
    );
  }
  if (sample.blankOrError) {
    guard("console-blank-or-error", sample.blankOrError);
  }
  if (!Number.isFinite(sample.usableMs)) {
    guard(
      "splash-never-left",
      `console-usable was not reached within ${sample.deadlineMs} ms${sample.lastState || ""}`,
    );
  }
  const entry = sample.entry || {};
  if (!entry.url) {
    guard("entry-not-from-this-origin", "no resource-timing entry for the console entry chunk");
  }
  let origin;
  try {
    origin = new URL(entry.url).origin;
  } catch {
    origin = "(unparseable URL)";
  }
  if (origin !== sample.baseOrigin) {
    guard(
      "entry-not-from-this-origin",
      `the entry chunk came from ${origin}, but the measured console is ${sample.baseOrigin}`,
    );
  }
  if (sample.cold && entry.transferSize === 0) {
    guard(
      "entry-not-from-this-origin",
      `transferSize=0 for ${entry.url} on a cold run — that run measured a cache`,
    );
  }
  let served;
  try {
    served = path.basename(new URL(entry.url).pathname);
  } catch {
    served = "(unparseable)";
  }
  if (served !== sample.expectedEntry) {
    guard(
      "stale-dist",
      `the daemon served ${served}, but web/dist/index.html names ${sample.expectedEntry}`,
    );
  }
  return sample.usableMs;
}

/** Parse the entry chunk path out of the built document. */
function parseEntry(html) {
  const match = html.match(/<script\b[^>]*\bsrc="(\/assets\/index-[^"]+\.js)"/);
  return match ? match[1] : null;
}

/* ------------------------------------------------------------------ */
/* Preflight: the console this daemon embeds must already be built     */
/* ------------------------------------------------------------------ */

function preflightDist() {
  if (!fs.existsSync(INDEX_HTML)) {
    process.stderr.write(
      "REFUSE: web/dist/index.html is missing — run `npm --prefix ui run build` first\n",
    );
    process.exit(2);
  }
  const html = fs.readFileSync(INDEX_HTML, "utf8");
  const entry = parseEntry(html);
  if (!entry) {
    process.stderr.write(
      "REFUSE: web/dist/index.html names no /assets/index-*.js entry chunk — run `npm --prefix ui run build`\n",
    );
    process.exit(2);
  }
  const file = path.join(DIST, entry.replace(/^\//, ""));
  if (!fs.existsSync(file)) {
    process.stderr.write(
      `REFUSE: web/dist/index.html names ${entry}, but ${path.relative(ROOT, file)} is missing — ` +
        "run `npm --prefix ui run build` first\n",
    );
    process.exit(2);
  }
  return {
    path: entry,
    name: path.basename(entry),
    bytes: fs.statSync(file).size,
  };
}

function newestMtime(target) {
  const stat = fs.statSync(target);
  if (!stat.isDirectory()) return stat.mtimeMs;
  let newest = stat.mtimeMs;
  for (const name of fs.readdirSync(target)) {
    newest = Math.max(newest, newestMtime(path.join(target, name)));
  }
  return newest;
}

function needsBuild() {
  if (!fs.existsSync(BIN)) return true;
  const binTime = fs.statSync(BIN).mtimeMs;
  const inputs = [
    path.join(ROOT, "go.mod"),
    path.join(ROOT, "go.sum"),
    path.join(ROOT, "cmd"),
    path.join(ROOT, "internal"),
    path.join(ROOT, "web"),
  ];
  return inputs.some((input) => fs.existsSync(input) && newestMtime(input) > binTime);
}

function buildKin() {
  say("building ./kin (gitignored build output; the console must already be built)");
  const result = spawnSync("go", ["build", "-o", BIN, "./cmd/kin"], {
    cwd: ROOT,
    stdio: ["ignore", 2, 2],
  });
  if (result.error) {
    throw new Error(`go build ./cmd/kin could not start: ${result.error.message}`);
  }
  if (result.status !== 0) {
    throw new Error(`go build ./cmd/kin exited ${result.status}`);
  }
}

/* ------------------------------------------------------------------ */
/* Throwaway daemon                                                   */
/* ------------------------------------------------------------------ */

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

function insideHomeState(dir) {
  const real = fs.realpathSync(dir);
  const homeKin = path.join(fs.realpathSync(os.homedir()), ".kin");
  return real === homeKin || real.startsWith(`${homeKin}${path.sep}`);
}

function daemonTail(logPath) {
  try {
    const lines = fs.readFileSync(logPath, "utf8").trim().split("\n").slice(-8);
    if (lines.length === 0) return "";
    return `\n--- daemon log (last ${lines.length} lines) ---\n${lines.join("\n")}`;
  } catch {
    return "";
  }
}

async function startDaemon() {
  let port = 7777;
  for (let attempt = 0; attempt < 10 && port === 7777; attempt++) {
    port = await freePort();
  }
  if (port === 7777) throw new Error("could not reserve a port away from the live node on :7777");

  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "kin-phone-startup-"));
  if (insideHomeState(stateDir)) {
    throw new Error(`refusing to use a state directory under ~/.kin: ${stateDir}`);
  }
  const logPath = path.join(stateDir, "daemon.log");
  const out = fs.openSync(logPath, "a");

  // Only the variables this run sets: an inherited KIN_ROLE/KIN_HUB_URL/KIN_PORT
  // would silently turn the throwaway daemon into something else.
  const env = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (!key.startsWith("KIN_")) env[key] = value;
  }
  env.KIN_STATE_DIR = stateDir;

  const child = spawn(BIN, ["serve", "--port", String(port)], {
    cwd: ROOT,
    env,
    stdio: ["ignore", out, out],
    detached: true, // one process group to stop; never kill by name
  });
  fs.closeSync(out);
  // The runner owns the child's lifetime explicitly (stopDaemon); an unref'd
  // handle keeps a failed cleanup from wedging the process at exit.
  child.unref();
  let spawnError = null;
  child.on("error", (error) => {
    spawnError = error;
  });

  const base = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + HEALTH_DEADLINE_MS;
  while (Date.now() < deadline) {
    if (spawnError) {
      guard("daemon-never-healthy", `could not start ${BIN}: ${spawnError.message}`);
    }
    if (child.exitCode !== null || child.signalCode !== null) {
      guard(
        "daemon-never-healthy",
        `the daemon exited (${child.exitCode ?? child.signalCode}) before answering /api/health` +
          daemonTail(logPath),
      );
    }
    try {
      const response = await fetch(`${base}/api/health`, {
        signal: AbortSignal.timeout(1500),
      });
      if (response.ok) {
        await response.body?.cancel();
        return { base, port, stateDir, logPath, child };
      }
    } catch {
      // Not listening yet, or the one request timed out; keep polling.
    }
    await sleep(100);
  }
  guard(
    "daemon-never-healthy",
    `no answer from ${base}/api/health within ${HEALTH_DEADLINE_MS} ms` + daemonTail(logPath),
  );
}

async function stopDaemon(daemon) {
  if (!daemon) return;
  const { child, stateDir } = daemon;
  if (child.pid) {
    try {
      // detached: true made the child its own process-group leader, so the
      // group holds anything `kin serve` started under it.
      process.kill(-child.pid, "SIGTERM");
    } catch {
      try {
        child.kill("SIGTERM");
      } catch {
        // Already gone.
      }
    }
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      try {
        process.kill(-child.pid, 0);
      } catch {
        break;
      }
      await sleep(100);
    }
    try {
      process.kill(-child.pid, "SIGKILL");
    } catch {
      // Group already gone.
    }
    try {
      child.kill("SIGKILL");
    } catch {
      // Already gone.
    }
  }
  fs.rmSync(stateDir, { recursive: true, force: true });
}

/* ------------------------------------------------------------------ */
/* Browser instrumentation                                            */
/* ------------------------------------------------------------------ */

/**
 * Runs in every document before any page script. All timing marks are taken
 * with performance.now() on this document's clock; the runner reads them and
 * keeps navigation-start (performance.timeOrigin) beside them.
 *
 * This function is serialized by Playwright, so it must stay self-contained.
 */
function instrumentPage() {
  const state = {
    timeOrigin: performance.timeOrigin,
    docIndex: 0,
    splashGoneAt: null,
    usableAt: null,
    usableState: null,
    blankOrError: null,
    manualAt: null,
  };
  try {
    performance.setResourceTimingBufferSize(1000);
  } catch {
    // A smaller default buffer is still enough for the entry chunk.
  }
  // sessionStorage survives a reload the boot guard would perform; a second
  // document is how the runner sees a reload it did not ask for.
  try {
    const key = "kin.phone.startup.docIndex";
    const prior = Number(sessionStorage.getItem(key) || "0") || 0;
    state.docIndex = prior + 1;
    sessionStorage.setItem(key, String(state.docIndex));
  } catch {
    state.docIndex = 1;
  }
  window.__kinStartup = state;

  const rootEl = () => document.getElementById("root");
  const visible = (el) => {
    const box = el.getBoundingClientRect();
    const style = getComputedStyle(el);
    return (
      box.width > 0 &&
      box.height > 0 &&
      style.visibility !== "hidden" &&
      style.display !== "none"
    );
  };
  const hasNonSplashChild = () => {
    const root = rootEl();
    return !!root && [...root.children].some((el) => !el.classList.contains("kin-boot"));
  };
  const badSurface = () => {
    const root = rootEl();
    if (!root) return "#root is missing";
    if (root.children.length === 0) return "#root is empty";
    if (!root.querySelector(".kin-boot") && !hasNonSplashChild()) {
      return "#root has no non-splash child";
    }
    const alerts = [...root.querySelectorAll('[role="alert"], [data-error-surface]')].filter(
      visible,
    );
    if (alerts.length > 0) {
      const text = (alerts[0].textContent || "").trim().replace(/\s+/g, " ").slice(0, 120);
      return `a visible error surface is on screen: ${text || alerts[0].tagName.toLowerCase()}`;
    }
    return null;
  };

  const frame = () => {
    if (state.usableAt !== null) return;
    const root = rootEl();
    if (!root) {
      requestAnimationFrame(frame);
      return;
    }
    // The boot guard's manual state keeps .kin-boot and adds this control.
    if (state.manualAt === null && root.querySelector(".kin-boot-retry")) {
      state.manualAt = performance.now();
    }
    if (state.splashGoneAt === null) {
      if (!root.querySelector(".kin-boot")) state.splashGoneAt = performance.now();
      requestAnimationFrame(frame);
      return;
    }
    // One animation frame past the splash removal: the moment the finding
    // defines as usable, or the moment a blank/error surface is stamped as one.
    state.usableAt = performance.now();
    const bad = badSurface();
    if (bad) {
      state.usableState = "blank-or-error";
      state.blankOrError = bad;
    } else if (hasNonSplashChild()) {
      state.usableState = "usable";
    } else {
      state.usableState = "blank-or-error";
      state.blankOrError = "#root is empty one frame after the splash left";
    }
  };
  requestAnimationFrame(frame);
}

async function readState(page) {
  return page.evaluate(() => {
    const state = window.__kinStartup;
    if (!state) return null;
    return {
      timeOrigin: state.timeOrigin,
      docIndex: state.docIndex,
      splashGoneAt: state.splashGoneAt,
      usableAt: state.usableAt,
      usableState: state.usableState,
      blankOrError: state.blankOrError,
      manualAt: state.manualAt,
    };
  });
}

async function collect(page, context) {
  // shell-total is reported, not required: a usable console can precede the
  // load event by a few resources. A load that never arrives is null.
  await page.waitForLoadState("load", { timeout: LOAD_DEADLINE_MS }).catch(() => {});
  const data = await page.evaluate(() => {
    const state = window.__kinStartup || {};
    const navigation = performance.getEntriesByType("navigation")[0];
    const script = document.querySelector('script[type="module"][src*="/assets/index-"]');
    const root = document.getElementById("root");
    const first = root && root.firstElementChild;
    return {
      timeOrigin: state.timeOrigin,
      docIndex: state.docIndex,
      splashGoneAt: state.splashGoneAt,
      usableAt: state.usableAt,
      usableState: state.usableState,
      blankOrError: state.blankOrError,
      manualAt: state.manualAt,
      entrySrc: script ? script.src : null,
      loadEventEnd: navigation ? navigation.loadEventEnd : null,
      resources: performance.getEntriesByType("resource").map((entry) => ({
        name: entry.name,
        transferSize: entry.transferSize,
        encodedBodySize: entry.encodedBodySize,
        decodedBodySize: entry.decodedBodySize,
        startTime: entry.startTime,
        responseEnd: entry.responseEnd,
      })),
      screen: first
        ? {
            tag: first.tagName.toLowerCase(),
            className: typeof first.className === "string" ? first.className.slice(0, 120) : "",
            text: (first.textContent || "").trim().replace(/\s+/g, " ").slice(0, 120),
          }
        : null,
    };
  });

  let entry = null;
  if (data.entrySrc) {
    const wanted = new URL(data.entrySrc).pathname;
    entry =
      data.resources.find((resource) => {
        try {
          return new URL(resource.name).pathname === wanted;
        } catch {
          return false;
        }
      }) || null;
  }
  const sample = {
    daemonHealthy: true,
    bootGuardReloaded: false,
    blankOrError: data.blankOrError,
    usableMs: data.usableAt,
    deadlineMs: USABLE_DEADLINE_MS,
    lastState: data.splashGoneAt === null ? " (the splash was still in #root)" : "",
    entry: {
      url: entry?.name ?? null,
      transferSize: entry?.transferSize ?? null,
      encodedBodySize: entry?.encodedBodySize ?? null,
      decodedBodySize: entry?.decodedBodySize ?? null,
    },
    baseOrigin: new URL(context.base).origin,
    cold: context.cold,
    expectedEntry: context.expectedEntry,
  };
  const usableMs = runGuards(sample);

  return {
    timeOrigin: data.timeOrigin,
    docIndex: data.docIndex,
    marks: {
      "navigation-start": data.timeOrigin,
      "console-usable": usableMs,
      "shell-total": data.loadEventEnd && data.loadEventEnd > 0 ? data.loadEventEnd : null,
    },
    splashGoneMs: data.splashGoneAt,
    entry: sample.entry,
    screen: data.screen,
    usableState: data.usableState,
  };
}

async function waitForUsable(page, context) {
  const deadline = Date.now() + USABLE_DEADLINE_MS;
  let last = null;
  while (Date.now() < deadline) {
    let snapshot = null;
    try {
      snapshot = await readState(page);
    } catch {
      // "Execution context was destroyed" is a navigation: the next read sees
      // the new document's docIndex.
    }
    if (snapshot) {
      last = snapshot;
      if (snapshot.docIndex > context.expectedDocs) {
        guard(
          "boot-guard-reloaded",
          `the document was replaced ${snapshot.docIndex - 1} time(s); a reloaded document is not a first-load number`,
        );
      }
      if (snapshot.manualAt !== null) {
        guard(
          "boot-guard-reloaded",
          "the boot guard showed its visible reload control (重新加载 / Reload)",
        );
      }
      if (snapshot.usableAt !== null) return collect(page, context);
    }
    await sleep(50);
  }
  runGuards({
    daemonHealthy: true,
    bootGuardReloaded: false,
    blankOrError: last?.blankOrError ?? null,
    usableMs: Number.NaN,
    deadlineMs: USABLE_DEADLINE_MS,
    lastState: last?.splashGoneAt === null ? " (the splash was still in #root)" : "",
    entry: { url: `${context.base}/assets/unreached.js`, transferSize: null },
    baseOrigin: new URL(context.base).origin,
    cold: context.cold,
    expectedEntry: context.expectedEntry,
  });
}

async function measureCondition(browser, daemon, expectedEntry, condition, runIndex) {
  const contextOptions = {
    viewport: VIEWPORT,
    deviceScaleFactor: 1,
    isMobile: true,
    hasTouch: true,
    serviceWorkers: "block",
  };
  const context = await browser.newContext(contextOptions);
  const page = await context.newPage();
  await page.addInitScript(instrumentPage);

  const cdp = await context.newCDPSession(page);
  await cdp.send("Network.enable");
  await cdp.send("Network.setCacheDisabled", { cacheDisabled: true });
  if (condition === "throttled") {
    await cdp.send("Network.emulateNetworkConditions", {
      offline: false,
      latency: PHONE_WEAK.latencyMs,
      downloadThroughput: PHONE_WEAK.downloadBytesPerSecond,
      uploadThroughput: PHONE_WEAK.uploadBytesPerSecond,
      connectionType: "cellular3g",
    });
  }

  const url = `${daemon.base}/`;
  let result;
  try {
    await page.goto(url, { waitUntil: "commit", timeout: 30_000 });
    result = await waitForUsable(page, {
      base: daemon.base,
      cold: true,
      expectedEntry,
      expectedDocs: 1,
    });
  } finally {
    await context.close().catch(() => {});
  }

  return {
    run: runIndex,
    condition,
    loadavg: os.loadavg().map((value) => Number(value.toFixed(2))),
    ...result,
  };
}

/* ------------------------------------------------------------------ */
/* Reporting                                                          */
/* ------------------------------------------------------------------ */

function percentile(sorted, fraction) {
  if (sorted.length === 0) return null;
  const rank = Math.max(1, Math.ceil(fraction * sorted.length));
  return sorted[rank - 1];
}

function stats(values) {
  const sorted = values.filter((value) => Number.isFinite(value)).sort((a, b) => a - b);
  if (sorted.length === 0) return { p50: null, p90: null, min: null, max: null, n: 0 };
  return {
    p50: Math.round(percentile(sorted, 0.5)),
    p90: Math.round(percentile(sorted, 0.9)),
    min: Math.round(sorted[0]),
    max: Math.round(sorted[sorted.length - 1]),
    n: sorted.length,
  };
}

function printTable(rows, entryFile, startedAt) {
  say(
    `machine: ${os.platform()} ${os.release()} ${os.arch()}, ${os.cpus().length} cpus; ` +
      `load average now ${os.loadavg().map((value) => value.toFixed(2)).join(" ")}`,
  );
  say(`viewport: ${VIEWPORT.width}x${VIEWPORT.height} (Chrome, isMobile, hasTouch)`);
  say(
    `throttle ${PHONE_WEAK.name}: latency ${PHONE_WEAK.latencyMs} ms, ` +
      `download ${PHONE_WEAK.downloadBytesPerSecond / 1024} KB/s, ` +
      `upload ${PHONE_WEAK.uploadBytesPerSecond / 1024} KB/s`,
  );
  say(
    `entry chunk: ${entryFile.path} (${entryFile.bytes} bytes) named by web/dist/index.html`,
  );
  say(`started: ${startedAt.toISOString()}`);
  say("");
  for (const row of rows) {
    const marks = METRICS.map((metric) => {
      const value = row.marks[metric];
      return `${metric}=${Number.isFinite(value) ? `${Math.round(value)}ms` : "n/a"}`;
    }).join("  ");
    say(
      `run ${row.run}  ${row.condition.padEnd(9)}  navigation-start=${Math.round(row.timeOrigin)}  ` +
        `${marks}  entry-transfer=${row.entry.transferSize ?? "n/a"}B ` +
        `entry-encoded=${row.entry.encodedBodySize ?? "n/a"}B  ` +
        `loadavg=${row.loadavg.join("/")}`,
    );
  }
  say("");
  for (const condition of CONDITIONS) {
    const runs = rows.filter((row) => row.condition === condition);
    if (runs.length === 0) continue;
    say(`${condition}:`);
    say(`  ${"mark".padEnd(24)} ${"p50".padStart(7)} ${"p90".padStart(7)} ${"min".padStart(7)} ${"max".padStart(7)} ${"n".padStart(3)}`);
    for (const metric of METRICS) {
      const stat = stats(runs.map((row) => row.marks[metric]));
      say(
        `  ${metric.padEnd(24)} ${String(stat.p50 ?? "n/a").padStart(7)} ${String(stat.p90 ?? "n/a").padStart(7)} ` +
          `${String(stat.min ?? "n/a").padStart(7)} ${String(stat.max ?? "n/a").padStart(7)} ${String(stat.n).padStart(3)}`,
      );
    }
    say(
      `  entry transfers (bytes): ${runs.map((row) => row.entry.transferSize ?? "n/a").join(", ")}; ` +
        `encoded: ${runs.map((row) => row.entry.encodedBodySize ?? "n/a").join(", ")}`,
    );
    say("");
  }
  say("console-usable is the headline: first frame after the splash left and a non-splash child committed.");
  say("shell-total is navigation loadEventEnd; it is reported, not required, and can be later than usability.");
}

/* ------------------------------------------------------------------ */
/* Main                                                               */
/* ------------------------------------------------------------------ */

async function main() {
  const opts = parseArgs(process.argv.slice(2));

  if (opts.help) {
    process.stdout.write("usage: node scripts/phone-console-startup.mjs [--runs N]\n");
    return;
  }

  const entryFile = preflightDist();
  if (needsBuild()) buildKin();

  const require = createRequire(import.meta.url);
  let chromium;
  try {
    ({ chromium } = require(
      process.env.PW_CORE ||
        path.join(os.homedir(), ".kin/ux-proto-tools/node_modules/playwright-core"),
    ));
  } catch (error) {
    process.stderr.write(`SKIP: playwright-core missing: ${error.message}\n`);
    process.exit(2);
  }

  let browser;
  try {
    browser = await chromium.launch({ channel: "chrome", headless: true, args: ["--disable-gpu"] });
  } catch (error) {
    process.stderr.write(`SKIP: chrome launch failed: ${error.message}\n`);
    process.exit(2);
  }

  let daemon = null;
  const stop = () => {
    if (daemon?.child.pid) {
      try {
        process.kill(-daemon.child.pid, "SIGKILL");
      } catch {
        // Already gone.
      }
    }
    daemon = null;
    browser?.close().catch(() => {});
    process.exit(130);
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);

  const startedAt = new Date();
  const rows = [];
  try {
    daemon = await startDaemon();
    say(`daemon: ${daemon.base} (throwaway state ${daemon.stateDir})`);
    for (let run = 1; run <= opts.runs; run++) {
      for (const condition of CONDITIONS) {
        const row = await measureCondition(browser, daemon, entryFile.name, condition, run);
        rows.push(row);
        say(
          `run ${run}/${opts.runs} ${condition}: console-usable ${Math.round(row.marks["console-usable"])}ms`,
        );
      }
    }
  } finally {
    await stopDaemon(daemon);
    daemon = null;
    await browser.close().catch(() => {});
  }

  printTable(rows, entryFile, startedAt);
}

main().catch((error) => {
  if (error instanceof GuardFailure) {
    process.stderr.write(`GUARD ${error.guardName}: ${error.detail}\n`);
    process.exit(2);
  }
  process.stderr.write(`FAIL: ${error?.stack || error}\n`);
  process.exit(1);
});
