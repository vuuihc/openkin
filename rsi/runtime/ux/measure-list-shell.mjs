#!/usr/bin/env node
// What the 768–1023 conversation list costs the project name at its real
// 304px width now that the 44px coarse floor is shipped over the whole iPad
// band (KIN-CONTINUE-007 item 5 / D4, 2026-11-24) — and whether repeating that
// floor as an unlayered control moves anything.
//
//   node measure-list-shell.mjs [--kin <binary>] [--json] [--out DIR]
//                               [--shots DIR] [--viewports all|820x1180,…]
//   node measure-list-shell.mjs --self-test
//
// Boots its own throwaway daemon (free port, mktemp KIN_STATE_DIR, the journey
// fake agent pinned first), seeds it with scripts/journeys_seed.py, and opens
// /sessions at each viewport in one headless Chrome. At every viewport it
// records, from the rendered page:
//
//   · the list column's width (`[data-kin-list-column] aside.w-list`);
//   · the project header's inline controls and their boxes;
//   · the truncating project-name element's width as shipped;
//   · the same name width with the shipped `.touch-lg` floor repeated at
//     runtime as an unlayered control.
//
// The injection is a control, never a proposal: it repeats the shipped
// selectors at the shipped arms, over one page, and it is removed before the
// next reading. Nothing here writes to the repository. A non-zero delta means
// a utility opts one control out of the layered floor, or that the tool and
// the stylesheet disagree; the shipped columns are the reading that counts.
//
// The shipped reading answers "does the floor crush the name at 304px". A
// viewport whose rows did not render is reported as unmeasured and exits 2 —
// no number is interpolated (Watch 79).
//
// Needs playwright-core (PW_CORE or ~/.kin/ux-proto-tools) and Google Chrome,
// loaded exactly as rsi/runtime/ux/switch-latency.mjs and walk.mjs do. Exit 0 =
// every requested viewport measured; exit 2 = a guard fired or the measurement
// could not run (UNAVAILABLE). It is a tool, not a suite: it is deliberately
// not wired into scripts/check.sh and CI never launches a browser for it.
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
const r1 = (n) => Math.round(n * 10) / 10;

class Unavailable extends Error {}
const unavail = (m) => { throw new Unavailable(m); };

// Playwright's default timeout does not cover `page.evaluate` or a screenshot.
// Every await on the page gets its own bound shorter than the run's, so a
// wedged renderer reports "no verdict" instead of holding the tool forever.
function bounded(promise, ms, what) {
  let timer;
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Unavailable(`${what} did not finish in ${ms}ms`)), ms);
  });
  return Promise.race([promise, deadline]).finally(() => clearTimeout(timer));
}

// ---------------------------------------------------------------- the injection
// The shipped rule is ui/src/index.css's `.touch-lg` block: since
// KIN-CONTINUE-007 item 5 (D4, 2026-11-24) the floor applies at
// `max-width: 639.98px` and to a coarse pointer up to `1023.98px`, so it
// already covers the whole 768–1023 band. The instrument below repeats those
// selectors at the same arms as an unlayered control: it must not move a
// control the layered rule governs, and where it does move one, a utility is
// opting that control out. No other declaration changes.
const SHIPPED_WIDTH_ARM = 639.98;
const SHIPPED_FLOOR_ARM = 1023.98;
const CONTROL_FLOOR_ARM = 1023.98;
// The same query the stylesheet ships, built from the constants so the reading
// cannot drift from the arms `--self-test` checks against index.css.
const SHIPPED_FLOOR_QUERY = `(max-width: ${SHIPPED_WIDTH_ARM}px), ((pointer: coarse) and (max-width: ${SHIPPED_FLOOR_ARM}px))`;
const INJECTED_FLOOR_CSS = `@media (max-width: ${SHIPPED_WIDTH_ARM}px), ((pointer: coarse) and (max-width: ${CONTROL_FLOOR_ARM}px)) {
  .touch-lg button:not([data-touch-mini]),
  .touch-lg select,
  .touch-lg [role="button"],
  .touch-lg input:not([type="checkbox"]):not([type="radio"]) {
    min-height: 44px;
    min-width: 44px;
  }
  .touch-lg label:has(input[type="radio"]),
  .touch-lg label:has(input[type="checkbox"]) {
    min-height: 44px;
  }
}`;

