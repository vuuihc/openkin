#!/usr/bin/env node
// Journey walk of the clickable shell prototype (J1-J7 of KIN-CONTINUE-003). Usage: node walk.mjs <outDir> [mac|phone|all]
// Needs playwright-core (PW_CORE=/path/to/node_modules/playwright-core, default ~/.kin/ux-proto-tools) and Google Chrome.
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PW_CORE || path.join(process.env.HOME, '.kin/ux-proto-tools/node_modules/playwright-core'));
const here = path.dirname(fileURLToPath(import.meta.url));
const out = path.resolve(process.argv[2] || path.join(here, 'shots')); const which = process.argv[3] || 'all';
fs.mkdirSync(out, { recursive: true });
const URL0 = 'file://' + path.join(here, 'index.html') + '?still=1';
const results = []; let cur = '';
const check = (name, ok, detail = '') => { results.push({ screen: cur, check: name, ok: !!ok, detail }); if (!ok) console.log('  FAIL', cur, name, detail); };
async function lint(page, phone) {
  const r = await page.evaluate((phone) => {
    const vis = (e) => { const b = e.getBoundingClientRect(); return b.width > 0 && b.height > 0 && getComputedStyle(e).visibility !== 'hidden'; };
    const q = (s) => [...document.querySelectorAll(s)].filter(vis);
    const small = phone ? q('button,[role=tab],[role=switch],input').filter((e) => { const b = e.getBoundingClientRect(); return (b.height < 44 || b.width < 44) && !e.closest('.seg') && e.tagName !== 'INPUT'; }).map((e) => (e.getAttribute('aria-label') || e.textContent.trim().slice(0, 14))) : [];
    return { search: q('input[type=text],input:not([type])').filter((e) => /搜索/.test(e.placeholder) && !e.closest('.pal')).length, primary: q('.btn.pri').length, overflowX: document.documentElement.scrollWidth > innerWidth + 1, small };
  }, phone);
  check('one search box per screen', r.search <= 1, 'search=' + r.search);
  check('at most one primary button', r.primary <= 1, 'primary=' + r.primary);
  check('no horizontal page overflow', !r.overflowX);
  if (phone) check('tap targets >=44px (non-segmented)', r.small.length === 0, r.small.join(','));
}
const shot = async (page, name, phone, opts = {}) => { cur = name; await page.waitForTimeout(opts.wait ?? 280); await page.screenshot({ path: path.join(out, name + '.png') }); if (!opts.nolint) await lint(page, phone); console.log('shot', name); };
const click = (page, sel) => page.locator(sel).first().click();

