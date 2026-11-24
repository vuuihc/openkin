#!/usr/bin/env node
/**
 * F4: does one keystroke in the composer move the transcript?
 *
 * Boots a throwaway daemon (temp state dir, OS-chosen port), seeds it with
 * scripts/journeys_seed.py, tops the `[seed] Morning planning` transcript up
 * through the public API, then reads the transcript's `scrollTop` around one
 * real `keyboard.type('x')`.
 *
 * Each run is a fresh browser context (a real reload: no saved place, no draft)
 * so five runs are five separate readings, not five polls of one state.
 *
 * The bar is the walker's own tolerance: a move of more than 48 px in at least
 * three of five runs at either width is red (`rsi/runtime/ux/walk.mjs`,
 * scroll-kept). Everything else is green and reported as measured.
 *
 * Usage:
 *   node scripts/measure-draft-scroll.mjs [--runs 5] [--json]
 *   node scripts/measure-draft-scroll.mjs --kin ./kin   # skip the build
 *
 * Playwright is resolved the way the rest of the repo resolves it: $PW_CORE,
 * else ~/.kin/ux-proto-tools/node_modules/playwright-core. It drives the
 * system Chrome (`channel: "chrome"`). No new dependency.
 *
 * Never touches the live node: the state directory is a fresh mkdtemp outside
 * ~/.kin, and a port of 7777 is refused.
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
const FAKE_AGENT_DIR = path.join(ROOT, "scripts", "journeys_fake_agent");
const SEED = path.join(ROOT, "scripts", "journeys_seed.py");
const HEALTH_DEADLINE_MS = 60_000;
const SETTLE_DEADLINE_MS = 30_000;
const SCROLL_TARGET = 320;
const MOVE_LIMIT = 48;
const READ_DELAY_MS = 250;
const WIDTHS = [
  { name: "1100x760", viewport: { width: 1100, height: 760 }, hasTouch: false },
  { name: "820x1180", viewport: { width: 820, height: 1180 }, hasTouch: true },
];
const TOP_UP = ["F4 turn 1", "F4 turn 2", "F4 turn 3", "F4 turn 4"];
// The fake agent answers "[seed] reading" with a long prose answer and a
// five-row table, so the pinned position is inside real reading content.
const READING_PROMPT = "[seed] reading";

function arg(name, fallback = "") {
  const i = process.argv.indexOf(`--${name}`);
  if (i < 0) return fallback;
  const next = process.argv[i + 1];
  return next && !next.startsWith("--") ? next : "true";
}

const JSON_OUT = process.argv.includes("--json");
const RUNS = Number(arg("runs", "5"));
const KIN_ARG = arg("kin", "");
const SHOT_DIR = arg("shot", "");

function say(line = "") {
  if (JSON_OUT) process.stderr.write(`${line}\n`);
  else process.stdout.write(`${line}\n`);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

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

function fakeAgentEnv(stateDir) {
  const env = { ...process.env, KIN_STATE_DIR: stateDir, RSI_FAKE_SLOW_SECS: "0" };
  env.PATH = `${FAKE_AGENT_DIR}:${env.PATH}`;
  env.KIN_CLAUDE_BIN = path.join(FAKE_AGENT_DIR, "claude");
  return env;
}

function insideHomeState(dir) {
  const home = path.join(os.homedir(), ".kin");
  return dir === home || dir.startsWith(home + path.sep);
}

async function startDaemon() {
  let bin = KIN_ARG;
  let buildDir = "";
  if (!bin) {
    buildDir = fs.mkdtempSync(path.join(os.tmpdir(), "kin-measure-draft-build-"));
    bin = path.join(buildDir, "kin");
    say("building ./kin (throwaway)");
    const build = spawnSync("go", ["build", "-o", bin, "./cmd/kin"], {
      cwd: ROOT,
      stdio: ["ignore", "ignore", "pipe"],
      timeout: 600_000,
    });
    if (build.status !== 0) {
      fs.rmSync(buildDir, { recursive: true, force: true });
      throw new Error(`go build failed: ${build.stderr?.toString().slice(-800) || "no output"}`);
    }
  }
  const port = await freePort();
  if (port === 7777) throw new Error("the OS handed out the live node port; refusing");
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "kin-measure-draft-"));
  if (insideHomeState(stateDir)) throw new Error(`refusing a state directory under ~/.kin: ${stateDir}`);
  const logPath = path.join(stateDir, "daemon.log");
  const out = fs.openSync(logPath, "a");
  const child = spawn(bin, ["serve", "--port", String(port)], {
    cwd: ROOT,
    env: fakeAgentEnv(stateDir),
    stdio: ["ignore", out, out],
    detached: true,
  });
  fs.closeSync(out);
  child.unref();
  const base = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + HEALTH_DEADLINE_MS;
  // A boot that failed must not leave a detached daemon, its state dir or the
  // throwaway build behind: main never receives the handle, so its own
  // cleanup cannot run.
  const discard = () => {
    try {
      if (child.pid) process.kill(-child.pid, "SIGKILL");
    } catch {
      // Already gone.
    }
    fs.rmSync(stateDir, { recursive: true, force: true });
    if (buildDir) fs.rmSync(buildDir, { recursive: true, force: true });
  };
  try {
    while (Date.now() < deadline) {
      if (child.exitCode !== null || child.signalCode !== null) {
        const tail = fs.existsSync(logPath) ? fs.readFileSync(logPath, "utf8").slice(-1200) : "";
        throw new Error(`the daemon exited before /api/health\n${tail}`);
      }
      try {
        const response = await fetch(`${base}/api/health`, { signal: AbortSignal.timeout(1500) });
        if (response.ok) {
          await response.body?.cancel();
          const token = fs.readFileSync(path.join(stateDir, "token"), "utf8").trim();
          if (!token) throw new Error("the daemon answered health but wrote no token");
          return { base, port, stateDir, logPath, token, child, buildDir };
        }
      } catch (error) {
        if (error instanceof Error && /wrote no token/.test(error.message)) throw error;
      }
      await sleep(100);
    }
  } catch (error) {
    discard();
    throw error;
  }
  discard();
  throw new Error(`no answer from ${base}/api/health within ${HEALTH_DEADLINE_MS} ms`);
}

function stopDaemon(daemon) {
  if (!daemon) return;
  try {
    if (daemon.child.pid) process.kill(-daemon.child.pid, "SIGTERM");
  } catch {
    try {
      daemon.child.kill("SIGTERM");
    } catch {
      // Already gone.
    }
  }
  if (daemon.stateDir) fs.rmSync(daemon.stateDir, { recursive: true, force: true });
  if (daemon.buildDir) fs.rmSync(daemon.buildDir, { recursive: true, force: true });
}

function seedDaemon(daemon) {
  const logPath = path.join(daemon.stateDir, "seed.log");
  const out = fs.openSync(logPath, "a");
  try {
    const result = spawnSync("python3", [SEED], {
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
}

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
  if (!response.ok) throw new Error(`${method} ${apiPath} = ${response.status}: ${text.slice(0, 300)}`);
  return text ? JSON.parse(text) : null;
}

async function waitSettled(daemon, id, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const task = await api(daemon, "GET", `/api/tasks/${id}`);
    const status = String(task?.status ?? "");
    if (!["queued", "running", "waiting_approval", "waiting_input"].includes(status)) return status;
    await sleep(100);
  }
  throw new Error(`task ${id} never settled within ${timeoutMs} ms`);
}

async function findMorning(daemon) {
  const body = await api(daemon, "GET", "/api/tasks");
  const rows = Array.isArray(body) ? body : (body?.tasks ?? []);
  const row = rows.find((task) => task?.title === "[seed] Morning planning");
  if (!row?.id) throw new Error("the seed created no [seed] Morning planning conversation");
  return row;
}

async function topUpTranscript(daemon, id) {
  for (const prompt of [...TOP_UP, READING_PROMPT]) {
    await api(daemon, "POST", `/api/tasks/${id}/prompt`, { prompt });
    await waitSettled(daemon, id, SETTLE_DEADLINE_MS);
  }
}

async function measureRun(browser, base, token, width, taskId) {
  const context = await browser.newContext({
    viewport: width.viewport,
    deviceScaleFactor: 1,
    hasTouch: width.hasTouch,
    isMobile: false,
  });
  try {
    await context.addInitScript((t) => {
      try {
        localStorage.setItem("kin_token", t);
      } catch {
        // ignore
      }
    }, token);
    const tab = await context.newPage();
    // The deep link the notification taps use (`/tasks/:id` renders the
    // keep-alive host's detail); the list's collapsed project sections are
    // not part of this measurement.
    await tab.goto(`${base}/tasks/${taskId}`, { waitUntil: "domcontentloaded", timeout: 20_000 });
    // The keep-alive host may hold more than one region (a hidden pane keeps
    // its DOM); the reader's is the visible one.
    const transcript = tab.locator("[role=region][tabindex='-1']:visible").first();
    try {
      await transcript.waitFor({ state: "visible", timeout: 20_000 });
      await transcript.locator("text=F4 turn 4").first().waitFor({ state: "visible", timeout: 20_000 });
      await transcript.locator("text=Tablet reading fixture").first().waitFor({ state: "visible", timeout: 20_000 });
    } catch (error) {
      const text = await tab.locator("body").innerText().catch(() => "<no body>");
      process.stderr.write(`page text at ${tab.url()}:\n${text.slice(0, 1200)}\n`);
      throw error;
    }

    const beforeScroll = await transcript.evaluate((node) => ({
      top: node.scrollTop,
      height: node.scrollHeight,
      client: node.clientHeight,
    }));
    const max = beforeScroll.height - beforeScroll.client;
    if (max < SCROLL_TARGET + 120) {
      throw new Error(
        `the transcript is too short to read at ${SCROLL_TARGET}: max ${Math.round(max)} px at ${width.name}`,
      );
    }
    // Put the reader in the middle of the answer, the way the walker's scroll
    // op does, then let onScroll record the place (250 ms, the brief's wait).
    const afterScroll = await transcript.evaluate((node, y) => {
      node.scrollTop = y;
      return { top: node.scrollTop, height: node.scrollHeight, client: node.clientHeight };
    }, SCROLL_TARGET);
    await tab.waitForTimeout(READ_DELAY_MS);

    const composer = tab.locator("[data-kin-bottom-chrome] textarea").first();
    await composer.waitFor({ state: "visible", timeout: 10_000 });
    await composer.click();
    const focus = await tab.evaluate(() => {
      const active = document.activeElement;
      return active instanceof HTMLTextAreaElement
        ? { tag: "textarea", value: active.value }
        : { tag: active?.tagName?.toLowerCase() ?? null, value: null };
    });

    // One real key, through the browser's own input pipeline.
    await tab.keyboard.type("x");
    const immediate = await transcript.evaluate((node) => node.scrollTop);
    await tab.waitForTimeout(READ_DELAY_MS);
    const delayed = await transcript.evaluate((node) => node.scrollTop);
    const parsed = await tab.evaluate(() => {
      const active = document.activeElement;
      return {
        value: active instanceof HTMLTextAreaElement ? active.value : null,
        tag: active?.tagName?.toLowerCase() ?? null,
      };
    });

    const readings = {
      width: width.name,
      scrollHeight: Math.round(afterScroll.height),
      clientHeight: Math.round(afterScroll.client),
      max: Math.round(max),
      scrolledTo: Math.round(afterScroll.top),
      immediate: Math.round(immediate),
      delayed: Math.round(delayed),
      immediateMove: Math.round(Math.abs(immediate - afterScroll.top)),
      delayedMove: Math.round(Math.abs(delayed - afterScroll.top)),
      focusBeforeType: focus.tag,
      focusAfterType: parsed.tag,
      composerValue: parsed.value,
    };
    return readings;
  } finally {
    await context.close();
  }
}

function verdict(readings) {
  for (const width of WIDTHS) {
    const rows = readings.filter((row) => row.width === width.name);
    const moved = rows.filter((row) => row.immediateMove > MOVE_LIMIT || row.delayedMove > MOVE_LIMIT);
    if (moved.length >= 3) {
      return {
        color: "red",
        reason: `${width.name}: ${moved.length}/${rows.length} runs moved more than ${MOVE_LIMIT} px`,
      };
    }
  }
  return { color: "green", reason: `no width moved more than ${MOVE_LIMIT} px in 3 of ${RUNS} runs` };
}

/**
 * The verdict is the whole answer, so it is provable without a browser: every
 * boundary the bar names gets a synthetic case. `--self-check` runs this and
 * exits nonzero on the first disagreement, which is also what keeps the
 * manifest's mutants honest (`scripts/measure-draft-scroll.mutants.json`).
 */
