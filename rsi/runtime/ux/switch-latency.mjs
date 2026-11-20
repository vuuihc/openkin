#!/usr/bin/env node
// What an F4 switch costs: click → the destination's own content on screen.
//
//   node switch-latency.mjs [--kin <binary>] [--runs N] [--out DIR]
//                           [--legs mac-chat-to-chat,mac-area-to-area,phone-list-to-chat]
//                           [--break-target] [--break-shell]
//                           [--break-splash] [--break-alert] [--break-blank]
//   node switch-latency.mjs --print DIR/switch-latency.json
//
// Boots its own throwaway daemon (free port, mktemp KIN_STATE_DIR, the
// journey fake agent pinned first), seeds it with scripts/journeys_seed.py,
// and measures three legs separately:
//
//   mac-chat-to-chat  (1100x760)  [seed] Morning planning → [seed] Failed migration
//   mac-area-to-area  (1100x760)  conversations → projects
//   phone-list-to-chat (390x844)  /sessions → [seed] Morning planning
//
// Timing never includes Playwright's round trip: a capture-phase click
// listener records performance.now() into window.__switch.t0 in the page,
// locator.click() dispatches the press, the script waits until the destination
// selector is visible, and t1 is read in a requestAnimationFrame callback on
// the same clock. Duration = t1 − t0. One discarded warm-up per leg, then
// `--runs` measured runs (default 10). p50/p90 are nearest-rank.
//
// Guards fail loudly (exit 2, no number recorded, the guard is printed):
//   (a) destination-never-appeared — the destination's own text never showed,
//       or it was already on screen before the click (switching proved nothing).
//   (b) shell-rebuilt — #root .touch-lg is not the same element before and
//       after; a reload/remount is not a switch.
//   (c) splash-blank-or-error — a boot splash, an empty <main>, or an error
//       surface (visible role=alert) is what is on screen.
// `--break-target` points every destination at #never-appears; `--break-shell`
// reloads the page right after the click. `--break-splash`, `--break-alert` and
// `--break-blank` inject, after the press landed and the destination appeared,
// the boot splash, a visible role=alert error surface, or an emptied <main>.
// Each must exit 2 with its guard.
//
// The daemon is always a throwaway: never ~/.kin, never :7777. Needs
// playwright-core (PW_CORE or ~/.kin/ux-proto-tools) and Google Chrome,
// loaded exactly as rsi/runtime/ux/walk.mjs does. Exit 0 = measured; exit 2 =
// a guard fired or the measurement could not run (UNAVAILABLE).
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { execFileSync, spawn } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import net from 'node:net';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '../../..');
const arg = (k, d) => { const i = process.argv.indexOf('--' + k); return i > 0 ? process.argv[i + 1] : d; };
const flag = (k) => process.argv.includes('--' + k);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------- stats/table
const r1 = (n) => Math.round(n * 10) / 10;
// Nearest-rank: the smallest value whose rank covers the percentile. With 10
// runs p50 is the 5th smallest and p90 the 9th; no interpolation is invented.
const pct = (sorted, p) => sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1))];
function stats(runs) {
  const s = [...runs].sort((a, b) => a - b);
  return { p50: r1(pct(s, 50)), p90: r1(pct(s, 90)), min: r1(s[0]), max: r1(s[s.length - 1]) };
}
function formatTable(doc) {
  const out = [];
  out.push(`switch latency — ${doc.sha} · ${doc.runs} measured runs + 1 warm-up per leg · nearest-rank p50/p90 · ms`);
  out.push('leg                  viewport    p50     p90     min     max');
  const pad = (s, n) => String(s).padEnd(n);
  const num = (s, n) => String(s).padStart(n);
  for (const [name, leg] of Object.entries(doc.legs)) {
    out.push(`${pad(name, 21)}${pad(leg.viewport, 12)}${num(leg.p50, 6)}${num(leg.p90, 8)}${num(leg.min, 8)}${num(leg.max, 8)}`);
  }
  for (const [name, leg] of Object.entries(doc.legs)) {
    out.push(`runs ${name}: ${leg.runs.join(', ')}`);
  }
  out.push(`loadavg before ${doc.loadavgBefore.join(' ')} · after ${doc.loadavgAfter.join(' ')} (1m 5m 15m)`);
  out.push(`entry ${doc.entry} · ${doc.machine.platform} ${doc.machine.release} ${doc.machine.arch} · ${doc.machine.cpus} CPUs · node ${doc.node}`);
  return out.join('\n');
}

