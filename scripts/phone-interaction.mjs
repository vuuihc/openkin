#!/usr/bin/env node
/**
 * What a phone pays to interact with the console: scroll the full /sessions
 * list, scroll a long transcript, tap a row into its detail, open the
 * run-config sheet, and send a message. Startup is not re-measured here; it
 * has its own script (scripts/phone-console-startup.mjs).
 *
 * The method, per leg and per run, on the page's own clock:
 *
 *   frame interval       every requestAnimationFrame timestamp is recorded by
 *                        an init script; the run's intervals are the gaps
 *                        between consecutive frames inside the gesture window
 *   dropped frame        an interval longer than 1.5x that run's median frame
 *                        interval. A 60 Hz median of 16.7 ms therefore counts
 *                        a 33 ms frame as dropped. The ratio is reported, not
 *                        smoothed: a compositor-held scroll is a run of them
 *   long task            PerformanceObserver('longtask'): entries over 50 ms
 *                        inside the same window; blocking time is the sum of
 *                        (duration - 50)
 *   tap -> detail        a capture-phase touchstart listener stamps t0 in the
 *                        page; a requestAnimationFrame loop stamps t1 on the
 *                        first frame where the destination's own content is
 *                        visible. Playwright's round trip is excluded
 *   sheet open           the same shape, destination `[data-kin-sheet]`
 *   composer send        the same shape, destination one more message element
 *                        than before the press
 *
 * Scroll and tap gestures are Chrome's real touch pipeline through CDP
 * `Input.dispatchTouchEvent` (the transport rsi/runtime/ux/touch-drag.mjs
 * uses), not a synthetic dispatchEvent. p50/p90 are nearest-rank.
 *
 * It boots its own throwaway daemon exactly as scripts/phone-console-startup.mjs
 * does (reserved free port, mktemp state dir, process-group kill, never :7777
 * or ~/.kin), seeds it with scripts/journeys_seed.py under the journey fake
 * agent, and tops the fixtures up through the public HTTP API until the list
 * has 30 rows and the transcript has 60 messages. Short falls are reported as
 * `rows=N (short sample)` / `messages=N (short sample)`, never padded.
 *
 * What a run refuses to do (exit 2, `GUARD <name>: <detail>` on stderr, no
 * number recorded):
 *
 *   daemon-never-healthy       /api/health did not answer within 60 s
 *   console-never-usable       #root never left the boot splash
 *   console-error-surface      a visible role=alert / [data-error-surface]
 *   stale-dist                 the served entry chunk != web/dist/index.html
 *   list-never-rendered        no [data-session-row] appeared
 *   scroll-did-not-move        scrollTop did not change, so the swipe proved
 *                              nothing
 *   too-few-frames             fewer than 30 rAF intervals in the window
 *   longtask-observer-missing  Chrome reported no longtask entry type
 *   frame-clock-throttled      the idle page already ran slower than 40 ms per
 *                              frame (headless Chrome on this machine is a
 *                              20 Hz clock): the frame numbers would describe
 *                              the browser, not the app
 *   transcript-never-rendered  no [data-conversation-pane] / message appeared
 *   tap-never-arrived          no touchstart, or the detail content never
 *                              became visible, within 15 s
 *
 * The sheet and composer legs are reported separately; if either cannot be
 * isolated honestly the leg prints `unmeasured: <reason>` instead of a number.
 *
 * Usage:
 *   node scripts/phone-interaction.mjs [--runs N] [--json] [--headless]
 *   node scripts/phone-interaction.mjs --self-check
 *
 * Chrome runs headed by default: headless Chrome on this machine advances
 * requestAnimationFrame at 20 Hz, so its frame intervals describe the browser,
 * not the app. `--headless` is available for a DOM-only smoke, and the
 * frame-clock guard refuses its scroll numbers when the idle cadence is that
 * slow.
 *
 * --self-check proves the parser, the nearest-rank percentile and every guard
 * without a browser or a daemon. Playwright is resolved like the siblings:
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
const SELF = fileURLToPath(import.meta.url);

const VIEWPORT = { width: 390, height: 844 };
const MIN_FRAMES = 30;
const TARGET_ROWS = 30;
const TARGET_MESSAGES = 60;
const HEALTH_DEADLINE_MS = 60_000;
const USABLE_DEADLINE_MS = 30_000;
const CONTENT_DEADLINE_MS = 30_000;
const TAP_DEADLINE_MS = 15_000;
const SWIPES = 4;
const SWIPE_STEPS = 10;

const GUARD_NAMES = [
  "daemon-never-healthy",
  "console-never-usable",
  "console-error-surface",
  "stale-dist",
  "list-never-rendered",
  "scroll-did-not-move",
  "too-few-frames",
  "longtask-observer-missing",
  "frame-clock-throttled",
  "transcript-never-rendered",
  "tap-never-arrived",
];

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
const r1 = (n) => Math.round(n * 10) / 10;

let JSON_OUT = false;
function say(line = "") {
  if (JSON_OUT) process.stderr.write(`${line}\n`);
  else process.stdout.write(`${line}\n`);
}

/* ------------------------------------------------------------------ */
/* Stats                                                              */
/* ------------------------------------------------------------------ */

/**
 * Nearest-rank: the smallest value whose rank covers the percentile. With
 * five samples p50 is the 3rd smallest and p90 the 5th; no value between two
 * measurements is invented. self-check pins this against interpolation.
 */
function percentile(sorted, fraction) {
  if (sorted.length === 0) return null;
  const rank = Math.max(1, Math.ceil(fraction * sorted.length));
  return sorted[rank - 1];
}

function stats(values) {
  const sorted = values.filter((value) => Number.isFinite(value)).sort((a, b) => a - b);
  if (sorted.length === 0) return { p50: null, p90: null, min: null, max: null, n: 0 };
  return {
    p50: r1(percentile(sorted, 0.5)),
    p90: r1(percentile(sorted, 0.9)),
    min: r1(sorted[0]),
    max: r1(sorted[sorted.length - 1]),
    n: sorted.length,
  };
}

function intervalsOf(frames) {
  const intervals = [];
  for (let i = 1; i < frames.length; i++) {
    const delta = frames[i] - frames[i - 1];
    if (Number.isFinite(delta) && delta >= 0) intervals.push(delta);
  }
  return intervals;
}

/** The numbers a leg reports from one gesture window. */
function frameMetrics(intervals, longtasks) {
  const sorted = intervals.filter(Number.isFinite).sort((a, b) => a - b);
  if (sorted.length === 0) {
    return {
      frames: 0,
      p50: null,
      p90: null,
      longest: null,
      median: null,
      dropped: 0,
      droppedPct: null,
      longTasks: 0,
      blockingMs: 0,
    };
  }
  const median = percentile(sorted, 0.5);
  const threshold = median * 1.5;
  const dropped = sorted.filter((value) => value > threshold).length;
  const tasks = (longtasks || []).filter(
    (task) => Number.isFinite(task.duration) && task.duration > 50,
  );
  const blocking = tasks.reduce((sum, task) => sum + (task.duration - 50), 0);
  return {
    frames: sorted.length,
    p50: r1(percentile(sorted, 0.5)),
    p90: r1(percentile(sorted, 0.9)),
    longest: r1(sorted[sorted.length - 1]),
    median: r1(median),
    dropped,
    droppedPct: r1((dropped / sorted.length) * 100),
    longTasks: tasks.length,
    blockingMs: Math.round(blocking),
  };
}