function selfCheck() {
  const row = (width, immediateMove, delayedMove = 0) => ({ width, immediateMove, delayedMove });
  const five = (width, over, at = 0) => [
    ...Array.from({ length: over }, () => row(width, at, at)),
    ...Array.from({ length: 5 - over }, () => row(width, 0, 0)),
  ];
  const cases = [
    { name: "all ten readings still", rows: [...five("1100x760", 0), ...five("820x1180", 0)], want: "green" },
    { name: "exactly at the 48 px bar", rows: [...five("1100x760", 0, 48), ...five("820x1180", 0)], want: "green" },
    { name: "three of five at 1100 past the bar", rows: [...five("1100x760", 3, 49), ...five("820x1180", 0)], want: "red" },
    { name: "two of five at 1100 past the bar", rows: [...five("1100x760", 2, 49), ...five("820x1180", 0)], want: "green" },
    { name: "three of five at 820 past the bar", rows: [...five("1100x760", 0), ...five("820x1180", 3, 49)], want: "red" },
    { name: "the delayed reading alone convicts", rows: [...Array.from({ length: 3 }, () => row("820x1180", 0, 49)), ...five("1100x760", 0), row("820x1180", 0, 0), row("820x1180", 0, 0)], want: "red" },
  ];
  const failures = [];
  for (const testCase of cases) {
    const got = verdict(testCase.rows);
    if (got.color !== testCase.want) {
      failures.push(`${testCase.name}: want ${testCase.want}, got ${got.color} (${got.reason})`);
    }
    if (testCase.want === "red" && !/1100x760|820x1180/.test(got.reason)) {
      failures.push(`${testCase.name}: a red verdict must name the width that moved`);
    }
  }
  if (failures.length) {
    process.stderr.write(`DRAFT_SCROLL_SELF_CHECK_FAILED\n${failures.join("\n")}\n`);
    return 1;
  }
  process.stdout.write(`DRAFT_SCROLL_SELF_CHECK_OK (${cases.length} cases)\n`);
  return 0;
}

