#!/usr/bin/env node
// Real-browser proof of the phone's hold-to-reorder: a 500ms hold lifts a
// conversation row, the finger drags it inside its own project, release keeps
// the new order across a reload, and a short tap / an early move stay inert.
//
//   node touch-drag.mjs --base http://127.0.0.1:PORT --token T --out DIR
//
// Why this exists: the shipped tests for the gesture are jsdom-only, and jsdom
// has neither real pointer capture nor `touch-action` (LESSONS 2026-10-30), so
// a gesture can pass there and still be dead under a finger. This script drives
// Chrome's own touch pipeline through CDP (`Input.dispatchTouchEvent`), which
// is OS-level input to the renderer, not a dispatchEvent of a synthetic
// PointerEvent. Writes DIR/390-*.png, DIR/820-*.png and DIR/touch-drag.json.
//
// Exit 0 every assertion passed; exit 1 a real-browser assertion failed (a
// defect in the shipped gesture); exit 2 could not run (no playwright-core,
// no Chrome, or the console never rendered rows).
//
// Needs playwright-core (PW_CORE or ~/.kin/ux-proto-tools) and Google Chrome,
// loaded exactly as rsi/runtime/ux/walk.mjs does. The daemon must already be
// seeded with a project that has at least two rows; scripts/journeys_seed.py
// gives "Project Alpha" two active conversations.
import { createRequire } from 'node:module';
import path from 'node:path';
import fs from 'node:fs';

const require = createRequire(import.meta.url);
const arg = (k, d) => {
  const i = process.argv.indexOf('--' + k);
  return i > 0 ? process.argv[i + 1] : d;
};
const base = (arg('base') || '').replace(/\/$/, '');
const token = arg('token', '');
const out = path.resolve(arg('out', './touch-drag'));
if (!base) {
  console.error('--base required');
  process.exit(2);
}
let chromium;
try {
  ({ chromium } = require(
    process.env.PW_CORE || path.join(process.env.HOME, '.kin/ux-proto-tools/node_modules/playwright-core'),
  ));
} catch (e) {
  console.error('playwright-core missing: ' + e.message);
  process.exit(2);
}
fs.mkdirSync(out, { recursive: true });
let browser;
try {
  browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--disable-gpu'] });
} catch (e) {
  console.error('chrome launch failed: ' + e.message);
  process.exit(2);
}

/** A failed assertion: the shipped gesture is broken in a real browser. */
class Defect extends Error {}
/** The page never reached the state the walk needs; not a gesture verdict. */
class Unavailable extends Error {}

const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok: Boolean(ok), detail });
  console.log(`${ok ? 'PASS' : 'FAIL'} · ${name}${detail ? ' · ' + detail : ''}`);
  if (!ok) throw new Defect(`${name}${detail ? ' — ' + detail : ''}`);
}
function note(name, detail) {
  results.push({ name, ok: true, detail, note: true });
  console.log(`NOTE · ${name}${detail ? ' — ' + detail : ''}`);
}

const TOUCH_ID = 7;
// A finger sized like a fingertip; Chrome only needs an id that stays stable
// for the whole gesture.
const finger = (x, y) => ({ x, y, id: TOUCH_ID, radiusX: 6, radiusY: 6, force: 1 });

async function touchEvent(cdp, type, x, y) {
  await cdp.send('Input.dispatchTouchEvent', {
    type,
    touchPoints: type === 'touchEnd' ? [] : [finger(x, y)],
  });
}

/** The list a viewport is judged on: the phone page or the iPad sidebar. */
const scopeFor = (viewport) => (viewport === '820' ? '[data-kin-list-column]' : '[data-phone-scroll]');

/**
 * The first project bucket with at least two rows, as drawn.
 *
 * A bucket is the leaf `<section>` that owns the rows; device sections nest
 * buckets, so the leaf test keeps the walked scope inside one project — the
 * gesture is only allowed to reorder there.
 */
async function bucket(page, scope) {
  return page.evaluate((sel) => {
    const root = document.querySelector(sel);
    if (!root) return null;
    const leaf = [...root.querySelectorAll('section')].filter(
      (s) => s.querySelectorAll('[data-session-row]').length >= 2 && !s.querySelector('section'),
    );
    for (const section of leaf) {
      const ids = [...section.querySelectorAll('[data-session-row]')].map(
        (el) => el.dataset.sessionRow || '',
      );
      if (ids.filter(Boolean).length >= 2) {
        return {
          ids,
          heading: section.querySelector('button[aria-label]')?.getAttribute('aria-label') || '',
        };
      }
    }
    return null;
  }, scope);
}