/* ------------------------------------------------------------------ */
/* Guards                                                             */
/* ------------------------------------------------------------------ */

/**
 * One place where a sample becomes a number or a guard. Real runs build the
 * same sample shape the self-check feeds, so proving the guards here proves
 * the guards a measurement goes through.
 */
function runGuards(sample) {
  if (!sample.daemonHealthy) {
    guard("daemon-never-healthy", sample.daemonDetail || "the daemon did not answer /api/health");
  }
  if (!sample.consoleUsable) {
    guard("console-never-usable", sample.consoleDetail || "the console never left its boot splash");
  }
  if (sample.errorSurface) guard("console-error-surface", sample.errorSurface);
  if (sample.staleDist) guard("stale-dist", sample.staleDist);
  if (sample.leg === "sessions" && !sample.listRendered) {
    guard("list-never-rendered", sample.listDetail || "no [data-session-row] appeared");
  }
  if (sample.leg === "transcript" && !sample.transcriptRendered) {
    guard(
      "transcript-never-rendered",
      sample.transcriptDetail || "no [data-conversation-pane] with a message appeared",
    );
  }
  if (sample.leg === "tap" && !sample.tapArrived) {
    guard(
      "tap-never-arrived",
      sample.tapDetail || `the detail content was not visible within ${TAP_DEADLINE_MS} ms of the touch`,
    );
  }
  if (sample.leg === "sessions" || sample.leg === "transcript") {
    if (!sample.longtaskSupported) {
      guard(
        "longtask-observer-missing",
        "PerformanceObserver did not support 'longtask'; jank would be invisible",
      );
    }
    if (Number.isFinite(sample.idleP50) && sample.idleP50 > 40) {
      guard(
        "frame-clock-throttled",
        `the idle page ran at ${sample.idleP50} ms per frame; ` +
          "this browser's frame clock is throttled (headless Chrome is 20 Hz here), so scroll numbers would measure it, not the app",
      );
    }
    if (!sample.scrollMoved) {
      guard(
        "scroll-did-not-move",
        sample.scrollDetail || "scrollTop did not change, so the swipe measured nothing",
      );
    }
    if ((sample.intervals || []).length < MIN_FRAMES) {
      guard(
        "too-few-frames",
        `${(sample.intervals || []).length} frame intervals in the window, need ${MIN_FRAMES}`,
      );
    }
  }
  return frameMetrics(sample.intervals || [], sample.longtasks || []);
}

function sampleFor(kind) {
  const good = {
    daemonHealthy: true,
    daemonDetail: "",
    consoleUsable: true,
    consoleDetail: "",
    errorSurface: null,
    staleDist: null,
    leg: "sessions",
    listRendered: true,
    listDetail: "",
    transcriptRendered: true,
    transcriptDetail: "",
    tapArrived: true,
    tapDetail: "",
    scrollMoved: true,
    scrollDetail: "",
    longtaskSupported: true,
    idleP50: 16.7,
    intervals: Array.from({ length: 40 }, (_, index) => (index % 5 === 0 ? 33 : 16)),
    longtasks: [{ startTime: 10, duration: 70 }],
  };
  switch (kind) {
    case "good":
      return good;
    case "daemon-never-healthy":
      return { ...good, daemonHealthy: false, daemonDetail: "the daemon exited 1" };
    case "console-never-usable":
      return { ...good, consoleUsable: false, consoleDetail: "the splash stayed in #root" };
    case "console-error-surface":
      return { ...good, errorSurface: "a visible error surface: 无法连接" };
    case "stale-dist":
      return { ...good, staleDist: "the daemon served index-old.js, not index-new.js" };
    case "list-never-rendered":
      return { ...good, listRendered: false };
    case "scroll-did-not-move":
      return { ...good, scrollMoved: false };
    case "too-few-frames":
      return { ...good, intervals: [16, 33, 50] };
    case "longtask-observer-missing":
      return { ...good, longtaskSupported: false };
    case "frame-clock-throttled":
      return { ...good, idleP50: 50 };
    case "transcript-never-rendered":
      return { ...good, leg: "transcript", transcriptRendered: false };
    case "tap-never-arrived":
      return { ...good, leg: "tap", tapArrived: false };
    default:
      throw new Error(`unknown self-check case: ${kind}`);
  }
}

function selfCheckCase(kind) {
  if (kind === "stats-nearest-rank") {
    const metric = frameMetrics([16, 16, 17, 33, 50], []);
    process.stdout.write(`p50=${metric.p50} p90=${metric.p90}\n`);
    return;
  }
  if (kind === "interpolated-percentile-refused") {
    // Two samples: nearest-rank p50 is the smaller one (10); an interpolating
    // percentile would print 15.
    const metric = frameMetrics([10, 20], []);
    process.stdout.write(`p50=${metric.p50} p90=${metric.p90}\n`);
    return;
  }
  if (kind === "json-round-trip") {
    const runs = [
      frameMetrics(Array.from({ length: 40 }, () => 17), [{ duration: 60 }]),
      frameMetrics(Array.from({ length: 40 }, () => 33), []),
    ];
    const doc = {
      schema: "phone-interaction/1",
      legs: { sessions: { runs, summary: summarizeRuns(runs) } },
      guards: [],
    };
    process.stdout.write(`${JSON.stringify(doc)}\n`);
    return;
  }
  const sample = sampleFor(kind);
  const metric = runGuards(sample);
  process.stdout.write(
    `report frames=${metric.frames} p50=${metric.p50} p90=${metric.p90} ` +
      `dropped=${metric.droppedPct}% longTasks=${metric.longTasks}\n`,
  );
}