async function main() {
  if (process.argv.includes("--self-check")) {
    process.exitCode = selfCheck();
    return;
  }
  if (!fs.existsSync(SEED)) throw new Error(`missing ${SEED}`);
  if (!fs.existsSync(path.join(FAKE_AGENT_DIR, "claude"))) {
    throw new Error(`missing fake agent at ${FAKE_AGENT_DIR}/claude`);
  }
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

  let daemon = null;
  let browser = null;
  try {
    daemon = await startDaemon();
    say(`daemon: ${daemon.base} (throwaway state ${daemon.stateDir})`);
    seedDaemon(daemon);
    const morning = await findMorning(daemon);
    await topUpTranscript(daemon, morning.id);
    say(`transcript: ${TOP_UP.length + 1} tail turns topped up via the API`);

    browser = await chromium.launch({
      channel: "chrome",
      headless: true,
      args: ["--disable-gpu"],
    });
    const chromeVersion = await browser.version();

    const readings = [];
    for (const width of WIDTHS) {
      for (let run = 1; run <= RUNS; run++) {
        const reading = await measureRun(browser, daemon.base, daemon.token, width, morning.id);
        readings.push(reading);
        say(
          `${reading.width} run ${run}: at ${reading.scrolledTo} -> ${reading.immediate} (+${READ_DELAY_MS}ms ${reading.delayed}); ` +
            `moves ${reading.immediateMove}/${reading.delayedMove} px; ` +
            `scrollHeight ${reading.scrollHeight} clientHeight ${reading.clientHeight}; composer=${JSON.stringify(reading.composerValue)}`,
        );
      }
    }

    if (SHOT_DIR) {
      fs.mkdirSync(SHOT_DIR, { recursive: true });
      const context = await browser.newContext({
        viewport: { width: 820, height: 1180 },
        deviceScaleFactor: 1,
        hasTouch: true,
        isMobile: false,
      });
      try {
        await context.addInitScript((t) => {
          try {
            localStorage.setItem("kin_token", t);
          } catch {
            /* ignore */
          }
        }, daemon.token);
        const tab = await context.newPage();
        await tab.goto(`${daemon.base}/tasks/${morning.id}`, {
          waitUntil: "domcontentloaded",
          timeout: 20_000,
        });
        await tab.locator("text=Tablet reading fixture").first().waitFor({ state: "visible", timeout: 20_000 });
        const transcript = tab.locator("[role=region][tabindex='-1']").first();
        // The shot is evidence of the real reading surface, not of the
        // measurement offset: the long answer's five-row table is at the end.
        await transcript.evaluate((node) => {
          node.scrollTop = node.scrollHeight;
        });
        await tab.waitForTimeout(READ_DELAY_MS);
        await tab.screenshot({ path: path.join(SHOT_DIR, "820x1180-reading.png") });
      } finally {
        await context.close();
      }
    }

    const result = verdict(readings);
    const report = {
      at: new Date().toISOString(),
      chrome: chromeVersion,
      runs: RUNS,
      scrollTarget: SCROLL_TARGET,
      moveLimit: MOVE_LIMIT,
      loadAverage: os.loadavg().map((value) => Math.round(value * 100) / 100),
      readings,
      verdict: result,
    };
    if (JSON_OUT) process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    else {
      say("");
      say(`load average: ${report.loadAverage.join(" ")}`);
      say(`verdict: ${result.color.toUpperCase()} — ${result.reason}`);
    }
  } finally {
    // The daemon is detached and the browser holds an open CDP pipe: without
    // both closes the event loop never drains and the run looks hung after
    // its last reading.
    if (browser) await browser.close().catch(() => {});
    stopDaemon(daemon);
  }
}

main().catch((error) => {
  process.stderr.write(`FAIL: ${error?.stack || error}\n`);
  process.exitCode = 1;
});