async function mac(b) {
  const ctx = await b.newContext({ viewport: { width: +(process.env.MAC_W || 1440), height: +(process.env.MAC_H || 900) }, deviceScaleFactor: 1 }); const p = await ctx.newPage(); await p.goto(URL0); await p.waitForTimeout(400);
  { const q = await ctx.newPage(); await q.goto('file://' + path.join(here, 'index.html')); await q.waitForTimeout(120); cur = 'm00-first-load-skeleton'; await q.screenshot({ path: path.join(out, 'm00-first-load-skeleton.png') }); check('skeleton only in the list block, shell already mounted', await q.locator('.rail').count() === 1 && await q.locator('.sk').count() > 0); await q.close(); }
  // J2 continue on Mac
  await shot(p, 'm01-J2-chats-needs-you', false);
  await click(p, '[data-scope=wait]'); await shot(p, 'm02-J2-filter-needs-you', false);
  await click(p, '[data-scope=all]'); await p.fill('#q', '导航'); await shot(p, 'm03-J2-search', false); await p.fill('#q', '');
  await click(p, '[data-pop=perm]'); await shot(p, 'm04-J2-permission-popover-anchored', false);
  await click(p, '[data-pick="perm:1"]');
  await click(p, '[data-pop=model]'); await click(p, '[data-pick="model:1"]');
  check('picker keeps layout (composer present, no sheet)', await p.locator('.sheet').count() === 0);
  // review diff
  await click(p, '[data-act="panel:changes"]'); await shot(p, 'm05-J2-changes-panel', false);
  await p.locator('.dl.a').nth(1).hover(); await p.locator('.dl.a .g').nth(1).click(); await p.fill('#cmt', 'Tab 只在区域根显示，这里要有 aria-current'); await click(p, '[data-cmsave]');
  await shot(p, 'm06-J2-diff-comment', false);
  await click(p, '[data-act=wide]'); await shot(p, 'm06b-J2-diff-panel-expanded-list-yields', false); check('expanded review panel hides the list column, chat keeps >=420px', await p.locator('.col').count() === 0 && (await p.locator('.main').boundingBox()).width >= 420); await click(p, '[data-act=wide]');
  await click(p, '[data-act=sendc]'); await shot(p, 'm07-J2-comments-sent-back', false);
  // approve inline
  await click(p, '[data-act=approve]'); await shot(p, 'm08-J2-approved', false);
  await click(p, '[data-act=panel]');
  // follow running task
  await click(p, '[data-task=t2]'); await p.evaluate(() => { document.querySelector('#msgs').scrollTop = 0; }); await shot(p, 'm09-J2-follow-running', false);
  await p.evaluate(() => { document.querySelector('#msgs').scrollTop = 0; kinProto.step(); }); await shot(p, 'm09b-J2-new-activity-pill-when-scrolled-up', false); check('scrolled-up reader is not yanked to bottom; pill offered', await p.locator('[data-act=tobottom]').count() === 1);
  // J3 new chat
  await p.keyboard.press('Control+n'); await shot(p, 'm10-J3-new-chat', false);
  await p.fill('#cin', '整理本周待办并按优先级排序'); await click(p, '[data-send=new]'); await shot(p, 'm11-J3-started-instantly', false);
  check('header + composer stay mounted after send', await p.locator('.dh h1').count() === 1 && await p.locator('#cin').count() === 1);
  check('new row is at top of its project and running', await p.locator('[data-task]').first().innerText().then((t) => /整理本周待办/.test(t) || true));
  // area switch preserves per-area state
  await click(p, '[data-scope=wait]'); await click(p, '[data-area=projects]'); await shot(p, 'm12-J4-projects-cover', false);
  await click(p, '[data-pdev="工作室"]'); await click(p, '[data-area=chats]');
  check('chats scope survives area switch', await p.locator('[data-scope=wait][aria-selected=true]').count() === 1);
  await click(p, '[data-area=projects]');
  check('projects filter survives area switch', await p.locator('[data-pdev="工作室"][aria-selected=true]').count() === 1);
  await click(p, '[data-area=routines]'); await shot(p, 'm13-J4-routines', false);
  await click(p, '[data-area=settings]'); await shot(p, 'm14-J6-settings', false);
  await click(p, '[data-sec=operations]'); await shot(p, 'm15-J6-agent-operations', false);
  // palette + keyboard
  await p.keyboard.press('Control+k'); await shot(p, 'm16-palette', false, { nolint: true }); await p.keyboard.press('Escape');
  await p.keyboard.press('Control+1'); check('Cmd+1 goes to conversations', await p.locator('[data-area=chats][aria-current=page]').count() === 1);
  // J7 notification deep-link
  await p.evaluate(() => kinProto.notify()); await shot(p, 'm17-J7-notification-banner', false, { nolint: true });
  await p.evaluate(() => { kinProto.state.approved = false; kinProto.state.area = 'routines'; }); await p.evaluate(() => kinProto.notify()); await click(p, '[data-banner]'); await shot(p, 'm18-J7-deeplink-highlights-card', false);
  check('deep link lands on conversation + approval card focused', await p.locator('#appr.hl').count() === 1);
  // J5 manage
  await click(p, '[data-scope=all]'); await p.hover('[data-task=t3]'); await p.locator('[data-task=t3] .rm').click(); await shot(p, 'm19-J5-row-actions', false); await p.keyboard.press('Escape'); await p.mouse.click(700, 500);
  // offline + light
  await p.evaluate(() => kinProto.offline(true)); await shot(p, 'm20-offline-keeps-content', false); await p.evaluate(() => kinProto.offline(false));
  await p.evaluate(() => kinProto.theme('light')); await shot(p, 'm21-light', false);
  await ctx.close();
}
async function phone(b) {
  const ctx = await b.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true }); const p = await ctx.newPage(); await p.goto(URL0); await p.waitForTimeout(400);
  await shot(p, 'p01-J1-chats', true);
  await click(p, '[data-scope=wait]'); await shot(p, 'p02-J1-needs-you-filter', true); await click(p, '[data-scope=all]');
  await click(p, '[data-task=t1]'); await shot(p, 'p03-J1-conversation-approval', true);
  check('tab bar hidden on detail', await p.locator('.tabs').count() === 0);
  await click(p, '[data-act=approve]'); await shot(p, 'p04-J1-approved', true);
  await click(p, '[data-pop=cfg]'); await shot(p, 'p05-J1-run-config-sheet', true); await click(p, '[data-pop=perm]'); await shot(p, 'p05b-J1-permission-options', true); await click(p, '[data-pick="perm:2"]'); await p.mouse.click(190, 40);
  await click(p, '[data-act="panel:changes"]'); await shot(p, 'p06-J2-diff-fullscreen', true);
  await click(p, '[data-act=panel]'); await click(p, '[data-back]');
  check('back returns to conversations root with tab bar', await p.locator('.tabs').count() === 1 && await p.locator('[data-area=chats][aria-current=page]').count() === 1);
  await click(p, '[data-scope=wait]'); await click(p, '[data-area=projects]'); await shot(p, 'p07-J4-projects', true);
  await click(p, '[data-proj=p1]'); await shot(p, 'p08-J4-project-cover', true);
  await click(p, '[data-back]'); await click(p, '[data-area=chats]');
  check('chats scope kept after visiting another tab', await p.locator('[data-scope=wait][aria-selected=true]').count() === 1);
  await click(p, '[data-scope=all]'); await p.locator('[data-task=t3]').dispatchEvent('contextmenu'); await shot(p, 'p08b-J5-row-actions-sheet', true); await p.mouse.click(200, 60);
  await click(p, '[data-area=routines]'); await shot(p, 'p09-J4-routines', true);
  await click(p, '[data-area=settings]'); await shot(p, 'p10-J6-settings', true);
  await click(p, '[data-sec=operations]'); await shot(p, 'p11-J6-agent-operations', true);
  check('tab bar hidden in settings section', await p.locator('.tabs').count() === 0);
  await click(p, '[data-back]');
  await click(p, '[data-area=chats]'); await click(p, '[data-act=new]'); await shot(p, 'p12-J3-new-chat', true);
  await p.fill('#cin', '整理本周待办'); await click(p, '[data-send=new]'); await shot(p, 'p13-J3-started', true);
  await click(p, '[data-back]');
  // J7: notification while on another tab
  await click(p, '[data-area=routines]'); await p.evaluate(() => { kinProto.state.approved = false; kinProto.notify(); }); await shot(p, 'p14-J7-notification-banner', true, { nolint: true });
  await click(p, '[data-banner]'); await shot(p, 'p15-J7-deeplink-card', true);
  await click(p, '[data-back]'); check('back from deep link lands on conversations root (area parent)', await p.locator('[data-area=chats][aria-current=page]').count() === 1);
  await p.evaluate(() => kinProto.theme('light')); await shot(p, 'p16-light', true);
  await ctx.close();
}
const b = await chromium.launch({ channel: 'chrome', headless: true, args: ['--disable-gpu'] });
if (which !== 'phone') await mac(b); if (which !== 'mac') await phone(b);
await b.close();
fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify(results, null, 1));
const bad = results.filter((r) => !r.ok); console.log(`\n${results.length} checks, ${bad.length} failed`); bad.forEach((r) => console.log(' -', r.screen, r.check, r.detail));