function selfCheck() {
  let failures = 0;
  const fail = (message) => {
    failures += 1;
    process.stderr.write(`FAIL self-check: ${message}\n`);
  };
  const run = (kind) =>
    spawnSync(process.execPath, [SELF, "--self-check-case", kind], {
      encoding: "utf8",
      timeout: 20_000,
    });

  const nearest = run("stats-nearest-rank");
  if (nearest.status !== 0 || !/^p50=17 p90=50$/m.test(nearest.stdout || "")) {
    fail(
      `nearest-rank printed '${(nearest.stdout || "").trim()}' exit ${nearest.status}, want p50=17 p90=50`,
    );
  } else {
    process.stdout.write(`ok nearest-rank: [16,16,17,33,50] -> ${nearest.stdout.trim()}\n`);
  }

  const interpolated = run("interpolated-percentile-refused");
  if (interpolated.status !== 0 || !/^p50=10 p90=20$/m.test(interpolated.stdout || "")) {
    fail(
      `interpolation case printed '${(interpolated.stdout || "").trim()}', want p50=10 (nearest rank), not 15`,
    );
  } else {
    process.stdout.write("ok nearest-rank refuses interpolation: [10,20] -> p50=10, not 15\n");
  }

  for (const kind of GUARD_NAMES) {
    const result = run(kind);
    const firstLine = (result.stderr || "").trim().split("\n")[0] || "";
    if (result.status !== 2) {
      fail(`${kind} exited ${result.status}, want 2 (stderr: ${firstLine || "(empty)"})`);
      continue;
    }
    if (!firstLine.startsWith(`GUARD ${kind}: `)) {
      fail(`${kind} printed '${firstLine}', want 'GUARD ${kind}: ...'`);
      continue;
    }
    process.stdout.write(`ok guard ${kind}: exit 2 — ${firstLine}\n`);
  }

  const good = run("good");
  if (good.status !== 0 || /GUARD /.test(good.stderr || "") || !/^report frames=\d+ /m.test(good.stdout || "")) {
    fail(`a good sample exited ${good.status} and printed '${(good.stdout || "").trim()}'`);
  } else {
    process.stdout.write(`ok good sample: exit 0 — ${(good.stdout || "").trim()}\n`);
  }

  const roundTrip = run("json-round-trip");
  let doc = null;
  try {
    doc = JSON.parse(roundTrip.stdout || "");
  } catch {
    doc = null;
  }
  if (roundTrip.status !== 0 || !doc) {
    fail(`json-round-trip exited ${roundTrip.status} without parseable JSON`);
  } else {
    const summary = doc.legs.sessions.summary;
    if (summary.p50?.p50 !== 17 || summary.p90?.p90 !== 33 || doc.guards.length !== 0) {
      fail(`json-round-trip summary did not match the samples: ${JSON.stringify(summary)}`);
    } else {
      process.stdout.write("ok json round-trip: per-run p50 17/33 -> summary p50 17, p90 33\n");
    }
  }

  if (failures > 0) {
    process.stderr.write(`FAIL phone-interaction --self-check: ${failures} case(s) failed\n`);
    process.exit(1);
  }
  process.stdout.write(
    `ok phone-interaction --self-check: nearest-rank pinned, ${GUARD_NAMES.length} guards exit 2, ` +
      "short sets refused, JSON round-trips\n",
  );
  process.exit(0);
}

/* ------------------------------------------------------------------ */
/* Args                                                               */
/* ------------------------------------------------------------------ */

function parseArgs(argv) {
  const opts = { runs: 5, json: false, selfCheck: false, selfCheckCase: null, headless: false, help: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--runs" || arg.startsWith("--runs=")) {
      const value = arg === "--runs" ? argv[++i] : arg.slice("--runs=".length);
      if (value === undefined || !/^[0-9]+$/.test(value) || Number(value) < 1) {
        throw new Error(`--runs must be a positive integer, got '${value ?? ""}'`);
      }
      opts.runs = Number(value);
    } else if (arg === "--json") {
      opts.json = true;
    } else if (arg === "--headless") {
      opts.headless = true;
    } else if (arg === "--self-check") {
      opts.selfCheck = true;
    } else if (arg === "--self-check-case") {
      opts.selfCheckCase = argv[++i] ?? null;
      if (!opts.selfCheckCase) throw new Error("--self-check-case needs a name");
    } else if (arg === "-h" || arg === "--help") {
      opts.help = true;
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }
  return opts;
}

function summarizeRuns(runs) {
  const keys = ["frames", "p50", "p90", "longest", "droppedPct", "longTasks", "blockingMs"];
  const summary = {};
  for (const key of keys) summary[key] = stats(runs.map((row) => row[key]));
  return summary;
}

/* ------------------------------------------------------------------ */
/* Preflight and throwaway daemon                                     */
/* ------------------------------------------------------------------ */

function parseEntry(html) {
  const match = html.match(/<script\b[^>]*\bsrc="(\/assets\/index-[^"]+\.js)"/);
  return match ? match[1] : null;
}

function preflightDist() {
  if (!fs.existsSync(INDEX_HTML)) {
    process.stderr.write("REFUSE: web/dist/index.html is missing — run `npm --prefix ui run build` first\n");
    process.exit(2);
  }
  const html = fs.readFileSync(INDEX_HTML, "utf8");
  const entry = parseEntry(html);
  if (!entry) {
    process.stderr.write("REFUSE: web/dist/index.html names no /assets/index-*.js entry chunk\n");
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
  return { path: entry, name: path.basename(entry), bytes: fs.statSync(file).size };
}

function newestMtime(target) {
  const stat = fs.statSync(target);
  if (!stat.isDirectory()) return stat.mtimeMs;
  let newest = stat.mtimeMs;
  for (const name of fs.readdirSync(target)) newest = Math.max(newest, newestMtime(path.join(target, name)));
  return newest;
}

function needsBuild() {
  if (!fs.existsSync(BIN)) return true;
  const binTime = fs.statSync(BIN).mtimeMs;
  return ["go.mod", "go.sum", "cmd", "internal", "web"].some(
    (input) => fs.existsSync(path.join(ROOT, input)) && newestMtime(path.join(ROOT, input)) > binTime,
  );
}

function buildKin() {
  say("building ./kin (gitignored build output; the console must already be built)");
  const result = spawnSync("go", ["build", "-o", BIN, "./cmd/kin"], { cwd: ROOT, stdio: ["ignore", 2, 2] });
  if (result.error) throw new Error(`go build ./cmd/kin could not start: ${result.error.message}`);
  if (result.status !== 0) throw new Error(`go build ./cmd/kin exited ${result.status}`);
}

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
    return lines.length ? `\n--- daemon log (last ${lines.length} lines) ---\n${lines.join("\n")}` : "";
  } catch {
    return "";
  }
}

/**
 * The fake agent's environment, copied from the shape switch-latency.mjs and
 * ux-walk.sh use: the fake directory first on PATH, and an inherited absolute
 * `claude` pin outside that directory removed. The daemon resolves the binary,
 * so PATH order is the part that matters; the override name is read from the
 * walk runner so the two cannot drift.
 */
function fakeAgentEnv(stateDir) {
  const fakeDir = path.join(ROOT, "scripts/journeys_fake_agent");
  const fake = path.join(fakeDir, "claude");
  if (!fs.existsSync(fake)) throw new Error(`${fake} is missing; the seed cannot answer without it`);
  const env = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (key.startsWith("KIN_")) continue;
    if (typeof value === "string" && /(^|\/)claude$/.test(value) && !value.startsWith(fakeDir + path.sep)) continue;
    env[key] = value;
  }
  env.PATH = fakeDir + path.delimiter + (env.PATH || "");
  try {
    const sh = fs.readFileSync(path.join(ROOT, "rsi/runtime/ux-walk.sh"), "utf8");
    const match = sh.match(/^\s*([A-Z0-9_]+)="\$FAKE_AGENT_DIR\/claude"; export \1$/m);
    if (match) env[match[1]] = fake;
  } catch {
    // PATH order is still in place; the seed refuses loudly if it is not enough.
  }
  env.KIN_STATE_DIR = stateDir;
  env.RSI_FAKE_SLOW_SECS = "0";
  return env;
}