// ---------------------------------------------------------------- viewports
// All deviceScaleFactor 1: CSS pixels are the units the design is written in.
// `phone` is an anchor, not a target — the floor already applies there — and
// it is only run under `--viewports all` (the screenshot pass uses it).
const VIEWPORTS = [
  { name: '820x1180', width: 820, height: 1180, hasTouch: true, isMobile: false },
  { name: '768x1024', width: 768, height: 1024, hasTouch: true, isMobile: false },
  { name: '1023x768', width: 1023, height: 768, hasTouch: true, isMobile: false },
  { name: '1100x760', width: 1100, height: 760, hasTouch: false, isMobile: false },
  { name: '390x844', width: 390, height: 844, hasTouch: true, isMobile: true, phone: true },
];
function requestedViewports() {
  const given = arg('viewports', '');
  if (!given) return VIEWPORTS.filter((v) => !v.phone);
  if (given === 'all') return VIEWPORTS;
  const want = given.split(',').map((s) => s.trim()).filter(Boolean);
  const found = want.map((n) => {
    const vp = VIEWPORTS.find((v) => v.name === n);
    if (!vp) unavail(`no such viewport: ${n} (want ${VIEWPORTS.map((v) => v.name).join(', ')})`);
    return vp;
  });
  return found;
}

// ---------------------------------------------------------------- self-test
// The mutant seam: the repeat is only a control if it repeats the arm the
// stylesheet actually ships. If it drifts back to the old 767.98px, the iPad
// band is never reached and every reading there is of a page the CSS does not
// describe, so fail before a browser is launched.
function selfTest() {
  const fail = (m) => { console.error(`SELF_TEST_FAIL: ${m}`); process.exit(1); };
  if (CONTROL_FLOOR_ARM !== SHIPPED_FLOOR_ARM) fail(`the control arm ${CONTROL_FLOOR_ARM} does not repeat the shipped ${SHIPPED_FLOOR_ARM}`);
  for (const decl of ['.touch-lg button:not([data-touch-mini])', 'min-width: 44px', 'min-height: 44px', '[role="button"]', 'label:has(input[type="radio"])']) {
    if (!INJECTED_FLOOR_CSS.includes(decl)) fail(`the injected floor lost ${decl}`);
  }
  const css = fs.readFileSync(path.join(repo, 'ui/src/index.css'), 'utf8');
  // Read the arms off the `.touch-lg` rule itself: `.touch-hide` carries the
  // same query text further down, so matching the first media query would let
  // the two blocks drift apart unnoticed.
  const selectorAt = css.indexOf('.touch-lg button:not([data-touch-mini])');
  if (selectorAt < 0) fail('the shipped .touch-lg selectors are gone');
  const mediaAt = css.lastIndexOf('@media ', selectorAt);
  const query = mediaAt < 0 ? '' : css.slice(mediaAt, css.indexOf('{', mediaAt));
  const widthArm = query.match(/^@media \(max-width: ([0-9.]+)px\)/);
  const coarseArm = query.match(/\(pointer: coarse\) and \(max-width: ([0-9.]+)px\)/);
  if (!widthArm || !coarseArm) fail(`the .touch-lg floor has no width/coarse arm pair: ${query.trim()}`);
  if (Number(widthArm[1]) !== SHIPPED_WIDTH_ARM) fail(`the width arm is ${widthArm[1]}px, the tool assumes ${SHIPPED_WIDTH_ARM}px`);
  if (Number(coarseArm[1]) !== SHIPPED_FLOOR_ARM) fail(`shipped arm is ${coarseArm[1]}px, the tool assumes ${SHIPPED_FLOOR_ARM}px`);
  console.log(`SELF_TEST_OK: the injected control repeats the shipped selectors at the shipped ${SHIPPED_WIDTH_ARM}px / coarse ${SHIPPED_FLOOR_ARM}px arms`);
}

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
// Copied in shape from switch-latency.mjs / ux-walk.sh: drop an inherited
// absolute `claude` override, pin the fake agent on PATH, and export the
// override name the walk runner uses (read from that runner so the two cannot
// drift). The seed refuses to create anything when this resolution is wrong.
function fakeAgentEnv(stateDir) {
  const fakeDir = path.join(repo, 'scripts/journeys_fake_agent');
  const fake = path.join(fakeDir, 'claude');
  if (!fs.existsSync(fake)) unavail(`${fake} is missing; the seed cannot answer without the journey fake agent`);
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
  if (port === 7777) unavail('the OS handed out the live node port; refusing');
  const log = path.join(tmp, 'daemon.log');
  const out = fs.openSync(log, 'a');
  const child = spawn(kinBin, ['serve', '--port', String(port)], {
    env: fakeAgentEnv(stateDir), stdio: ['ignore', out, out],
  });
  fs.closeSync(out);
  const base = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 60000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) unavail(`daemon exited (${child.exitCode}): ${tail(log)}`);
    try {
      const res = await fetch(base + '/api/health', { signal: AbortSignal.timeout(2000) });
      if (res.ok) {
        const token = fs.readFileSync(path.join(stateDir, 'token'), 'utf8').trim();
        if (!token) unavail('daemon answered health but wrote no token');
        return { child, port, base, token, stateDir, log };
      }
    } catch (e) { if (e instanceof Unavailable) throw e; }
    await sleep(200);
  }
  child.kill('SIGKILL');
  unavail(`daemon did not answer /api/health in 60s: ${tail(log)}`);
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
    unavail(`seed failed: ${tail(log)}`);
  } finally { fs.closeSync(out); }
  const seeded = tail(log, 4000);
  if (!/\[seed\]/.test(seeded)) unavail(`seed wrote no [seed] fixtures: ${seeded.slice(-400)}`);
  return log;
}
// `--kin` wins. Without it, build here: the daemon embeds web/dist, so build
// the console first when its assets are absent, then the binary.
function resolveBinary(tmp) {
  const given = arg('kin', '');
  if (given) {
    const abs = path.resolve(given);
    if (!fs.existsSync(abs)) unavail(`--kin ${abs} does not exist`);
    return abs;
  }
  if (!fs.existsSync(path.join(repo, 'web/dist/assets'))) {
    console.error('measure-list-shell: web/dist/assets is absent; building the console');
    execFileSync('npm', ['run', 'build'], { cwd: path.join(repo, 'ui'), stdio: 'inherit', timeout: 600000 });
  }
  const bin = path.join(tmp, 'kin');
  execFileSync('go', ['build', '-o', bin, './cmd/kin'], { cwd: repo, stdio: 'inherit', timeout: 600000 });
  return bin;
}