// `--print` is the claim check: the document's numbers must be these, and no
// daemon, browser or seed is needed to read them back.
if (arg('print')) {
  const doc = JSON.parse(fs.readFileSync(path.resolve(arg('print')), 'utf8'));
  if (doc.guard) { console.error(`this JSON recorded a guard, not numbers: ${JSON.stringify(doc.guard)}`); process.exit(2); }
  console.log(formatTable(doc));
  process.exit(0);
}

// ---------------------------------------------------------------- failures
class Unavailable extends Error {}
class Guard extends Error {
  constructor(code, name, detail) { super(`${name}: ${detail}`); this.code = code; this.guard = name; this.detail = detail; }
}
const guard = (code, name, detail) => { throw new Guard(code, name, detail); };

// ---------------------------------------------------------------- inputs
const runs = (() => { const n = Number(arg('runs', '10')); return Number.isFinite(n) && n >= 1 ? Math.floor(n) : 10; })();
const WAIT_MS = (() => { const n = Number(arg('wait-ms', '15000')); return Number.isFinite(n) && n > 0 ? n : 15000; })();
const outDir = path.resolve(arg('out', path.join(repo, 'rsi/state/switch-latency')));
const breakTarget = flag('break-target');
const breakShell = flag('break-shell');
const breakSplash = flag('break-splash');
const breakAlert = flag('break-alert');
const breakBlank = flag('break-blank');
const only = (arg('legs', '') || '').split(',').map((s) => s.trim()).filter(Boolean);

const SHA = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim();
function entryChunk() {
  const html = path.join(repo, 'web/dist/index.html');
  const text = fs.readFileSync(html, 'utf8');
  const m = text.match(/<script[^>]+src="([^"]*\/assets\/[^"]+\.js)"/);
  if (!m) throw new Unavailable(`${html} names no hashed entry chunk; run the ui build`);
  return m[1];
}
const ENTRY = entryChunk();