async function startDaemon() {
  const port = await freePort();
  if (port === 7777) throw new Error("the OS handed out the live node port; refusing");
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "kin-phone-interaction-"));
  if (insideHomeState(stateDir)) throw new Error(`refusing to use a state directory under ~/.kin: ${stateDir}`);
  const logPath = path.join(stateDir, "daemon.log");
  const out = fs.openSync(logPath, "a");
  const child = spawn(BIN, ["serve", "--port", String(port)], {
    cwd: ROOT,
    env: fakeAgentEnv(stateDir),
    stdio: ["ignore", out, out],
    detached: true,
  });
  fs.closeSync(out);
  child.unref();
  let spawnError = null;
  child.on("error", (error) => {
    spawnError = error;
  });
  const base = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + HEALTH_DEADLINE_MS;
  let ready = false;
  try {
    while (Date.now() < deadline) {
      if (spawnError) guard("daemon-never-healthy", `could not start ${BIN}: ${spawnError.message}`);
      if (child.exitCode !== null || child.signalCode !== null) {
        guard(
          "daemon-never-healthy",
          `the daemon exited (${child.exitCode ?? child.signalCode}) before /api/health` + daemonTail(logPath),
        );
      }
      try {
        const response = await fetch(`${base}/api/health`, { signal: AbortSignal.timeout(1500) });
        if (response.ok) {
          await response.body?.cancel();
          const tokenPath = path.join(stateDir, "token");
          const token = fs.existsSync(tokenPath) ? fs.readFileSync(tokenPath, "utf8").trim() : "";
          if (!token) guard("daemon-never-healthy", "the daemon answered health but wrote no token");
          ready = true;
          return { base, port, stateDir, logPath, token, child };
        }
      } catch (error) {
        if (error instanceof GuardFailure) throw error;
      }
      await sleep(100);
    }
    guard("daemon-never-healthy", `no answer from ${base}/api/health within ${HEALTH_DEADLINE_MS} ms` + daemonTail(logPath));
  } finally {
    // A boot that failed must not leave the daemon (or its state dir) behind:
    // main never receives the handle, so its own cleanup cannot run.
    if (!ready) {
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch {
        // Already gone.
      }
      fs.rmSync(stateDir, { recursive: true, force: true });
    }
  }
}

async function stopDaemon(daemon) {
  if (!daemon) return;
  const { child, stateDir } = daemon;
  if (child.pid) {
    try {
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
  }
  fs.rmSync(stateDir, { recursive: true, force: true });
}

function seedDaemon(daemon) {
  const logPath = path.join(daemon.stateDir, "seed.log");
  const out = fs.openSync(logPath, "a");
  try {
    const result = spawnSync("python3", [path.join(ROOT, "scripts/journeys_seed.py")], {
      env: { ...fakeAgentEnv(daemon.stateDir), KIN_BASE: daemon.base, KIN_TOKEN: daemon.token },
      stdio: ["ignore", out, out],
      timeout: 300_000,
    });
    if (result.status !== 0) {
      const tail = fs.readFileSync(logPath, "utf8").trim().split("\n").slice(-12).join("\n");
      throw new Error(`the seed exited ${result.status}:\n${tail}`);
    }
  } finally {
    fs.closeSync(out);
  }
  const seeded = fs.readFileSync(logPath, "utf8");
  if (!/\[seed\]/.test(seeded)) throw new Error("the seed wrote no [seed] fixtures");
}

/* ------------------------------------------------------------------ */
/* Public HTTP API (seed top-up only)                                 */
/* ------------------------------------------------------------------ */

async function api(daemon, method, apiPath, body) {
  const headers = { Authorization: `Bearer ${daemon.token}`, Accept: "application/json" };
  if (body !== undefined) headers["Content-Type"] = "application/json";
  const response = await fetch(daemon.base + apiPath, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(30_000),
  });
  const text = await response.text();
  let parsed = null;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    parsed = null;
  }
  if (!response.ok) {
    throw new Error(`${method} ${apiPath} -> ${response.status}: ${text.slice(0, 200)}`);
  }
  return parsed;
}

async function listTasks(daemon) {
  const body = await api(daemon, "GET", "/api/tasks");
  return Array.isArray(body) ? body : (body?.tasks ?? []);
}

async function messageCount(daemon, id) {
  const events = await api(daemon, "GET", `/api/tasks/${id}/events`);
  return (Array.isArray(events) ? events : []).filter((event) => event.type === "message").length;
}

async function waitSettled(daemon, id, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const task = await api(daemon, "GET", `/api/tasks/${id}`);
    const state = String(task?.status ?? "");
    if (!["queued", "running", "waiting_approval", "waiting_input"].includes(state)) return state;
    await sleep(100);
  }
  return "timeout";
}

/** A cwd the daemon will accept: the seeded Alpha root, else a fresh temp dir. */
async function seedCwd(daemon) {
  try {
    const projects = await api(daemon, "GET", "/api/projects?status=all");
    const alpha = (Array.isArray(projects) ? projects : []).find((row) => row?.name === "[seed] Project Alpha");
    const root = alpha?.roots?.[0];
    if (root) return root;
  } catch {
    // Fall through to a directory this run owns.
  }
  const dir = path.join(daemon.stateDir, "perf-root");
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

async function topUpRows(daemon) {
  let rows = await listTasks(daemon);
  if (rows.length >= TARGET_ROWS) return rows.length;
  const cwd = await seedCwd(daemon);
  const titles = new Set(rows.map((row) => row.title));
  let made = 0;
  for (let i = 1; made < TARGET_ROWS - rows.length && i <= TARGET_ROWS * 2; i++) {
    const title = `[seed] perf row ${i}`;
    if (titles.has(title)) continue;
    const task = await api(daemon, "POST", "/api/tasks", {
      agent: "claude-code",
      cwd,
      prompt: title,
      title,
      permission_mode: "yolo",
      workspace_mode: "shared",
    });
    if (task?.id) {
      made += 1;
      await waitSettled(daemon, task.id, 15_000).catch(() => {});
    }
  }
  rows = await listTasks(daemon);
  return rows.length;
}

async function topUpTranscript(daemon, id) {
  let messages = await messageCount(daemon, id);
  let sent = 0;
  while (messages < TARGET_MESSAGES && sent < 60) {
    await api(daemon, "POST", `/api/tasks/${id}/prompt`, {
      prompt: `[seed] perf follow-up ${sent + 1}`,
    });
    const state = await waitSettled(daemon, id, 20_000);
    const next = await messageCount(daemon, id);
    if (next <= messages || state === "timeout") break;
    messages = next;
    sent += 1;
  }
  return { messages, sent };
}

/* ------------------------------------------------------------------ */
/* Page instrumentation                                               */
/* ------------------------------------------------------------------ */

/**
 * Runs before any page script. Frame timestamps, long tasks and the typed
 * watchers all live on this document's clock; the runner reads them by window
 * slice. Serialized by Playwright, so it must stay self-contained.
 */
function installProbes() {
  const state = {
    frames: [],
    longtasks: [],
    longtaskSupported: false,
    tap: null,
  };
  window.__kinPerf = state;
  const tick = (at) => {
    state.frames.push(at);
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
  try {
    if (PerformanceObserver.supportedEntryTypes?.includes("longtask")) {
      state.longtaskSupported = true;
      new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
          state.longtasks.push({ startTime: entry.startTime, duration: entry.duration });
        }
      }).observe({ type: "longtask", buffered: true });
    }
  } catch {
    state.longtaskSupported = false;
  }
}

