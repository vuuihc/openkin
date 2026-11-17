#!/usr/bin/env node
// Journey walk of the REAL console. Usage:
//   node walk.mjs --base http://127.0.0.1:PORT --token T --out DIR [--journeys J1,J2] [--files changed-files.txt] [--spec path/to/journeys.json]
//   node walk.mjs --resolve-j1 DIR/seed.log [--spec path/to/journeys.json]   (print the J1 approve/deny URLs or skip; no browser)
//   node walk.mjs --resolve-j7 DIR/seed.log [--spec path/to/journeys.json]   (print the J7 URL or skip; no browser)
//   node walk.mjs --check-spec [--spec path/to/journeys.json]                (J3's send contract; no browser)
// Needs playwright-core (PW_CORE or ~/.kin/ux-proto-tools) and Google Chrome. Writes DIR/<journey>-<vp>-<step>.png (+ .aria.txt) and DIR/walk.json.
// Exit 0 always when the walk ran (verdicts are the reviewer's and walk.json's `hardFail`); exit 2 when it could not run (no chrome, daemon unreachable).
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';
const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const arg = (k, d) => { const i = process.argv.indexOf('--' + k); return i > 0 ? process.argv[i + 1] : d; };
const base = arg('base'), token = arg('token', ''), out = path.resolve(arg('out', './ux-walk'));
const spec = JSON.parse(fs.readFileSync(arg('spec', path.join(here, 'journeys.json')), 'utf8'));
// How long a `wait`/`url` may take before it is a hard failure.
const WAIT_MS = (() => { const n = Number(process.env.RSI_UX_WAIT_MS); return Number.isFinite(n) && n > 0 ? n : 15000; })();
// The J3 contract the gate depends on: the walk must press Start for real and
// then prove the send landed. A spec that only asserts Start is usable
// photographs a page, not the product — the F1 path could lose the pending
// bubble between /new and /tasks/:id and still walk green. The same parser
// that runs the walk checks the contract, so the regression is red before a
// browser starts:
//   node walk.mjs --check-spec [--spec path/to/journeys.json]
function checkJ3Contract(spec) {
  const steps = (((spec || {}).journeys || {}).J3 || {}).steps;
  if (!Array.isArray(steps) || steps.length === 0) return ['J3 has no steps'];
  const errs = [];
  const idx = (pred, from = 0) => steps.findIndex((st, i) => i >= from && Array.isArray(st) && pred(st));
  const sendAt = idx(([op, sel]) => op === 'send' && /开始|Start/.test(String(sel)));
  if (sendAt < 0) errs.push('J3 has no send step on the Start control; an `enabled` assertion does not press it');
  const fillAt = idx(([op, sel, val]) => op === 'fill' && /textarea/.test(String(sel)) && typeof val === 'string' && val.trim() !== '');
  if (fillAt < 0) errs.push('J3 never types a prompt into the composer');
  const prompt = fillAt >= 0 ? String(steps[fillAt][2]) : '';
  // Without the marker the fake answers at once and the `sent` shot races it.
  if (prompt && !prompt.includes('[seed] slow')) errs.push('the J3 prompt must carry [seed] slow, or the pending shot races the answer');
  if (fillAt >= 0 && sendAt >= 0 && fillAt > sendAt) errs.push('J3 presses Start before typing the prompt');
  // Start navigates away, so the pickers must be settled first.
  const configAt = idx(([op, sel]) => (op === 'focus' || op === 'click') && /运行设置|Run settings/.test(String(sel)));
  if (configAt < 0) errs.push('J3 never opens the run settings');
  else if (sendAt >= 0 && configAt > sendAt) errs.push('J3 presses Start before choosing the run settings; the page navigates away');
  const afterSend = (pred) => (sendAt < 0 ? -1 : idx(pred, sendAt + 1));
  const promptWait = prompt ? afterSend(([op, needle]) => op === 'wait' && String(needle) === 'text=' + prompt) : -1;
  if (prompt && promptWait < 0) errs.push('J3 never waits for the typed prompt on the conversation route');
  const statusWait = afterSend(([op, needle]) => op === 'wait' && /^css=/.test(String(needle)) && /role=status/.test(String(needle)) && /思考|thinking/.test(String(needle)));
  if (statusWait < 0) errs.push('J3 never waits for the waiting row ([role=status], chat.thinking)');
  const replyWait = afterSend(([op, needle]) => op === 'wait' && /^text=/.test(String(needle)) && String(needle).includes('Fake reply from the journey fake agent.'));
  if (replyWait < 0) errs.push("J3 never waits for the fake agent's reply");
  const urlWait = afterSend(([op, pattern]) => op === 'url' && /tasks/.test(String(pattern)));
  if (urlWait < 0) errs.push('J3 never waits for the /tasks/ route');
  const shotAt = (name) => steps.findIndex((st) => Array.isArray(st) && st[0] === 'shot' && st[1] === name);
  const sentAt = shotAt('sent'), repliedAt = shotAt('replied');
  if (sentAt < 0) errs.push('J3 takes no `sent` shot');
  else if (sendAt >= 0 && sentAt <= sendAt) errs.push('the `sent` shot must be taken after Start');
  else if (replyWait >= 0 && sentAt > replyWait) errs.push('the `sent` shot must be taken while the run is still pending, before the reply');
  if (repliedAt < 0) errs.push('J3 takes no `replied` shot');
  else if (replyWait >= 0 && repliedAt < replyWait) errs.push('the `replied` shot must follow the reply wait');
  const emptyAt = idx(([op, sel, want]) => op === 'value' && /textarea/.test(String(sel)) && String(want) === '');
  if (emptyAt < 0) errs.push('J3 never proves the composer emptied (value textarea "")');
  else if (repliedAt >= 0 && emptyAt < repliedAt) errs.push('the empty-composer check must follow the reply');
  return errs;
}
if (process.argv.includes('--check-spec')) {
  const errs = checkJ3Contract(spec);
  if (errs.length) { console.log('spec red: J3'); errs.forEach((e) => console.log(' - ' + e)); process.exit(1); }
  console.log('spec ok: J3 sends a prompt and waits for the reply');
  process.exit(0);
}
// J7 must land on the conversation and card a notification would name. The
// seed prints one `j7 target conversation=<task> focus=<approval>` line when
// (and only when) it really produced both; without that line J7 is a skip,
// never a walk against an invented id. The spec itself keeps its literals
// (rsi/runtime/ux/journeys.json is the merge-gate spec, DECISIONS 2026-11-17);
// the walker substitutes here.
const J7_TARGET = /^j7 target conversation=(\S+) focus=(\S+)$/m;
function readJ7Target(seedText) {
  const seed = typeof seedText === 'string' ? seedText : '';
  if (/no scripts\/journeys_seed|seed failed|empty daemon/i.test(seed)) return { skip: 'seed failed or empty daemon' };
  if (!seed.trim()) return { skip: 'no seeded notification target' };
  const match = J7_TARGET.exec(seed);
  if (!match) return { skip: 'no seeded notification target' };
  return { conversation: match[1], focus: match[2] };
}
function applyJ7Target(goto, target) {
  return String(goto)
    .replace(/demo-task/g, target.conversation)
    .replace(/demo-item/g, target.focus)
    .replace(/\{conversation\}/g, target.conversation)
    .replace(/\{focus\}/g, target.focus);
}
// J1 must press BOTH decisions on the two conversations the seed named, not on
// "the first row". The seed prints one `j1 targets …` line only when both held
// cards exist; without it J1 is a skip, never a walk against an invented id.
const J1_TARGETS = /^j1 targets approve conversation=(\S+) focus=(\S+) deny conversation=(\S+) focus=(\S+)$/m;
function readJ1Target(seedText) {
  const seed = typeof seedText === 'string' ? seedText : '';
  if (/no scripts\/journeys_seed|seed failed|empty daemon/i.test(seed)) return { skip: 'seed failed or empty daemon' };
  if (!seed.trim()) return { skip: 'no seeded approval targets' };
  const match = J1_TARGETS.exec(seed);
  if (!match) return { skip: 'no seeded approval targets' };
  return { approve: { conversation: match[1], focus: match[2] }, deny: { conversation: match[3], focus: match[4] } };
}
function applyJ1Target(goto, target) {
  return String(goto)
    .replace(/\{approve\.conversation\}/g, target.approve.conversation)
    .replace(/\{approve\.focus\}/g, target.approve.focus)
    .replace(/\{deny\.conversation\}/g, target.deny.conversation)
    .replace(/\{deny\.focus\}/g, target.deny.focus);
}
// `--resolve-j1 <seed.log>` answers the same question without Chromium or a
// daemon, so the resolution (both cards, the skip, the placeholders) has a pure
// test through the same functions the real walk uses.
const resolveJ1 = arg('resolve-j1');
if (resolveJ1) {
  const target = readJ1Target(fs.existsSync(resolveJ1) ? fs.readFileSync(resolveJ1, 'utf8') : '');
  const gotos = ((spec.journeys.J1 || {}).steps || []).filter((st) => st[0] === 'goto');
  const approveStep = gotos.find((st) => String(st[1]).includes('{approve.conversation}'));
  const denyStep = gotos.find((st) => String(st[1]).includes('{deny.conversation}'));
  if (target.skip) console.log('J1 skip: ' + target.skip);
  else if (!approveStep || !denyStep) console.log('J1 skip: the spec has no J1 approval gotos');
  else console.log('J1 approve ' + applyJ1Target(approveStep[1], target) + ' deny ' + applyJ1Target(denyStep[1], target));
  process.exit(0);
}
// `--resolve-j7 <seed.log>` answers the same question without Chromium or a
// daemon, so the resolution has a pure test: the target line, the skip, the
// legacy literals and the placeholders all resolve through this one function.
const resolveJ7 = arg('resolve-j7');
if (resolveJ7) {
  const target = readJ7Target(fs.existsSync(resolveJ7) ? fs.readFileSync(resolveJ7, 'utf8') : '');
  const gotoStep = ((spec.journeys.J7 || {}).steps || []).find((st) => st[0] === 'goto');
  if (target.skip) console.log('J7 skip: ' + target.skip);
  else if (!gotoStep) console.log('J7 skip: the spec has no J7 goto step');
  else console.log('J7 ' + applyJ7Target(gotoStep[1], target));
  process.exit(0);
}
let want = arg('journeys', '') ? arg('journeys').split(',') : null;
if (!want && arg('files')) { // map changed files -> journeys
  const files = fs.readFileSync(arg('files'), 'utf8').split('\n').filter(Boolean); const set = new Set();
  for (const f of files) { const hit = spec.paths.find(([re]) => new RegExp('^(' + re + ')').test(f) || re.split('|').some((p) => f.startsWith(p))); (hit ? hit[1] : Object.keys(spec.journeys)).forEach((j) => set.add(j)); }
  want = [...set];
}
want = (want && want.length ? want : Object.keys(spec.journeys)).filter((j) => spec.journeys[j]);
if (!base) { console.error('--base required'); process.exit(2); }
let chromium; try { ({ chromium } = require(process.env.PW_CORE || path.join(process.env.HOME, '.kin/ux-proto-tools/node_modules/playwright-core'))); } catch (e) { console.error('playwright-core missing: ' + e.message); process.exit(2); }
fs.mkdirSync(out, { recursive: true });
let browser; try { browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--disable-gpu'] }); } catch (e) { console.error('chrome launch failed: ' + e.message); process.exit(2); }

const screens = [], hardFail = [];
async function lint(page, phone) {
  return page.evaluate((phone) => {
    const vis = (e) => { const b = e.getBoundingClientRect(); return b.width > 0 && b.height > 0 && getComputedStyle(e).visibility !== 'hidden'; };
    const q = (s) => [...document.querySelectorAll(s)].filter(vis);
    const bodyText = (document.body.innerText || '').trim().length;
    const small = phone ? q('button,a[href],[role=button],[role=tab],[role=switch]').filter((e) => { const b = e.getBoundingClientRect(); return (b.height < 44 || b.width < 44) && !e.closest('[role=tablist]'); }).length : 0;
    return {
      bodyText, overflowX: document.documentElement.scrollWidth > innerWidth + 1,
      searchBoxes: q('input').filter((e) => /搜索|search/i.test(e.placeholder || e.getAttribute('aria-label') || '')).length,
      solidPrimary: q('button').filter((e) => /primary|accent|btn-pri|bg-kin-(blue|accent)/i.test(e.className + '')).length,
      smallTapTargets: small, rawSelects: q('select').length,
      focusable: q('button,a[href],input,textarea,[tabindex]').length,
    };
  }, phone);
}
// A journey may depend on a choice no throwaway state dir has made, such as the
// working directory J3 must pick before Start is usable. When that choice is
// provably absent and the page says so, the journey is skipped with a reason --
// never recorded as a product failure. A missing precondition that the page does
// NOT explain stays a hard failure (J7's fixture skip is the same idea).
const SKIP = Symbol('skip-journey');
const skipJourney = (reason, name = 'skipped-no-workdir') => Object.assign(new Error(reason), { [SKIP]: true, skipName: name });
const listedPlace = (page) => page.locator('[data-place-option]:not([disabled])');
async function clickListedPlace(page) {
  const options = listedPlace(page);
  if (await options.count() === 0) return false;
  await options.first().click({ timeout: 3000 });
  await page.waitForTimeout(400);
  return true;
}
// The first root of a project the daemon already knows. A fresh state dir has no
// recent task directories, so the picker's own list is empty; a project root is
// still a place a person can choose, and the picker's field offers it as a row.
async function firstProjectRoot() {
  if (!base) return '';
  try {
    const res = await fetch(base.replace(/\/$/, '') + '/api/projects?status=all', { headers: token ? { Authorization: 'Bearer ' + token } : {} });
    if (!res.ok) return '';
    for (const project of await res.json()) {
      const root = (Array.isArray(project.roots) ? project.roots : []).find((r) => typeof r === 'string' && r.trim());
      if (root) return root;
    }
  } catch (_) {}
  return '';
}
async function choosePlace(page, selector) {
  if (await clickListedPlace(page)) return; // already offered (a fixture, or a panel left open)
  const raw = String(selector), optional = raw.startsWith('?'), sel = optional ? raw.slice(1) : raw;
  const trigger = page.locator(sel).first();
  // A missing picker, a picker without its search field, or one that offers
  // nothing after typing a known root is the page being broken, not an empty
  // environment: those stay hard failures so a PR that breaks the picker cannot
  // walk green. Only "there is genuinely nothing to choose" skips (below).
  if (await trigger.count() === 0) throw new Error('no working-directory picker (' + sel + ')');
  // The trigger is disabled while the machine list is still being fetched; give
  // that fetch a bounded moment instead of reading it as a picker that failed.
  let off = await trigger.isDisabled().catch(() => false);
  for (let i = 0; off && i < 30; i++) { await page.waitForTimeout(100); off = await trigger.isDisabled().catch(() => false); }
  if (off) throw new Error('the working-directory picker (' + sel + ') stayed disabled');
  // Open from the keyboard: a mouse press blurs the composer, the page lays out
  // again under the pointer, and the click lands on the wrapper (observed on
  // /new at 1100px). Enter on the focused trigger is the accessible path and is
  // stable at both widths.
  await trigger.focus();
  await page.keyboard.press('Enter');
  await page.waitForTimeout(500);
  if (await clickListedPlace(page)) return;
  const root = await firstProjectRoot();
  if (!root) throw skipJourney('the picker offers no project or recent directory, and the daemon knows no project root to choose');
  const search = page.locator('[role=dialog] input[type=search]').first();
  if (await search.count() === 0) throw new Error('the directory picker opened without a search field');
  await search.fill(root);
  await page.waitForTimeout(500);
  if (!(await clickListedPlace(page))) throw new Error('typing ' + root + ' into the picker offered no directory to choose');
}
// A text selector names a control by what it says. Resolve it the way a person
// reads the page: a VISIBLE text match first, then the accessible name (the
// phone's icon-only back button says 返回 only to a screen reader). A match that
// is only hidden text is not the control — J7's `/返回|Back/` otherwise resolves
// to the collapsed usage note "此任务未返回缓存用量" and every optional step
// would wait out a click timeout on it.
async function stepLocator(page, sel) {
  if (!sel.startsWith('/')) return page.locator(sel).first();
  const re = new RegExp(sel.slice(1, sel.lastIndexOf('/')), 'i');
  const text = page.getByText(re);
  const count = await text.count();
  for (let i = 0; i < count; i++) if (await text.nth(i).isVisible().catch(() => false)) return text.nth(i);
  for (const role of ['button', 'link']) {
    const named = page.getByRole(role, { name: re });
    const namedCount = await named.count();
    for (let i = 0; i < namedCount; i++) if (await named.nth(i).isVisible().catch(() => false)) return named.nth(i);
  }
  return text.first();
}
// A `?` prefix means the same thing for every op: absent or not visible is a
// recorded skip, not a failure (see journeys.json `_doc`).
const optionalOf = (raw) => { const s = String(raw); return s.startsWith('?') ? { optional: true, value: s.slice(1) } : { optional: false, value: s }; };
async function anyVisible(locator) {
  const count = await locator.count();
  for (let i = 0; i < count; i++) if (await locator.nth(i).isVisible().catch(() => false)) return true;
  return false;
}
async function pollUntil(page, probe, timeout) {
  const deadline = Date.now() + timeout;
  for (;;) {
    let hit = false;
    // `url` probes are synchronous; a locator probe is a promise. Either way a
    // throw (a detached frame, a bad selector) is "not yet", not a crash.
    try { hit = await probe(); } catch (_) { hit = false; }
    if (hit) return true;
    if (Date.now() >= deadline) return false;
    await page.waitForTimeout(100);
  }
}
// `text=` is read the way a person reads the page: a visible literal, not a
// regex (the J3 prompt carries `[seed]`, which as a regex is a character
// class). `css=` is a selector. Both wait for something VISIBLE; hidden text
// is not the screen showing the message.
async function waitVisible(page, needle, timeout) {
  if (needle.startsWith('text=')) {
    const text = needle.slice('text='.length);
    if (!text) throw new Error('wait text= needs a literal');
    return pollUntil(page, () => anyVisible(page.getByText(text)), timeout);
  }
  if (needle.startsWith('css=')) {
    const sel = needle.slice('css='.length);
    if (!sel) throw new Error('wait css= needs a selector');
    return pollUntil(page, () => anyVisible(page.locator(sel)), timeout);
  }
  throw new Error('wait needs text=<literal> or css=<selector>');
}
// This repo's fake agent, and the directory that proves it: the seed's
// `_fake_agent` makes the same test on the daemon's answer.
const FAKE_AGENT_DIRNAME = 'journeys_fake_agent';
// Pressing Start starts a turn. A walk may do that only when the daemon would
// launch the journey fake: a real claude would be a model run on the review
// machine, which is the one thing a walk must never cause. (why) — '' means
// the fake would answer.
async function fakeAgentVerdict() {
  if (!token) return 'no token: the walk cannot ask which claude the daemon would start, so it must not press Start';
  let rows;
  try {
    const res = await fetch(base.replace(/\/$/, '') + '/api/agents', { headers: { Authorization: 'Bearer ' + token } });
    if (!res.ok) return `GET /api/agents answered ${res.status}; refusing to guess which binary a turn would start`;
    const body = await res.json();
    rows = Array.isArray(body) ? body : (body && Array.isArray(body.agents) ? body.agents : null);
  } catch (e) {
    return 'cannot list agents; refusing to guess which binary a turn would start';
  }
  if (!rows) return 'GET /api/agents returned an unexpected shape; refusing to guess which binary a turn would start';
  const row = rows.find((r) => r && r.id === 'claude-code');
  if (!row) return 'no claude-code agent is installed on this daemon';
  if (!row.available) return 'the daemon reports no runnable claude-code agent';
  const binary = String(row.binary || '');
  if (!binary) return 'the daemon does not say which claude it would start; refusing to guess';
  // The daemon reports the path it resolved; realpath both prove the same
  // directory when one of them is a symlink and neither follows a missing one.
  let real = binary;
  try { real = fs.realpathSync(binary); } catch (_) { real = path.resolve(binary); }
  if (path.basename(path.dirname(real)) !== FAKE_AGENT_DIRNAME) return 'the daemon would start a real claude CLI; only the fake agent may answer';
  return '';
}
for (const j of want) {
  const seed = (j === 'J1' || j === 'J7') && fs.existsSync(path.join(out, 'seed.log')) ? fs.readFileSync(path.join(out, 'seed.log'), 'utf8') : '';
  const j1 = j === 'J1' ? readJ1Target(seed) : null;
  const j7 = j === 'J7' ? readJ7Target(seed) : null;
  if (j1 && j1.skip) { screens.push({ journey: j, viewport: 'n/a', name: 'J1-skipped-no-approval-target', url: '', lint: {}, notes: ['skipped J1: ' + j1.skip] }); continue; }
  if (j7 && j7.skip) { screens.push({ journey: j, viewport: 'n/a', name: 'J7-skipped-no-fixtures', url: '', lint: {}, notes: ['skipped J7: no seeded notification target'] }); continue; }
  const J = spec.journeys[j];
  for (const vpName of J.viewports) {
    const [w, h] = spec.viewports[vpName].split('x').map(Number); const phone = w < 700;
    const ctx = await browser.newContext({ viewport: { width: w, height: h }, deviceScaleFactor: phone ? 2 : 1, isMobile: phone, hasTouch: phone });
    if (token) await ctx.addInitScript((t) => { try { localStorage.setItem('kin_token', t); } catch (_) {} }, token);
    const page = await ctx.newPage(); const errs = [], bad = [], soft = [];
    page.on('pageerror', (e) => errs.push(String(e.message).slice(0, 200)));
    // A failed request also prints a content-free "Failed to load resource" console line. Attribute
    // failures to the response below, where the URL and status are known, so a 404 can be told apart
    // from a broken app; keep every other console error.
    page.on('console', (m) => { if (m.type() === 'error' && !/^Failed to load resource/.test(m.text())) errs.push('console: ' + m.text().slice(0, 160)); });
    page.on('response', (r) => {
      const p = new URL(r.url()).pathname;
      // `/api/projects/by-root` answers 404 for "this directory has no project yet" — the page renders
      // that empty state on purpose (an unseeded throwaway daemon is all such directories).
      if (r.status() === 404 && p === '/api/projects/by-root') { soft.push('no project for ' + new URL(r.url()).searchParams.get('path')); return; }
      if (r.status() >= 400) bad.push(r.status() + ' ' + p);
    });
    const log = []; let n = 0;
    for (const st of J.steps) {
      const [op, a, b] = st;
      try {
        if (op === 'goto') { await page.goto(base + (j === 'J7' ? applyJ7Target(a, j7) : j === 'J1' ? applyJ1Target(a, j1) : a), { waitUntil: 'domcontentloaded', timeout: 20000 }); await page.waitForTimeout(900); }
        else if (op === 'shot') {
          await page.waitForTimeout(250); const name = `${j}-${vpName}-${String(++n).padStart(2, '0')}-${a}`;
          await page.screenshot({ path: path.join(out, name + '.png') });
          try { fs.writeFileSync(path.join(out, name + '.aria.txt'), await page.locator('body').ariaSnapshot({ timeout: 4000 })); } catch (_) {}
          const l = await lint(page, phone); screens.push({ journey: j, viewport: vpName, name, url: new URL(page.url()).pathname + new URL(page.url()).search.replace(/token=[^&]+/g, 'token=<redacted>'), lint: l });
          if (l.bodyText < 20) hardFail.push(`${name}: blank page`);
          if (l.overflowX) hardFail.push(`${name}: horizontal page overflow`);
        } else if (op === 'click' || op === 'hover' || op === 'fill' || op === 'enabled' || op === 'focus') {
          const raw = String(a), optional = raw.startsWith('?'), sel = optional ? raw.slice(1) : raw;
          const loc = await stepLocator(page, sel);
          if (await loc.count() === 0) { if (optional) { log.push('skipped ' + op + ' ' + sel); continue; } hardFail.push(`${j}/${vpName}: missing required ${op} ${sel}`); continue; }
          // An optional step whose only match is invisible is that control not
          // being on this page; clicking it can only time out.
          if (optional && !(await loc.isVisible().catch(() => false))) { log.push('skipped ' + op + ' ' + sel + ' (not visible)'); continue; }
          if (op === 'enabled') {
            // Asserts a control a person would use is usable, without pressing
            // it. Only `send` may press, and only after proving the daemon
            // would launch the fake agent; `enabled` is for controls whose
            // activation is not the thing under test (or would leave the
            // page). A disabled control that names its missing prerequisite is
            // the page being honest; one that says nothing is broken.
            if (await loc.isDisabled()) {
              const why = await page.evaluate(() => {
                const block = document.querySelector('[data-send-block]');
                const status = document.querySelector('[role=status]');
                return ((block && block.textContent) || (status && status.textContent) || '').replace(/\s+/g, ' ').trim().slice(0, 100);
              });
              hardFail.push(`${j}/${vpName}: ${sel} is disabled` + (why ? ` (${why})` : ' with no on-screen explanation'));
              continue;
            }
            log.push('enabled ' + sel); await page.waitForTimeout(150); continue;
          }
          if (op === 'focus') {
            // A trigger inside a composer re-lays-out when the field blurs, and
            // the mouse-up then lands on the wrapper, swallowing the click
            // (`choosePlace` documents the same defect on /new at 1100px).
            // Focusing first, then pressing Enter, is the accessible path and
            // the stable one: the layout settles before the layer opens.
            await loc.focus({ timeout: 3000 }); await page.waitForTimeout(200); continue;
          }
          if (op === 'fill') await loc.fill(b, { timeout: 3000 }); else await (op === 'click' ? loc.click({ timeout: 3000 }) : loc.hover({ timeout: 3000 })); await page.waitForTimeout(400);
        } else if (op === 'gone') {
          // A decision landing must take its control off the screen: the
          // pending card unmounts its buttons when the answer arrives. Waiting
          // for "detached" is not enough — a card can stay mounted and be
          // hidden — so poll until no VISIBLE match remains, and treat a
          // control still on screen at the deadline as a hard failure.
          const raw = String(a), optional = raw.startsWith('?'), sel = optional ? raw.slice(1) : raw;
          const wait = Math.max(0, Number(process.env.RSI_UX_WAIT_MS) || 15000);
          const deadline = Date.now() + wait;
          const stillVisible = async () => {
            const loc = page.locator(sel);
            const count = await loc.count().catch(() => 0);
            for (let i = 0; i < count; i++) if (await loc.nth(i).isVisible().catch(() => false)) return true;
            return false;
          };
          let visible = await stillVisible();
          while (visible && Date.now() < deadline) { await page.waitForTimeout(200); visible = await stillVisible(); }
          if (!visible) { log.push('gone ' + sel); continue; }
          if (optional) { log.push('skipped gone ' + sel + ' (still visible)'); continue; }
          hardFail.push(`${j}/${vpName}: gone ${sel} still visible after ${wait}ms`);
        } else if (op === 'place') {
          await choosePlace(page, a); log.push('chose a working directory');
        } else if (op === 'send') {
          // Press Start for real — the F1 path's last unproven inch. The
          // disabled-control verdict is `enabled`'s, so a page that turns the
          // send off still fails the same way. Then the daemon must prove it
          // would launch the journey fake before any click: a real CLI is a
          // model run, and the journey is skipped with a reason instead.
          const { optional, value: sel } = optionalOf(a);
          const loc = await stepLocator(page, sel);
          if (await loc.count() === 0) {
            if (optional) { log.push('skipped send ' + sel); continue; }
            hardFail.push(`${j}/${vpName}: missing required send ${sel}`); continue;
          }
          if (optional && !(await loc.isVisible().catch(() => false))) { log.push('skipped send ' + sel + ' (not visible)'); continue; }
          if (await loc.isDisabled()) {
            const why = await page.evaluate(() => {
              const block = document.querySelector('[data-send-block]');
              const status = document.querySelector('[role=status]');
              return ((block && block.textContent) || (status && status.textContent) || '').replace(/\s+/g, ' ').trim().slice(0, 100);
            });
            hardFail.push(`${j}/${vpName}: ${sel} is disabled` + (why ? ` (${why})` : ' with no on-screen explanation'));
            continue;
          }
          const why = await fakeAgentVerdict();
          if (why) throw skipJourney(why, 'skipped-no-fake-agent');
          await loc.click({ timeout: 3000 });
          await page.waitForURL(/\/tasks\/[^/?#]+/, { timeout: WAIT_MS });
          log.push('pressed ' + sel + '; the daemon runs the journey fake agent');
        } else if (op === 'wait') {
          const { optional, value: needle } = optionalOf(a);
          let seen;
          try { seen = await waitVisible(page, needle, WAIT_MS); }
          catch (e) { hardFail.push(`${j}/${vpName}: wait ${needle}: ${String(e.message).split('\n')[0]}`); continue; }
          if (seen) log.push('waited for ' + needle);
          else if (optional) log.push('skipped wait ' + needle + ' (not visible within ' + WAIT_MS + 'ms)');
          else hardFail.push(`${j}/${vpName}: wait ${needle} not visible within ${WAIT_MS}ms`);
        } else if (op === 'url') {
          // The path the person is on, as a regex over `location.pathname`.
          const { optional, value: pattern } = optionalOf(a);
          let re; try { re = new RegExp(pattern); } catch (e) { hardFail.push(`${j}/${vpName}: url ${pattern} is not a regex: ${e.message}`); continue; }
          const pathNow = () => new URL(page.url()).pathname;
          const matched = await pollUntil(page, () => re.test(pathNow()), WAIT_MS);
          if (matched) log.push('url ' + pathNow() + ' matches ' + pattern);
          else if (optional) log.push('skipped url ' + pattern + ' (still at ' + pathNow() + ')');
          else hardFail.push(`${j}/${vpName}: url ${pathNow()} did not match ${pattern} within ${WAIT_MS}ms`);
        } else if (op === 'value') {
          const { optional, value: sel } = optionalOf(a);
          const loc = page.locator(sel).first();
          if (await loc.count() === 0) {
            if (optional) { log.push('skipped value ' + sel); continue; }
            hardFail.push(`${j}/${vpName}: missing required value ${sel}`); continue;
          }
          const actual = await loc.inputValue({ timeout: 3000 }).catch(() => null);
          if (actual === null) {
            if (optional) { log.push('skipped value ' + sel + ' (not readable)'); continue; }
            hardFail.push(`${j}/${vpName}: ${sel} value could not be read`); continue;
          }
          if (actual === b) log.push('value ' + sel + ' is ' + JSON.stringify(b));
          else if (optional) log.push('skipped value ' + sel + ' (is ' + JSON.stringify(actual) + ')');
          else hardFail.push(`${j}/${vpName}: ${sel} value is ${JSON.stringify(actual)}, want ${JSON.stringify(b)}`);
        } else if (op === 'key') { await page.keyboard.press(a); await page.waitForTimeout(200); }
        else { hardFail.push(`${j}/${vpName}: unknown step op ${JSON.stringify(op)}`); }
      } catch (e) {
        if (e && e[SKIP]) {
          const name = `${j}-${vpName}-${e.skipName}`;
          try {
            await page.screenshot({ path: path.join(out, name + '.png') });
            try { fs.writeFileSync(path.join(out, name + '.aria.txt'), await page.locator('body').ariaSnapshot({ timeout: 4000 })); } catch (_) {}
          } catch (_) {}
          screens.push({ journey: j, viewport: vpName, name, url: new URL(page.url()).pathname, lint: await lint(page, phone).catch(() => ({})) });
          log.push('skipped ' + j + ': ' + e.message);
          break;
        }
        const msg = `${op} ${a}: ${String(e.message).split('\n')[0].slice(0, 120)}`; log.push(msg); hardFail.push(`${j}/${vpName}: ${msg}`);
      }
    }
    if (errs.length) hardFail.push(`${j}/${vpName}: page errors: ${[...new Set(errs)].slice(0, 3).join(' | ')}`);
    if (bad.length) hardFail.push(`${j}/${vpName}: 4xx/5xx: ${[...new Set(bad)].slice(0, 3).join(', ')}`);
    if (soft.length) log.push('soft: ' + [...new Set(soft)].slice(0, 3).join(', '));
    screens.filter((s) => s.journey === j && s.viewport === vpName).forEach((s) => { s.notes = log; });
    await ctx.close();
  }
}
await browser.close();
fs.writeFileSync(path.join(out, 'walk.json'), JSON.stringify({ base: base.replace(/:\d+/, ':<port>'), journeys: want, hardFail, screens }, null, 1));
console.log(`ux-walk: ${screens.length} screens, ${hardFail.length} hard failures`); hardFail.forEach((f) => console.log(' - ' + f));