/** The ids of every drawn row under `scope`, in DOM order (bucket boundaries included). */
async function drawnIds(page, scope) {
  return page.evaluate(
    (sel) =>
      [...document.querySelectorAll(`${sel} [data-session-row]`)].map(
        (el) => el.dataset.sessionRow || '',
      ),
    scope,
  );
}

/** Where one row sits, in viewport coordinates. */
async function rectOf(page, scope, id) {
  return page.evaluate(
    ({ sel, rowId }) => {
      const el = [...document.querySelectorAll(`${sel} [data-session-row]`)].find(
        (candidate) => candidate.dataset.sessionRow === rowId,
      );
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { x: r.x + r.width / 2, y: r.y + r.height / 2, top: r.top, bottom: r.bottom, height: r.height };
    },
    { sel: scope, rowId: id },
  );
}

/** Whether a row's swipe/reorder wrapper reports the lifted state. */
async function lifted(page, id) {
  return page.evaluate((rowId) => {
    const el = [...document.querySelectorAll('[data-session-row]')].find(
      (candidate) => candidate.dataset.sessionRow === rowId,
    );
    const wrapper = el?.closest('[data-phone-swipe]');
    return Boolean(wrapper && wrapper.hasAttribute('data-reordering') && el.closest('[data-dragging]'));
  }, id);
}

async function scrollTop(page, scope) {
  return page.evaluate((sel) => {
    const root = document.querySelector(sel);
    if (!root) return 0;
    const scroller = root.matches('[data-phone-scroll]') ? root : root.querySelector('[data-phone-scroll]');
    if (scroller) return scroller.scrollTop;
    // The sidebar's list is the nearest scrollable ancestor of its rows.
    const row = root.querySelector('[data-session-row]');
    for (let node = row?.parentElement; node; node = node.parentElement) {
      if (node.scrollHeight > node.clientHeight + 1) return node.scrollTop;
    }
    return 0;
  }, scope);
}

/** Install page-side probes: the pointer type actually delivered, and whether touchmoves were cancelled. */
async function armTouchProbe(page) {
  await page.evaluate(() => {
    window.__touchProbe = { moves: 0, prevented: 0, pointerType: '' };
    if (window.__touchProbeBound) return;
    window.__touchProbeBound = true;
    document.addEventListener(
      'pointerdown',
      (event) => {
        window.__touchProbe.pointerType = event.pointerType;
      },
      true,
    );
    // Bubble phase, non-passive: the wrapper's own listener runs first, so
    // `defaultPrevented` here says whether the gesture claimed the scroll.
    document.addEventListener(
      'touchmove',
      (event) => {
        window.__touchProbe.moves += 1;
        if (event.defaultPrevented) window.__touchProbe.prevented += 1;
      },
      { passive: false },
    );
  });
}
const readTouchProbe = (page) =>
  page.evaluate(() => window.__touchProbe || { moves: 0, prevented: 0, pointerType: '' });

async function storedOrder(page) {
  return page.evaluate(() => {
    try {
      const parsed = JSON.parse(localStorage.getItem('kin_task_order') || '{}');
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
    } catch {
      return {};
    }
  });
}

/** The stored array that carries `ids` — the bucket's key is its cwd, not known here. */
function entryFor(order, ids) {
  for (const [key, list] of Object.entries(order)) {
    if (!Array.isArray(list)) continue;
    // The stored list may also carry rows folded behind "show all"; it only
    // has to contain every drawn id of the bucket we walked.
    if (ids.every((id) => list.includes(id))) return { key, list };
  }
  return null;
}

async function openSessions(page) {
  await page.goto(base + '/sessions', { waitUntil: 'domcontentloaded', timeout: 20000 });
  await page.waitForSelector('[data-session-row]', { timeout: 15000 });
  // The list is fed by a fetch that renders buckets after the first paint.
  await page.waitForTimeout(600);
}

/**
 * Press and hold, and report when the lift appeared.
 *
 * The shipped threshold is 500ms; the measurement is a floor at ~320ms (a hold
 * must not lift early) plus a bounded poll (a CPU-starved machine can deliver
 * the timer a little late; that is the harness, not the gesture). A real
 * measurement of 15 holds on an idle box was 504–533ms.
 */