const TOUCH_ID = 7;
const finger = (x, y) => ({ x, y, id: TOUCH_ID, radiusX: 6, radiusY: 6, force: 1 });

async function touch(cdp, type, x, y) {
  await cdp.send("Input.dispatchTouchEvent", {
    type,
    touchPoints: type === "touchEnd" ? [] : [finger(x, y)],
  });
}

async function swipe(cdp, x, fromY, toY, steps = SWIPE_STEPS) {
  await touch(cdp, "touchStart", x, fromY);
  for (let i = 1; i <= steps; i++) {
    await sleep(16);
    await touch(cdp, "touchMove", x, fromY + ((toY - fromY) * i) / steps);
  }
  await touch(cdp, "touchEnd", x, toY);
}

async function tap(cdp, x, y) {
  await touch(cdp, "touchStart", x, y);
  await sleep(30);
  await touch(cdp, "touchEnd", x, y);
}

/** Install a page-side watcher: touchstart -> first frame the selector is visible. */
async function armWatcher(page, selector, deadlineMs) {
  return page.evaluate(
    ({ selector, deadlineMs }) => {
      const state = window.__kinPerf;
      state.tap = { t0: null, t1: null, seen: false, timedOut: false };
      const visible = (el) => {
        if (!el) return false;
        const box = el.getBoundingClientRect();
        const style = getComputedStyle(el);
        return box.width > 0 && box.height > 0 && style.visibility !== "hidden" && style.display !== "none";
      };
      const target = () => {
        if (selector.kind === "selector") return document.querySelector(selector.value);
        if (selector.kind === "messageCount") {
          const list = document.querySelectorAll("[data-message-key]");
          return list.length > selector.count ? list[list.length - 1] : null;
        }
        return null;
      };
      const onTouchStart = () => {
        if (state.tap.t0 !== null) return;
        state.tap.seen = true;
        state.tap.t0 = performance.now();
        const frame = () => {
          if (state.tap.t1 !== null) return;
          if (visible(target())) {
            state.tap.t1 = performance.now();
            return;
          }
          if (performance.now() - state.tap.t0 > deadlineMs) {
            state.tap.timedOut = true;
            return;
          }
          requestAnimationFrame(frame);
        };
        requestAnimationFrame(frame);
      };
      document.addEventListener("touchstart", onTouchStart, { capture: true, once: true });
      return true;
    },
    { selector, deadlineMs },
  );
}

async function readWatcher(page) {
  return page.evaluate(() => {
    const tap = window.__kinPerf?.tap;
    if (!tap) return null;
    return {
      seen: tap.seen,
      timedOut: tap.timedOut,
      duration: tap.t0 !== null && tap.t1 !== null ? tap.t1 - tap.t0 : null,
    };
  });
}

async function waitWatcher(page, timeoutMs = TAP_DEADLINE_MS + 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const state = await readWatcher(page);
    if (state && (state.duration !== null || state.timedOut)) return state;
    await sleep(50);
  }
  return (await readWatcher(page)) || { seen: false, timedOut: true, duration: null };
}

async function sliceWindow(page, t0, t1) {
  return page.evaluate(
    ({ t0, t1 }) => {
      const state = window.__kinPerf || {};
      return {
        frames: (state.frames || []).filter((at) => at >= t0 && at <= t1),
        longtasks: (state.longtasks || []).filter((task) => task.startTime >= t0 && task.startTime <= t1),
        longtaskSupported: Boolean(state.longtaskSupported),
      };
    },
    { t0, t1 },
  );
}

async function now(page) {
  return page.evaluate(() => performance.now());
}

/* ------------------------------------------------------------------ */
/* Page helpers                                                       */
/* ------------------------------------------------------------------ */

async function expandAllFolds(page) {
  return page.evaluate(() => {
    const folds = [...document.querySelectorAll('button[aria-expanded="false"]')].filter((button) =>
      /^(Show all|展开全部)/.test(button.getAttribute("aria-label") || button.textContent || ""),
    );
    for (const button of folds) button.click();
    return folds.length;
  });
}

async function rowCount(page) {
  return page.evaluate(() => document.querySelectorAll("[data-session-row]").length);
}

/** The list's scroller and where a finger can start inside it. */
async function scrollerInfo(page, selector) {
  return page.evaluate((selector) => {
    const anchor = selector ? document.querySelector(selector) : null;
    let el = anchor;
    if (!el) return null;
    while (el && el !== document.body) {
      if (el.scrollHeight > el.clientHeight + 4) break;
      el = el.parentElement;
    }
    if (!el || el === document.body) return null;
    const box = el.getBoundingClientRect();
    return {
      scrollTop: el.scrollTop,
      scrollHeight: el.scrollHeight,
      clientHeight: el.clientHeight,
      top: box.top,
      bottom: box.bottom,
      x: box.x + box.width / 2,
    };
  }, selector);
}

/** Whether a visible error surface is on screen. The console's own refusal. */
async function errorSurface(page) {
  return page.evaluate(() => {
    const visible = (el) => {
      const box = el.getBoundingClientRect();
      const style = getComputedStyle(el);
      return box.width > 0 && box.height > 0 && style.visibility !== "hidden" && style.display !== "none";
    };
    const alerts = [...document.querySelectorAll('[role="alert"], [data-error-surface]')].filter(visible);
    if (!alerts.length) return null;
    const text = (alerts[0].textContent || "").trim().replace(/\s+/g, " ").slice(0, 120);
    return `a visible error surface is on screen: ${text || alerts[0].tagName.toLowerCase()}`;
  });
}

async function servedEntry(page) {
  return page.evaluate(() => {
    const script = document.querySelector('script[type="module"][src*="/assets/index-"]');
    return script ? new URL(script.src).pathname : null;
  });
}

/**
 * The console is usable when #root has left the boot splash and the route has
 * drawn something. A splash that stays is a guard, never a timing sample.
 */
async function waitUsable(page) {
  try {
    await page.waitForFunction(
      () => {
        const root = document.getElementById("root");
        return !!root && !root.querySelector(".kin-boot") && root.children.length > 0;
      },
      null,
      { timeout: USABLE_DEADLINE_MS, polling: "raf" },
    );
  } catch {
    const last = await page
      .evaluate(() => {
        const root = document.getElementById("root");
        if (!root) return "#root is missing";
        if (root.querySelector(".kin-boot")) return "the boot splash is still in #root";
        return "#root has no child";
      })
      .catch(() => "the page could not be read");
    guard("console-never-usable", last);
  }
  const surface = await errorSurface(page);
  if (surface) guard("console-error-surface", surface);
}