// ---------------------------------------------------------------- daemon boot
function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => { const p = srv.address().port; srv.close(() => resolve(p)); });
  });
}
function tail(file, bytes = 600) {
  try { return fs.readFileSync(file, 'utf8').slice(-bytes).replace(/\s+/g, ' ').trim(); } catch { return ''; }
}
// The fake agent's env. PATH order is one half of the pin; an inherited
// absolute override pointing at a real CLI is the other half, and the daemon
// honours an override ahead of PATH (see ux-walk.sh). Drop any inherited
// `claude` pin outside the fake directory, then pin the fake the same way the
// walk runner does — the override's name is read from that runner so the two
// cannot drift.
function fakeAgentEnv(stateDir) {
  const fakeDir = path.join(repo, 'scripts/journeys_fake_agent');
  const fake = path.join(fakeDir, 'claude');
  if (!fs.existsSync(fake)) throw new Unavailable(`${fake} is missing; the seed cannot answer without the journey fake agent`);
  const env = { ...process.env };
  for (const k of Object.keys(env)) {
    const v = env[k];
    if (typeof v === 'string' && /(^|\/)claude$/.test(v) && !v.startsWith(fakeDir + path.sep)) delete env[k];
  }
  env.PATH = fakeDir + path.delimiter + (env.PATH || '');
  try {
    const sh = fs.readFileSync(path.join(repo, 'rsi/runtime/ux-walk.sh'), 'utf8');
    const m = sh.match(/^\s*([A-Z0-9_]+)="\$FAKE_AGENT_DIR\/claude"; export \1$/m);
    if (m) env[m[1]] = fake;
  } catch { /* PATH order is still in place; the seed refuses loudly if it is not enough */ }
  env.KIN_STATE_DIR = stateDir;
  return env;
}
async function startDaemon(kinBin, tmp) {
  const stateDir = path.join(tmp, 'state');
  fs.mkdirSync(stateDir, { recursive: true });
  const port = await freePort();
  if (port === 7777) throw new Unavailable('the OS handed out the live node port; refusing');
  const log = path.join(tmp, 'daemon.log');
  const out = fs.openSync(log, 'a');
  const child = spawn(kinBin, ['serve', '--port', String(port)], {
    env: fakeAgentEnv(stateDir), stdio: ['ignore', out, out],
  });
  fs.closeSync(out);
  const base = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 60000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Unavailable(`daemon exited (${child.exitCode}): ${tail(log)}`);
    try {
      const res = await fetch(base + '/api/health', { signal: AbortSignal.timeout(2000) });
      if (res.ok) {
        const token = fs.readFileSync(path.join(stateDir, 'token'), 'utf8').trim();
        if (!token) throw new Unavailable('daemon answered health but wrote no token');
        return { child, port, base, token, stateDir, log };
      }
    } catch (e) { if (e instanceof Unavailable) throw e; }
    await sleep(200);
  }
  child.kill('SIGKILL');
  throw new Unavailable(`daemon did not answer /api/health in 60s: ${tail(log)}`);
}
function seedDaemon(d, tmp) {
  const log = path.join(tmp, 'seed.log');
  const out = fs.openSync(log, 'a');
  try {
    execFileSync('python3', [path.join(repo, 'scripts/journeys_seed.py')], {
      env: { ...fakeAgentEnv(d.stateDir), KIN_BASE: d.base, KIN_TOKEN: d.token },
      stdio: ['ignore', out, out], timeout: 300000,
    });
  } catch (e) {
    throw new Unavailable(`seed failed: ${tail(log)}`);
  } finally { fs.closeSync(out); }
  const seeded = tail(log, 4000);
  if (!/\[seed\]/.test(seeded)) throw new Unavailable(`seed wrote no [seed] fixtures: ${seeded.slice(-400)}`);
  return log;
}
// `--kin` wins. Without it, build here: the daemon embeds web/dist, so build
// the console first when its assets are absent, then the binary.
function resolveBinary(tmp) {
  const given = arg('kin', '');
  if (given) {
    const abs = path.resolve(given);
    if (!fs.existsSync(abs)) throw new Unavailable(`--kin ${abs} does not exist`);
    return abs;
  }
  if (!fs.existsSync(path.join(repo, 'web/dist/assets'))) {
    console.error('switch-latency: web/dist/assets is absent; building the console');
    execFileSync('npm', ['run', 'build'], { cwd: path.join(repo, 'ui'), stdio: 'inherit' });
  }
  const bin = path.join(tmp, 'kin');
  execFileSync('go', ['build', '-o', bin, './cmd/kin'], { cwd: repo, stdio: 'inherit' });
  return bin;
}

// ---------------------------------------------------------------- legs
const MORNING = "[role=region][tabindex='-1']:has-text('[seed] change: summarise the three things worth doing today.')";
const MORNING_ROW = "[data-session-row]:has-text('[seed] Morning planning')";

async function visibleNow(page, sel) {
  return page.locator(sel).first().isVisible().catch(() => false);
}
async function waitVisible(page, sel, timeout = WAIT_MS) {
  await page.locator(sel).first().waitFor({ state: 'visible', timeout });
}
// All destination selectors must be visible. The honest content gate is the
// last one listed per leg; the earlier ones are the destination's own state.
async function waitDestination(page, sels) {
  for (const sel of sels) {
    try { await waitVisible(page, sel); } catch { return false; }
  }
  return true;
}
async function allVisibleNow(page, sels) {
  for (const sel of sels) if (!(await visibleNow(page, sel))) return false;
  return true;
}