// ---------------------------------------------------------------- in-page read
// Runs in the page. Returns plain numbers only; every selector is resolved
// here so the caller never depends on a page handle surviving a style change.
function readPage(floorQuery) {
  const box = (el) => {
    const r = el.getBoundingClientRect();
    return { x: Math.round(r.x * 10) / 10, y: Math.round(r.y * 10) / 10, w: Math.round(r.width * 10) / 10, h: Math.round(r.height * 10) / 10 };
  };
  const shown = (el) => {
    const r = el.getBoundingClientRect();
    const s = getComputedStyle(el);
    return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none' && s.opacity !== '0';
  };
  const CONTROL = 'button, [role="button"], select, input:not([type="checkbox"]):not([type="radio"]):not([type="range"]):not([type="file"]):not([type="color"]):not([type="hidden"])';
  const FLOOR = '.touch-lg button:not([data-touch-mini]), .touch-lg select, .touch-lg [role="button"], .touch-lg input:not([type="checkbox"]):not([type="radio"])';
  const controlsIn = (scope, labelOf) => Array.from(scope.querySelectorAll(CONTROL))
    .filter(shown)
    .map((el) => {
      const cs = getComputedStyle(el);
      return {
        label: labelOf(el),
        w: box(el).w,
        h: box(el).h,
        absolute: cs.position === 'absolute' || cs.position === 'fixed',
        minWidth: cs.minWidth,
        minHeight: cs.minHeight,
        // Whether the `.touch-lg` floor's selector actually reaches this
        // control. Without this, "the injected rule changed nothing" could be
        // true because the rule never applied — a vacuous reading.
        floorMatches: el.matches(FLOOR),
      };
    });
  const nameOf = (el) => (el.getAttribute('aria-label') || el.getAttribute('title') || (el.textContent || '').trim().replace(/\s+/g, ' ')).slice(0, 60);

  const column = document.querySelector('[data-kin-list-column] aside');
  if (!column) return { error: 'the list column ([data-kin-list-column] aside) is not on the page' };

  // The project header: the heading button carries the project name as its
  // aria-label, and its parent is the line that owns the chevron, the heading
  // and the coarse-pointer project menu. The fold chevron's aria-label also
  // spells the project name, so the name element is what identifies the
  // heading button rather than the label alone.
  const heading = Array.from(document.querySelectorAll('button[aria-label]'))
    .find((b) => b.querySelector('span.truncate') && (b.textContent || '').includes('Project Alpha'));
  if (!heading) return { error: 'the seeded project header ([seed] Project Alpha) is not on the page' };
  const projectRow = heading.parentElement;
  const projectName = heading.querySelector('span.truncate');
  if (!projectName) return { error: 'the project header has no truncating name element' };

  // The conversation row: the seeded one, so the reading is a real row and
  // not an empty-state placeholder. Climb until the wrapper owns the row's
  // trailing action trigger, which is a sibling of the row button.
  const row = Array.from(document.querySelectorAll('[data-session-row]'))
    .find((el) => (el.textContent || '').includes('[seed] Morning planning'))
    || Array.from(document.querySelectorAll('[data-session-row]')).find((el) => (el.textContent || '').includes('[seed]'));
  if (!row) return { error: 'no seeded conversation row ([data-session-row]) is on the page' };
  let rowLine = row;
  while (rowLine.parentElement && !rowLine.querySelector('[data-row-actions]')) rowLine = rowLine.parentElement;
  const rowName = row.querySelector('[id^="session-row-title-"]');
  if (!rowName) return { error: 'the conversation row has no title element' };

  const readName = (el) => {
    const b = box(el);
    return { text: (el.textContent || '').trim().slice(0, 80), w: b.w, clientWidth: el.clientWidth, scrollWidth: el.scrollWidth, truncated: el.scrollWidth > el.clientWidth + 1 };
  };

  return {
    viewport: { width: window.innerWidth, height: window.innerHeight, devicePixelRatio: window.devicePixelRatio },
    pointerCoarse: window.matchMedia('(pointer: coarse)').matches,
    shippedFloorMatches: window.matchMedia(floorQuery).matches,
    touchLgWrapper: Boolean(document.querySelector('.touch-lg')),
    column: box(column),
    project: {
      label: heading.getAttribute('aria-label'),
      rowWidth: box(projectRow).w,
      name: readName(projectName),
      controls: controlsIn(projectRow, nameOf),
    },
    conversation: {
      title: row.getAttribute('aria-label') || (row.textContent || '').trim().slice(0, 60),
      rowWidth: box(row).w,
      lineWidth: box(rowLine).w,
      name: readName(rowName),
      controls: controlsIn(rowLine, nameOf),
    },
  };
}