function checkServed(entry, expected) {
  if (!entry) return "no /assets/index-*.js script on the served document";
  const served = path.basename(entry);
  if (served !== expected) return `the daemon served ${served}, but web/dist/index.html names ${expected}`;
  return null;
}

/* ------------------------------------------------------------------ */
/* Legs                                                               */
/* ------------------------------------------------------------------ */

async function measureIdle(page) {
  const t0 = await now(page);
  await sleep(1000);
  const t1 = await now(page);
  const window = await sliceWindow(page, t0, t1);
  return frameMetrics(intervalsOf(window.frames), window.longtasks);
}

async function open(page, url) {
  try {
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30_000 });
  } catch (error) {
    guard("console-never-usable", `${url} did not load: ${error.message}`);
  }
  await waitUsable(page);
}

async function measureSessions(page, cdp, expectedEntry) {
  await open(page, `${page.__base}/sessions`);
  const staleDist = checkServed(await servedEntry(page), expectedEntry);
  if (staleDist) guard("stale-dist", staleDist);

  await page
    .locator("[data-session-row]")
    .first()
    .waitFor({ state: "visible", timeout: CONTENT_DEADLINE_MS })
    .catch(() => guard("list-never-rendered", "no [data-session-row] appeared within 30 s"));
  await page.locator("[data-phone-scroll]").first().waitFor({ state: "visible", timeout: 10_000 }).catch(() => {});
  const folds = await expandAllFolds(page);
  if (folds > 0) await page.waitForTimeout(400);

  const before = await scrollerInfo(page, "[data-phone-scroll]");
  if (!before) guard("scroll-did-not-move", "no scrollable [data-phone-scroll] on /sessions");
  const idle = await measureIdle(page);

  const t0 = await now(page);
  for (let i = 0; i < SWIPES; i++) {
    await swipe(cdp, before.x, Math.min(before.bottom - 60, 720), Math.max(before.top + 60, 160));
    await sleep(120);
  }
  await sleep(500);
  const t1 = await now(page);
  const after = await scrollerInfo(page, "[data-phone-scroll]");
  const window = await sliceWindow(page, t0, t1);
  const sample = {
    daemonHealthy: true,
    consoleUsable: true,
    leg: "sessions",
    listRendered: (await rowCount(page)) > 0,
    scrollMoved: Boolean(after && before.scrollTop !== after.scrollTop),
    scrollDetail: after
      ? `scrollTop stayed at ${after.scrollTop} (scrollHeight ${after.scrollHeight}, clientHeight ${after.clientHeight})`
      : "the scroller disappeared after the swipes",
    intervals: intervalsOf(window.frames),
    longtasks: window.longtasks,
    longtaskSupported: window.longtaskSupported,
    idleP50: idle.p50,
  };
  const metrics = runGuards(sample);
  return {
    metrics,
    idle,
    rows: await rowCount(page),
    folds,
    intervals: sample.intervals,
    longtasks: sample.longtasks,
    scrollTop: { before: before.scrollTop, after: after?.scrollTop ?? null },
    scrollHeight: after?.scrollHeight ?? before.scrollHeight,
    clientHeight: after?.clientHeight ?? before.clientHeight,
  };
}

/**
 * From /sessions: tap the seeded Morning planning row with a real touch and
 * stop the clock on the first frame its transcript content is visible.
 */
async function measureTap(page, cdp) {
  await open(page, `${page.__base}/sessions`);
  await page.locator("[data-session-row]").first().waitFor({ state: "visible", timeout: CONTENT_DEADLINE_MS });
  const folds = await expandAllFolds(page);
  if (folds > 0) await page.waitForTimeout(400);
  const row = page.locator("[data-session-row]").filter({ hasText: "[seed] Morning planning" }).first();
  const found = await row.isVisible().catch(() => false);
  if (!found) guard("tap-never-arrived", "the seeded [seed] Morning planning row was not on /sessions");
  await row.scrollIntoViewIfNeeded().catch(() => {});
  const box = await row.boundingBox();
  if (!box) guard("tap-never-arrived", "the seeded row has no measurable box");
  await armWatcher(page, { kind: "selector", value: "[data-conversation-pane] [data-message-key]" }, TAP_DEADLINE_MS);
  await tap(cdp, box.x + box.width / 2, box.y + box.height / 2);
  const watched = await waitWatcher(page);
  const state = {
    daemonHealthy: true,
    consoleUsable: true,
    leg: "tap",
    tapArrived: watched.duration !== null,
    tapDetail: !watched.seen
      ? "no touchstart reached the page"
      : "the tapped document never showed [data-conversation-pane] content",
  };
  runGuards(state);
  return { duration: r1(watched.duration) };
}

/** On the detail page after the tap: open the run-config sheet. */
async function measureSheet(page, cdp) {
  const trigger = page.locator('button[aria-haspopup="dialog"]').last();
  const visible = await trigger.isVisible().catch(() => false);
  if (!visible) return { unmeasured: "the run-config trigger (button[aria-haspopup=dialog]) was not on screen" };
  const box = await trigger.boundingBox();
  if (!box) return { unmeasured: "the run-config trigger had no measurable box" };
  await armWatcher(page, { kind: "selector", value: "[data-kin-sheet]" }, TAP_DEADLINE_MS);
  await tap(cdp, box.x + box.width / 2, box.y + box.height / 2);
  const watched = await waitWatcher(page);
  // Setup: close it again, so the composer leg starts from the same screen.
  await page.keyboard.press("Escape").catch(() => {});
  await page.waitForTimeout(250);
  if (watched.duration === null) {
    return {
      unmeasured: watched.seen
        ? "the run-config sheet was not visible within 15 s of the touch"
        : "no touchstart reached the run-config trigger",
    };
  }
  return { duration: r1(watched.duration) };
}

/** On the detail page: type a probe, tap send, stop on the first new message. */
async function measureComposer(page, cdp, daemon, taskId) {
  const textarea = page.locator("textarea").last();
  const visible = await textarea.isVisible().catch(() => false);
  if (!visible) return { unmeasured: "the composer textarea was not on screen" };
  try {
    await textarea.fill(`[seed] perf composer probe ${Date.now() % 100000}`);
  } catch {
    return { unmeasured: "the composer textarea refused input (disabled or still busy)" };
  }
  await page.waitForTimeout(150);
  const send = page
    .locator("textarea")
    .last()
    .locator("xpath=ancestor::form")
    .locator('button[type="submit"]')
    .last();
  const sendable = await send.isVisible().catch(() => false);
  if (!sendable) return { unmeasured: "the composer's send control was not on screen" };
  const box = await send.boundingBox();
  if (!box) return { unmeasured: "the composer's send control had no measurable box" };
  const count = await page.evaluate(() => document.querySelectorAll("[data-message-key]").length);
  await armWatcher(page, { kind: "messageCount", count }, TAP_DEADLINE_MS);
  await tap(cdp, box.x + box.width / 2, box.y + box.height / 2);
  const watched = await waitWatcher(page);
  // Setup: let the turn settle before the next run opens the same conversation.
  await waitSettled(daemon, taskId, 15_000).catch(() => {});
  if (watched.duration === null) {
    return {
      unmeasured: watched.seen
        ? "no new [data-message-key] appeared within 15 s of the send touch"
        : "no touchstart reached the send control",
    };
  }
  return { duration: r1(watched.duration) };
}