const LEGS = [
  {
    name: 'mac-chat-to-chat',
    viewport: '1100x760',
    width: 1100, height: 760, phone: false,
    click: "[data-session-row]:has-text('[seed] Failed migration')",
    destination: ["[role=region][tabindex='-1']:has-text('[seed] fail: explain why the migration stopped.')"],
    async prepare(page, base) {
      await page.goto(base + '/sessions');
      await waitVisible(page, '[data-session-row]');
      await openMorning(page);
    },
    async reset(page) { await openMorning(page); },
  },
  {
    name: 'mac-area-to-area',
    viewport: '1100x760',
    width: 1100, height: 760, phone: false,
    click: '[data-area="projects"]',
    destination: ['[data-projects-list]', '[data-area="projects"][aria-current="page"]'],
    async prepare(page, base) {
      await page.goto(base + '/sessions');
      await waitVisible(page, '[data-session-row]');
      await toConversations(page);
    },
    async reset(page) { await toConversations(page); },
  },
  {
    name: 'phone-list-to-chat',
    viewport: '390x844',
    width: 390, height: 844, phone: true,
    click: MORNING_ROW,
    destination: [MORNING],
    async prepare(page, base) {
      await page.goto(base + '/sessions');
      await waitVisible(page, 'input[type=search]');
      await ensureMorningRow(page);
    },
    async reset(page) { await backToList(page); await ensureMorningRow(page); },
  },
];

// The Mac start state: the seeded Morning planning transcript, with its first
// answer on screen. At most one click away from any measured destination.
async function openMorning(page) {
  if (await visibleNow(page, MORNING)) return;
  const row = page.locator(MORNING_ROW).first();
  await row.waitFor({ state: 'visible', timeout: WAIT_MS });
  await row.click();
  await waitVisible(page, MORNING);
}
async function toConversations(page) {
  if (await visibleNow(page, '[data-projects-list]')) {
    await page.locator('[data-area="conversations"]').first().click();
    await page.locator('[data-projects-list]').first().waitFor({ state: 'hidden', timeout: WAIT_MS });
  }
  await waitVisible(page, '[data-area="conversations"][aria-current="page"]');
}
// J11's rule: on a phone the seeded row can sit past the five a project bucket
// draws, so press the bucket's own fold when it is on screen. Setup, not the
// measured press.
async function ensureMorningRow(page) {
  const row = page.locator(MORNING_ROW).first();
  if (await row.isVisible().catch(() => false)) return;
  const fold = page
    .locator("section:has-text('[seed] Project Alpha'):not(:has(section)) button[aria-label^='展开全部'], section:has-text('[seed] Project Alpha'):not(:has(section)) button[aria-label^='Show all']")
    .first();
  if (await fold.isVisible().catch(() => false)) await fold.click();
  await row.waitFor({ state: 'visible', timeout: WAIT_MS });
}
// The app's own Back control, never page.goto. The conversation header draws
// it with `tr("app.back")` = 返回 / Back; the search field is the list's own.
async function backToList(page) {
  if (await visibleNow(page, 'input[type=search]')) return;
  const back = page.locator("header button[aria-label='返回'], header button[aria-label='Back']").first();
  await back.waitFor({ state: 'visible', timeout: WAIT_MS });
  await back.click();
  await waitVisible(page, 'input[type=search]');
}