// ---------------------------------------------------------------- main
async function main() {
  if (flag('self-test')) { selfTest(); return; }
  const viewports = requestedViewports();
  const asJson = flag('json');
  const outDir = arg('out', '');
  const shotsDir = arg('shots', '');
  const log = (...a) => console.error(...a);

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-list-shell-'));
  let daemon = null;
  let browser = null;
  const doc = {
    schema: 1,
    startedAt: new Date().toISOString(),
    injectedCss: INJECTED_FLOOR_CSS,
    shippedWidthArm: SHIPPED_WIDTH_ARM,
    shippedFloorArm: SHIPPED_FLOOR_ARM,
    controlFloorArm: CONTROL_FLOOR_ARM,
    machine: { platform: os.platform(), release: os.release(), arch: os.arch(), cpus: os.cpus().length },
    node: process.version,
    viewports: {},
    anchors: {},
    unmeasured: [],
  };
  try {
    const require = createRequire(import.meta.url);
    let chromium;
    try {
      ({ chromium } = require(process.env.PW_CORE || path.join(process.env.HOME, '.kin/ux-proto-tools/node_modules/playwright-core')));
    } catch (e) { unavail('playwright-core missing: ' + e.message); }

    const kinBin = resolveBinary(tmp);
    daemon = await startDaemon(kinBin, tmp);
    const seedLog = seedDaemon(daemon, tmp);
    log(`measure-list-shell: daemon on :${daemon.port}, seed ${seedLog}`);

    try { browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--disable-gpu'] }); }
    catch (e) { unavail('chrome launch failed: ' + e.message); }

    if (shotsDir) fs.mkdirSync(shotsDir, { recursive: true });

    for (const vp of viewports) {
      const ctx = await browser.newContext({
        viewport: { width: vp.width, height: vp.height },
        deviceScaleFactor: 1,
        isMobile: vp.isMobile,
        hasTouch: vp.hasTouch,
      });
      await ctx.addInitScript((t) => { try { localStorage.setItem('kin_token', t); } catch (_) {} }, daemon.token);
      const page = await ctx.newPage();
      page.setDefaultTimeout(15000);
      page.on('pageerror', (e) => log(`[${vp.name}] pageerror: ${String(e.message).slice(0, 200)}`));
      try {
        await page.goto(daemon.base + '/sessions', { waitUntil: 'domcontentloaded', timeout: 20000 });
        await page.waitForSelector('[data-session-row]:has-text("[seed]")', { timeout: 15000 }).catch(() => {});
        // The list is seeded asynchronously by the app's own read; wait until
        // the named project header exists rather than assuming the first paint.
        await page.waitForFunction(() => Array.from(document.querySelectorAll('button[aria-label]'))
          .some((b) => b.querySelector('span.truncate') && (b.textContent || '').includes('Project Alpha')), null, { timeout: 15000 })
          .catch(() => {});
        await page.waitForTimeout(300); // one settled frame after the async list paints

        if (vp.hasTouch) {
          const coarse = await bounded(page.evaluate(() => window.matchMedia('(pointer: coarse)').matches), 15000, `${vp.name} coarse-pointer read`);
          if (!coarse) unavail(`${vp.name}: hasTouch did not produce (pointer: coarse); the floor reading would be of a mouse`);
        }

        if (vp.phone) {
          // The phone shell is one page, not the persistent list+detail column:
          // there is no `[data-kin-list-column]` to measure, and the 44px floor
          // already covers this width. It is a screenshot anchor for the band's
          // other end, never a row in the 768–1023 table.
          if (shotsDir) {
            await bounded(page.screenshot({ path: path.join(shotsDir, `${vp.name}.png`) }), 20000, `${vp.name} screenshot`);
            log(`[${vp.name}] shot ${path.join(shotsDir, `${vp.name}.png`)}`);
          }
          doc.anchors[vp.name] = {
            viewport: vp.name,
            input: { width: vp.width, height: vp.height, hasTouch: vp.hasTouch, isMobile: vp.isMobile, deviceScaleFactor: 1 },
            note: 'phone shell: no persistent list column; the 44px floor already applies below md',
          };
          continue;
        }

        await page.waitForSelector('[data-kin-list-column] aside', { state: 'visible', timeout: 15000 });
        const shipped = await bounded(page.evaluate(readPage, SHIPPED_FLOOR_QUERY), 15000, `${vp.name} shipped read`);
        if (shipped.error) { doc.unmeasured.push({ viewport: vp.name, reason: shipped.error }); log(`[${vp.name}] UNMEASURED: ${shipped.error}`); continue; }

        if (shotsDir) {
          await bounded(page.screenshot({ path: path.join(shotsDir, `${vp.name}.png`) }), 20000, `${vp.name} screenshot`);
          log(`[${vp.name}] shot ${path.join(shotsDir, `${vp.name}.png`)}`);
        }

        const injected = await bounded(page.addStyleTag({ content: INJECTED_FLOOR_CSS }), 15000, `${vp.name} floor injection`);
        await bounded(page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))), 15000, `${vp.name} reflow`);
        const floored = await bounded(page.evaluate(readPage, SHIPPED_FLOOR_QUERY), 15000, `${vp.name} floored read`);
        // Removed by handle, so the element taken out is the one added above.
        await bounded(injected.evaluate((el) => el.remove()), 15000, `${vp.name} floor removal`);
        await bounded(page.evaluate(() => new Promise((resolve) => requestAnimationFrame(resolve))), 15000, `${vp.name} settle`);

        if (floored.error) { doc.unmeasured.push({ viewport: vp.name, reason: `after injection: ${floored.error}` }); log(`[${vp.name}] UNMEASURED after injection: ${floored.error}`); continue; }

        doc.viewports[vp.name] = {
          viewport: vp.name,
          input: { width: vp.width, height: vp.height, hasTouch: vp.hasTouch, isMobile: vp.isMobile, deviceScaleFactor: 1 },
          page: shipped.viewport,
          pointerCoarse: shipped.pointerCoarse,
          shippedFloorMatches: shipped.shippedFloorMatches,
          touchLgWrapper: shipped.touchLgWrapper,
          column: shipped.column,
          project: {
            label: shipped.project.label,
            rowWidth: shipped.project.rowWidth,
            controlCount: shipped.project.controls.length,
            name: shipped.project.name,
            controls: shipped.project.controls,
            nameAfterFloor: floored.project.name,
            controlsAfterFloor: floored.project.controls,
        },
          conversation: {
            title: shipped.conversation.title,
            rowWidth: shipped.conversation.rowWidth,
            lineWidth: shipped.conversation.lineWidth,
            controlCount: shipped.conversation.controls.length,
            name: shipped.conversation.name,
            controls: shipped.conversation.controls,
            nameAfterFloor: floored.conversation.name,
            controlsAfterFloor: floored.conversation.controls,
          },
        };
        const p = doc.viewports[vp.name];
        log(`[${vp.name}] column ${p.column.w}px · project name ${p.project.name.w}px -> ${p.project.nameAfterFloor.w}px · row name ${p.conversation.name.w}px -> ${p.conversation.nameAfterFloor.w}px`);
      } finally { await ctx.close(); }
    }

    if (doc.unmeasured.length) {
      log(`measure-list-shell: ${doc.unmeasured.length} viewport(s) unmeasured: ${doc.unmeasured.map((u) => u.viewport).join(', ')}`);
    }
    if (outDir) {
      fs.mkdirSync(outDir, { recursive: true });
      fs.writeFileSync(path.join(outDir, 'list-shell.json'), JSON.stringify(doc, null, 2) + '\n');
      log(`json ${path.join(outDir, 'list-shell.json')}`);
    }
    if (asJson) {
      console.log(JSON.stringify(doc, null, 2) + '\n');
    } else {
      printTable(doc);
    }
    if (doc.unmeasured.length) process.exitCode = 2;
  } finally {
    if (browser) await browser.close().catch(() => {});
    if (daemon) daemon.child.kill('SIGKILL');
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

function num(n) { return Number.isInteger(n) ? String(n) : n.toFixed(1); }
function printTable(doc) {
  const rows = Object.values(doc.viewports);
  console.log(`list shell — 44px floor read at ${rows.length} viewport(s) · deviceScaleFactor 1 · re-blessed 2026-11-25 (floor shipped over the band)`);
  console.log('viewport   column  pointer  floor-now  project name   ctrl     row name   ctrl    project/row controls');
  for (const v of rows) {
    console.log([
      v.viewport.padEnd(11),
      `${num(v.column.w)}px`.padEnd(8),
      (v.pointerCoarse ? 'coarse' : 'fine').padEnd(9),
      (v.shippedFloorMatches ? 'on' : 'off').padEnd(11),
      `${num(v.project.name.w)}px`.padEnd(14),
      `${num(v.project.nameAfterFloor.w)}px`.padEnd(8),
      `${num(v.conversation.name.w)}px`.padEnd(10),
      `${num(v.conversation.nameAfterFloor.w)}px`.padEnd(8),
      `${v.project.controlCount}/${v.conversation.controlCount}`,
    ].join(' '));
  }
  for (const v of rows) {
    console.log(`\n${v.viewport} · project "${v.project.label}" · name ${JSON.stringify(v.project.name.text)}${v.project.name.truncated ? ' (truncated)' : ''}`);
    for (const c of v.project.controls) console.log(`  control ${String(c.w + 'x' + c.h).padEnd(9)} min ${c.minWidth}/${c.minHeight}  ${c.absolute ? 'overlay ' : 'inline  '}${c.floorMatches ? 'floor-matches ' : 'no-floor     '}${c.label}`);
    for (const c of v.project.controlsAfterFloor) console.log(`  repeat  ${String(c.w + 'x' + c.h).padEnd(9)} min ${c.minWidth}/${c.minHeight}  ${c.absolute ? 'overlay ' : 'inline  '}${c.floorMatches ? 'floor-matches ' : 'no-floor     '}${c.label}`);
    console.log(`  row "${v.conversation.title}" name ${JSON.stringify(v.conversation.name.text)}${v.conversation.name.truncated ? ' (truncated)' : ''}`);
    for (const c of v.conversation.controls) console.log(`  control ${String(c.w + 'x' + c.h).padEnd(9)} min ${c.minWidth}/${c.minHeight}  ${c.absolute ? 'overlay ' : 'inline  '}${c.label}`);
  }
  console.log(`\ninjected at runtime only: the shipped selectors repeated at the same ${doc.controlFloorArm}px coarse arm as a control; the shipped columns are the reading that counts`);
}

main().catch((e) => {
  const reason = e instanceof Unavailable ? e.message : (e && e.stack) || String(e);
  console.error(`measure-list-shell: UNAVAILABLE: ${reason}`);
  process.exit(2);
});