async function holdLifts(page, cdp, x, y, id) {
  await touchEvent(cdp, 'touchStart', x, y);
  await page.waitForTimeout(320);
  const early = await lifted(page, id);
  let late = early;
  const deadline = Date.now() + 1800;
  while (!late && Date.now() < deadline) {
    await page.waitForTimeout(40);
    late = await lifted(page, id);
  }
  return { early, late };
}

/**
 * One viewport's whole gesture. Throws Defect on a product failure; the caller
 * records it and continues with the next viewport.
 */
async function walk(viewport, options) {
  const { width, height, deviceScaleFactor, isMobile } = options;
  const context = await browser.newContext({
    viewport: { width, height },
    deviceScaleFactor,
    isMobile,
    hasTouch: true,
  });
  if (token) await context.addInitScript((t) => { try { localStorage.setItem('kin_token', t); } catch (_) {} }, token);
  const page = await context.newPage();
  const pageErrors = [];
  page.on('pageerror', (e) => pageErrors.push(String(e.message).slice(0, 200)));
  const cdp = await context.newCDPSession(page);
  const scope = scopeFor(viewport);

  try {
    await openSessions(page);
    // The iPad must present its sidebar list; the phone must not have one.
    if (viewport === '820') {
      const sidebar = await page.locator(scope).count();
      check('820 · iPad renders the sidebar list', sidebar > 0, `found ${sidebar} [data-kin-list-column]`);
    }
    const touchSupport = await page.evaluate(() => ({
      coarse: matchMedia('(pointer: coarse)').matches,
      points: navigator.maxTouchPoints || 0,
    }));
    check(
      `${viewport} · the context is a finger`,
      touchSupport.coarse && touchSupport.points > 0,
      `pointer coarse=${touchSupport.coarse}, maxTouchPoints=${touchSupport.points}`,
    );

    const first = await bucket(page, scope);
    if (!first) throw new Unavailable(`${viewport}: no project bucket with at least two drawn rows`);
    check(
      `${viewport} · a project bucket has two conversations`,
      first.ids.length >= 2,
      `${first.heading || '(heading)'} → ${first.ids.length} rows`,
    );
    const [a, b] = first.ids;
    await page.screenshot({ path: path.join(out, `${viewport}-before.png`) });
    const beforeIds = await drawnIds(page, scope);
    const aRect = await rectOf(page, scope, a);
    const bRect = await rectOf(page, scope, b);
    if (!aRect || !bRect) throw new Unavailable(`${viewport}: the chosen rows have no layout box`);
    const scrollBefore = await scrollTop(page, scope);
    const urlBefore = page.url();

    // ---- 2. a hold lifts the row, and no sheet opens -----------------------
    await armTouchProbe(page);
    const hold = await holdLifts(page, cdp, aRect.x, aRect.y, a);
    check(`${viewport} · the hold does not lift before its threshold`, !hold.early, 'at ~320ms');
    check(`${viewport} · hold lifts the row`, hold.late, 'within the bounded poll after 320ms');
    const probeAtHold = await readTouchProbe(page);
    check(
      `${viewport} · the gesture arrived as touch, not a mouse`,
      probeAtHold.pointerType === 'touch',
      `pointerdown pointerType=${probeAtHold.pointerType || '(none)'}`,
    );
    const dialogsAtHold = await page.locator('[role="dialog"]').count();
    check(`${viewport} · the hold does not open a sheet`, dialogsAtHold === 0, `${dialogsAtHold} dialog(s)`);
    const stripAtHold = await page.evaluate((rowId) => {
      const el = [...document.querySelectorAll('[data-session-row]')].find(
        (candidate) => candidate.dataset.sessionRow === rowId,
      );
      const wrapper = el?.closest('[data-phone-swipe]');
      return wrapper ? wrapper.querySelectorAll('[inert]').length : -1;
    }, a);
    check(`${viewport} · the hold does not open the action strip`, stripAtHold === 0, `${stripAtHold} inert layer(s)`);

    // ---- 3. drag down past the next row's midpoint -------------------------
    const targetY = bRect.top + bRect.height * 0.8;
    const steps = 8;
    for (let i = 1; i <= steps; i++) {
      const y = aRect.y + ((targetY - aRect.y) * i) / steps;
      await touchEvent(cdp, 'touchMove', aRect.x, y);
      await page.waitForTimeout(24);
      if (i === 3) {
        // A few frames in, the row is visibly out of line with its slot: the
        // frame a reviewer can read as "lifted", before it settles over the
        // next row. The transform is the row following the finger.
        check(`${viewport} · the row is still lifted mid-drag`, await lifted(page, a), `row ${a}`);
        const transform = await page.evaluate(
          () => document.querySelector('[data-dragging]')?.style.transform || '',
        );
        check(
          `${viewport} · the lifted row follows the finger`,
          /translateY\(-?\d/.test(transform),
          transform || '(no transform)',
        );
        await page.screenshot({ path: path.join(out, `${viewport}-lifted.png`) });
      }
    }
    await page.waitForTimeout(120);
    const duringIds = await drawnIds(page, scope);
    const moved = duringIds.indexOf(a) > duringIds.indexOf(b);
    check(`${viewport} · the drawn order changes under the finger`, moved, `${beforeIds.join(',')} → ${duringIds.join(',')}`);

    // ---- 5. no scroll, no navigation, no strip mid-drag --------------------
    const scrollDuring = await scrollTop(page, scope);
    check(
      `${viewport} · the list does not scroll under the drag`,
      scrollDuring === scrollBefore,
      `scrollTop ${scrollBefore} → ${scrollDuring}`,
    );
    const probeDuring = await readTouchProbe(page);
    note(
      `${viewport} · the lift claims vertical moves`,
      `${probeDuring.prevented}/${probeDuring.moves} touchmove(s) cancelled by the drag`,
    );
    check(`${viewport} · a drag is not a navigation`, page.url() === urlBefore, page.url());
    check(
      `${viewport} · no action strip mid-drag`,
      (await page.locator('[role="dialog"]').count()) === 0,
      'no dialog',
    );

    // ---- release -----------------------------------------------------------
    await touchEvent(cdp, 'touchEnd', aRect.x, targetY);
    await page.waitForTimeout(350);
    check(`${viewport} · release drops the lift`, !(await lifted(page, a)), 'no [data-reordering]');
    const afterIds = await drawnIds(page, scope);
    check(`${viewport} · the new order stays after release`, afterIds.join(',') === duringIds.join(','), afterIds.join(','));

    // ---- 3b. persisted and restored across a full reload -------------------
    const order = await storedOrder(page);
    const entry = entryFor(order, first.ids);
    check(`${viewport} · release writes kin_task_order`, Boolean(entry), entry ? `${entry.key} → ${entry.list.join(',')}` : JSON.stringify(order));
    // A bucket may also hold rows folded behind "show all"; compare the drawn
    // ids only, in both directions.
    const drawnOf = (list) => list.filter((id) => first.ids.includes(id));
    check(
      `${viewport} · stored order is the drawn order`,
      drawnOf(entry.list).join(',') === drawnOf(afterIds).join(','),
      `${entry.list.join(',')} vs ${afterIds.join(',')}`,
    );
    await openSessions(page);
    const reloadedBucket = await bucket(page, scope);
    check(
      `${viewport} · a full reload restores the new order`,
      Boolean(reloadedBucket) && drawnOf(reloadedBucket.ids).join(',') === drawnOf(entry.list).join(','),
      reloadedBucket ? reloadedBucket.ids.join(',') : 'no bucket after reload',
    );
    await page.screenshot({ path: path.join(out, `${viewport}-after-reload.png`) });

    // ---- 4a. a short tap does not lift ------------------------------------
    const tapBucket = await bucket(page, scope);
    const tapId = tapBucket.ids[0];
    const tapRect = await rectOf(page, scope, tapId);
    const urlBeforeTap = page.url();
    await touchEvent(cdp, 'touchStart', tapRect.x, tapRect.y);
    await page.waitForTimeout(200);
    check(`${viewport} · a 200ms press does not lift`, !(await lifted(page, tapId)), `row ${tapId}`);
    await touchEvent(cdp, 'touchEnd', tapRect.x, tapRect.y);
    await page.waitForTimeout(600);
    check(`${viewport} · the tap leaves no lift behind`, !(await lifted(page, tapId)), 'no [data-reordering]');
    // A tap is the row's own gesture: it opens the conversation (or, at worst,
    // the row as it does today). Both are a navigation or a sheet, never a lift.
    const afterTapUrl = page.url();
    const afterTapDialog = await page.locator('[role="dialog"]').count();
    check(
      `${viewport} · the tap still opens the conversation`,
      afterTapUrl !== urlBeforeTap || afterTapDialog > 0,
      afterTapUrl !== urlBeforeTap ? `→ ${new URL(afterTapUrl).pathname}` : `${afterTapDialog} dialog(s)`,
    );
    await openSessions(page);

    // ---- 4b. >8px before the hold cancels it, and the scroll is not claimed -
    const moveBucket = await bucket(page, scope);
    const moveId = moveBucket.ids[0];
    const moveRect = await rectOf(page, scope, moveId);
    const scrollContainerScrollable = await page.evaluate((sel) => {
      const root = document.querySelector(sel);
      const row = root?.querySelector('[data-session-row]');
      for (let node = row?.parentElement; node; node = node.parentElement) {
        if (node.scrollHeight > node.clientHeight + 1) return true;
      }
      return false;
    }, scope);
    await armTouchProbe(page);
    await touchEvent(cdp, 'touchStart', moveRect.x, moveRect.y);
    await page.waitForTimeout(120);
    for (let i = 1; i <= 6; i++) {
      await touchEvent(cdp, 'touchMove', moveRect.x, moveRect.y - i * 18);
      await page.waitForTimeout(24);
    }
    await page.waitForTimeout(420); // past the 500ms mark: a surviving hold would have fired
    check(`${viewport} · an early move cancels the hold`, !(await lifted(page, moveId)), `row ${moveId}`);
    await touchEvent(cdp, 'touchEnd', moveRect.x, moveRect.y - 108);
    await page.waitForTimeout(400);
    const probeEarly = await readTouchProbe(page);
    check(
      `${viewport} · the early move is not claimed by the drag`,
      probeEarly.prevented === 0,
      `${probeEarly.prevented}/${probeEarly.moves} touchmove(s) cancelled`,
    );
    if (scrollContainerScrollable) {
      check(`${viewport} · the early move scrolls the list instead`, (await scrollTop(page, scope)) > scrollBefore, `scrollTop ${await scrollTop(page, scope)}`);
    } else {
      note(
        `${viewport} · the early-move scroll is not measurable here`,
        'the seeded list is shorter than the viewport; the un-cancelled touchmove is the observable',
      );
    }
    await openSessions(page);

    // ---- 4c. the left swipe still opens the row's actions ------------------
    // The same wrapper owns the hold and the horizontal reveal; a drag that
    // broke the swipe would trade one gesture for the other.
    const swipeBucket = await bucket(page, scope);
    const swipeId = swipeBucket.ids[0];
    const swipeRect = await rectOf(page, scope, swipeId);
    const swipeStartX = swipeRect.x + 60;
    await touchEvent(cdp, 'touchStart', swipeStartX, swipeRect.y);
    for (let i = 1; i <= 10; i++) {
      await touchEvent(cdp, 'touchMove', swipeStartX - i * 12, swipeRect.y + 1);
      await page.waitForTimeout(18);
    }
    await touchEvent(cdp, 'touchEnd', swipeStartX - 120, swipeRect.y + 1);
    await page.waitForTimeout(350);
    const swipeState = await page.evaluate((rowId) => {
      const el = [...document.querySelectorAll('[data-session-row]')].find(
        (candidate) => candidate.dataset.sessionRow === rowId,
      );
      const wrapper = el?.closest('[data-phone-swipe]');
      if (!wrapper) return null;
      const cover = wrapper.lastElementChild;
      return {
        transform: cover?.style.transform || '',
        reordering: wrapper.hasAttribute('data-reordering'),
        inert: wrapper.querySelectorAll('[inert]').length,
      };
    }, swipeId);
    check(
      `${viewport} · the left swipe still opens the row actions`,
      Boolean(swipeState) && /translateX\(-\d/.test(swipeState.transform) && !swipeState.reordering,
      swipeState ? `${swipeState.transform}, ${swipeState.inert} inert layer(s)` : 'no swipe wrapper',
    );
    await openSessions(page);

    // ---- 6. bucket containment --------------------------------------------
    const containBucket = await bucket(page, scope);
    const containId = containBucket.ids[0];
    const containRect = await rectOf(page, scope, containId);
    const otherIds = (await drawnIds(page, scope)).filter((id) => !containBucket.ids.includes(id));
    const containHold = await holdLifts(page, cdp, containRect.x, containRect.y, containId);
    check(`${viewport} · the containment drag lifts`, containHold.late, `row ${containId}`);
    // Far past the bucket's last row, into whatever is drawn below it.
    for (let i = 1; i <= 10; i++) {
      await touchEvent(cdp, 'touchMove', containRect.x, containRect.y + i * 40);
      await page.waitForTimeout(20);
    }
    await page.waitForTimeout(120);
    const contained = await page.evaluate(
      ({ sel, rowId, ids }) => {
        const root = document.querySelector(sel);
        const section = [...root.querySelectorAll('section')].find(
          (candidate) =>
            candidate.querySelectorAll('[data-session-row]').length >= 2 &&
            !candidate.querySelector('section') &&
            [...candidate.querySelectorAll('[data-session-row]')].every((el) => ids.includes(el.dataset.sessionRow)),
        );
        const row = [...document.querySelectorAll('[data-session-row]')].find(
          (candidate) => candidate.dataset.sessionRow === rowId,
        );
        return { inside: Boolean(section && row && section.contains(row)), ids: [...(section?.querySelectorAll('[data-session-row]') || [])].map((el) => el.dataset.sessionRow) };
      },
      { sel: scope, rowId: containId, ids: containBucket.ids },
    );
    check(`${viewport} · the dragged row stays under its own project heading`, contained.inside, contained.ids.join(','));
    await page.screenshot({ path: path.join(out, `${viewport}-containment.png`) });
    await touchEvent(cdp, 'touchEnd', containRect.x, containRect.y + 400);
    await page.waitForTimeout(300);
    const afterContain = await drawnIds(page, scope);
    check(
      `${viewport} · no row crosses into another bucket`,
      otherIds.every((id) => afterContain.includes(id)),
      `others kept: ${otherIds.join(',') || '(none)'}`,
    );

    if (pageErrors.length) note(`${viewport} · page errors`, [...new Set(pageErrors)].slice(0, 3).join(' | '));
    return true;
  } catch (e) {
    // A failed assertion is evidence: keep the frame and the row state next to
    // the JSON so a later run can tell a product defect from a harness miss.
    if (e instanceof Defect) {
      try {
        await page.screenshot({ path: path.join(out, `${viewport}-defect.png`) });
      } catch (_) {}
      try {
        const dump = await page.evaluate(() => ({
          url: location.pathname,
          rows: [...document.querySelectorAll('[data-session-row]')].map((el) => {
            const box = el.getBoundingClientRect();
            return {
              id: el.dataset.sessionRow,
              reordering: Boolean(el.closest('[data-phone-swipe]')?.hasAttribute('data-reordering')),
              dragging: Boolean(el.closest('[data-dragging]')),
              rect: [Math.round(box.x), Math.round(box.y), Math.round(box.width), Math.round(box.height)],
            };
          }),
          dialogs: document.querySelectorAll('[role="dialog"]').length,
          scroll: [...document.querySelectorAll('[data-phone-scroll]')].map((el) => el.scrollTop),
        }));
        fs.writeFileSync(path.join(out, `${viewport}-defect.json`), JSON.stringify(dump, null, 1));
      } catch (_) {}
    }
    throw e;
  } finally {
    await context.close();
  }
}

let failed = null;
for (const [viewport, options] of [
  ['390', { width: 390, height: 844, deviceScaleFactor: 2, isMobile: true }],
  ['820', { width: 820, height: 1180, deviceScaleFactor: 1, isMobile: false }],
]) {
  try {
    await walk(viewport, options);
  } catch (e) {
    // The two viewports are separate contexts: a defect in the phone list must
    // not hide the iPad's verdict. A missing fixture ends the run, though —
    // the second viewport would fail the same way.
    if (!failed) failed = e;
    if (!(e instanceof Defect) && !(e instanceof Unavailable)) {
      console.error('unexpected: ' + (e?.stack || e));
    }
    if (e instanceof Unavailable) console.error('could not run: ' + e.message);
    if (e instanceof Unavailable) break;
  }
}
await browser.close();

const summary = {
  base: base.replace(/:\d+/, ':<port>'),
  viewports: ['390', '820'],
  results,
  verdict: failed ? (failed instanceof Defect ? 'defect' : 'unavailable') : 'pass',
};
fs.writeFileSync(path.join(out, 'touch-drag.json'), JSON.stringify(summary, null, 1));
const passed = results.filter((r) => r.ok && !r.note).length;
const notes = results.filter((r) => r.note).length;
console.log(`touch-drag: ${passed} passed, ${notes} notes, verdict=${summary.verdict}`);
if (failed) console.log(' - ' + failed.message);
process.exit(failed ? (failed instanceof Defect ? 1 : 2) : 0);