// ---------------------------------------------------------------- one attempt
// The measured press. Throws Guard; never returns a number a guard should have
// stopped. Evaluated in this order because a rebuilt shell explains a missing
// destination, while a missing destination with an intact shell is a dead tap.
async function measureOnce(page, leg, destination) {
  if (await allVisibleNow(page, destination)) {
    guard('a', 'destination-never-appeared', 'the destination was already on screen before the click, so the press proved nothing');
  }
  const marked = await page.evaluate(() => {
    const shell = document.querySelector('#root .touch-lg');
    if (!shell) return false;
    window.__switchShell = shell;
    window.__switch = { t0: null, clicks: 0 };
    document.addEventListener('click', function once() {
      if (window.__switch.t0 === null) window.__switch.t0 = performance.now();
      window.__switch.clicks += 1;
    }, { capture: true, once: true });
    return true;
  });
  if (!marked) guard('b', 'shell-rebuilt', 'there is no #root .touch-lg to mark before the click');

  await page.locator(leg.click).first().click();
  if (breakShell) await page.reload({ waitUntil: 'domcontentloaded' });

  const appeared = await waitDestination(page, destination);
  // t1 is the next animation frame after the destination is visible, on the
  // page's clock. It therefore includes the wait's detection lag and at most
  // one frame; the method's honest upper bound.
  const t1 = appeared
    ? await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => resolve(performance.now()))))
    : null;
  const state = await page.evaluate(() => {
    const now = document.querySelector('#root .touch-lg');
    return {
      t0: window.__switch ? window.__switch.t0 : null,
      clicks: window.__switch ? window.__switch.clicks : 0,
      hadShell: !!window.__switchShell,
      sameShell: !!window.__switchShell && window.__switchShell === now,
      shellNow: !!now,
    };
  }).catch(() => ({ t0: null, clicks: 0, hadShell: false, sameShell: false, shellNow: false }));

  if (!state.shellNow || !state.hadShell || !state.sameShell) {
    guard('b', 'shell-rebuilt', 'the #root .touch-lg element is not the one that was on screen before the click');
  }
  if (!appeared) {
    guard('a', 'destination-never-appeared', `the destination never became visible within ${WAIT_MS}ms: ${destination.join(' + ')}`);
  }
  if (state.t0 === null || state.clicks === 0) {
    guard('a', 'click-never-landed', 'the press never reached the page, so there is no start instant to measure from');
  }
  // The committed way to red guard (c). The injection waits until the press
  // landed and its destination appeared, so guards (a) and (b) cannot answer
  // first; it runs after t1 and the shell check, so it can never change a
  // number or be mistaken for a rebuilt shell.
  if (breakSplash || breakAlert || breakBlank) {
    await page.evaluate((kind) => {
      if (kind === 'splash') {
        const el = document.createElement('div');
        el.className = 'kin-boot';
        el.textContent = 'injected boot splash (--break-splash)';
        document.querySelector('#root').appendChild(el);
      } else if (kind === 'alert') {
        const el = document.createElement('div');
        el.setAttribute('role', 'alert');
        el.textContent = 'injected error surface (--break-alert)';
        document.body.appendChild(el);
      } else {
        const main = document.querySelector('main');
        if (main) main.replaceChildren();
      }
    }, breakSplash ? 'splash' : breakAlert ? 'alert' : 'blank');
  }
  const surface = await page.evaluate(() => {
    const vis = (el) => !!el && el.getClientRects().length > 0;
    const main = document.querySelector('main');
    const alert = Array.from(document.querySelectorAll('[role=alert]')).find(vis);
    return {
      splash: vis(document.querySelector('#root .kin-boot')),
      mainBlank: !main || (main.innerText || '').replace(/\s+/g, ' ').trim() === '',
      alert: alert ? (alert.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 140) : '',
    };
  });
  if (surface.splash) guard('c', 'splash-blank-or-error', 'the boot splash is still the surface on screen');
  if (surface.mainBlank) guard('c', 'splash-blank-or-error', 'the main surface is blank');
  if (surface.alert) guard('c', 'splash-blank-or-error', `an error surface is on screen: ${surface.alert}`);

  return { ms: t1 - state.t0, t0: state.t0, t1 };
}