/** Scroll a long transcript from its bottom upward. */
async function measureTranscript(page, cdp, taskId, idleP50) {
  await open(page, `${page.__base}/tasks/${taskId}`);
  await page
    .locator("[data-conversation-pane]")
    .first()
    .waitFor({ state: "visible", timeout: CONTENT_DEADLINE_MS })
    .catch(() => guard("transcript-never-rendered", "no [data-conversation-pane] appeared within 30 s"));
  await page
    .locator("[data-message-key]")
    .first()
    .waitFor({ state: "visible", timeout: CONTENT_DEADLINE_MS })
    .catch(() => guard("transcript-never-rendered", "the conversation showed no message within 30 s"));
  await page.waitForTimeout(600);

  const before = await scrollerInfo(page, "[data-conversation-pane]");
  if (!before) {
    guard("scroll-did-not-move", "the transcript does not scroll: it fits the viewport");
  }
  if (before.scrollHeight <= before.clientHeight + 4) {
    guard(
      "scroll-did-not-move",
      `the transcript fits the viewport (scrollHeight ${before.scrollHeight}, clientHeight ${before.clientHeight})`,
    );
  }
  const messages = await page.evaluate(() => document.querySelectorAll("[data-message-key]").length);
  const t0 = await now(page);
  // Finger moves down: the transcript, already at its newest message, scrolls
  // back toward the start.
  for (let i = 0; i < SWIPES; i++) {
    await swipe(cdp, before.x, Math.min(before.top + 120, 260), Math.min(before.bottom - 60, 760));
    await sleep(120);
  }
  await sleep(500);
  const t1 = await now(page);
  const after = await scrollerInfo(page, "[data-conversation-pane]");
  const window = await sliceWindow(page, t0, t1);
  const sample = {
    daemonHealthy: true,
    consoleUsable: true,
    leg: "transcript",
    transcriptRendered: messages > 0,
    scrollMoved: Boolean(after && before.scrollTop !== after.scrollTop),
    scrollDetail: after
      ? `scrollTop stayed at ${after.scrollTop} (scrollHeight ${after.scrollHeight}, clientHeight ${after.clientHeight})`
      : "the transcript scroller disappeared after the swipes",
    intervals: intervalsOf(window.frames),
    longtasks: window.longtasks,
    longtaskSupported: window.longtaskSupported,
    idleP50,
  };
  const metrics = runGuards(sample);
  return {
    metrics,
    messages,
    intervals: sample.intervals,
    longtasks: sample.longtasks,
    scrollTop: { before: before.scrollTop, after: after?.scrollTop ?? null },
  };
}

/* ------------------------------------------------------------------ */
/* Reporting                                                          */
/* ------------------------------------------------------------------ */

function printReport(doc) {
  say(
    `machine: ${doc.machine.platform} ${doc.machine.release} ${doc.machine.arch}, ` +
      `${doc.machine.cpus} cpus; load average ${doc.machine.loadavg.map((v) => v.toFixed(2)).join(" ")}`,
  );
  say(`browser: ${doc.chrome} (${doc.browserMode})`);
  say(`viewport: ${doc.viewport.width}x${doc.viewport.height} (Chrome, isMobile, hasTouch)`);
  say(`commit: ${doc.commit}`);
  say(`entry chunk: ${doc.entry.path} (${doc.entry.bytes} bytes)`);
  say(
    `seed: rows=${doc.seed.rows}${doc.seed.rows < TARGET_ROWS ? " (short sample)" : ""}  ` +
      `messages=${doc.seed.messages}${doc.seed.messages < TARGET_MESSAGES ? " (short sample)" : ""}  ` +
      `follow-ups=${doc.seed.followUps}`,
  );
  say("");
  for (const run of doc.runsDetail) {
    const sessions = run.sessions;
    const transcript = run.transcript;
    const tapText = Number.isFinite(run.tap?.duration) ? `${run.tap.duration}ms` : "unmeasured";
    say(
      `run ${run.run}  sessions rows=${sessions.rows} frames=${sessions.metrics.frames} ` +
        `p50=${sessions.metrics.p50}ms p90=${sessions.metrics.p90}ms dropped=${sessions.metrics.droppedPct}% ` +
        `longtasks=${sessions.metrics.longTasks}/${sessions.metrics.blockingMs}ms ` +
        `idle-p50=${sessions.idle.p50}ms idle-dropped=${sessions.idle.droppedPct}%  ` +
        `transcript frames=${transcript.metrics.frames} p50=${transcript.metrics.p50}ms ` +
        `p90=${transcript.metrics.p90}ms dropped=${transcript.metrics.droppedPct}% ` +
        `longtasks=${transcript.metrics.longTasks}/${transcript.metrics.blockingMs}ms  tap=${tapText}`,
    );
  }
  say("");
  const pooled = (leg) => {
    const all = doc.runsDetail.flatMap((run) => run[leg].intervals || []);
    const tasks = doc.runsDetail.flatMap((run) => run[leg].longtasks || []);
    return frameMetrics(all, tasks);
  };
  // The per-run metrics are what the JSON carries; the printed headline pools
  // every frame interval of every run, so a single bad run cannot be averaged
  // away by a good one.
  for (const [leg, label] of [
    ["sessions", "/sessions scroll"],
    ["transcript", "/tasks/:id transcript scroll"],
  ]) {
    const metric = pooled(leg);
    say(
      `${label}: frame interval p50 ${metric.p50}ms p90 ${metric.p90}ms · ` +
        `dropped ${metric.droppedPct}% · long tasks ${metric.longTasks} (${metric.blockingMs} ms blocking)`,
    );
  }
  const tapStats = stats(doc.runsDetail.map((run) => run.tap?.duration).filter(Number.isFinite));
  say(
    `tap -> detail: p50 ${tapStats.p50}ms p90 ${tapStats.p90}ms over ${tapStats.n}/${doc.runsDetail.length} runs`,
  );
  for (const [leg, label] of [
    ["sheet", "run-config sheet open"],
    ["composer", "composer send -> bubble"],
  ]) {
    const values = doc.runsDetail.map((run) => run[leg]?.duration).filter(Number.isFinite);
    const reasons = [...new Set(doc.runsDetail.map((run) => run[leg]?.unmeasured).filter(Boolean))];
    if (values.length === 0) {
      say(`${label}: unmeasured: ${reasons.join("; ") || "no run produced a number"}`);
      continue;
    }
    const stat = stats(values);
    say(`${label}: p50 ${stat.p50}ms p90 ${stat.p90}ms over ${stat.n}/${doc.runsDetail.length} runs`);
  }
  say("");
  say("dropped frame = interval > 1.5x the run's median frame interval; p50/p90 are nearest-rank.");
  say("long-task blocking = sum(duration - 50 ms) inside the gesture window.");
  say("idle-p50/idle-dropped is the same page's rAF one second before the gesture: machine noise, not the app.");
  say("The Chrome number is a proxy; a real iPhone WKWebView is the fact this script cannot produce.");
}

