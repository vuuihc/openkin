#!/usr/bin/env node
// optional-grace.fixture.mjs — the real-browser proof that the call site is wired.
//
// The hermetic suite (optional-grace.test.mjs) proves the helper's rule; it says
// nothing about whether walk.mjs actually consults it before logging `skipped`.
// A class-string check would prove neither (Watch 53). So this fixture boots a
// throwaway page and the real walker:
//
//   1. a node:http server on 127.0.0.1:0 appends <button id="fold"> 1200 ms
//      after load; pressing it reveals #fold-pressed;
//   2. `goto` in walk.mjs settles for 900 ms, so at the optional click the
//      button is still absent and only the grace can find it;
//   3. the walk must log `click #fold after <N>ms optional grace`, press it, and
//      see #fold-pressed. A walker that skips at the empty count fails the
//      bounded wait below.
//
// Exit 0 green · 1 the walk under-ran · 2 unavailable (playwright-core or Chrome
// absent, or the walk could not start). Unavailable is never a pass.
//
// No Kin daemon, no UI build, no npm; the only external need is the Mac's
// playwright-core and Chrome, the same pair every walk uses. Run:
//   node rsi/runtime/ux/optional-grace.fixture.mjs
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';

const here = path.dirname(fileURLToPath(import.meta.url));
const walker = path.join(here, 'walk.mjs');
const require = createRequire(import.meta.url);

function unavailable(why) {
  console.log('unavailable: playwright-core/chrome (' + why + ')');
  process.exit(2);
}

try {
  require(process.env.PW_CORE || path.join(process.env.HOME, '.kin/ux-proto-tools/node_modules/playwright-core'));
} catch (e) {
  unavailable('playwright-core missing: ' + String(e.message).split('\n')[0]);
}

// The fold arrives after the click step has already looked, and inside the
// 1500 ms grace. The page is deliberately plain: nothing here is a Kin surface.
const PAGE = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>optional grace fixture</title></head>
<body style="margin:0;font:16px system-ui">
<main style="padding:24px">
  <h1>optional grace fixture</h1>
  <p>The fold below is appended 1200 ms after load.</p>
  <div id="host"></div>
  <div id="pressed"></div>
</main>
<script>
  setTimeout(function () {
    var b = document.createElement('button');
    b.id = 'fold';
    b.textContent = '展开全部';
    b.addEventListener('click', function () {
      var out = document.getElementById('pressed');
      out.id = 'fold-pressed';
      out.textContent = 'pressed';
    });
    document.getElementById('host').appendChild(b);
  }, 1200);
</script>
</body></html>`;

const server = createServer((_req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(PAGE);
});
await new Promise((resolve, reject) => {
  server.once('error', reject);
  server.listen(0, '127.0.0.1', resolve);
});
const port = server.address().port;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'optional-grace-'));
const out = path.join(tmp, 'out');
const specPath = path.join(tmp, 'spec.json');
// The `wait` carries its own 1500 ms budget, so the red case (a walker that
// skipped the click) ends in ~1.5 s instead of the global 15 s.
fs.writeFileSync(specPath, JSON.stringify({
  viewports: { fixture: '1100x760' },
  journeys: {
    T1: {
      title: 'optional grace',
      viewports: ['fixture'],
      steps: [
        ['goto', '/'],
        ['click', '?#fold'],
        ['wait', 'css=#fold-pressed', '1500'],
        ['shot', 'pressed'],
      ],
    },
  },
}));

let code = null;
let stdout = '';
let stderr = '';
let timedOut = false;
try {
  // `spawn`, not `spawnSync`: the parent owns the fixture server, and a blocked
  // event loop could never answer the walker's page request. Every wait is
  // bounded; a run past 90 s is "no verdict", never a pass (AGENTS §13).
  const child = spawn(process.execPath, [
    walker,
    '--base', 'http://127.0.0.1:' + port,
    '--out', out,
    '--spec', specPath,
    '--journeys', 'T1',
  ], { stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.on('data', (d) => { stdout += d; });
  child.stderr.on('data', (d) => { stderr += d; });
  ({ code, timedOut } = await new Promise((resolve) => {
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      resolve({ code: null, timedOut: true });
    }, 90000);
    child.once('error', () => { clearTimeout(timer); resolve({ code: null, timedOut: false }); });
    child.once('close', (exitCode) => { clearTimeout(timer); resolve({ code: exitCode, timedOut: false }); });
  }));
} finally {
  server.close();
}

if (timedOut) {
  console.log('unavailable: playwright-core/chrome (walk exceeded its 90 s bound; no verdict)');
  process.exit(2);
}

if (code === 2) {
  unavailable('walk could not run: ' + (stderr.trim() || stdout.trim() || 'exit 2').split('\n').slice(-1)[0]);
}
if (code !== 0) {
  console.log('FAIL the walk exited ' + code + (stderr.trim() ? ': ' + stderr.trim().split('\n').slice(-1)[0] : ''));
  process.exit(1);
}

let doc;
try {
  doc = JSON.parse(fs.readFileSync(path.join(out, 'walk.json'), 'utf8'));
} catch (e) {
  console.log('FAIL the walk wrote no readable walk.json: ' + String(e.message).split('\n')[0]);
  process.exit(1);
}
const notes = (doc.screens || []).flatMap((s) => s.notes || []);
const problems = [];
if ((doc.hardFail || []).length) problems.push('hardFail: ' + doc.hardFail.join(' | '));
const graceLine = notes.find((n) => /^click #fold after \d+ms optional grace$/.test(n));
if (!graceLine) problems.push('no "click #fold after <N>ms optional grace" note');
if (notes.some((n) => /^skipped click #fold/.test(n))) problems.push('the optional click was recorded as skipped');
if (!notes.some((n) => n === 'click #fold')) problems.push('the optional click never ran');
if (!notes.some((n) => n === 'waited for css=#fold-pressed')) problems.push('#fold-pressed never appeared');

console.log('walk exit 0, hardFail ' + (doc.hardFail || []).length + ', ' + (doc.screens || []).length + ' screen(s)');
for (const line of notes.filter((n) => /#fold|grace/.test(n))) console.log('  note: ' + line);
if (problems.length) {
  console.log('FAIL ' + problems.join(' | '));
  console.log('kept for inspection: ' + tmp);
  process.exit(1);
}
console.log('PASS ' + graceLine + '; the optional click ran and #fold-pressed appeared');
fs.rmSync(tmp, { recursive: true, force: true });
process.exit(0);