// ---------------------------------------------------------------- main
async function main() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-switch-'));
  let daemon = null, browser = null;
  const doc = {
    schema: 1,
    startedAt: new Date().toISOString(),
    sha: SHA,
    entry: ENTRY,
    runs,
    warmup: 1,
    machine: { platform: os.platform(), release: os.release(), arch: os.arch(), cpus: os.cpus().length },
    node: process.version,
    loadavgBefore: os.loadavg().map(r1),
    loadavgAfter: null,
    legs: {},
    guard: null,
  };
  try {
    const require = createRequire(import.meta.url);
    let chromium;
    try {
      ({ chromium } = require(process.env.PW_CORE || path.join(process.env.HOME, '.kin/ux-proto-tools/node_modules/playwright-core')));
    } catch (e) { throw new Unavailable('playwright-core missing: ' + e.message); }

    const kinBin = resolveBinary(tmp);
    daemon = await startDaemon(kinBin, tmp);
    const seedLog = seedDaemon(daemon, tmp);
    console.error(`switch-latency: daemon on :${daemon.port}, seed ${seedLog}`);

    try { browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--disable-gpu'] }); }
    catch (e) { throw new Unavailable('chrome launch failed: ' + e.message); }

    const legs = only.length ? LEGS.filter((l) => only.includes(l.name)) : LEGS;
    if (!legs.length) throw new Unavailable(`no such leg: ${only.join(', ')} (want ${LEGS.map((l) => l.name).join(', ')})`);

    for (const leg of legs) {
      const ctx = await browser.newContext({
        viewport: { width: leg.width, height: leg.height },
        deviceScaleFactor: leg.phone ? 2 : 1,
        isMobile: leg.phone, hasTouch: leg.phone,
      });
      await ctx.addInitScript((t) => { try { localStorage.setItem('kin_token', t); } catch (_) {} }, daemon.token);
      const page = await ctx.newPage();
      page.on('pageerror', (e) => console.error(`[${leg.name}] pageerror: ${String(e.message).slice(0, 200)}`));
      const destination = breakTarget ? ['#never-appears'] : leg.destination;
      try {
        await leg.prepare(page, daemon.base);
        // One discarded warm-up per leg: first click after a cold render pays
        // for work every later click does not, and it is not a switch cost.
        const warm = await measureOnce(page, leg, destination);
        console.error(`switch-latency: ${leg.name} warm-up ${r1(warm.ms)}ms (discarded)`);
        const times = [];
        for (let i = 0; i < runs; i++) {
          await leg.reset(page);
          const got = await measureOnce(page, leg, destination);
          times.push(r1(got.ms));
        }
        doc.legs[leg.name] = { viewport: leg.viewport, click: leg.click, destination: leg.destination.join(' + '), warmup: r1(warm.ms), runs: times, ...stats(times) };
      } finally { await ctx.close(); }
    }
    doc.loadavgAfter = os.loadavg().map(r1);
    fs.mkdirSync(outDir, { recursive: true });
    const file = path.join(outDir, 'switch-latency.json');
    fs.writeFileSync(file, JSON.stringify(doc, null, 2) + '\n');
    console.log(formatTable(doc));
    console.log(`json ${file}`);
    return 0;
  } catch (e) {
    if (e instanceof Guard) {
      doc.guard = { code: e.code, name: e.guard, detail: e.detail };
      doc.legs = {};
      doc.loadavgAfter = os.loadavg().map(r1);
      fs.mkdirSync(outDir, { recursive: true });
      const file = path.join(outDir, 'switch-latency.json');
      fs.writeFileSync(file, JSON.stringify(doc, null, 2) + '\n');
      console.error(`GUARD (${e.code}) ${e.guard}: ${e.detail}`);
      console.error(`no number recorded; json ${file}`);
      return 2;
    }
    if (e instanceof Unavailable) { console.error(`UNAVAILABLE: ${e.message}`); return 2; }
    console.error(`UNAVAILABLE: ${e && e.stack ? e.stack : e}`);
    return 2;
  } finally {
    try { if (browser) await browser.close(); } catch (_) {}
    try { if (daemon && daemon.child.exitCode === null) daemon.child.kill('SIGKILL'); } catch (_) {}
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) {}
  }
}
process.exit(await main());