function summarizeLeg(runs) {
  const measured = runs.filter((run) => run && run.metrics).map((run) => run.metrics);
  if (measured.length === 0) return { unmeasured: "no run produced a number" };
  return { runs: measured, summary: summarizeRuns(measured) };
}

/* ------------------------------------------------------------------ */
/* Main                                                               */
/* ------------------------------------------------------------------ */

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  JSON_OUT = opts.json;

  if (opts.help) {
    process.stdout.write(
      "usage: node scripts/phone-interaction.mjs [--runs N] [--json] [--headless] [--self-check]\n",
    );
    return;
  }
  if (opts.selfCheckCase) {
    selfCheckCase(opts.selfCheckCase);
    return;
  }
  if (opts.selfCheck) {
    selfCheck();
    return;
  }

  const entryFile = preflightDist();
  if (needsBuild()) buildKin();

  const require = createRequire(import.meta.url);
  let chromium;
  try {
    ({ chromium } = require(
      process.env.PW_CORE || path.join(os.homedir(), ".kin/ux-proto-tools/node_modules/playwright-core"),
    ));
  } catch (error) {
    process.stderr.write(`SKIP: playwright-core missing: ${error.message}\n`);
    process.exit(2);
  }

  let browser;
  try {
    browser = await chromium.launch({
      channel: "chrome",
      headless: opts.headless,
      // Headed keeps the real compositor; --disable-gpu belongs to the
      // headless path only, where it is also why the frame-clock guard exists.
      args: opts.headless ? ["--disable-gpu"] : [],
    });
  } catch (error) {
    process.stderr.write(`SKIP: chrome launch failed: ${error.message}\n`);
    process.exit(2);
  }
  const chromeVersion = await browser.version();
  const browserMode = opts.headless ? "headless" : "headed";

  let daemon = null;
  const runsDetail = [];
  let seedCounts = { rows: 0, messages: 0, followUps: 0 };
  try {
    daemon = await startDaemon();
    say(`daemon: ${daemon.base} (throwaway state ${daemon.stateDir})`);
    seedDaemon(daemon);
    const rows = await topUpRows(daemon);
    let tasks = await listTasks(daemon);
    const morning = tasks.find((task) => task.title === "[seed] Morning planning");
    if (!morning?.id) throw new Error("the seed created no [seed] Morning planning conversation");
    const transcript = await topUpTranscript(daemon, morning.id);
    seedCounts = { rows, messages: transcript.messages, followUps: transcript.sent };
    say(
      `seed top-up: rows=${rows}${rows < TARGET_ROWS ? " (short sample)" : ""} ` +
        `messages=${transcript.messages}${transcript.messages < TARGET_MESSAGES ? " (short sample)" : ""} ` +
        `follow-ups=${transcript.sent}`,
    );

    for (let run = 1; run <= opts.runs; run++) {
      const context = await browser.newContext({
        viewport: VIEWPORT,
        deviceScaleFactor: 1,
        isMobile: true,
        hasTouch: true,
        serviceWorkers: "block",
      });
      // The console authenticates a paired browser from localStorage; without
      // it every route draws the token gate instead of the list. Same door the
      // switch-latency phone leg uses.
      await context.addInitScript((token) => {
        try {
          localStorage.setItem("kin_token", token);
        } catch {
          // A denied storage still leaves the page measurable; the guards see it.
        }
      }, daemon.token);
      const page = await context.newPage();
      page.__base = daemon.base;
      const errors = [];
      page.on("pageerror", (error) => errors.push(`pageerror: ${error.message || error}`));
      page.on("console", (message) => {
        if (message.type() === "error") errors.push(`console.error: ${message.text()}`);
      });
      await page.addInitScript(installProbes);
      const cdp = await context.newCDPSession(page);
      try {
        const sessions = await measureSessions(page, cdp, entryFile.name);
        const tapped = await measureTap(page, cdp);
        const sheet = await measureSheet(page, cdp);
        const composer = await measureComposer(page, cdp, daemon, morning.id);
        const transcriptRun = await measureTranscript(page, cdp, morning.id, sessions.idle.p50);
        runsDetail.push({
          run,
          loadavg: os.loadavg().map((value) => Number(value.toFixed(2))),
          sessions: { ...sessions, run },
          transcript: { ...transcriptRun, run },
          tap: { ...tapped, run },
          sheet: { ...sheet, run },
          composer: { ...composer, run },
          pageErrors: errors.slice(0, 10),
        });
        say(
          `run ${run}/${opts.runs}: sessions p50 ${sessions.metrics.p50}ms dropped ${sessions.metrics.droppedPct}% · ` +
            `transcript p50 ${transcriptRun.metrics.p50}ms dropped ${transcriptRun.metrics.droppedPct}% · ` +
            `tap ${tapped.duration}ms`,
        );
      } finally {
        await context.close().catch(() => {});
      }
    }
  } finally {
    await stopDaemon(daemon);
    daemon = null;
    await browser.close().catch(() => {});
  }

  const doc = {
    generatedAt: new Date().toISOString(),
    commit: spawnSync("git", ["rev-parse", "HEAD"], { cwd: ROOT, encoding: "utf8" }).stdout.trim(),
    machine: {
      platform: os.platform(),
      release: os.release(),
      arch: os.arch(),
      cpus: os.cpus().length,
      loadavg: os.loadavg(),
    },
    chrome: chromeVersion,
    browserMode,
    viewport: VIEWPORT,
    entry: entryFile,
    seed: seedCounts,
    runs: opts.runs,
    runsDetail,
    guards: [],
    legs: {
      sessions: summarizeLeg(runsDetail.map((run) => run.sessions)),
      transcript: summarizeLeg(runsDetail.map((run) => run.transcript)),
    },
    tap: stats(runsDetail.map((run) => run.tap?.duration).filter(Number.isFinite)),
    sheet: stats(runsDetail.map((run) => run.sheet?.duration).filter(Number.isFinite)),
    composer: stats(runsDetail.map((run) => run.composer?.duration).filter(Number.isFinite)),
  };

  if (opts.json) {
    process.stdout.write(`${JSON.stringify(doc, null, 2)}\n`);
    return;
  }
  printReport(doc);
}

main().catch((error) => {
  if (error instanceof GuardFailure) {
    process.stderr.write(`GUARD ${error.guardName}: ${error.detail}\n`);
    process.exit(2);
  }
  process.stderr.write(`FAIL: ${error?.stack || error}\n`);
  process.exit(1);
});
