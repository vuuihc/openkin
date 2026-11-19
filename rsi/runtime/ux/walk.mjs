#!/usr/bin/env node
// Journey walk of the REAL console. Usage:
//   node walk.mjs --base http://127.0.0.1:PORT --token T --out DIR [--journeys J1,J2] [--files changed-files.txt] [--spec path/to/journeys.json] [--delay-tasks MS]
//   node walk.mjs --resolve-j1 DIR/seed.log [--spec path/to/journeys.json]   (print the J1 approve/deny URLs or skip; no browser)
//   node walk.mjs --resolve-j5 DIR/seed.log [--spec path/to/journeys.json]   (print the resolved J5 row-menu step or skip; no browser)
//   node walk.mjs --resolve-j7 DIR/seed.log [--spec path/to/journeys.json]   (print the J7 URL or skip; no browser)
//   node walk.mjs --resolve-j7-plan DIR/seed.log [--spec path/to/journeys.json] (print the resolved J7 steps as JSON; no browser)
//   node walk.mjs --check-spec [--seed DIR/seed.log] [--spec path/to/journeys.json] (J1's phone search/approve/deny leg, J2/J8's review loop, J3's send + mid-run follow-up, J5's row menu, J6's default-agent change/reload/restore, J7's landing contract, J9's Mac switch, J11's phone switch and J12's thumb gestures; no browser)
// Needs playwright-core (PW_CORE or ~/.kin/ux-proto-tools) and Google Chrome. Writes DIR/<journey>-<vp>-<step>.png (+ .aria.txt) and DIR/walk.json.
// Ops are documented in journeys.json `_doc`. One op is not listed there
// because it belongs to one story: `history-back` is the browser's own Back
// (`page.goBack`), for legs where the app draws a Back button of its own and
// the promise under test is the system Back / edge gesture. `back` presses
// that button when it is reachable; `history-back` never does.
// Exit 0 always when the walk ran (verdicts are the reviewer's and walk.json's `hardFail`); exit 2 when it could not run (no chrome, daemon unreachable).
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';
const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const arg = (k, d) => { const i = process.argv.indexOf('--' + k); return i > 0 ? process.argv[i + 1] : d; };
// The spec is an index: each `journeys` entry is either an inline body (old
// single-file specs, the smoke fixture, the reduced specs the mutant tests
// write) or a path relative to the index (one file per journey, so two walk
// PRs never edit the same JSON). A missing, unreadable or empty body is loud:
// a walk that silently skips a journey is evidence of nothing.
function loadSpec(specPath) {
  const abs = path.resolve(specPath);
  let spec;
  try { spec = JSON.parse(fs.readFileSync(abs, 'utf8')); }
  catch (e) { throw new Error(`spec ${abs}: ${e.message}`); }
  for (const [id, entry] of Object.entries(spec.journeys || {})) {
    if (typeof entry !== 'string') continue;
    const body = path.resolve(path.dirname(abs), entry);
    let parsed;
    try { parsed = JSON.parse(fs.readFileSync(body, 'utf8')); }
    catch (e) { throw new Error(`journey ${id}: cannot read ${body}: ${e.message}`); }
    if (!parsed || !Array.isArray(parsed.steps) || parsed.steps.length === 0) {
      throw new Error(`journey ${id}: ${body} has no steps`);
    }
    spec.journeys[id] = parsed;
  }
  return spec;
}
const base = arg('base'), token = arg('token', ''), out = path.resolve(arg('out', './ux-walk'));
const spec = loadSpec(arg('spec', path.join(here, 'journeys.json')));
// How long a `wait`/`url` may take before it is a hard failure.
const WAIT_MS = (() => { const n = Number(process.env.RSI_UX_WAIT_MS); return Number.isFinite(n) && n > 0 ? n : 15000; })();
// `--delay-tasks <ms>` holds the task-detail GET open so a walk can prove the
// message the draft already showed survives the route *before* the first
// detail answer. The pending bubble is handed over in memory and the seeded
// detail row carries `task.prompt`; a tree that loses both draws a skeleton
// until this request lands, and a wait shorter than the delay goes red.
// Default 0 installs no route at all, so the gate's behaviour is unchanged.
const DELAY_TASKS_MS = (() => { const n = Number(arg('delay-tasks', '0')); return Number.isFinite(n) && n > 0 ? n : 0; })();
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
  // The message, not any text that happens to equal it: the conversation
  // header's title IS the prompt, so a bare `text=` wait stays green while the
  // bubble the draft drew is gone (R-walk-mutant proved exactly that). The
  // wait must be a selector scoped to the transcript scroller and name the
  // prompt inside it.
  const promptWait = prompt ? afterSend(([op, needle]) => op === 'wait' && /^css=/.test(String(needle)) && /\[role=.?region/.test(String(needle)) && String(needle).includes(prompt)) : -1;
  if (prompt && promptWait < 0) errs.push('J3 never waits for the typed prompt inside the transcript (the title alone is not the message)');
  const statusWait = afterSend(([op, needle]) => op === 'wait' && /^css=/.test(String(needle)) && /role=status/.test(String(needle)) && /思考|thinking/.test(String(needle)));
  if (statusWait < 0) errs.push('J3 never waits for the waiting row ([role=status], chat.thinking)');
  const REPLY = 'Fake reply from the journey fake agent.';
  const replyWait = afterSend(([op, needle]) => op === 'wait' && /^text=/.test(String(needle)) && String(needle).includes(REPLY));
  if (replyWait < 0) errs.push("J3 never waits for the fake agent's reply");
  // The mid-run follow-up is F2's lost-message path: a second message typed
  // and queued while the first round is still open must be proved on screen
  // BEFORE the first answer, marked queued, with the composer's honest guide.
  // A walk that only sends once never exercises the queue at all, and one that
  // asserts the guide but not the ordering is green while the message is lost.
  const followFillAt = afterSend(([op, sel, val]) => op === 'fill' && /textarea/.test(String(sel)) && typeof val === 'string' && val.trim() !== '');
  const followPrompt = followFillAt >= 0 ? String(steps[followFillAt][2]) : '';
  if (followFillAt < 0) errs.push('J3 never types a follow-up while the round runs (a second fill after Start)');
  else if (prompt && followPrompt === prompt) errs.push('the mid-run follow-up repeats the Start prompt; it must be a distinct message');
  else if (/\[seed\] slow/.test(followPrompt)) errs.push('the mid-run follow-up must not carry [seed] slow: it answers as soon as the first round ends');
  const followSendAt = followFillAt < 0 ? -1 : idx(([op, sel]) => op === 'send' && !/开始|Start/.test(String(sel)) && !/打断|[Ii]nterrupt/.test(String(sel)), followFillAt + 1);
  if (followFillAt >= 0 && followSendAt < 0) errs.push('J3 never sends the follow-up with the queue Send (a send step after the second fill that is not Start or the interrupt)');
  const followWaitAt = followPrompt ? idx(([op, needle]) => op === 'wait' && /^css=/.test(String(needle)) && /\[role=.?region/.test(String(needle)) && String(needle).includes(followPrompt), followFillAt + 1) : -1;
  if (followPrompt && followWaitAt < 0) errs.push('J3 never waits for the mid-run follow-up inside the transcript');
  const guideAt = afterSend(([op, needle]) => op === 'wait' && /^css=/.test(String(needle)) && /role=status/.test(String(needle)) && /已排队：本轮结束后回答|Queued — answered when the current round ends/.test(String(needle)));
  if (guideAt < 0) errs.push("J3 never waits for the composer's queued guide ([role=status], task.queuedGuide)");
  const queuedAt = afterSend(([op, needle]) => op === 'wait' && /^css=/.test(String(needle)) && /\[role=.?region/.test(String(needle)) && /排队中|Queued/.test(String(needle)));
  if (queuedAt < 0) errs.push('J3 never waits for the queued marker inside the transcript (chat.queued)');
  // The ordering proof: no answer on screen yet when the follow-up is read.
  // Counting the reply as 0 is what separates "queued mid-round" from "the
  // round ended and the message happened to be in the transcript after it".
  const zeroCountAt = afterSend(([op, needle, want]) => op === 'count' && /^text=/.test(String(needle)) && String(needle).includes(REPLY) && String(want) === '0');
  if (zeroCountAt < 0) errs.push("J3 never counts the fake agent's reply as 0 before waiting for it; the follow-up must be on screen before the first answer");
  else if (replyWait >= 0 && zeroCountAt > replyWait) errs.push('the reply count must come before the reply wait; after it the answer is already on screen');
  // The fake holds the first round open for RSI_FAKE_SLOW_SECS (10s in the
  // mutant walk), so the reply wait needs its own budget beyond the global one.
  const replyTimeout = replyWait >= 0 ? Number(steps[replyWait][2]) : NaN;
  if (replyWait >= 0 && !(Number.isFinite(replyTimeout) && replyTimeout >= 20000)) errs.push('the reply wait must carry a per-step timeout of at least 20000ms (the fake holds the first round open)');
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
  // The Stop contract (R-midrun-stop). A round stopped mid-flight must end on
  // screen, and the message queued behind it must be accounted for. Without
  // these rules a Stop that does nothing stays green: the walk photographs a
  // running round, the stop never happens, and nothing says so.
  const stopControl = (sel) => /停止|Stop/.test(String(sel)) && /aria-label/.test(String(sel));
  const afterReplied = repliedAt >= 0 ? repliedAt + 1 : 0;
  const stopClickAt = idx(([op, sel]) => op === 'click' && stopControl(sel), afterReplied);
  if (stopClickAt < 0) errs.push('J3 never presses Stop on the running round after the reply (click button[aria-label=停止|Stop])');
  const afterStop = (pred) => (stopClickAt < 0 ? -1 : idx(pred, stopClickAt + 1));
  if (stopClickAt >= 0 && afterStop(([op, sel]) => op === 'gone' && stopControl(sel)) < 0) {
    errs.push('J3 never proves the Stop control left the screen (gone button[aria-label=停止|Stop])');
  }
  if (stopClickAt >= 0 && afterStop(([op, needle]) => op === 'wait' && /^css=/.test(String(needle)) && /role=status/.test(String(needle)) && /已停止当前轮次|Stopped current round/.test(String(needle))) < 0) {
    errs.push('J3 never waits for the stopped toast (task.stopped)');
  }
  const discardAt = afterStop(([op, needle]) => op === 'wait' && String(needle).includes('queued prompt(s) discarded with the canceled task'));
  if (stopClickAt >= 0 && discardAt < 0) {
    errs.push("J3 never waits for the daemon's discard report (queued prompt(s) discarded with the canceled task)");
  }
  const stoppedAt = shotAt('stopped');
  if (stopClickAt >= 0 && stoppedAt < 0) errs.push('J3 takes no `stopped` shot after Stop');
  else if (stopClickAt >= 0 && discardAt >= 0 && stoppedAt < discardAt) errs.push('the `stopped` shot must follow the discard report');
  // The round being stopped has to be held open, and a follow-up must be
  // queued into it before Stop: that queued message is what the discard report
  // has to account for, and the only reason the report can name a count.
  const heldAt = idx(([op, sel, val]) => op === 'fill' && /textarea/.test(String(sel)) && String(val).includes('[seed] slow'), afterReplied);
  if (stopClickAt >= 0 && (heldAt < 0 || heldAt > stopClickAt)) {
    errs.push('the stopped round must start from a held prompt carrying [seed] slow after the first answer');
  }
  const stopFillAt = heldAt < 0 ? -1 : idx(([op, sel, val]) => op === 'fill' && /textarea/.test(String(sel)) && String(val).trim() !== '' && !String(val).includes('[seed] slow'), heldAt + 1);
  if (heldAt >= 0 && (stopFillAt < 0 || stopFillAt > stopClickAt)) {
    errs.push('J3 never queues a follow-up into the round it stops (the never-silently-dropped half)');
  }
  const stopGuideAt = stopFillAt < 0 ? -1 : idx(([op, needle]) => op === 'wait' && /已排队：本轮结束后回答|Queued — answered when the current round ends/.test(String(needle)), stopFillAt + 1);
  if (stopFillAt >= 0 && (stopGuideAt < 0 || stopGuideAt > stopClickAt)) {
    errs.push('J3 never waits for the queued guide before it presses Stop');
  }
  const stopFollowWaitAt = stopFillAt < 0 ? -1 : idx(([op, needle]) => op === 'wait' && /^css=/.test(String(needle)) && /\[role=.?region/.test(String(needle)) && String(needle).includes(String(steps[stopFillAt][2])), stopFillAt + 1);
  if (stopFillAt >= 0 && (stopFollowWaitAt < 0 || stopFollowWaitAt > stopClickAt)) {
    errs.push('J3 never waits for the stopped round\'s follow-up inside the transcript');
  }
  return errs;
}
// J2's contract: the review loop a person runs, not a screenshot of it. A
// comment on a changed line is saved into the tray and sent as one ordinary
// follow-up; the transcript must carry the anchor — path, hunk header and the
// quoted line — not only the words. The quote is the exact line the journey
// fake appends to the seeded notes.md; pinning it here (as J3 pins the fake
// reply) is what lets a body-only assertion be rejected.
//   node walk.mjs --check-spec [--spec path/to/journeys.json]
const J2_QUOTE = '- [seed] change: the journey walk reads this line as a real diff.';
function checkJ2Contract(spec) {
  const steps = (((spec || {}).journeys || {}).J2 || {}).steps;
  if (!Array.isArray(steps) || steps.length === 0) return ['J2 has no steps'];
  const errs = [];
  const idx = (pred, from = 0) => steps.findIndex((st, i) => i >= from && Array.isArray(st) && pred(st));
  // Strictly after `prev`: a rule that silently searches from 0 would accept
  // the step it depends on being absent.
  const after = (prev, pred) => (prev < 0 ? -1 : idx(pred, prev + 1));
  const sel = (st, i) => String((st || [])[i] ?? '');
  const cssWait = (st, re) => st[0] === 'wait' && /^css=/.test(sel(st, 1)) && re.test(sel(st, 1));
  const traySel = (st, i = 1) => /改动评论|Diff comments/.test(sel(st, i));

  // The seeded diff must be open before a changed line is commented: the file
  // click, then Monaco's diff editor. A comment box opened on whatever was
  // mounted (the file list, another file) proves nothing about the diff.
  const notesAt = idx((st) => st[0] === 'click' && /notes\.md/.test(sel(st, 1))
    && !/评论|Comment on/.test(sel(st, 1)) && !/改动评论|Diff comments/.test(sel(st, 1)));
  const diffWaitAt = idx((st) => cssWait(st, /monaco-diff-editor/));
  if (notesAt < 0) errs.push('J2 never opens the seeded changed file (click notes.md)');
  if (diffWaitAt < 0) errs.push('J2 never waits for the diff editor (wait css=.monaco-diff-editor)');

  // The entry is the changed line's own: Alt+C on the cursor line, or the
  // line's glyph. The box wait names the path, so a box opened elsewhere
  // cannot stand in.
  const openAt = idx((st) => (st[0] === 'key' && /Alt\+.*C/i.test(sel(st, 1)))
    || (st[0] === 'click' && /kin-diff-comment-glyph/.test(sel(st, 1))));
  if (openAt < 0) errs.push('J2 never opens the comment box on a changed line (key Alt+C, or click .kin-diff-comment-glyph)');
  else if (notesAt >= 0 && openAt < notesAt) errs.push('J2 opens the comment box before the seeded file is open');
  if (openAt >= 0 && diffWaitAt >= 0 && openAt < diffWaitAt) errs.push('J2 opens the comment box before the diff is open');
  const boxAt = idx((st) => cssWait(st, /section\[aria-label/) && /notes\.md/.test(sel(st, 1)) && /aria-label\^=/.test(sel(st, 1)));
  if (boxAt < 0) errs.push('J2 never waits for the comment box naming notes.md (section[aria-label^=…])');
  else if (openAt >= 0 && boxAt < openAt) errs.push('J2 waits for the comment box before opening it');

  // The person's words, typed into the box itself, then saved into the tray.
  const fillAt = idx((st) => st[0] === 'fill' && /textarea/.test(sel(st, 1)) && /aria-label/.test(sel(st, 1))
    && typeof st[2] === 'string' && st[2].trim() !== '');
  const body = fillAt >= 0 ? String(steps[fillAt][2]) : '';
  if (fillAt < 0) errs.push('J2 never types the comment into the box textarea');
  else if (boxAt >= 0 && fillAt < boxAt) errs.push('J2 fills the comment before the box is on screen');
  const saveAt = after(fillAt, (st) => st[0] === 'click' && /保存|Save/.test(sel(st, 1)));
  if (saveAt < 0) errs.push('J2 never saves the comment (click Save) after typing it');

  // Saved means one row in the tray, carrying both the path and the line's
  // own text — not a count of text that happens to appear somewhere.
  const trayWaitAt = after(saveAt, (st) => cssWait(st, /li:has-text/) && traySel(st) && /notes\.md/.test(sel(st, 1)) && sel(st, 1).includes(J2_QUOTE));
  if (trayWaitAt < 0) errs.push('J2 never waits for the tray row naming notes.md and the quoted changed line');
  const countAt = after(trayWaitAt, (st) => st[0] === 'count' && traySel(st) && String(st[2]) === '1');
  if (countAt < 0) errs.push('J2 never asserts the tray holds exactly one comment (count … 1)');

  // The press itself, after the row is read: the tray's send button, or the
  // tray's documented ⌘/Ctrl+Enter on a focused row (the seeded pending
  // approval floats over the button at Mac widths, and the keyboard path is
  // the same send()).
  const clickSendAt = after(countAt, (st) => st[0] === 'click' && traySel(st) && /发送|Send/.test(sel(st, 1)));
  const rowFocusAt = after(countAt, (st) => st[0] === 'focus' && traySel(st));
  const keySendAt = after(rowFocusAt, (st) => st[0] === 'key' && /(Meta|Ctrl|Control)\+Enter/i.test(sel(st, 1)));
  const sendAt = clickSendAt >= 0 ? clickSendAt : keySendAt;
  if (sendAt < 0) errs.push('J2 never sends the tray (click the send button, or focus a row and press Meta/Ctrl+Enter); a transcript assertion without the send proves nothing');

  // The transcript must carry the whole anchor. Counting the comment body
  // alone is the mutant's shape: the words arrive, the path/hunk/quote are
  // gone, and a reviewer can no longer tell what was commented.
  const transcriptAt = after(sendAt, (st) => st[0] === 'wait' && /^css=/.test(sel(st, 1)) && /\[role=.?region/.test(sel(st, 1))
    && body !== '' && sel(st, 1).includes(body)
    && /notes\.md/.test(sel(st, 1))
    && /@@\s*-\d+,\d+\s*\+\d+,\d+\s*@@/.test(sel(st, 1))
    && sel(st, 1).includes(J2_QUOTE));
  if (transcriptAt < 0) {
    errs.push('J2 never asserts the sent follow-up carries the path, hunk header and quote in the transcript');
  }
  // Both widths walk the same seeded conversation against one daemon. A body
  // shared across viewports lets the second width's transcript wait be
  // satisfied by the first width's message, so the second send is unproven;
  // the body carries {vp}, and no substituted body may be a substring of
  // another's (plain `mac` is inside `mac-wide`, so the token is bracketed).
  const viewports = (((spec || {}).journeys || {}).J2 || {}).viewports;
  const sentBodies = Array.isArray(viewports) ? viewports.map((vp) => applyVpStep([body], vp)[0]) : [];
  if (body === '' || !body.includes('{vp}')) {
    errs.push('J2 types one comment body at every viewport; put a {vp} token in the body and the transcript wait so each width proves its own send');
  } else if (sentBodies.some((mine, i) => sentBodies.some((other, k) => i !== k && other.includes(mine)))) {
    errs.push('J2\'s {vp} token leaves one viewport\'s comment body inside another\'s; bracket it, e.g. [{vp}]');
  }
  // The loop closes: the tray is empty again (or says it was sent), otherwise
  // the send is unproven and the comments are still waiting.
  const goneAt = after(sendAt, (st) => st[0] === 'gone' && traySel(st));
  const sentAt = after(sendAt, (st) => st[0] === 'wait' && /已发回对话|Sent back to the conversation/.test(sel(st, 1)));
  if (sentAt < 0 && goneAt < 0) errs.push('J2 never proves the tray emptied after send (gone … or the sent line)');

  // The screenshots are the reviewable evidence, in the order the loop runs.
  const shotAt = (name) => steps.findIndex((st) => Array.isArray(st) && st[0] === 'shot' && st[1] === name);
  const boxShot = shotAt('diff-comment-box'), trayShot = shotAt('diff-comment-tray'), sentShot = shotAt('diff-comment-sent');
  if (boxShot < 0) errs.push('J2 takes no `diff-comment-box` shot');
  else if (boxAt >= 0 && (boxShot < boxAt || (saveAt >= 0 && boxShot > saveAt))) errs.push('the `diff-comment-box` shot must be taken while the box is open, before Save');
  if (trayShot < 0) errs.push('J2 takes no `diff-comment-tray` shot');
  else if (trayWaitAt >= 0 && trayShot < trayWaitAt) errs.push('the `diff-comment-tray` shot must follow the tray row wait');
  if (sentShot < 0) errs.push('J2 takes no `diff-comment-sent` shot');
  else if (transcriptAt >= 0 && sentShot < transcriptAt) errs.push('the `diff-comment-sent` shot must follow the transcript assertion');

  // The rerun leg (R-p3-rerun-comment). A person comments a changed line, then
  // asks the agent for another round. The tray must keep the comment: the row
  // moves to the line its quote moved to, and when the quote is gone the row
  // says 该行已变化 / This line has changed and still carries the quote. Without
  // these rules a walk sends [seed] shift and [seed] rewrite and photographs
  // whatever the tray happens to show: a dropped report renders an absent
  // anchor as live (never as stale), which is a silent lie rather than a
  // missing badge.
  const J2_SHIFT = '[seed] shift';
  const J2_REWRITE = '[seed] rewrite';
  const J2_STALE = /该行已变化|This line has changed/;
  const rerunFrom = sentShot >= 0 ? sentShot + 1 : (sendAt >= 0 ? sendAt + 1 : 0);
  // The comment box is the only surface whose Save belongs to this leg; a bare
  // Save elsewhere proves nothing about the tray.
  const boxScoped = (v) => /section\[aria-label/.test(String(v)) && /评论|Comment on/.test(String(v));
  const isBoxSave = (st) => st[0] === 'click' && /保存|Save/.test(sel(st, 1)) && boxScoped(sel(st, 1));
  // The composer's own send, never the tray's button: the tray holds the
  // comment under test and must not be emptied by the rerun.
  const isComposerSend = (st) => st[0] === 'send' && /发送|Send/.test(sel(st, 1)) && !traySel(st);
  // The rerun prompt is typed into the composer — not into Monaco's hidden
  // editor textarea and not into a comment box, both of which are on screen
  // while the diff is open.
  const isMarkerFill = (st, marker) => st[0] === 'fill' && typeof st[2] === 'string' && st[2].includes(marker)
    && /textarea/.test(sel(st, 1)) && !/monaco|editor\.modified/.test(sel(st, 1)) && !/评论|Comment on/.test(sel(st, 1));
  const trayRowWithQuote = (st) => cssWait(st, /li:has-text/) && traySel(st) && /notes\.md/.test(sel(st, 1)) && sel(st, 1).includes(J2_QUOTE);
  // The stale row keeps the saved quote but no longer has a live line, so its
  // wait may name only the badge and the quote.
  const staleRowWait = (st) => cssWait(st, /li:has-text/) && traySel(st) && J2_STALE.test(sel(st, 1)) && sel(st, 1).includes(J2_QUOTE);
  const namedLines = (v) => [...String(v).matchAll(/notes\.md:(\d+)/g)].map((m) => Number(m[1]));

  // (a) A second comment, saved while the first one's send has left the tray
  // empty. Its box must pin the line, or "re-anchored to a different line" has
  // nothing to be different from.
  const box2At = idx((st) => cssWait(st, /section\[aria-label/) && /notes\.md:\d+/.test(sel(st, 1)) && /aria-label\^=/.test(sel(st, 1)), rerunFrom);
  const box2Line = box2At >= 0 ? (namedLines(sel(steps[box2At], 1))[0] ?? NaN) : NaN;
  if (box2At < 0) errs.push('J2 never reopens the comment box naming notes.md:<line> after the first send; the rerun must start from a saved comment and the box must pin the line');
  const fill2At = after(box2At, (st) => st[0] === 'fill' && /textarea/.test(sel(st, 1)) && boxScoped(sel(st, 1)) && typeof st[2] === 'string' && st[2].trim() !== '');
  if (box2At >= 0 && fill2At < 0) errs.push('J2 never types the second comment into the box textarea');
  const save2At = after(fill2At, isBoxSave);
  if (fill2At >= 0 && save2At < 0) errs.push('J2 never saves the second comment (click Save in the box); a rerun without a saved comment proves nothing');
  const tray2At = after(save2At, trayRowWithQuote);
  if (save2At >= 0 && tray2At < 0) errs.push('J2 never reads the second comment in the tray (a row naming notes.md and the quoted line) before the rerun');
  const count2At = after(tray2At, (st) => st[0] === 'count' && traySel(st) && String(st[2]) === '1');
  if (tray2At >= 0 && count2At < 0) errs.push('J2 never asserts the tray holds exactly one comment again after the second Save (count … 1)');

  // (b) The round that moves the seeded line. It has to be sent after the
  // comment is saved, or the saved line is already the moved one.
  const shiftFillAt = idx((st) => isMarkerFill(st, J2_SHIFT), rerunFrom);
  const shiftAt = after(shiftFillAt, isComposerSend);
  if (shiftFillAt < 0 || shiftAt < 0) {
    errs.push('J2 never sends a rerun round asking for [seed] shift after the second comment is saved; without it the tray is never re-anchored by a real fresh diff');
  } else if (save2At >= 0 && shiftAt < save2At) {
    errs.push('J2 sends [seed] shift before the second comment is saved; the rerun must start from a saved comment');
  }
  if (shiftAt >= 0 && tray2At >= 0 && tray2At > shiftAt) {
    errs.push('J2 reads the tray holding the second comment after the [seed] shift send; the row and its count must come first');
  }

  // (c) Re-anchored means a DIFFERENT line number carrying the same quote.
  // Waiting for the saved line again would pass on a stale report that never
  // re-pointed anything.
  const reanchorAt = after(shiftAt, (st) => {
    if (!trayRowWithQuote(st)) return false;
    const lines = namedLines(sel(st, 1));
    return Number.isInteger(box2Line) && lines.length > 0 && lines.some((n) => n !== box2Line);
  });
  if (shiftAt >= 0 && reanchorAt < 0) {
    errs.push('J2 never asserts the saved comment re-anchored to a different line (a tray row naming notes.md:<new line> with the saved quote) after [seed] shift');
  }
  // (d) At that moment no row may claim the line changed: a live row is never
  // implied stale.
  const staleZeroAt = after(reanchorAt, (st) => st[0] === 'count' && traySel(st) && J2_STALE.test(sel(st, 1)) && String(st[2]) === '0');
  if (reanchorAt >= 0 && staleZeroAt < 0) errs.push('J2 never asserts no row is marked 该行已变化 while the comment is re-anchored (count … 0)');

  // (e) Then the round that removes the quoted line.
  const rewriteFillAt = after(reanchorAt, (st) => isMarkerFill(st, J2_REWRITE));
  const rewriteAt = after(rewriteFillAt, isComposerSend);
  if (reanchorAt >= 0 && (rewriteFillAt < 0 || rewriteAt < 0)) {
    errs.push('J2 never sends a second rerun asking for [seed] rewrite after the re-anchored row; the stale half of the contract is unwalked');
  }
  // (f) The stale row: the badge AND the saved quote, so a row that merely
  // says "changed" without saying what was commented cannot stand in.
  const staleWaitAt = after(rewriteAt, staleRowWait);
  if (rewriteAt >= 0 && staleWaitAt < 0) {
    errs.push('J2 never waits for the stale row (该行已变化 / This line has changed) carrying the saved quote after [seed] rewrite');
  }
  // (g) Kept, not dropped and not duplicated.
  const keptAt = after(staleWaitAt, (st) => st[0] === 'count' && traySel(st) && String(st[2]) === '1');
  if (staleWaitAt >= 0 && keptAt < 0) errs.push('J2 never proves the stale comment was kept and not duplicated (count the tray rows = 1 after the stale wait)');

  // (h) The two screenshots, each of the state it names.
  const reanchorShot = shotAt('diff-comment-reanchored'), staleShot = shotAt('diff-comment-stale');
  if (reanchorShot < 0) errs.push('J2 takes no `diff-comment-reanchored` shot');
  else if (reanchorAt >= 0 && reanchorShot < reanchorAt) errs.push('the `diff-comment-reanchored` shot must follow the re-anchored row wait');
  else if (rewriteAt >= 0 && reanchorShot > rewriteAt) errs.push('the `diff-comment-reanchored` shot must be taken before [seed] rewrite; after it the row is stale');
  if (staleShot < 0) errs.push('J2 takes no `diff-comment-stale` shot');
  else if (staleWaitAt >= 0 && staleShot < staleWaitAt) errs.push('the `diff-comment-stale` shot must follow the stale row wait');
  return errs;
}
// J8's contract: the review loop the way a thumb runs it at 390. J2 proves the
// same loop from the keyboard (⌥C, ⌘Enter), which a phone does not have, so J8
// is its own journey: tap the changed line's glyph, write in the sheet, Save,
// read the tray's one row, tap Send, and find the anchored follow-up in the
// transcript. Without these rules a J8 that presses Alt+C, sends with a chord,
// or asserts only the words would be green while the tap path is broken.
const J8_QUOTE = '- [seed] change: the journey walk reads this line as a real diff.';
// The one seeded conversation J2's rerun leg rewrites: `[seed] shift` moves
// the commented line and `[seed] rewrite` deletes the quoted text. J8 must
// review its own seeded diff, or its tray wait asks for a line that is gone
// and the failure gets excused as a known artifact.
const J8_CONVERSATION = 'Morning planning';
function checkJ8Contract(spec) {
  const journey = (((spec || {}).journeys || {}).J8) || {};
  const steps = journey.steps;
  if (!Array.isArray(steps) || steps.length === 0) return ['J8 has no steps'];
  const errs = [];
  const idx = (pred, from = 0) => steps.findIndex((st, i) => i >= from && Array.isArray(st) && pred(st));
  const after = (prev, pred) => (prev < 0 ? -1 : idx(pred, prev + 1));
  const sel = (st, i) => String((st || [])[i] ?? '');
  const cssWait = (st, re) => st[0] === 'wait' && /^css=/.test(sel(st, 1)) && re.test(sel(st, 1));
  const traySel = (st, i = 1) => /改动评论|Diff comments/.test(sel(st, i));

  // Phone only. J2 already walks the Mac keyboard path, and replaying it at
  // 390 would prove the chords rather than the tap a phone person uses.
  const viewports = journey.viewports;
  if (!Array.isArray(viewports) || viewports.length !== 1 || viewports[0] !== 'phone') {
    errs.push('J8 is the phone review loop: its viewports must be exactly ["phone"]; the Mac loop is J2');
  }

  // The fixture. J2 rewrites [seed] Morning planning's notes.md in the same
  // walk, so a J8 that opens that conversation quotes a line the first journey
  // deleted; its tray wait then fails for a fixture reason and the gate learns
  // to excuse it. The phone review reads its own seeded diff.
  const listAt = idx((st) => st[0] === 'goto' && String(sel(st, 1)).startsWith('/sessions'));
  const openAt = after(listAt, (st) => st[0] === 'click');
  if (openAt < 0) {
    errs.push('J8 never opens a conversation from the seeded list (click … after goto /sessions)');
  } else if (String(sel(steps[openAt], 1)).includes(J8_CONVERSATION)) {
    errs.push(`J8 opens ${J8_CONVERSATION}, the seeded conversation J2's [seed] shift / [seed] rewrite rewrites; give J8 its own seeded conversation`);
  }

  // The seeded diff must be open before a changed line is tapped. A tap on a
  // glyph that is not there proves nothing about the diff.
  const notesAt = idx((st) => st[0] === 'click' && /notes\.md/.test(sel(st, 1))
    && !/评论|Comment on/.test(sel(st, 1)) && !/改动评论|Diff comments/.test(sel(st, 1)));
  const diffWaitAt = idx((st) => cssWait(st, /monaco-diff-editor/));
  if (notesAt < 0) errs.push('J8 never opens the seeded changed file (click notes.md)');
  if (diffWaitAt < 0) errs.push('J8 never waits for the diff editor (wait css=.monaco-diff-editor)');

  // The entry is a pointer tap on the line's own glyph. Alt+C may exist in the
  // product for the desktop, but it must not be what J8 walks: a phone has no
  // keyboard, so a chord here would leave the tap path unproven. The tap names
  // the line by index and is not optional: an optional tap that resolves to
  // nothing walks on and fails two steps later, where the cause is invisible.
  const glyphClick = (st) => st[0] === 'click' && /kin-diff-comment-glyph/.test(sel(st, 1));
  const glyphAt = idx((st) => glyphClick(st) && !sel(st, 1).startsWith('?') && />>\s*nth=\d+/.test(sel(st, 1)));
  const keyOpenAt = idx((st) => st[0] === 'key' && /Alt\+.*C/i.test(sel(st, 1)));
  if (keyOpenAt >= 0) {
    errs.push('J8 uses the desktop Alt+C chord; the phone entry must be a tap on the changed line\'s glyph (click .kin-diff-comment-glyph)');
  }
  if (glyphAt < 0) {
    const loose = idx((st) => glyphClick(st));
    errs.push(loose >= 0
      ? 'J8 taps the glyph without pinning a line (click css=.kin-diff-comment-glyph >> nth=…) and must not mark the tap optional'
      : 'J8 never taps a changed line\'s glyph (click .kin-diff-comment-glyph)');
  } else {
    if (notesAt >= 0 && glyphAt < notesAt) errs.push('J8 taps the glyph before the seeded file is open');
    if (diffWaitAt >= 0 && glyphAt < diffWaitAt) errs.push('J8 taps the glyph before the diff is open');
  }
  // The sheet names the seeded line, so a tap that landed on another changed
  // line is caught right here rather than at the tray or the transcript.
  const boxAt = idx((st) => cssWait(st, /section\[aria-label/) && /notes\.md:5/.test(sel(st, 1)) && /aria-label\^=/.test(sel(st, 1)));
  if (boxAt < 0) errs.push('J8 never waits for the comment sheet naming notes.md:5 (section[aria-label^=…])');
  else if (glyphAt >= 0 && boxAt < glyphAt) errs.push('J8 waits for the comment sheet before tapping the glyph');

  // The person's words, typed into the sheet itself, then saved into the tray.
  const fillAt = idx((st) => st[0] === 'fill' && /textarea/.test(sel(st, 1)) && /aria-label/.test(sel(st, 1))
    && typeof st[2] === 'string' && st[2].trim() !== '');
  const body = fillAt >= 0 ? String(steps[fillAt][2]) : '';
  if (fillAt < 0) errs.push('J8 never types the comment into the sheet textarea');
  else if (boxAt >= 0 && fillAt < boxAt) errs.push('J8 fills the comment before the sheet is on screen');
  const saveAt = after(fillAt, (st) => st[0] === 'click' && /保存|Save/.test(sel(st, 1)));
  if (saveAt < 0) errs.push('J8 never saves the comment (click Save) after typing it');

  // Saved means one row in the tray, carrying both the path and the line's
  // own text — not a count of text that happens to appear somewhere.
  const trayWaitAt = after(saveAt, (st) => cssWait(st, /li:has-text/) && traySel(st) && /notes\.md/.test(sel(st, 1)) && sel(st, 1).includes(J8_QUOTE));
  if (trayWaitAt < 0) errs.push('J8 never waits for the tray row naming notes.md and the quoted changed line');
  const countAt = after(trayWaitAt, (st) => st[0] === 'count' && traySel(st) && String(st[2]) === '1');
  if (countAt < 0) errs.push('J8 never asserts the tray holds exactly one comment (count … 1)');

  // The press is the tray's own button: a thumb at 390 has no Meta/Ctrl+Enter.
  // The row must already be read, or the send is unproven (an empty tray).
  const sendAt = idx((st) => st[0] === 'click' && traySel(st) && /发送|Send/.test(sel(st, 1)));
  if (sendAt < 0) {
    const keySend = idx((st) => st[0] === 'key' && /(Meta|Ctrl|Control)\+Enter/i.test(sel(st, 1)));
    errs.push('J8 never taps the tray\'s send (click the tray button 发送|Send); a thumb has no Meta/Ctrl+Enter'
      + (keySend >= 0 ? ' — the spec only presses the chord' : ''));
  } else if (countAt >= 0 && sendAt < countAt) {
    errs.push('J8 sends the tray before it holds the saved comment; the one-row wait and count must come first');
  }

  // The transcript must carry the whole anchor. Counting the comment body
  // alone is the mutant's shape: the words arrive, the path/hunk/quote are
  // gone, and the reviewer can no longer tell what was commented.
  const transcriptAt = sendAt < 0 ? -1 : after(sendAt, (st) => st[0] === 'wait' && /^css=/.test(sel(st, 1)) && /\[role=.?region/.test(sel(st, 1))
    && body !== '' && sel(st, 1).includes(body)
    && /notes\.md/.test(sel(st, 1))
    && /@@\s*-\d+,\d+\s*\+\d+,\d+\s*@@/.test(sel(st, 1))
    && sel(st, 1).includes(J8_QUOTE));
  if (sendAt >= 0 && transcriptAt < 0) {
    errs.push('J8 never asserts the sent follow-up carries the path, hunk header and quote in the transcript');
  }
  // The follow-up is exactly one of J8's own *settled* messages, and it still
  // carries the whole anchor. The pending echo is also a `data-message-key`
  // row and carries the full composed comment, so the count must exclude
  // `pending-*` and re-assert path/hunk/quote on the settled row itself:
  // otherwise a spec that drops the exclusion, or a daemon event that keeps
  // the words but drops the anchor, still walks green.
  const ownMessageCountAt = after(transcriptAt, (st) => st[0] === 'count'
    && /data-message-key/.test(sel(st, 1)) && sel(st, 1).includes(':not([data-message-key^=')
    && body !== '' && sel(st, 1).includes(body)
    && /notes\.md:5/.test(sel(st, 1)) && sel(st, 1).includes(J8_QUOTE)
    && /@@\s*-\d+,\d+\s*\+\d+,\d+\s*@@/.test(sel(st, 1))
    && String(st[2]) === '1');
  if (transcriptAt >= 0 && ownMessageCountAt < 0) {
    errs.push('J8 never counts exactly one settled message carrying its own comment body and the whole anchor (count [data-message-key]:not([data-message-key^=\'pending-\']) … notes.md:5 … hunk header … quoted line = 1); the transcript wait can pass on the pending bubble');
  }
  // The loop closes: the tray is empty again (or says it was sent), otherwise
  // the send is unproven and the comments are still waiting.
  const goneAt = sendAt < 0 ? -1 : after(sendAt, (st) => st[0] === 'gone' && traySel(st));
  const sentAt = sendAt < 0 ? -1 : after(sendAt, (st) => st[0] === 'wait' && /已发回对话|Sent back to the conversation/.test(sel(st, 1)));
  if (sendAt >= 0 && goneAt < 0 && sentAt < 0) errs.push('J8 never proves the tray emptied after send (gone … or the sent line)');

  // The screenshots are the reviewable evidence, in the order the loop runs.
  const shotAt = (name) => steps.findIndex((st) => Array.isArray(st) && st[0] === 'shot' && st[1] === name);
  const sheetShot = shotAt('diff-comment-sheet'), trayShot = shotAt('diff-comment-tray'), sentShot = shotAt('diff-comment-sent');
  if (sheetShot < 0) errs.push('J8 takes no `diff-comment-sheet` shot');
  else if (boxAt >= 0 && (sheetShot < boxAt || (saveAt >= 0 && sheetShot > saveAt))) errs.push('the `diff-comment-sheet` shot must be taken while the sheet is open, before Save');
  if (trayShot < 0) errs.push('J8 takes no `diff-comment-tray` shot');
  else if (trayWaitAt >= 0 && trayShot < trayWaitAt) errs.push('the `diff-comment-tray` shot must follow the tray row wait');
  if (sentShot < 0) errs.push('J8 takes no `diff-comment-sent` shot');
  else if (transcriptAt >= 0 && sentShot < transcriptAt) errs.push('the `diff-comment-sent` shot must follow the transcript assertion');

  // A workspace diff that no longer selects J8 would let the phone loop rot
  // without the gate ever walking it. Same first-match rule the walker uses.
  const paths = Array.isArray(spec.paths) ? spec.paths : [];
  const mapsToJ8 = (file) => {
    const row = paths.find(([re]) => re.split('|').some((p) => file.startsWith(p)));
    return !!row && Array.isArray(row[1]) && row[1].includes('J8');
  };
  for (const file of ['ui/src/components/workspace/WorkspacePanel.tsx', 'ui/src/pages/TaskDetailPage.tsx', 'ui/src/components/sessions/SessionList.tsx', 'ui/src/components/ui/Button.tsx']) {
    if (!mapsToJ8(file)) {
      errs.push(`the paths table does not map ${file} to J8; a diff there would not walk the phone review loop`);
    }
  }
  return errs;
}
// J9's contract: F4 — a switch is not a page load. Leaving a conversation for
// another one (or for another area) and coming back must keep the same shell
// element, the transcript where the reader left it, and the unsent draft in
// the composer. The keep-alive host ships and pieces of it are pinned in DOM
// tests, but no walk ever switches and comes back; a regression that remounts
// the shell, resets the scroller, or drops the draft is invisible to the gate.
// The proof is element identity, not a screenshot: `node` tags the shell once
// and asserts the same element after every route change, `scroll`/`scroll-kept`
// bracket the transcript's position, and `value` reads the draft back. A
// `goto` after the conversation is open would reload the document and make the
// shell question meaningless, so it is rejected.
//   node walk.mjs --check-spec [--spec path/to/journeys.json]
function checkJ9Contract(spec) {
  const journey = (((spec || {}).journeys || {}).J9) || {};
  const steps = journey.steps;
  if (!Array.isArray(steps) || steps.length === 0) return ['J9 has no steps'];
  const errs = [];
  const idx = (pred, from = 0) => steps.findIndex((st, i) => i >= from && Array.isArray(st) && pred(st));
  const after = (prev, pred) => (prev < 0 ? -1 : idx(pred, prev + 1));
  const sel = (st, i) => String((st || [])[i] ?? '');

  // The phone half needs per-viewport steps (#282's `vp` scope), so this
  // journey is the Mac proof and must not pretend to be the phone one.
  const viewports = journey.viewports;
  if (!Array.isArray(viewports) || viewports.length !== 1 || viewports[0] !== 'mac') {
    errs.push('J9 is the Mac switch proof: its viewports must be exactly ["mac"]; the phone switch is its own journey');
  }

  // Open, leave for a different conversation, come back. A journey that never
  // leaves proves nothing, and one that leaves and never returns proves only
  // the first half.
  const openAt = idx((st) => st[0] === 'click' && /Morning planning/.test(sel(st, 1)));
  const switchAt = after(openAt, (st) => st[0] === 'click' && /Failed migration/.test(sel(st, 1)));
  const backAt = after(switchAt, (st) => st[0] === 'click' && /Morning planning/.test(sel(st, 1)));
  if (openAt < 0) errs.push('J9 never opens the seeded conversation from the list (click … Morning planning)');
  if (switchAt < 0) errs.push('J9 never switches to the second seeded conversation (click … Failed migration)');
  if (backAt < 0) errs.push('J9 never returns to the conversation it left (click … Morning planning again)');

  // A `goto` reloads the document. The shell claim is about client-side
  // navigation, so nothing after the first open may replace the page.
  if (openAt >= 0 && steps.findIndex((st, i) => i > openAt && Array.isArray(st) && st[0] === 'goto') >= 0) {
    errs.push('J9 reloads the document with goto after the conversation is open; the switch must be client-side navigation');
  }

  // Shell identity. One tag before the first switch, then the same tag after
  // every route change: a shell remounted on the new pathname is a page load
  // wearing the same markup, and only element identity catches it.
  const nodes = [];
  steps.forEach((st, i) => { if (Array.isArray(st) && st[0] === 'node') nodes.push(i); });
  const nodeName = nodes.length ? sel(steps[nodes[0]], 2) : '';
  const tagged = nodes.find((i) => i < (switchAt < 0 ? steps.length : switchAt));
  if (!nodeName || tagged === undefined) {
    errs.push('J9 never tags the shell before the switch (node css=… shell)');
  } else if (!/^css=/.test(sel(steps[tagged], 1))) {
    errs.push('J9\'s shell tag must name the element with css=<selector>');
  }
  // The next area-nav click after `from`, or the end of the journey: the
  // assertion must sit between the route change and the next one, so a node
  // after the *return* cannot stand in for the one the switch needed.
  const areaNavAt = (from) => steps.findIndex((st, i) => i > from && Array.isArray(st) && st[0] === 'click' && sel(st, 1).includes('data-area='));
  const sameShell = (from, to = steps.length) => nodes.find((i) => i > from && i < to && sel(steps[i], 2) === nodeName);
  if (nodeName) {
    if (switchAt >= 0 && sameShell(switchAt, backAt < 0 ? steps.length : backAt) === undefined) {
      errs.push('J9 never asserts the same shell node after the switch; a remount would go unseen');
    }
    const firstArea = backAt < 0 ? -1 : areaNavAt(backAt);
    if (backAt >= 0 && sameShell(backAt, firstArea < 0 ? steps.length : firstArea) === undefined) {
      errs.push('J9 never asserts the same shell node after returning to the conversation');
    }
  }
  // Area changes are route changes too. A shell keyed on the pathname dies on
  // /sessions → /projects just as it dies on one conversation → another.
  const areas = ['projects', 'settings'].map((area) => ({
    area,
    at: idx((st) => st[0] === 'click' && sel(st, 1).includes(`data-area="${area}"`)),
  }));
  areas.forEach(({ area, at: areaAt }, i) => {
    if (areaAt < 0) {
      errs.push(`J9 never visits the ${area} area (click [data-area="${area}"])`);
      return;
    }
    const nextAt = i + 1 < areas.length && areas[i + 1].at >= 0 ? areas[i + 1].at : steps.length;
    if (nodeName && sameShell(areaAt, nextAt) === undefined) {
      errs.push(`J9 never asserts the same shell node after the ${area} area change`);
    }
  });

  // The composer is part of the shell claim (TASTE 15). #342 tags the `form`
  // itself by name: `composer` before the switch, `composer-failed` on the
  // other conversation, `composer` again after the return. A per-route re-key
  // leaves the shell node identical while the input is a new element, so
  // without these tags the walk photographs the right pane and proves nothing.
  const composerTag = (name, from, to = steps.length) => (nodes.find((i) => i > from && i < to && sel(steps[i], 2) === name && /^css=/.test(sel(steps[i], 1))) ?? -1);
  const composerBefore = switchAt < 0 ? -1 : (nodes.find((i) => i < switchAt && sel(steps[i], 2) === 'composer' && /^css=/.test(sel(steps[i], 1))) ?? -1);
  const composerFailed = switchAt < 0 || backAt < 0 ? -1 : composerTag('composer-failed', switchAt, backAt);
  const composerBack = backAt < 0 ? -1 : composerTag('composer', backAt);
  if (switchAt >= 0 && composerBefore < 0) {
    errs.push('J9 never tags the composer element before the switch (node css=… composer)');
  }
  if (switchAt >= 0 && backAt >= 0 && composerFailed < 0) {
    errs.push("J9 never tags the second conversation's composer (node css=… composer-failed)");
  }
  if (backAt >= 0 && composerBack < 0) {
    errs.push('J9 never tags the same composer element again after the return (node css=… composer); a per-route re-key would go unseen');
  }

  // The transcript's place. The offset must be numeric and away from the top:
  // a remount that starts at 0, or the product's own jump-to-bottom on a fresh
  // pane, must not be able to satisfy the return by accident.
  const transcript = (st) => sel(st, 1).startsWith('css=') && /role=.?region/.test(sel(st, 1));
  const scrollAt = idx((st) => st[0] === 'scroll' && transcript(st));
  const keptAt = backAt < 0 ? -1 : idx((st) => st[0] === 'scroll-kept' && transcript(st), backAt + 1);
  if (scrollAt < 0) {
    errs.push('J9 never scrolls the transcript before the switch; the return has no position to prove');
  } else {
    const asked = sel(steps[scrollAt], 2);
    if (!/^\d+$/.test(asked) || Number(asked) < 96) {
      errs.push('J9 must scroll the transcript to a numeric middle offset of at least 96px, not ' + JSON.stringify(asked));
    }
    if (switchAt >= 0 && scrollAt > switchAt) {
      errs.push('J9 scrolls the transcript after the switch; the position must be left before it');
    }
  }
  if (keptAt < 0) {
    errs.push('J9 never asserts the transcript came back where it was left (scroll-kept after the return)');
  } else if (scrollAt >= 0) {
    const asked = Number(sel(steps[scrollAt], 2));
    const kept = Number(sel(steps[keptAt], 2));
    if (!Number.isFinite(kept) || Math.abs(kept - asked) > 48) {
      errs.push('J9\'s scroll-kept offset must be the offset it scrolled to (within the walker\'s 48px tolerance)');
    }
  }

  // The half-typed message. It must be typed before the conversation is left,
  // must not be sent, and must be read back from the composer after the
  // return; a walk that only checks the route survived leaves F4's draft half
  // unproven. Sends in the journey are allowed (they give the transcript a
  // position to lose), which is why the draft is the last fill before the
  // switch that no `send` follows — not merely the first fill.
  const fills = [];
  steps.forEach((st, i) => {
    if (Array.isArray(st) && st[0] === 'fill' && /textarea/.test(sel(st, 1)) && typeof st[2] === 'string' && st[2].trim() !== '') fills.push(i);
  });
  const sentAfter = (i) => {
    const send = idx((st) => st[0] === 'send', i + 1);
    return send >= 0 && (switchAt < 0 || send < switchAt);
  };
  const draftFills = switchAt < 0 ? fills : fills.filter((i) => i < switchAt && !sentAfter(i));
  const draftFillAt = draftFills.length ? draftFills[draftFills.length - 1] : -1;
  const draft = draftFillAt >= 0 ? String(steps[draftFillAt][2]) : '';
  if (fills.length === 0) {
    errs.push('J9 never types an unsent draft into the composer');
  } else if (draftFillAt < 0) {
    errs.push('J9 never leaves an unsent draft in the composer before the switch; every text it typed was sent');
  }
  const draftAt = backAt < 0 || draftFillAt < 0 ? -1
    : idx((st) => st[0] === 'value' && /textarea/.test(sel(st, 1)) && sel(st, 2) === draft, backAt + 1);
  if (draftFillAt >= 0 && draftAt < 0) {
    errs.push('J9 never proves the draft survived the return (value textarea … after the return)');
  }

  // The screenshots are the reviewable evidence, in the order the switch runs.
  const shotAt = (name) => steps.findIndex((st) => Array.isArray(st) && st[0] === 'shot' && st[1] === name);
  const chatShot = shotAt('switch-chat'), backShot = shotAt('switch-back'), areaShot = shotAt('area-projects');
  if (chatShot < 0) errs.push('J9 takes no `switch-chat` shot');
  else if (switchAt >= 0 && chatShot > switchAt) errs.push('the `switch-chat` shot must be taken before the switch');
  if (backShot < 0) errs.push('J9 takes no `switch-back` shot');
  else if (backAt >= 0 && backShot < backAt) errs.push('the `switch-back` shot must follow the return');
  if (areaShot < 0) errs.push('J9 takes no `area-projects` shot');

  // A shell or conversation-pane diff that no longer selects J9 would let the
  // keep-alive contract rot without the gate ever walking it. Same first-match
  // rule the walker uses, and only the rows that can break the switch.
  const paths = Array.isArray(spec.paths) ? spec.paths : [];
  const mapsToJ9 = (file) => {
    const row = paths.find(([re]) => re.split('|').some((p) => file.startsWith(p)));
    return !!row && Array.isArray(row[1]) && row[1].includes('J9');
  };
  for (const file of ['ui/src/components/layout/AppShell.tsx', 'ui/src/pages/TaskDetailPage.tsx']) {
    if (!mapsToJ9(file)) {
      errs.push(`the paths table does not map ${file} to J9; a diff there would not walk the switch`);
    }
  }
  return errs;
}
// J11's contract: F4 at 390 — the phone switch keeps the same shell element,
// the transcript where the reader left it, and the unsent draft. J9 proves the
// promise on the Mac; the phone has its own Back, its own list rows and a
// footer, and nothing walked the switch there. The leaving is a `back` to the
// list (a `goto` would reload the document), and the area round goes through
// the footer: the pane is off screen while the reader is in Routines, so the
// return proves the restore, not only element identity. A `value` after the
// first return and a second one after the area round are both required, and
// so are both `scroll-kept`s.
//   node walk.mjs --check-spec [--spec path/to/journeys.json]
function checkJ11Contract(spec) {
  const journey = (((spec || {}).journeys || {}).J11) || {};
  const steps = journey.steps;
  if (!Array.isArray(steps) || steps.length === 0) return ['J11 has no steps'];
  const errs = [];
  const idx = (pred, from = 0) => steps.findIndex((st, i) => i >= from && Array.isArray(st) && pred(st));
  const after = (prev, pred) => (prev < 0 ? -1 : idx(pred, prev + 1));
  const sel = (st, i) => String((st || [])[i] ?? '');

  // Phone only: the footer and the phone's own Back are what this walks.
  const viewports = journey.viewports;
  if (!Array.isArray(viewports) || viewports.length !== 1 || viewports[0] !== 'phone') {
    errs.push('J11 is the phone switch proof: its viewports must be exactly ["phone"]');
  }

  // Open, back to the list, open the other conversation, back, return.
  const openAt = idx((st) => st[0] === 'click' && /Morning planning/.test(sel(st, 1)));
  const leaveAt = after(openAt, (st) => st[0] === 'back');
  const switchAt = after(leaveAt, (st) => st[0] === 'click' && /Failed migration/.test(sel(st, 1)));
  const backAt = after(switchAt, (st) => st[0] === 'back');
  const returnAt = after(backAt, (st) => st[0] === 'click' && /Morning planning/.test(sel(st, 1)));
  if (openAt < 0) errs.push('J11 never opens the seeded conversation from the list (click … Morning planning)');
  if (leaveAt < 0) errs.push('J11 never leaves the conversation for the list (back)');
  if (switchAt < 0) errs.push('J11 never opens the second seeded conversation (click … Failed migration)');
  if (backAt < 0) errs.push('J11 never leaves the second conversation for the list (back again)');
  if (returnAt < 0) errs.push('J11 never returns to the conversation it left (click … Morning planning again)');

  // The list grows past the page: conversations another journey created land
  // in the same project bucket, and past five rows the seeded row is folded
  // behind 展开全部, so a click aimed at it never lands. Every list entry that
  // opens the seeded row must press that fold first. The press is optional
  // (`?`) because the disclosure exists only when the bucket is taller than
  // five rows and a standalone walk's fullest bucket holds four; the row clicks stay required
  // and named, so a press that silently fails cannot hide a list that lost it.
  const foldClick = (st) => st[0] === 'click' && /展开全部|Show all/.test(sel(st, 1));
  const listEntryBefore = (at) => {
    let entry = -1;
    steps.forEach((st, i) => {
      if (i >= at || !Array.isArray(st)) return;
      if ((st[0] === 'goto' && sel(st, 1) === '/sessions')
        || st[0] === 'back'
        || (st[0] === 'click' && sel(st, 1).includes('[data-phone-return="sessions"]'))) entry = i;
    });
    return entry;
  };
  let missingFold = false;
  steps.forEach((st, i) => {
    if (!Array.isArray(st) || st[0] !== 'click' || !/Morning planning/.test(sel(st, 1))) return;
    const entry = listEntryBefore(i);
    const pressed = steps.findIndex((cand, j) => j > entry && j < i && Array.isArray(cand) && foldClick(cand));
    if (pressed < 0) missingFold = true;
  });
  if (missingFold) {
    errs.push('J11 never presses the project fold before opening the seeded row from the list (click … 展开全部|Show all)');
  }

  // A `goto` reloads the document. The shell claim is about client-side
  // navigation, so nothing after the first open may replace the page.
  if (openAt >= 0 && steps.findIndex((st, i) => i > openAt && Array.isArray(st) && st[0] === 'goto') >= 0) {
    errs.push('J11 reloads the document with goto after the conversation is open; the switch must be client-side navigation');
  }

  // Shell identity. One tag before the first leaving, then the same tag after
  // every route change: a shell remounted on the new pathname is a page load
  // wearing the same markup.
  const nodes = [];
  steps.forEach((st, i) => { if (Array.isArray(st) && st[0] === 'node') nodes.push(i); });
  const nodeName = nodes.length ? sel(steps[nodes[0]], 2) : '';
  const tagged = nodes.find((i) => i < (leaveAt < 0 ? steps.length : leaveAt));
  if (!nodeName || tagged === undefined) {
    errs.push('J11 never tags the shell before the switch (node css=… shell)');
  } else if (!/^css=/.test(sel(steps[tagged], 1))) {
    errs.push('J11\'s shell tag must name the element with css=<selector>');
  }
  const areaNavAt = (from) => steps.findIndex((st, i) => i > from && Array.isArray(st) && st[0] === 'click' && sel(st, 1).includes('data-phone-return='));
  const sameShell = (from, to = steps.length) => nodes.find((i) => i > from && i < to && sel(steps[i], 2) === nodeName);
  if (nodeName) {
    if (switchAt >= 0 && sameShell(switchAt, backAt < 0 ? steps.length : backAt) === undefined) {
      errs.push('J11 never asserts the same shell node after the chat switch; a remount would go unseen');
    }
    const firstArea = returnAt < 0 ? -1 : areaNavAt(returnAt);
    if (returnAt >= 0 && sameShell(returnAt, firstArea < 0 ? steps.length : firstArea) === undefined) {
      errs.push('J11 never asserts the same shell node after returning to the conversation');
    }
  }

  // The footer round: the list, Routines, the list again. Each tap is a route
  // change while the pane is off screen.
  const footerAt = (id) => idx((st) => st[0] === 'click' && sel(st, 1).includes(`[data-phone-return="${id}"]`));
  const routinesAt = footerAt('routines');
  const sessionsAt = routinesAt < 0 ? -1 : idx((st) => st[0] === 'click' && sel(st, 1).includes('[data-phone-return="sessions"]'), routinesAt + 1);
  if (routinesAt < 0) errs.push('J11 never visits the routines area from the phone footer (click [data-phone-return="routines"])');
  if (sessionsAt < 0) errs.push('J11 never returns to the chat list from the footer (click [data-phone-return="sessions"])');
  if (nodeName) {
    if (routinesAt >= 0 && sameShell(routinesAt, sessionsAt < 0 ? steps.length : sessionsAt) === undefined) {
      errs.push('J11 never asserts the same shell node after the routines area change');
    }
    if (sessionsAt >= 0 && sameShell(sessionsAt) === undefined) {
      errs.push('J11 never asserts the same shell node after the sessions area change');
    }
  }

  // The composer is part of the shell claim at 390 too (TASTE 15). #342 tags
  // the `form` by name before the first Back, on the other conversation, after
  // the return and after the footer round; the last one is the stronger
  // claim, because the pane was off screen. Deleting any tag must be red.
  const composerTag = (name, from, to = steps.length) => (nodes.find((i) => i > from && i < to && sel(steps[i], 2) === name && /^css=/.test(sel(steps[i], 1))) ?? -1);
  const lastReturnAt = returnAt < 0 ? -1 : idx((st) => st[0] === 'click' && /Morning planning/.test(sel(st, 1)), returnAt + 1);
  const composerBefore = leaveAt < 0 ? -1 : (nodes.find((i) => i < leaveAt && sel(steps[i], 2) === 'composer' && /^css=/.test(sel(steps[i], 1))) ?? -1);
  const composerFailed = switchAt < 0 || backAt < 0 ? -1 : composerTag('composer-failed', switchAt, backAt);
  const composerBack = returnAt < 0 ? -1 : composerTag('composer', returnAt, lastReturnAt < 0 ? steps.length : lastReturnAt);
  const composerFinal = lastReturnAt < 0 ? -1 : composerTag('composer', lastReturnAt);
  if (leaveAt >= 0 && composerBefore < 0) {
    errs.push('J11 never tags the composer element before the first Back (node css=… composer)');
  }
  if (switchAt >= 0 && backAt >= 0 && composerFailed < 0) {
    errs.push("J11 never tags the second conversation's composer (node css=… composer-failed)");
  }
  if (returnAt >= 0 && composerBack < 0) {
    errs.push('J11 never tags the same composer element again after the return (node css=… composer); a per-route re-key would go unseen');
  }
  if (lastReturnAt >= 0 && composerFinal < 0) {
    errs.push('J11 never tags the same composer element again after the footer round (node css=… composer); the off-screen restore is the stronger claim');
  }

  // The transcript's place. The offset must be numeric and away from the top:
  // a remount that starts at 0 must not be able to satisfy the return by
  // accident.
  const transcript = (st) => sel(st, 1).startsWith('css=') && /role=.?region/.test(sel(st, 1));
  const scrollAt = idx((st) => st[0] === 'scroll' && transcript(st));
  if (scrollAt < 0) {
    errs.push('J11 never scrolls the transcript before the switch; the return has no position to prove');
  } else {
    const asked = sel(steps[scrollAt], 2);
    if (!/^\d+$/.test(asked) || Number(asked) < 96) {
      errs.push('J11 must scroll the transcript to a numeric middle offset of at least 96px, not ' + JSON.stringify(asked));
    }
    if (leaveAt >= 0 && scrollAt > leaveAt) {
      errs.push('J11 scrolls the transcript after leaving; the position must be left before it');
    }
  }
  const keptAfter = (from) => (from < 0 ? -1 : idx((st) => st[0] === 'scroll-kept' && transcript(st), from + 1));
  const keptBack = keptAfter(returnAt);
  if (keptBack < 0) {
    errs.push('J11 never asserts the transcript came back where it was left (scroll-kept after the return)');
  } else if (scrollAt >= 0) {
    const asked = Number(sel(steps[scrollAt], 2));
    const kept = Number(sel(steps[keptBack], 2));
    if (!Number.isFinite(kept) || Math.abs(kept - asked) > 48) {
      errs.push('J11\'s scroll-kept offset must be the offset it scrolled to (within the walker\'s 48px tolerance)');
    }
  }
  if (keptAfter(sessionsAt) < 0) {
    errs.push('J11 never asserts the transcript came back after the area round; the off-screen restore is the stronger claim');
  }

  // The half-typed message. Sends in the journey give the transcript a
  // position to lose, so the draft is the last fill before the leaving that no
  // `send` follows, and it is read back from the composer after both returns.
  const fills = [];
  steps.forEach((st, i) => {
    if (Array.isArray(st) && st[0] === 'fill' && /textarea/.test(sel(st, 1)) && typeof st[2] === 'string' && st[2].trim() !== '') fills.push(i);
  });
  const sentAfter = (i) => {
    const send = idx((st) => st[0] === 'send', i + 1);
    return send >= 0 && (leaveAt < 0 || send < leaveAt);
  };
  const draftFills = leaveAt < 0 ? fills : fills.filter((i) => i < leaveAt && !sentAfter(i));
  const draftFillAt = draftFills.length ? draftFills[draftFills.length - 1] : -1;
  const draft = draftFillAt >= 0 ? String(steps[draftFillAt][2]) : '';
  if (fills.length === 0) {
    errs.push('J11 never types an unsent draft into the composer');
  } else if (draftFillAt < 0) {
    errs.push('J11 never leaves an unsent draft in the composer before the switch; every text it typed was sent');
  }
  const draftAt = (from) => (from < 0 || draftFillAt < 0 ? -1
    : idx((st) => st[0] === 'value' && /textarea/.test(sel(st, 1)) && sel(st, 2) === draft, from + 1));
  if (draftFillAt >= 0 && draftAt(returnAt) < 0) {
    errs.push('J11 never proves the draft survived the return (value textarea … after the return)');
  }
  if (draftFillAt >= 0 && draftAt(sessionsAt) < 0) {
    errs.push('J11 never proves the draft survived the area round (value textarea … after the footer return)');
  }

  // The screenshots are the reviewable evidence, in the order the switch runs.
  const shotAt = (name) => steps.findIndex((st) => Array.isArray(st) && st[0] === 'shot' && st[1] === name);
  const chatShot = shotAt('switch-chat'), backShot = shotAt('switch-back'), areaShot = shotAt('switch-area-back');
  if (chatShot < 0) errs.push('J11 takes no `switch-chat` shot');
  else if (leaveAt >= 0 && chatShot > leaveAt) errs.push('the `switch-chat` shot must be taken before the leaving');
  if (backShot < 0) errs.push('J11 takes no `switch-back` shot');
  else if (returnAt >= 0 && backShot < returnAt) errs.push('the `switch-back` shot must follow the return');
  if (areaShot < 0) errs.push('J11 takes no `switch-area-back` shot');
  else if (sessionsAt >= 0 && areaShot < sessionsAt) errs.push('the `switch-area-back` shot must follow the footer round');

  // A shell, conversation-pane or footer diff that no longer selects J11
  // would let the phone claim rot without the gate ever walking it.
  const paths = Array.isArray(spec.paths) ? spec.paths : [];
  const mapsToJ11 = (file) => {
    const row = paths.find(([re]) => re.split('|').some((p) => file.startsWith(p)));
    return !!row && Array.isArray(row[1]) && row[1].includes('J11');
  };
  for (const file of ['ui/src/components/layout/AppShell.tsx', 'ui/src/components/layout/PhoneFooter.tsx', 'ui/src/pages/TaskDetailPage.tsx']) {
    if (!mapsToJ11(file)) {
      errs.push(`the paths table does not map ${file} to J11; a diff there would not walk the phone switch`);
    }
  }
  return errs;
}
// J10's contract: F5 — the phone's four tabs keep their place, and a card a
// person approved stays answered. J7 proves the deep link lands and Back
// returns; it never answers the card or leaves the conversation, so a footer
// that opens bare roots, or a decided card drawn pending again on the return,
// is green today. IA D8 is the sharp half: 设置 and Agent 运维 share /settings
// but each keeps its own `?tab=`, and the walk must assert the query, not just
// the pathname. The `url` op matches `location.pathname` only, so the query is
// a `search` step; a contract that demanded `url /settings?tab=…` would reject
// the only honest spelling the walker can execute.
//   node walk.mjs --check-spec [--spec path/to/journeys.json]
function checkJ10Contract(spec) {
  const journey = (((spec || {}).journeys || {}).J10) || {};
  const steps = journey.steps;
  if (!Array.isArray(steps) || steps.length === 0) return ['J10 has no steps'];
  const errs = [];
  const required = (v) => typeof v === 'string' && !v.startsWith('?');
  const bare = (v) => String(v).replace(/^\?/, '');
  const sel = (st, i) => String((st || [])[i] ?? '');
  const idx = (pred, from = 0) => steps.findIndex((st, i) => i >= from && Array.isArray(st) && pred(st));

  // Phone only: the footer exists below 700px, and the tab round is a thumb
  // tap. J7 walks the same landing at both widths; J10 is the phone proof.
  const viewports = journey.viewports;
  if (!Array.isArray(viewports) || viewports.length !== 1 || viewports[0] !== 'phone') {
    errs.push('J10 is the phone tab-memory proof: its viewports must be exactly ["phone"]');
  }

  // Land on the card the notification names, then answer it. A walk that only
  // photographs the card leaves every later `gone` vacuous.
  const deepAt = idx((st) => st[0] === 'goto' && required(sel(st, 1)) && /\/tasks\//.test(bare(sel(st, 1)))
    && bare(sel(st, 1)).includes('{conversation}') && /focus=|\{focus\}/.test(bare(sel(st, 1))));
  if (deepAt < 0) errs.push('J10 has no required deep-link goto naming both {conversation} and {focus}');
  const cardWait = ([op, needle]) => op === 'wait' && required(needle) && /^css=/.test(bare(needle))
    && bare(needle).includes('[data-pending-id="{focus}"]');
  const waitAt = idx(cardWait);
  if (waitAt < 0) errs.push('J10 never waits for the named card ([data-pending-id="{focus}"])');
  const approveControl = (v) => /批准|Approve/.test(String(v));
  const approveAt = idx((st) => st[0] === 'click' && required(sel(st, 1)) && approveControl(bare(sel(st, 1))));
  if (approveAt < 0) errs.push("J10 never presses the card's approve control (批准 / Approve)");
  else if ((deepAt >= 0 && approveAt < deepAt) || (waitAt >= 0 && approveAt < waitAt)) {
    errs.push('J10 presses approve before it waits for the named card');
  }

  // The four peer entries (IA D8). Each tap is its own rule: dropping one
  // leaves that area's memory unproven.
  const footerAt = (id) => idx((st) => st[0] === 'click' && required(sel(st, 1))
    && bare(sel(st, 1)).includes(`[data-phone-return="${id}"]`));
  const tabs = ['sessions', 'routines', 'agents', 'settings'];
  const taps = {};
  tabs.forEach((id) => {
    taps[id] = footerAt(id);
    if (taps[id] < 0) errs.push(`J10 never taps the ${id} footer entry (click [data-phone-return="${id}"])`);
  });
  const tapList = tabs.map((id) => taps[id]).filter((i) => i >= 0);
  const firstTap = tapList.length ? Math.min(...tapList) : -1;
  const lastTap = tapList.length ? Math.max(...tapList) : -1;
  const nextTapAfter = (from) => {
    const later = tapList.filter((i) => i > from);
    return later.length ? Math.min(...later) : steps.length;
  };

  // The answer must take the control off the screen before the reader leaves:
  // a card still showing Approve on the way out was never decided.
  const goneOf = (from = 0) => idx((st) => st[0] === 'gone' && required(sel(st, 1)) && approveControl(bare(sel(st, 1))), from);
  const approveGone = goneOf();
  if (approveGone < 0) errs.push('J10 never proves the approve control left the screen after the answer');
  else if (firstTap >= 0 && approveGone > firstTap) {
    errs.push('J10 never proves the approve control left the screen before the first footer tap');
  }

  // Settings and Agent Ops share a pathname; only `?tab=` tells them apart.
  const urlAt = (from, needle) => idx((st) => st[0] === 'url' && required(sel(st, 1)) && bare(sel(st, 1)).includes(needle), from);
  const searchAt = (from, needle) => idx((st) => st[0] === 'search' && required(sel(st, 1)) && bare(sel(st, 1)).includes(needle), from);
  if (taps.settings >= 0 && urlAt(taps.settings, '/settings') < 0) {
    errs.push('J10 never opens Settings from its footer entry (url ^/settings)');
  }
  if (taps.agents >= 0) {
    const ops = searchAt(taps.agents, 'tab=operations');
    if (ops < 0 || ops > nextTapAfter(taps.agents)) {
      errs.push('J10 never proves the Agent Ops entry reopened its own tab (search tab=operations)');
    }
  }
  if (taps.routines >= 0 && urlAt(taps.routines, '/routines') < 0) {
    errs.push('J10 never proves the Routines entry reopened /routines (url ^/routines)');
  }
  if (taps.sessions >= 0 && urlAt(taps.sessions, '/sessions') < 0) {
    errs.push('J10 never proves the Chats entry reopened the list (url ^/sessions)');
  }
  // The memory proof: leave Settings for another area, come back, and read
  // the non-operations tab off the address. Two settings taps are the shape;
  // one tap plus a bare root is the regression this journey exists to catch.
  const settingsTaps = [];
  steps.forEach((st, i) => {
    if (st[0] === 'click' && required(sel(st, 1)) && bare(sel(st, 1)).includes('[data-phone-return="settings"]')) settingsTaps.push(i);
  });
  const backToSettings = settingsTaps.length >= 2 ? settingsTaps[settingsTaps.length - 1] : -1;
  const leftSettings = backToSettings >= 0 && tapList.some((i) => i > settingsTaps[0] && i < backToSettings);
  if (!leftSettings) {
    errs.push('J10 never returns to Settings from another footer entry; the remembered tab cannot be proven without leaving and coming back');
  } else {
    const patterns = steps.map((st, i) => ({ st, i }))
      .filter(({ st, i }) => i > backToSettings && st[0] === 'search' && required(sel(st, 1)))
      .map(({ st }) => bare(sel(st, 1)));
    if (!patterns.some((p) => /tab=/.test(p) && !/tab=operations/.test(p))) {
      errs.push('J10 never proves Settings remembered its tab: a non-root settings URL (search tab=…) must follow the return');
    }
  }

  // The return is the half that catches an answered card drawn pending again.
  const rowAt = idx((st) => st[0] === 'click' && required(sel(st, 1))
    && bare(sel(st, 1)).includes('[data-session-row="{conversation}"]'), lastTap + 1);
  if (rowAt < 0) {
    errs.push('J10 never returns to the conversation after the tab round (click [data-session-row="{conversation}"])');
  } else {
    const backTask = idx((st) => st[0] === 'url' && required(sel(st, 1)) && bare(sel(st, 1)).includes('/tasks/{conversation}'), rowAt + 1);
    if (backTask < 0) errs.push('J10 never proves the return reached the conversation (url ^/tasks/{conversation})');
    const finalGone = goneOf(rowAt + 1);
    if (finalGone < 0) {
      errs.push('J10 never proves the approved card stayed gone after the return (gone of the approve control)');
    }
  }
  return errs;
}
// J7's contract: a notification tap must prove it landed on the card the
// notification named — not just photograph whatever loaded. Without these
// rules a blank deep link, a landing on the wrong card, and a Back that
// strands the reader are all green today:
//   node walk.mjs --check-spec [--seed DIR/seed.log] [--spec path/to/journeys.json]
function checkJ7Contract(spec) {
  const steps = (((spec || {}).journeys || {}).J7 || {}).steps;
  if (!Array.isArray(steps) || steps.length === 0) return ['J7 has no steps'];
  const errs = [];
  const required = (v) => typeof v === 'string' && !v.startsWith('?');
  const bare = (v) => String(v).replace(/^\?/, '');
  const idx = (pred, from = 0) => steps.findIndex((st, i) => i >= from && Array.isArray(st) && pred(st));
  const gotoAt = idx(([op, u]) => op === 'goto' && required(u) && /\/tasks\//.test(bare(u)) && /focus=|\{focus\}/.test(bare(u)));
  if (gotoAt < 0) errs.push('J7 has no required deep-link goto naming focus=');
  // The landing assertion is the required wait for the named card, and it has
  // to happen before Back: the post-Back wait proves something else.
  const cardWait = ([op, needle]) => op === 'wait' && required(needle) && /^css=/.test(bare(needle)) && /\[data-pending-id=/.test(bare(needle)) && bare(needle).includes('{focus}');
  const landingAt = idx(cardWait);
  const backAt = idx(([op, sel]) => op === 'back' || (op === 'click' && required(sel) && /返回|Back/.test(bare(sel))));
  if (landingAt < 0 || (backAt >= 0 && landingAt > backAt)) {
    errs.push('J7 never waits for the named card before Back ([data-pending-id="{focus}"])');
  }
  if (idx(([op, sel]) => op === 'active' && required(sel) && /^css=/.test(bare(sel)) && bare(sel).includes('{focus}')) < 0) {
    errs.push('J7 never asserts the named card holds DOM focus (active css=[data-pending-id="{focus}"])');
  }
  if (idx(([op, p]) => op === 'search' && required(p)) < 0) {
    errs.push('J7 never proves the ?focus= link was consumed (search ^$)');
  }
  if (backAt < 0) {
    errs.push('J7 has no required Back step (an optional `?` click is not a Back)');
  } else {
    if (idx(cardWait, backAt + 1) < 0) errs.push('J7 never asserts the named card again after Back');
    if (idx(([op, p]) => op === 'url' && required(p) && /sessions/.test(bare(p)), backAt + 1) < 0) {
      errs.push('J7 never proves Back returned to the conversation list (url ^/sessions)');
    }
    // Reopening after Back must be a pointer tap, the way a thumb does it.
    // focus+Enter only proves the row is in the tab order: a surface lying over
    // the list (the pre-#252 approval panel) leaves that path green while the
    // row is unreachable by touch. Playwright's click runs the hit-target
    // check, so a covered row times out and reddens the walk.
    const rowSel = '[data-session-row="{conversation}"]';
    const rowClickAt = idx(([op, sel]) => op === 'click' && required(sel) && bare(sel).includes(rowSel), backAt + 1);
    const titleWaitAt = idx(([op, needle]) => op === 'wait' && required(needle) && /^text=/.test(bare(needle)) && bare(needle).includes('{title}'), backAt + 1);
    if (rowClickAt < 0) {
      errs.push('J7 never reopens the seeded conversation after Back; it must tap the row (click ' + rowSel + ')');
    } else if (titleWaitAt >= 0 && rowClickAt < titleWaitAt) {
      errs.push('J7 taps the session row before the list shows the seeded title (wait text={title})');
    }
    if (idx(([op, sel]) => op === 'focus' && required(sel) && bare(sel).includes(rowSel), backAt + 1) >= 0) {
      errs.push('J7 reopens the row with focus+Enter after Back; it must tap the row (click ' + rowSel + '), so a surface covering the row reddens the walk');
    }
  }
  return errs;
}
// J5's contract: the row menu is a shipped list of actions, and one of them is
// a status line. Opening the menu and photographing it proves neither: a
// rename that left the active scope, a pin/archive/delete that vanished, or a
// 运行中 line that became pressable all ship green today. The walk must open
// the *running* row's menu — any other row has no 运行中 line — and assert the
// list in both languages, at both viewports. The running line is pinned by a
// required count of exactly one element that carries the label AND the
// disabled marker (the Mac menu item uses aria-disabled, the phone ActionSheet
// row is a <button disabled>), so dropping either half is red.
//   node walk.mjs --check-spec [--spec path/to/journeys.json]
function checkJ5Contract(spec) {
  const journey = (((spec || {}).journeys || {}).J5) || {};
  const steps = journey.steps;
  if (!Array.isArray(steps) || steps.length === 0) return ['J5 has no steps'];
  const errs = [];
  const required = (v) => typeof v === 'string' && !v.startsWith('?');
  const sel = (st, i) => String((st || [])[i] ?? '');
  const idx = (pred, from = 0) => steps.findIndex((st, i) => i >= from && Array.isArray(st) && pred(st));

  // The menu is one list on both surfaces. A `vp` scope would leave one
  // width's menu unread while the walk still reported green.
  if (steps.some((st) => Array.isArray(st) && st[0] === 'vp')) {
    errs.push('J5 scopes steps to one viewport; the row menu is the same list on the phone and the Mac, so its assertions must run at every viewport J5 claims');
  }
  const viewports = Array.isArray(journey.viewports) ? journey.viewports : [];
  for (const vp of ['phone', 'mac']) {
    if (!viewports.includes(vp)) errs.push(`J5 does not claim the ${vp} viewport; the row menu ships on both`);
  }

  // The menu under test is the seeded running row's. Opening whichever trigger
  // the list renders first photographs a menu that may have no 运行中 line.
  const listAt = idx((st) => st[0] === 'goto' && required(sel(st, 1)) && /sessions/.test(sel(st, 1)));
  const openAt = idx((st) => st[0] === 'click' && required(sel(st, 1))
    && sel(st, 1).includes('[data-row-actions]') && sel(st, 1).includes('{j5.conversation}'));
  if (listAt < 0) errs.push('J5 never opens the conversation list (goto /sessions)');
  if (openAt < 0) {
    errs.push('J5 never opens the seeded running row\'s menu (click [data-row-actions][aria-describedby="session-row-title-{j5.conversation}"])');
  } else if (listAt >= 0 && openAt < listAt) {
    errs.push('J5 opens a row menu before it is on the conversation list');
  }

  // The shipped contents, named in both languages. Every item is a required
  // step: an optional one records a skip when the action is gone, which is the
  // regression this journey exists to catch.
  const named = (zh, en) => (st) => (st[0] === 'wait' || st[0] === 'count')
    && required(sel(st, 1)) && sel(st, 1).includes(zh) && sel(st, 1).includes(en);
  let previous = openAt;
  for (const [zh, en, name] of [['改名', 'Rename', 'rename'], ['置顶', 'Pin', 'pin'], ['归档', 'Archive', 'archive'], ['删除', 'Delete', 'delete']]) {
    const at = previous < 0 ? -1 : idx(named(zh, en), previous + 1);
    if (at < 0) errs.push(`J5 never asserts the ${name} item (${zh} / ${en}) after opening the row menu`);
    else previous = at;
  }

  // The running line is a state, not an action: present and unusable. Both
  // halves are in the selector, and the count is exactly one, so a label that
  // stayed while the disable was dropped is red at both surfaces.
  const runningAt = previous < 0 ? -1 : idx((st) => st[0] === 'count' && required(sel(st, 1))
    && sel(st, 1).includes('运行中') && sel(st, 1).includes('Running')
    && (sel(st, 1).includes('aria-disabled') || sel(st, 1).includes('[disabled]'))
    && String(st[2]) === '1', previous + 1);
  if (runningAt < 0) {
    errs.push('J5 never asserts the 运行中 / Running line is present and disabled after opening the row menu (a required count … 1 naming the label and the disabled marker)');
  }

  const shotAt = idx((st) => st[0] === 'shot' && sel(st, 1) === 'row-actions');
  if (shotAt < 0) errs.push('J5 takes no `row-actions` shot');
  else if (runningAt >= 0 && shotAt < runningAt) {
    errs.push('the `row-actions` shot must follow the 运行中 assertion, so the photograph is of a menu whose contents were read');
  }
  return errs;
}
// J4's instructions leg (KIN-PROJECT-003). The cover's 工作方式 block is
// read-only on purpose, so the journey proves the *same text* on both surfaces
// by reading the block and then the agent's own receipt: the digest is not
// shown as user text in the transcript, so the user bubble cannot stand in.
// The file is edited mid-walk through the one `api` op (fixture setup), and
// the post-edit cover read and the old conversation's unchanged text are what
// separate "the cover re-reads the file" from "the page kept its first copy".
// Without these rules a J4 that photographs the cover, never presses the
// launcher, never sends, or never edits the file is green today.
//   node walk.mjs --check-spec [--spec path/to/journeys.json]
const J4_OLD_LINE = '- 交付前先跑 scripts/check.sh；生成文件不要手改。';
const J4_NEW_LINE = '- 新的工作方式：先写测试，再动实现；提交前先把结论说清楚。';
// The transcript renders the received body as markdown, so a received bullet's
// text is observable without its list marker: the marker is structure, not
// text. The cover shows the raw file, dash included, which is why the two
// halves of the proof use different needles for the same line.
const J4_OLD_TEXT = '交付前先跑 scripts/check.sh；生成文件不要手改。';
const J4_NEW_TEXT = '新的工作方式：先写测试，再动实现；提交前先把结论说清楚。';
const J4_CUT_NEEDLE = 'CUT-BOUNDARY…';
const J4_TAIL = 'TAIL-BEYOND-400';
function checkJ4Contract(spec) {
  const journey = (((spec || {}).journeys || {}).J4) || {};
  const steps = journey.steps;
  if (!Array.isArray(steps) || steps.length === 0) return ['J4 has no steps'];
  const errs = [];
  const sel = (st, i) => String((st || [])[i] ?? '');
  const idx = (pred, from = 0) => steps.findIndex((st, i) => i >= from && Array.isArray(st) && pred(st));
  const after = (prev, pred) => (prev < 0 ? -1 : idx(pred, prev + 1));
  const required = (v) => typeof v === 'string' && !v.startsWith('?');
  const cssWait = (st, re) => st[0] === 'wait' && /^css=/.test(sel(st, 1)) && re.test(sel(st, 1));
  const transcript = (st) => cssWait(st, /\[role=.?region/);
  const sectionWait = (st, text) => cssWait(st, /工作方式|How to work here/) && sel(st, 1).includes(text);
  const sendAt = (from) => idx((st) => st[0] === 'send' && required(sel(st, 1)), from);
  const shotAt = (name) => steps.findIndex((st) => Array.isArray(st) && st[0] === 'shot' && st[1] === name);

  // The launcher: one press from the cover, and it must be mandatory.
  const launcherAt = idx((st) => st[0] === 'click' && required(sel(st, 1)) && /让 Kin 改…|Ask Kin to edit…/.test(sel(st, 1)));
  if (launcherAt < 0) errs.push('J4 never presses the cover launcher (让 Kin 改… / Ask Kin to edit…); the pre-filled path is unwalked');
  // The prefill is the shipped prompt, and it is read from the composer, not
  // inferred from the route: the address drops ?q= as soon as it is consumed.
  const prefillAt = after(launcherAt, (st) => st[0] === 'value' && /textarea/.test(sel(st, 1)) && sel(st, 2).includes('ONE_PAGER.md'));
  if (prefillAt < 0) errs.push('J4 never reads the pre-filled composer (value textarea … ONE_PAGER.md) after the launcher');
  // Sending before the prefill is asserted would photograph an empty box.
  const firstSendAt = sendAt(Math.max(launcherAt, 0) + 1);
  if (firstSendAt < 0) errs.push('J4 never sends the pre-filled prompt');
  else if (prefillAt < 0 || prefillAt > firstSendAt) errs.push('J4 sends before it asserts the composer prefill');
  // The agent's receipt, inside the transcript. A bare text= wait passes on
  // the cover or the header and proves nothing about what the agent received.
  // The FIRST receipt read after the send belongs to the first chat; a later
  // one (the second chat's) cannot stand in for it.
  const firstReceiptAt = after(firstSendAt, (st) => st[0] === 'wait' && sel(st, 1).includes('Project instructions received:'));
  if (firstReceiptAt < 0) errs.push('J4 never waits for the agent\'s receipt after the first send (Project instructions received:)');
  else if (!transcript(steps[firstReceiptAt])) errs.push('the first chat\'s receipt wait is not scoped to the transcript; the cover could satisfy it');
  const firstEchoLineAt = after(firstReceiptAt, (st) => transcript(st) && sel(st, 1).includes(J4_OLD_TEXT));
  if (firstEchoLineAt < 0) errs.push('J4 never reads the received 工作方式 line inside the transcript');

  // The edit is the one api op, after the first send and before the post-edit
  // cover read; a PUT before the send would edit the file the first chat was
  // supposed to receive.
  const isApi = (st) => st[0] === 'api' && required(sel(st, 1)) && sel(st, 1) === 'PUT' && /^\/api\/projects\/[^/]+\/one-pager$/.test(sel(st, 2));
  const apiAfterSend = idx(isApi, Math.max(firstSendAt, 0) + 1);
  if (apiAfterSend < 0 || !sel(steps[apiAfterSend], 3).includes(J4_NEW_LINE)) {
    errs.push('J4 never edits ONE_PAGER.md through the one api PUT after the first send (an api step before the send would prove the wrong text)');
  }
  if (firstSendAt >= 0 && idx(isApi) >= 0 && idx(isApi) < firstSendAt) errs.push('J4 runs an api step before the first send; the fixture must be edited mid-walk');
  if (firstEchoLineAt >= 0 && apiAfterSend >= 0 && firstEchoLineAt > apiAfterSend) {
    errs.push('J4 reads the first chat\'s receipt only after the file is edited; that text proves nothing about the first chat');
  }
  const editAt = apiAfterSend;
  const postEditAt = after(editAt, (st) => sectionWait(st, J4_NEW_LINE));
  const leaveCoverAt = after(editAt, (st) => st[0] === 'click' && required(sel(st, 1)) && /data-session-row/.test(sel(st, 1)));
  if (postEditAt < 0 || (leaveCoverAt >= 0 && postEditAt > leaveCoverAt)) {
    errs.push('J4 never re-reads the cover after the edit (a 工作方式 section wait naming the new line)');
  }
  const oldCountAt = after(postEditAt, (st) => st[0] === 'count' && sel(st, 1) === 'text=' + J4_OLD_LINE && String(st[2]) === '0');
  if (oldCountAt < 0 || (leaveCoverAt >= 0 && oldCountAt > leaveCoverAt)) {
    errs.push('J4 never proves the old line left the cover after the edit (count text=<old> 0)');
  }

  // The old conversation keeps the text it started with. Both halves: the old
  // echo is still there, and the new line never reached it.
  const oldChatAt = after(oldCountAt, (st) => st[0] === 'click' && required(sel(st, 1)) && /data-session-row/.test(sel(st, 1)));
  if (oldChatAt < 0) errs.push('J4 never reopens the earlier conversation (click [data-session-row] …)');
  const oldEchoAt = after(oldChatAt, (st) => transcript(st) && sel(st, 1).includes('Project instructions received:'));
  const oldLineAt = after(oldEchoAt, (st) => transcript(st) && sel(st, 1).includes(J4_OLD_TEXT));
  if (oldChatAt >= 0 && oldLineAt < 0) errs.push('J4 never reads the old received line in the earlier conversation');
  const oldHasNewAt = after(oldLineAt, (st) => st[0] === 'count' && /\[role=.?region/.test(sel(st, 1)) && sel(st, 1).includes(J4_NEW_TEXT) && String(st[2]) === '0');
  if (oldLineAt >= 0 && oldHasNewAt < 0) errs.push('J4 never proves the earlier conversation did not receive the new line (count … 0 inside the transcript)');

  // A second chat, started after the edit, receives the new line.
  const secondSendAt = sendAt(oldHasNewAt + 1);
  if (secondSendAt < 0) errs.push('J4 never starts a second chat after the edit');
  const newEchoAt = after(secondSendAt, (st) => transcript(st) && sel(st, 1).includes(J4_NEW_TEXT));
  if (secondSendAt >= 0 && newEchoAt < 0) errs.push('J4 never reads the edited line in the new chat\'s receipt');

  // The restore keeps the next viewport's fixture where this one found it.
  const restoreAt = after(newEchoAt, (st) => isApi(st) && sel(st, 3).includes(J4_OLD_LINE) && !sel(st, 3).includes(J4_NEW_LINE));
  if (restoreAt < 0) errs.push('J4 never restores the seeded One-Pager after the edit (a second api PUT); the next viewport would start on the edited file');

  // The over-400 section: the same cut on the cover and in the agent's text,
  // and the tail beyond rune 400 on neither.
  const coverCutAt = after(restoreAt, (st) => sectionWait(st, J4_CUT_NEEDLE));
  if (coverCutAt < 0) errs.push('J4 never reads the truncated body on the cover (a 工作方式 wait naming CUT-BOUNDARY…)');
  const coverTruncAt = after(coverCutAt, (st) => sectionWait(st, '已截断') || sectionWait(st, 'Truncated'));
  if (coverTruncAt < 0) errs.push('J4 never reads the truncation footnote on the cover (已截断 / Truncated)');
  const coverTailAt = after(coverCutAt, (st) => st[0] === 'count' && sel(st, 1) === 'text=' + J4_TAIL && String(st[2]) === '0');
  if (coverTailAt < 0) errs.push('J4 never proves the tail beyond rune 400 is absent from the cover (count text=TAIL-BEYOND-400 0)');
  const gammaSendAt = sendAt(coverTailAt + 1);
  if (gammaSendAt < 0) errs.push('J4 never sends a chat in the truncated project');
  const sentCutAt = after(gammaSendAt, (st) => transcript(st) && sel(st, 1).includes(J4_CUT_NEEDLE));
  if (sentCutAt < 0) errs.push('J4 never reads the same truncated body in the agent\'s receipt');
  const sentTailAt = after(sentCutAt, (st) => st[0] === 'count' && /\[role=.?region/.test(sel(st, 1)) && sel(st, 1).includes(J4_TAIL) && String(st[2]) === '0');
  if (sentTailAt < 0) errs.push('J4 never proves the agent received no text beyond rune 400 (count … TAIL-BEYOND-400 0 inside the transcript)');

  // The empty state, so "no section" is read as its own copy rather than a
  // blank block that a missing read could also draw.
  const emptyAt = idx((st) => sectionWait(st, '还没写工作说明') || sectionWait(st, 'No working instructions yet'), Math.max(sentTailAt, 0) + 1);
  if (emptyAt < 0) errs.push('J4 never reads the empty state on a project with no 工作方式 section (还没写工作说明)');
  const emptyNoteAt = after(emptyAt, (st) => sectionWait(st, '新对话不会收到这一段') || sectionWait(st, 'New chats will not receive this section'));
  if (emptyAt >= 0 && emptyNoteAt < 0) errs.push('J4 never reads the empty state footnote (新对话不会收到这一段)');

  // The screenshots are the reviewable evidence, in the order the leg runs.
  for (const name of ['instructions-cover', 'instructions-composer', 'instructions-sent', 'instructions-edited', 'instructions-old-chat', 'instructions-truncated', 'instructions-truncated-sent', 'instructions-empty']) {
    if (shotAt(name) < 0) errs.push('J4 takes no `' + name + '` shot');
  }
  const coverShot = shotAt('instructions-cover'), composerShot = shotAt('instructions-composer');
  if (coverShot >= 0 && firstSendAt >= 0 && coverShot > firstSendAt) errs.push('the `instructions-cover` shot must be taken before the send');
  if (composerShot >= 0 && firstSendAt >= 0 && composerShot > firstSendAt) errs.push('the `instructions-composer` shot must be taken before the send');
  return errs;
}
// J12's contract: the phone's three thumb gestures, driven as real touch.
// jsdom has neither pointer capture nor `touch-action`, so a gesture can pass
// there and be dead under a finger (LESSONS 2026-10-30). J12 is the browser
// walk for the edge back, the row reveal and the hold-to-reorder: every leg
// must perform a `swipe`/`drag` and then READ the consequence it exists to
// prove. A journey that drops the gesture, starts the edge swipe outside the
// strip, or photographs the order instead of reading it after a reload is
// green while the phone gesture is dead.
//   node walk.mjs --check-spec [--spec path/to/journeys.json]
// These mirror the thresholds the gestures ship with in
// ui/src/hooks/useEdgeSwipeBack.ts (EDGE_START_PX / EDGE_COMMIT_PX) and
// SwipeReveal.tsx (+swipeGesture.ts). Nothing compares the numbers at build
// time, so a change there surfaces as a failed gesture in the walk, not here.
const J12_EDGE_START_PX = 20;
const J12_EDGE_COMMIT_PX = 64;
const J12_REVEAL_WIDTH = 152;
const J12_LONG_PRESS_MS = 500;
const J12_CHIP = /改名|Rename|置顶|Pin/;
function checkJ12Contract(spec) {
  const journey = (((spec || {}).journeys || {}).J12) || {};
  const steps = journey.steps;
  // J12 is registered in the index. An index or resolved spec that no longer
  // names it must be loud: the body is the phone's only gesture walk, and a
  // one-line deletion would otherwise retire it with every gate still green.
  if (!journey.title && !Array.isArray(steps)) return ['J12 is not in the spec'];
  if (!Array.isArray(steps) || steps.length === 0) return ['J12 has no steps'];
  const errs = [];
  const isFoldClick = (st) => Array.isArray(st) && st[0] === 'click'
    && /展开全部|Show all/.test(String(st[1] ?? ''));
  // Every J12 proof is mandatory. The executor logs a `?`-prefixed step that
  // does not match as `skipped …` with no hard failure, so one optional chip
  // wait or post-reload `rows` would leave the walk green while the gesture is
  // dead — the failure this contract exists to catch.
  steps.forEach((st) => {
    if (Array.isArray(st) && st.slice(1).some((v) => typeof v === 'string' && v.startsWith('?'))) {
      errs.push('J12 ' + (isFoldClick(st) ? 'project fold ' : 'step ') + JSON.stringify(st) + ' is optional; every J12 proof must be mandatory');
    }
  });
  const idx = (pred, from = 0) => steps.findIndex((st, i) => i >= from && Array.isArray(st) && pred(st));
  const after = (prev, pred) => (prev < 0 ? -1 : idx(pred, prev + 1));
  const sel = (st, i) => String((st || [])[i] ?? '');
  const num = (st, i) => Number(sel(st, i));
  const gestureAt = (i) => steps[i] && Array.isArray(steps[i]) && (steps[i][0] === 'swipe' || steps[i][0] === 'drag');
  const ASSERT_OPS = new Set(['wait', 'gone', 'count', 'url', 'search', 'value', 'rows', 'scroll-kept', 'active']);
  const assertionBetween = (from, to) => steps.some((st, i) => i > from && i < to && Array.isArray(st) && ASSERT_OPS.has(st[0]));

  // Phone only. A `swipe` or `drag` in a context without `hasTouch` is a mouse
  // wearing a touch verb; the executor refuses it, and so must the spec.
  const viewports = journey.viewports;
  if (!Array.isArray(viewports) || viewports.length !== 1 || viewports[0] !== 'phone') {
    errs.push('J12 is the phone thumb walk: its viewports must be exactly ["phone"]');
  }

  // Every unsearched list load whose rows the walk reads must press the fold
  // first. Past five rows the seeded row is not rendered until 展开全部 is
  // pressed, and a gesture aimed at it fails as "not on the screen". A load
  // followed by a non-empty search is exempt: `searching` force-opens every
  // bucket, so the row is drawn without the disclosure. The press must be
  // mandatory: an optional click would never prove the fold was exercised.
  const rowRead = (st) => Array.isArray(st)
    && ['click', 'wait', 'swipe', 'drag', 'rows'].includes(st[0])
    && /Morning planning/.test(JSON.stringify(st));
  let missingFold = false;
  steps.forEach((st, g) => {
    if (!Array.isArray(st) || st[0] !== 'goto' || st[1] !== '/sessions') return;
    const nextLoad = idx((cand) => cand[0] === 'goto', g + 1);
    const end = nextLoad < 0 ? steps.length : nextLoad;
    const readAt = steps.findIndex((cand, i) => i > g && i < end && rowRead(cand));
    if (readAt < 0) return;
    const fillAt = steps.findLastIndex((cand, i) => i > g && i < readAt && Array.isArray(cand)
      && cand[0] === 'fill' && /input\[type=search\]/.test(sel(cand, 1)));
    if (fillAt >= 0 && sel(steps[fillAt], 2).trim() !== '') return;
    const pressed = steps.findIndex((cand, i) => i > g && i < readAt && isFoldClick(cand) && !sel(cand, 1).startsWith('?'));
    if (pressed < 0) missingFold = true;
    if (fillAt < 0 || (pressed >= 0 && fillAt > pressed)) {
      errs.push('J12 must clear the search after each unsearched list load before pressing the project fold');
    }
  });
  if (missingFold) {
    errs.push('J12 never presses the project fold after a list load (click … 展开全部|Show all, not optional) before reading the seeded row');
  }

  // The standalone seed has only two Alpha rows. Create four conversations
  // through the fake-agent-gated UI so this walk exercises a real disclosure.
  const firstFoldAt = idx(isFoldClick);
  const fixtureSends = steps.filter((st, i) => i < firstFoldAt && Array.isArray(st) && st[0] === 'send');
  if (fixtureSends.length < 4) errs.push('J12 needs four fixture conversations before the project fold; the standalone seed does not fold');

  // Every gesture must be followed by the assertion it feeds before the next
  // gesture starts. A swipe nobody reads proves only that the event was sent.
  const gestures = steps.map((st, i) => i).filter((i) => gestureAt(i));
  gestures.forEach((at, k) => {
    const next = k + 1 < gestures.length ? gestures[k + 1] : steps.length;
    if (!assertionBetween(at, next)) {
      errs.push(`J12's ${steps[at][0]} at step ${at + 1} is never followed by an assertion (wait/gone/count/url/value/rows/scroll-kept) before the next gesture`);
    }
  });

  // Leg 1 — edge swipe back. The finger must start inside EDGE_START_PX and
  // travel past EDGE_COMMIT_PX; the point of the leg is that the search text
  // and the scroll offset it left are still there, so both must be set before
  // the swipe and read after it, without a reload in between (a fresh load
  // would restore them from the URL and sessionStorage, not from the pop).
  const edgeAt = idx((st) => {
    if (st[0] !== 'swipe') return false;
    const from = num(st, 1), to = num(st, 2);
    return Number.isFinite(from) && Number.isFinite(to) && from <= J12_EDGE_START_PX && to - from > J12_EDGE_COMMIT_PX;
  });
  if (edgeAt < 0) {
    errs.push(`J12 never swipes in from the left edge past ${J12_EDGE_COMMIT_PX}px (swipe fromX ≤ ${J12_EDGE_START_PX} → toX; the strip and the commit distance are the gesture)`);
  } else {
    const searchSel = (st) => /input\[type=search\]/.test(sel(st, 1));
    const fillAt = idx((st) => st[0] === 'fill' && searchSel(st) && typeof st[2] === 'string' && st[2].trim() !== '');
    const scrollAt = idx((st) => st[0] === 'scroll' && /data-phone-scroll/.test(sel(st, 1)) && num(st, 2) > 0);
    if (fillAt < 0 || fillAt > edgeAt) errs.push('J12 must type a search term before the edge swipe; a search restored from nothing proves nothing');
    if (scrollAt < 0 || scrollAt > edgeAt) errs.push('J12 must scroll the list before the edge swipe; a kept offset of 0 is not a kept offset');
    const openAt = idx((st) => st[0] === 'click' && /data-session-row/.test(sel(st, 1)));
    if (openAt < 0 || openAt > edgeAt || !/Morning planning/.test(sel(steps[openAt], 1))) {
      errs.push('J12 must open the named [seed] Morning planning row before the edge swipe');
    }
    const valueAt = after(edgeAt, (st) => st[0] === 'value' && searchSel(st));
    const keptAt = after(edgeAt, (st) => st[0] === 'scroll-kept' && /data-phone-scroll/.test(sel(st, 1)));
    if (valueAt < 0) errs.push('J12 never reads the search text back after the edge swipe (value input[type=search] …)');
    else if (fillAt >= 0 && sel(steps[valueAt], 2) !== sel(steps[fillAt], 2)) errs.push('J12 reads a different search text than it typed before the edge swipe');
    if (keptAt < 0) errs.push('J12 never proves the scroll offset survived the edge swipe (scroll-kept css=[data-phone-scroll] …)');
    else if (scrollAt >= 0 && Math.abs(num(steps[keptAt], 2) - num(steps[scrollAt], 2)) > 48) errs.push('J12\'s scroll-kept offset is not the offset it scrolled to before the edge swipe');
    const gotoBetween = steps.findIndex((st, i) => i > edgeAt && i < Math.max(valueAt, keptAt, edgeAt + 1) && Array.isArray(st) && st[0] === 'goto');
    if (gotoBetween >= 0) errs.push('J12 reloads the document after the edge swipe; the search and scroll must survive the pop, not a fresh load');
  }

  // Leg 2 — row swipe. Left past the reveal width, the chip must be readable;
  // closing rightward must take the chips away and must NOT navigate.
  const leftAt = idx((st) => st[0] === 'swipe' && Number.isFinite(num(st, 1)) && Number.isFinite(num(st, 2)) && num(st, 1) - num(st, 2) > J12_REVEAL_WIDTH);
  if (leftAt < 0) {
    errs.push(`J12 never swipes a row left past ${J12_REVEAL_WIDTH}px (swipe fromX → toX; the reveal distance is the gesture)`);
  } else {
    const chipAt = after(leftAt, (st) => st[0] === 'wait' && J12_CHIP.test(sel(st, 1)));
    if (chipAt < 0) errs.push('J12 never waits for the revealed action chip after the row swipe (wait … 置顶|Pin|改名|Rename)');
    const closeAt = after(Math.max(chipAt, leftAt), (st) => st[0] === 'swipe' && num(st, 2) > num(st, 1));
    if (closeAt < 0) errs.push('J12 never swipes the row back closed (a rightward swipe); a revealed strip must be closable');
    const goneAt = after(Math.max(closeAt, chipAt), (st) => st[0] === 'gone' && J12_CHIP.test(sel(st, 1)));
    if (goneAt < 0) errs.push('J12 never proves the action chips are gone after the row closes (gone … 置顶|Pin|改名|Rename)');
    const urlAt = after(Math.max(closeAt, leftAt), (st) => st[0] === 'url' && /^\^?\/sessions/.test(sel(st, 1)));
    if (urlAt < 0) errs.push('J12 never proves the row swipe stayed on /sessions (url ^/sessions); a swipe must not navigate');
  }

  // Leg 3 — hold-to-reorder. The hold must be a real one, the new order must
  // be read from the drawn DOM, and the same read must happen after a reload:
  // a reorder that lives only in React state is gone as soon as the phone
  // reopens the list.
  const dragAt = idx((st) => st[0] === 'drag' && /data-session-row/.test(sel(st, 1)) && num(st, 3) >= J12_LONG_PRESS_MS);
  if (dragAt < 0) {
    errs.push(`J12 never holds a conversation row for ${J12_LONG_PRESS_MS}ms and drags it (drag css=…[data-session-row]… <dy> ${J12_LONG_PRESS_MS})`);
  } else {
    const reloadAt = after(dragAt, (st) => st[0] === 'goto' && sel(st, 1) === '/sessions');
    const orderAt = idx((st) => st[0] === 'rows', dragAt + 1);
    if (orderAt < 0 || (reloadAt >= 0 && orderAt > reloadAt)) {
      errs.push('J12 never reads the new row order after the drag and before the reload (rows css=<scope> token|token)');
    }
    const beforeAt = steps.findLastIndex((st, i) => i < dragAt && Array.isArray(st) && st[0] === 'rows');
    if (beforeAt < 0) errs.push('J12 never reads the row order before the drag (rows css=<scope> token|token); a drag with no before cannot prove it moved');
    else if (orderAt >= 0 && sel(steps[beforeAt], 2) === sel(steps[orderAt], 2)) errs.push('J12 expects the same row order before and after the drag; the hold must move the row');
    if (reloadAt < 0) errs.push('J12 never reloads the list after the drag (goto /sessions)');
    const postAt = after(reloadAt, (st) => st[0] === 'rows');
    if (reloadAt >= 0 && postAt < 0) errs.push('J12 never reads the order back after the reload; persistence is the half a drag without a reload cannot prove');
    if (orderAt >= 0 && reloadAt >= 0 && orderAt < reloadAt && postAt >= 0 && sel(steps[orderAt], 2) !== sel(steps[postAt], 2)) errs.push('J12 expects a different order after the reload than the drag produced');
  }

  // The legs run in the order a thumb learns them; the contract stays honest
  // about which gesture the later assertions belong to.
  if (edgeAt >= 0 && leftAt >= 0 && edgeAt > leftAt) errs.push('J12 runs the row swipe before the edge back; the edge leg is first');
  if (leftAt >= 0 && dragAt >= 0 && leftAt > dragAt) errs.push('J12 runs the hold-to-reorder before the row swipe; the row reveal is the middle leg');

  // A shell, list or locale diff that no longer selects J12 would let the
  // thumb gestures rot without the gate ever walking them: `--files` picks
  // the journeys from this table, first match wins.
  const paths = Array.isArray(spec.paths) ? spec.paths : [];
  const mapsToJ12 = (file) => {
    const row = paths.find(([re]) => re.split('|').some((p) => file.startsWith(p)));
    return !!row && Array.isArray(row[1]) && row[1].includes('J12');
  };
  for (const file of ['ui/src/components/layout/AppShell.tsx', 'ui/src/components/sessions/SessionList.tsx', 'ui/src/components/sessions/SessionRow.tsx', 'ui/src/components/mobile/MobileList.tsx', 'ui/src/pages/TaskDetailPage.tsx', 'ui/src/i18n/locales/zh.ts', 'ui/src/i18n/locales/en.ts']) {
    if (!mapsToJ12(file)) {
      errs.push(`the paths table does not map ${file} to J12; a diff there would not walk the thumb gestures`);
    }
  }
  return errs;
}
// J13 is KIN-RESULT-002's phone leg: the files panel's address, the two Back
// stops behind it, and the self-contained HTML file's preview/source switch.
// The deep link is a cold start (a `goto`), so the only way to prove the
// address is a place is to press Back and read where it lands; the switch is
// component state, so its proof is the iframe leaving and `aria-pressed`
// moving — and the address NOT moving. A click nobody reads is a click that
// proves only that the event was delivered.
const J13_DEEP_LINK = /panel=files&file=/;
const J13_PREVIEW = /预览|Preview/;
const J13_SOURCE = /源码|Code/;
// The seeded conversation's own prompt (journeys_seed.py). Every seeded
// conversation carries the same fake reply, so only the prompt says which one
// the Mac's cold start reopened.
const J14_MAC_PROMPT = '[seed] change: summarise the three things worth doing today.';
function checkJ13Contract(spec) {
  const journey = (((spec || {}).journeys || {}).J13) || {};
  const steps = journey.steps;
  // Registration is the point: deleting the one index line must be loud, or
  // the phone's file walk can be retired by an edit no gate notices.
  if (!journey.title && !Array.isArray(steps)) return ['J13 is not in the spec'];
  if (!Array.isArray(steps) || steps.length === 0) return ['J13 has no steps'];
  const errs = [];
  // J13's proofs are mandatory for the same reason J12's are: a `?`-prefixed
  // step that misses is logged as `skipped`, so one optional Back or iframe
  // wait would leave the walk green while the address or the switch is dead.
  steps.forEach((st) => {
    if (Array.isArray(st) && st.slice(1).some((v) => typeof v === 'string' && v.startsWith('?'))) {
      errs.push('J13 step ' + JSON.stringify(st) + ' is optional; every J13 proof must be mandatory');
    }
  });
  const idx = (pred, from = 0) => steps.findIndex((st, i) => i >= from && Array.isArray(st) && pred(st));
  const after = (prev, pred) => (prev < 0 ? -1 : idx(pred, prev + 1));
  const sel = (st, i) => String((st || [])[i] ?? '');

  // Phone only. The Mac draws the list and the viewer as two columns, so a
  // Mac width would walk a surface this leg never claims.
  const viewports = journey.viewports;
  if (!Array.isArray(viewports) || viewports.length !== 1 || viewports[0] !== 'phone') {
    errs.push('J13 is the phone file walk: its viewports must be exactly ["phone"]');
  }
  // No Mac-only paths: a hover is a mouse without a finger, a platform chord
  // is the desktop's shortcut, and a viewport scope is a leg that never runs
  // at 390.
  steps.forEach((st) => {
    if (!Array.isArray(st)) return;
    if (st[0] === 'hover') errs.push('J13 hovers a control; the phone walk must press, not hover');
    if (st[0] === 'vp' && String(st[1] || '') !== '') errs.push('J13 scopes steps to ' + JSON.stringify(st[1]) + '; it is phone-only');
    if (st[0] === 'key' && /meta|cmd|ctrl|alt/i.test(String(st[1] || ''))) errs.push('J13 presses the Mac-only chord ' + JSON.stringify(st[1]));
  });

  // Every click must be followed by the state it changed before the next
  // click starts. J13 is a chain of presses, and a press with no read is a
  // photograph of a page that may not have moved.
  const ASSERT_OPS = new Set(['wait', 'gone', 'count', 'url', 'search', 'value', 'active']);
  const clicks = steps.map((st, i) => i).filter((i) => Array.isArray(steps[i]) && steps[i][0] === 'click');
  clicks.forEach((at, k) => {
    const next = k + 1 < clicks.length ? clicks[k + 1] : steps.length;
    if (!steps.some((st, i) => i > at && i < next && Array.isArray(st) && ASSERT_OPS.has(st[0]))) {
      errs.push(`J13's click at step ${at + 1} (${sel(steps[at], 1)}) is never followed by an assertion before the next click`);
    }
  });

  // Leg 1 — the cold-start link names the seeded conversation and one source
  // file, and the file is read before Back leaves it.
  const deepAt = idx((st) => st[0] === 'goto' && J13_DEEP_LINK.test(sel(st, 1)) && sel(st, 1).includes('{conversation}'));
  if (deepAt < 0) {
    errs.push('J13 has no cold-start goto naming {conversation} and ?panel=files&file=…');
  } else {
    const readAt = idx((st) => st[0] === 'wait' || st[0] === 'count', deepAt + 1);
    const backAt = after(deepAt, (st) => st[0] === 'back');
    if (readAt < 0 || (backAt >= 0 && readAt > backAt)) {
      errs.push('J13 never reads the linked file before pressing Back; a link that only changed the URL proves nothing');
    }
    if (backAt < 0) {
      errs.push('J13 never presses Back after the file deep link');
    } else {
      // Back must be read as an address: `url` sees the pathname only, so the
      // query needs `search` — and the list state is `panel=files` with no
      // `file=`. A Back that only changes the local view fails this.
      const urlAt = after(backAt, (st) => st[0] === 'url');
      if (urlAt < 0) errs.push('J13 presses Back after the deep link without asserting the address it returned to (url …)');
      const listAt = after(backAt, (st) => (st[0] === 'search' || st[0] === 'url') && /panel=files/.test(sel(st, 1)) && !/file=/.test(sel(st, 1)));
      if (listAt < 0) errs.push('J13 never proves Back landed on the list address (?panel=files with no file=)');
      // The panel's own exits: Back from the file, then the list's exit to the
      // conversation (the close button — a cold deep link's history parent is
      // the session list, not the conversation it was pasted from, so a second
      // browser Back is not this leg's proof). Either a Back or the close is
      // the reader's way out; both must land on the conversation and take the
      // panel off the screen.
      const exitAt = after(listAt >= 0 ? listAt : backAt, (st) => st[0] === 'back' || (st[0] === 'click' && /关闭|Close/.test(sel(st, 1))));
      if (exitAt < 0) {
        errs.push('J13 never leaves the file list for the conversation (Back or the panel close)');
      } else {
        const taskAt = after(exitAt, (st) => st[0] === 'url' && /\/tasks\//.test(sel(st, 1)));
        if (taskAt < 0) errs.push('J13 never proves the exit from the list reached the conversation (url ^/tasks/…)');
        const cleanAt = after(exitAt, (st) => st[0] === 'search' && sel(st, 1).replace(/\s/g, '') === '^$');
        if (cleanAt < 0) errs.push('J13 never proves the exit cleared panel/file from the address (search ^$)');
        const closedAt = after(exitAt, (st) => st[0] === 'gone');
        if (closedAt < 0) errs.push('J13 never proves the files pane left the screen when it returned to the conversation (gone …)');
      }
    }
  }

  // Leg 1b — the queue KIN-RESULT-002 promises to the system Back. The cold
  // files link is four entries (list → conversation → file list → file); the
  // browser's own Back has to pop them in that order. `back` may press the
  // panel's own Return control, which is a different promise, so the queue is
  // pinned to `history-back`. And the list has to be SHOWN as the list: an
  // address change over a still-open viewer would pass a `search`-only pin.
  const sysBackAt = idx((st) => st[0] === 'history-back');
  if (sysBackAt < 0) {
    errs.push('J13 never presses the system Back (history-back) from the file deep link');
  } else {
    const listAddressAt = after(sysBackAt, (st) => st[0] === 'search' && /panel=files/.test(sel(st, 1)) && !/file=/.test(sel(st, 1)));
    const listShownAt = after(sysBackAt, (st) => st[0] === 'wait' && /data-phone-view/.test(sel(st, 1)) && /list/.test(sel(st, 1)));
    const viewerGoneAt = after(sysBackAt, (st) => st[0] === 'gone' && /data-pane/.test(sel(st, 1)) && /viewer/.test(sel(st, 1)));
    if (listAddressAt < 0) errs.push('J13 never proves the first system Back reached the file list (?panel=files with no file=)');
    if (listShownAt < 0) errs.push("J13 never proves the file list is the pane on screen after the first system Back (wait [data-phone-view='list'])");
    if (viewerGoneAt < 0) errs.push('J13 never proves the file viewer left the screen after the first system Back (gone [data-pane=viewer])');

    const conversationBackAt = after(listAddressAt >= 0 ? listAddressAt : sysBackAt, (st) => st[0] === 'history-back');
    const conversationAt = after(conversationBackAt, (st) => st[0] === 'url' && /\/tasks\//.test(sel(st, 1)));
    const cleanAddressAt = after(conversationBackAt, (st) => st[0] === 'search' && sel(st, 1).replace(/\s/g, '') === '^$');
    const panelGoneAt = after(conversationBackAt, (st) => st[0] === 'gone');
    if (conversationBackAt < 0) errs.push('J13 never presses a second system Back from the file list');
    if (conversationAt < 0) errs.push('J13 never proves the second system Back reached the conversation (url ^/tasks/…)');
    if (cleanAddressAt < 0) errs.push('J13 never proves the second system Back cleared panel/file from the address (search ^$)');
    if (panelGoneAt < 0) errs.push('J13 never proves the files pane left the screen when the second system Back reached the conversation (gone …)');

    const sessionsBackAt = after(cleanAddressAt >= 0 ? cleanAddressAt : conversationBackAt, (st) => st[0] === 'history-back');
    const sessionsAt = after(sessionsBackAt, (st) => st[0] === 'url' && /sessions/.test(sel(st, 1)));
    if (sessionsBackAt < 0) errs.push('J13 never presses the third system Back from the conversation');
    if (sessionsAt < 0) errs.push('J13 never proves the third system Back reached the session list (url ^/sessions)');

    // Leg 1c — reopening Files from the conversation starts at the list. The
    // file the reader left belongs to a history entry, not to the panel's
    // memory; a panel that replays it opens a file nobody chose.
    const rowAt = after(sessionsAt >= 0 ? sessionsAt : sessionsBackAt, (st) => st[0] === 'click' && /data-session-row/.test(sel(st, 1)));
    const sheetAt = after(rowAt, (st) => st[0] === 'click' && /会话操作|Session actions/.test(sel(st, 1)));
    // The sheet row's label is a nested span, so `button:text-is(…)` does not
    // match it; the walker's exact-text regex does, and the row must be waited
    // for before the press (the sheet's entrance is animated).
    const filesRowSelector = /text-is\('(?:文件|Files)'\)|\^\(文件\|Files\)\$/;
    const reopenAt = after(sheetAt, (st) => st[0] === 'click' && filesRowSelector.test(sel(st, 1)));
    if (rowAt < 0) errs.push('J13 never reopens the seeded conversation after the system Back queue');
    if (sheetAt < 0) errs.push('J13 never opens the session action sheet to reach Files');
    if (reopenAt < 0) errs.push('J13 never presses the Files row in the action sheet');
    const reopenPanelAt = after(reopenAt, (st) => st[0] === 'search' && /panel=files/.test(sel(st, 1)) && !/file=/.test(sel(st, 1)));
    const reopenListAt = after(reopenAt, (st) => st[0] === 'wait' && /data-phone-view/.test(sel(st, 1)) && /list/.test(sel(st, 1)));
    const reopenGoneAt = after(reopenAt, (st) => st[0] === 'gone' && /data-pane/.test(sel(st, 1)) && /viewer/.test(sel(st, 1)));
    if (reopenPanelAt < 0) errs.push('J13 never proves opening Files named the list address (?panel=files with no file=)');
    if (reopenListAt < 0) errs.push("J13 never proves reopening Files shows the list (wait [data-phone-view='list'])");
    if (reopenGoneAt < 0) errs.push('J13 never proves reopening Files does not replay the earlier file (gone [data-pane=viewer])');
  }

  // Leg 2 — the self-contained HTML file. The preview is pressed, the source
  // press takes the iframe away and shows the source, and the preview press
  // brings the page back; every press moves `aria-pressed`, and the address
  // stays on the file because the switch is not a navigation.
  const openHtmlAt = idx((st) => st[0] === 'click' && /preview\.html/.test(sel(st, 1)));
  if (openHtmlAt < 0) errs.push('J13 never opens the seeded preview.html from the list');
  else {
    const iframeAt = after(openHtmlAt, (st) => (st[0] === 'wait' || st[0] === 'count') && /html-preview-header/.test(sel(st, 1)));
    if (iframeAt < 0) errs.push('J13 never waits for the HTML preview page (wait css=[data-testid=html-preview-header] iframe)');
  }
  const sourceAt = idx((st) => st[0] === 'click' && J13_SOURCE.test(sel(st, 1)));
  const previewAt = idx((st) => st[0] === 'click' && J13_PREVIEW.test(sel(st, 1)));
  if (sourceAt < 0) {
    errs.push('J13 never presses 源码/Code on the HTML preview');
  } else {
    const goneAt = after(sourceAt, (st) => st[0] === 'gone' && /iframe/.test(sel(st, 1)));
    const seenAt = after(sourceAt, (st) => (st[0] === 'wait' || st[0] === 'count') && /Seed preview page/.test(sel(st, 1)));
    const pressedAt = after(sourceAt, (st) => st[0] === 'count' && /aria-pressed/.test(sel(st, 1)) && J13_SOURCE.test(sel(st, 1)));
    if (goneAt < 0) errs.push('J13 never proves the preview iframe left the screen when 源码 was pressed (gone …iframe)');
    if (seenAt < 0) errs.push('J13 never reads the HTML source after pressing 源码');
    if (pressedAt < 0) errs.push('J13 never proves 源码 is the pressed segment (count …aria-pressed…)');
  }
  if (previewAt < 0) {
    errs.push('J13 never presses 预览/Preview');
  } else {
    const iframeBackAt = after(previewAt, (st) => (st[0] === 'wait' || st[0] === 'count') && /iframe/.test(sel(st, 1)));
    const pressedBackAt = after(previewAt, (st) => st[0] === 'count' && /aria-pressed/.test(sel(st, 1)) && J13_PREVIEW.test(sel(st, 1)));
    if (iframeBackAt < 0) errs.push('J13 never proves the preview iframe came back when 预览 was pressed');
    if (pressedBackAt < 0) errs.push('J13 never proves 预览 is pressed again after the source');
    if (sourceAt >= 0 && previewAt < sourceAt) errs.push('J13 presses 预览 before 源码; the switch is a round trip');
    const openedAt = steps.findIndex((st, i) => i < previewAt && Array.isArray(st) && st[0] === 'count' && /aria-pressed/.test(sel(st, 1)) && J13_PREVIEW.test(sel(st, 1)));
    if (openedAt < 0) errs.push('J13 never proves 预览 is the pressed segment when the HTML file opens');
    if (sourceAt >= 0) {
      const sameAddressAt = steps.findIndex((st, i) => i > sourceAt && i < (previewAt > sourceAt ? previewAt : steps.length) && Array.isArray(st) && (st[0] === 'search' || st[0] === 'url') && /file=/.test(sel(st, 1)));
      if (sameAddressAt < 0) errs.push('J13 never asserts the address stayed on the file across the preview/source switch (search …file=…)');
    }
  }

  // A page or locale diff that no longer selects J13 would let the phone's
  // file panel rot without the gate ever walking it: `--files` picks journeys
  // from this table, first match wins.
  const paths = Array.isArray(spec.paths) ? spec.paths : [];
  const mapsToJ13 = (file) => {
    const row = paths.find(([re]) => re.split('|').some((p) => file.startsWith(p)));
    return !!row && Array.isArray(row[1]) && row[1].includes('J13');
  };
  for (const file of ['ui/src/pages/TaskDetailPage.tsx', 'ui/src/components/workspace/WorkspacePanel.tsx', 'ui/src/components/workspace/FilePreview.tsx', 'ui/src/i18n/locales/zh.ts', 'ui/src/i18n/locales/en.ts']) {
    if (!mapsToJ13(file)) {
      errs.push(`the paths table does not map ${file} to J13; a diff there would not walk the file panel`);
    }
  }
  return errs;
}
// J14's contract: KIN-CONTINUE-001's three sentences at the walk's level. A
// Mac cold start at `/` reopens the conversation the reader left, proved by
// that conversation's own prompt (every seeded conversation carries the same
// fake reply, so the reply cannot say which one came back); ⌘K's dialog holds
// places and recipes but no conversation rows; and the phone home is the one
// list with the device, project and conversation levels on screen at 390. The
// walk is two cold starts, so its viewports are exactly `mac` and `phone`;
// unlike J13 it is not phone-only, so the phone leg's ban is only the Mac's
// own input (chords and hover).
//   node walk.mjs --check-spec [--spec path/to/journeys.json]
function checkJ14Contract(spec) {
  const journey = (((spec || {}).journeys || {}).J14) || {};
  const steps = journey.steps;
  // Registration is the point: deleting the one index line must be loud, or
  // the cold-start walk can be retired by an edit no gate notices.
  if (!journey.title && !Array.isArray(steps)) return ['J14 is not in the spec'];
  if (!Array.isArray(steps) || steps.length === 0) return ['J14 has no steps'];
  const errs = [];
  const idx = (pred, from = 0) => steps.findIndex((st, i) => i >= from && Array.isArray(st) && pred(st));
  const after = (prev, pred) => (prev < 0 ? -1 : idx(pred, prev + 1));
  const sel = (st, i) => String((st || [])[i] ?? '');

  // Only the project fold may be optional: past five rows the bucket draws
  // 展开全部 and a standalone walk's bucket may not. Every address, count,
  // wait, node, key and gone is a proof, and a `?`-prefixed proof that misses
  // is logged as `skipped` — green while the cold start, a palette zero or a
  // list level is dead.
  steps.forEach((st) => {
    if (!Array.isArray(st)) return;
    const optional = st.slice(1).some((v) => typeof v === 'string' && v.startsWith('?'));
    if (!optional) return;
    const isFold = st[0] === 'click' && /展开全部|Show all/.test(sel(st, 1));
    if (!isFold) {
      errs.push('J14 step ' + JSON.stringify(st) + ' is optional; only the project fold may be optional, every proof must be mandatory');
    }
  });

  // Two cold starts: a Mac reload and a phone reload, each landing on a list
  // the reader already had. One viewport would walk half the story.
  const viewports = journey.viewports;
  if (!Array.isArray(viewports) || viewports.length !== 2 || viewports[0] !== 'mac' || viewports[1] !== 'phone') {
    errs.push('J14 is two cold starts: its viewports must be exactly ["mac","phone"]');
  }
  const macAt = idx((st) => st[0] === 'vp' && sel(st, 1) === 'mac');
  const phoneAt = idx((st) => st[0] === 'vp' && sel(st, 1) === 'phone');

  // Leg 1 — the Mac cold start returns to the last conversation, not merely a
  // conversation. A conversation is open first (`url ^/tasks/` before the
  // reload), then `goto /` under `vp mac`, then the address and that
  // conversation's own prompt. The generic fake reply is on every seeded
  // conversation and cannot stand in for the wait.
  const openedAt = macAt < 0 ? -1 : steps.findIndex((st, i) => i < macAt && Array.isArray(st) && st[0] === 'url' && /^\^\/tasks\//.test(sel(st, 1)));
  if (macAt < 0) {
    errs.push('J14 never scopes the Mac leg (vp mac)');
  } else {
    if (openedAt < 0) errs.push('J14 never opens a conversation before the Mac cold start (url ^/tasks/)');
    const gotoAt = idx((st) => st[0] === 'goto' && sel(st, 1) === '/', macAt + 1);
    if (gotoAt < 0 || (phoneAt >= 0 && gotoAt > phoneAt)) {
      errs.push('J14 never reloads the Mac onto / for its cold start after the conversation is open (goto / under vp mac)');
    } else {
      const addressAt = after(gotoAt, (st) => st[0] === 'url' && /^\^\/tasks\//.test(sel(st, 1)));
      const promptAt = after(gotoAt, (st) => st[0] === 'wait' && /role=.?region/.test(sel(st, 1)) && sel(st, 1).includes(J14_MAC_PROMPT));
      if (addressAt < 0) errs.push('J14 never proves the Mac cold start landed on a conversation (url ^/tasks/)');
      if (promptAt < 0) errs.push('J14 never proves the Mac cold start reopened the last conversation (wait … ' + J14_MAC_PROMPT + ')');
    }
  }

  // Leg 2 — ⌘K holds places and recipes, not conversations. The places row is
  // required before the two zeros: a palette that failed to open would count
  // zero rows and pass a zero-only check.
  const keyAt = idx((st) => st[0] === 'key' && /^(meta|cmd)\+k$/i.test(sel(st, 1)));
  if (keyAt < 0) {
    errs.push('J14 never opens the command palette (key Meta+k)');
  } else {
    const dialogAt = after(keyAt, (st) => st[0] === 'wait' && /\[role=dialog\]/.test(sel(st, 1)));
    if (dialogAt < 0) errs.push('J14 never waits for the palette dialog (wait [role=dialog])');
    const placesAt = after(keyAt, (st) => st[0] === 'wait' && /例行任务|Routines/.test(sel(st, 1)));
    if (placesAt < 0) errs.push('J14 never proves the palette still holds a places/recipes row (例行任务|Routines); an empty palette would satisfy the zeros');
    const rowsAt = after(keyAt, (st) => st[0] === 'count' && /\[role=dialog\]/.test(sel(st, 1)) && /\[data-session-row\]/.test(sel(st, 1)) && sel(st, 2) === '0');
    if (rowsAt < 0) errs.push('J14 never proves the palette holds no conversation rows (count [role=dialog] [data-session-row] 0)');
    const seedAt = after(keyAt, (st) => st[0] === 'count' && /\[role=dialog\]/.test(sel(st, 1)) && /Morning planning/.test(sel(st, 1)) && sel(st, 2) === '0');
    if (seedAt < 0) errs.push('J14 never proves the palette does not name the seeded conversation (count … Morning planning 0)');
    const escapeAt = after(keyAt, (st) => st[0] === 'key' && sel(st, 1) === 'Escape');
    if (escapeAt < 0) errs.push('J14 never closes the palette with Escape');
    const goneAt = escapeAt < 0 ? -1 : after(escapeAt, (st) => st[0] === 'gone' && /\[role=dialog\]/.test(sel(st, 1)));
    if (goneAt < 0) errs.push('J14 never proves the palette left the screen (gone [role=dialog])');
  }

  // Leg 3 — the phone home is the one list at three levels. A cold `goto /`
  // under `vp phone` lands on /sessions, and the device heading, the project
  // button and the conversation row are all on screen. The count of one is
  // the one-list claim: a second copy of the seeded row is a duplicated list.
  if (phoneAt < 0) {
    errs.push('J14 never scopes the phone leg (vp phone)');
  } else {
    const phoneGotoAt = after(phoneAt, (st) => st[0] === 'goto' && sel(st, 1) === '/');
    if (phoneGotoAt < 0) {
      errs.push('J14 never reloads the phone home (goto / under vp phone)');
    } else {
      const sessionsAt = after(phoneGotoAt, (st) => st[0] === 'url' && /^\^\/sessions/.test(sel(st, 1)));
      if (sessionsAt < 0) errs.push('J14 never proves the phone cold start landed on the session list (url ^/sessions)');
      const deviceAt = after(phoneGotoAt, (st) => st[0] === 'wait' && /此设备|This machine/.test(sel(st, 1)));
      if (deviceAt < 0) errs.push('J14 never proves the phone one list draws its device level (wait … 此设备|This machine)');
      const projectAt = after(phoneGotoAt, (st) => st[0] === 'wait' && /\[seed\] Project Alpha/.test(sel(st, 1)));
      if (projectAt < 0) errs.push('J14 never proves the phone one list draws its project level (wait … [seed] Project Alpha)');
      const rowAt = after(phoneGotoAt, (st) => st[0] === 'wait' && /\[data-session-row\]/.test(sel(st, 1)) && /Morning planning/.test(sel(st, 1)));
      if (rowAt < 0) errs.push('J14 never proves the phone one list draws its conversation level (wait [data-session-row] … Morning planning)');
      const oneAt = after(phoneGotoAt, (st) => st[0] === 'count' && /\[data-session-row\]/.test(sel(st, 1)) && /Morning planning/.test(sel(st, 1)) && sel(st, 2) === '1');
      if (oneAt < 0) errs.push('J14 never proves the one list draws the seeded conversation exactly once (count … = 1)');
    }
  }

  // The phone leg has no mouse and no keyboard: a platform chord or a hover
  // after `vp phone` would press a control the surface does not have.
  if (phoneAt >= 0) {
    for (let i = phoneAt + 1; i < steps.length; i += 1) {
      const st = steps[i];
      if (!Array.isArray(st)) continue;
      if (st[0] === 'hover') errs.push('J14 hovers a control in the phone leg; the phone must press, not hover');
      if (st[0] === 'key' && /meta|cmd|ctrl|alt/i.test(sel(st, 1))) {
        errs.push('J14 presses the Mac-only chord ' + JSON.stringify(sel(st, 1)) + ' in the phone leg');
      }
    }
  }

  // Every click must be followed by the state it changed before the next
  // click starts. A press with no read is a photograph of a page that may not
  // have moved.
  const ASSERT_OPS = new Set(['wait', 'gone', 'count', 'url', 'search', 'value', 'active']);
  const clicks = steps.map((st, i) => i).filter((i) => Array.isArray(steps[i]) && steps[i][0] === 'click');
  clicks.forEach((at, k) => {
    const next = k + 1 < clicks.length ? clicks[k + 1] : steps.length;
    if (!steps.some((st, i) => i > at && i < next && Array.isArray(st) && ASSERT_OPS.has(st[0]))) {
      errs.push(`J14's click at step ${at + 1} (${sel(steps[at], 1)}) is never followed by an assertion before the next click`);
    }
  });

  // The paths table selects the journeys `--files` walks, first match wins. A
  // palette, list or conversation diff that drops J14 would let the cold
  // start rot without the gate ever walking it.
  const paths = Array.isArray(spec.paths) ? spec.paths : [];
  const mapsToJ14 = (file) => {
    const row = paths.find(([re]) => re.split('|').some((p) => file.startsWith(p)));
    return !!row && Array.isArray(row[1]) && row[1].includes('J14');
  };
  for (const file of ['ui/src/components/CommandPalette.tsx', 'ui/src/pages/SessionsPage.tsx', 'ui/src/components/sessions/SessionList.tsx', 'ui/src/components/mobile/MobileList.tsx', 'ui/src/pages/TaskDetailPage.tsx', 'ui/src/components/chat/ChatStream.tsx']) {
    if (!mapsToJ14(file)) {
      errs.push(`the paths table does not map ${file} to J14; a diff there would not walk the cold start`);
    }
  }
  return errs;
}
// J1's contract: the phone leg must find last week's chat, search and filter
// the list, and then decide two real cards — approve one, deny another —
// reading each answer's control off the screen. Every one of those steps can
// be deleted today with the gate green; only a 20-minute browser walk notices,
// and only if it happens to fail. The deep links reason about the seed's
// placeholders (`--resolve-j1` fills them), never about an invented id.
//   node walk.mjs --check-spec [--spec path/to/journeys.json]
function checkJ1Contract(spec) {
  const journey = (((spec || {}).journeys || {}).J1) || {};
  const steps = journey.steps;
  // Registration is the point: deleting the one index line must be loud, or
  // the phone's search/approve/deny walk can be retired by an edit no gate
  // notices.
  if (!journey.title && !Array.isArray(steps)) return ['J1 is not in the spec'];
  if (!Array.isArray(steps) || steps.length === 0) return ['J1 has no steps'];
  const errs = [];
  const required = (v) => typeof v === 'string' && !v.startsWith('?');
  const bare = (v) => String(v).replace(/^\?/, '');
  const sel = (st, i) => String((st || [])[i] ?? '');
  const idx = (pred, from = 0) => steps.findIndex((st, i) => i >= from && Array.isArray(st) && pred(st, i));

  // Phone only: the search field, the filter sheet and the approval card are
  // the 390px surfaces; a Mac width would walk a layout this leg never claims.
  const viewports = journey.viewports;
  if (!Array.isArray(viewports) || viewports.length !== 1 || viewports[0] !== 'phone') {
    errs.push('J1 is the phone approve/deny proof: its viewports must be exactly ["phone"]');
  }

  // Only setup steps — a fill or a click — may be optional. Every `gone`,
  // `wait`, `count`, `url`, `key`, `focus`, `value` and `active` is a proof,
  // and a `?`-prefixed proof that misses is logged as `skipped`: the walk
  // stays green while the decision is dead. (The decisions' own presses are
  // pinned as mandatory below, so an optional click cannot hide one.)
  steps.forEach((st) => {
    if (!Array.isArray(st)) return;
    if (!st.slice(1).some((v) => typeof v === 'string' && v.startsWith('?'))) return;
    if (st[0] !== 'fill' && st[0] !== 'click') {
      errs.push('J1 step ' + JSON.stringify(st) + ' is optional; only a fill or a click setup step may be optional, every proof must be mandatory');
    }
  });

  // The list is searched and filtered before either decision: deleting any of
  // the three leaves the walk starting on a card, not on the list a person
  // actually uses to find last week's chat.
  const firstTaskAt = idx((st) => st[0] === 'goto' && /\/tasks\//.test(bare(sel(st, 1))));
  const searchAt = idx((st) => st[0] === 'fill' && /input\[type=search\]/.test(sel(st, 1)) && sel(st, 2).trim() !== '');
  const filterAt = idx((st) => st[0] === 'click' && /筛选|Filter/.test(sel(st, 1)));
  const escapeAt = idx((st) => st[0] === 'key' && sel(st, 1) === 'Escape');
  if (searchAt < 0) errs.push('J1 never searches the list before the decisions (fill … input[type=search] with a term)');
  if (filterAt < 0) errs.push('J1 never opens the search filter before the decisions (click 筛选 / Filter)');
  if (escapeAt < 0) errs.push('J1 never closes the search filter with Escape before the decisions');
  if (searchAt >= 0 && filterAt >= 0 && filterAt < searchAt) {
    errs.push('J1 opens the filter before it searches; the search leg is fill, filter, Escape');
  }
  if (filterAt >= 0 && escapeAt >= 0 && escapeAt < filterAt) {
    errs.push('J1 presses Escape before it opens the filter; the search leg is fill, filter, Escape');
  }
  if (firstTaskAt >= 0) {
    if (searchAt > firstTaskAt) errs.push('J1 searches the list only after the first decision; the search leg must come first');
    if (filterAt > firstTaskAt) errs.push('J1 opens the filter only after the first decision; the search leg must come first');
    if (escapeAt > firstTaskAt) errs.push('J1 presses Escape only after the first decision; the search leg must come first');
  }

  // Each decision is a landing, a press and a consequence. The deep link must
  // name the seed's own placeholders; the press must follow the landing; and a
  // mandatory `gone` must follow the press, because a card still showing its
  // control after the walk says it decided was never decided.
  const APPROVE = /批准|Approve/;
  const DENY = /拒绝|Deny/;
  const linkAt = (name) => idx((st) => st[0] === 'goto' && required(sel(st, 1))
    && /\/tasks\//.test(bare(sel(st, 1))) && bare(sel(st, 1)).includes('{' + name + '.conversation}'));
  const pressAt = (re) => idx((st) => st[0] === 'click' && required(sel(st, 1)) && re.test(bare(sel(st, 1))));
  const goneAt = (re, from) => idx((st) => st[0] === 'gone' && required(sel(st, 1)) && re.test(bare(sel(st, 1))), from);
  const approveAt = linkAt('approve');
  const approvePress = pressAt(APPROVE);
  const approveGone = approvePress < 0 ? -1 : goneAt(APPROVE, approvePress + 1);
  const denyAt = linkAt('deny');
  const denyPress = pressAt(DENY);
  const denyGone = denyPress < 0 ? -1 : goneAt(DENY, denyPress + 1);
  if (approveAt < 0) {
    errs.push('J1 has no required approve deep link naming {approve.conversation} and focus={approve.focus}');
  } else if (!bare(sel(steps[approveAt], 1)).includes('{approve.focus}')) {
    errs.push('J1\'s approve deep link never names focus={approve.focus}; the card it opens is whatever landed');
  }
  if (approvePress < 0) errs.push('J1 never presses the approve control (批准 / Approve)');
  else if (approveAt >= 0 && approvePress < approveAt) errs.push('J1 presses approve before the approve deep link lands on the card');
  if (approveGone < 0) errs.push('J1 never proves the approve control left the screen after the answer (gone 批准 / Approve)');
  else if (denyAt >= 0 && approveGone > denyAt) {
    errs.push('J1 reads the approve control gone only after the deny card landed; the approve answer must be proven on its own card');
  }
  if (denyAt < 0) {
    errs.push('J1 has no required deny deep link naming {deny.conversation} and focus={deny.focus}');
  } else if (!bare(sel(steps[denyAt], 1)).includes('{deny.focus}')) {
    errs.push('J1\'s deny deep link never names focus={deny.focus}; the card it opens is whatever landed');
  }
  if (denyPress < 0) errs.push('J1 never presses the deny control (拒绝 / Deny)');
  else if (denyAt >= 0 && denyPress < denyAt) errs.push('J1 presses deny before the deny deep link lands on the card');
  if (denyGone < 0) errs.push('J1 never proves the deny control left the screen after the answer (gone 拒绝 / Deny)');

  // Two decisions, two cards: a copy-paste that points the deny leg at the
  // approve conversation approves and denies the same card, and the second
  // press lands on something already answered. The approve conversation is
  // decided first, and the deny link must not borrow either approve
  // placeholder (nor the approve link a deny one).
  if (approveAt >= 0 && denyAt >= 0) {
    const approveLink = bare(sel(steps[approveAt], 1));
    const denyLink = bare(sel(steps[denyAt], 1));
    if (/\{approve\.(conversation|focus)\}/.test(denyLink) || /\{deny\.(conversation|focus)\}/.test(approveLink)) {
      errs.push('J1 points both decisions at the same conversation: the approve and deny deep links must name different placeholders');
    }
    if (denyAt < approveAt) errs.push('J1 denies before it approves: the approve conversation must be decided first');
  }

  // No Mac-only input: a hover is a mouse a phone does not have, a platform
  // chord is the desktop's shortcut, and a viewport scope is a leg that never
  // runs at 390.
  steps.forEach((st) => {
    if (!Array.isArray(st)) return;
    if (st[0] === 'hover') errs.push('J1 hovers a control; the phone walk must press, not hover (Mac-only input)');
    if (st[0] === 'vp' && String(st[1] || '') !== '') errs.push('J1 scopes steps to ' + JSON.stringify(st[1]) + '; a Mac-only viewport scope has no place in the phone leg');
    if (st[0] === 'key' && /meta|cmd|ctrl|alt/i.test(sel(st, 1))) errs.push('J1 presses the Mac-only chord ' + JSON.stringify(sel(st, 1)));
  });

  // A mandatory press must be followed by the state it changed before the next
  // press starts; the optional filter click is setup, and its proof is the
  // `gone` after each answer.
  const ASSERT_OPS = new Set(['wait', 'gone', 'count', 'url', 'search', 'value', 'active']);
  const clicks = steps.map((st, i) => i).filter((i) => Array.isArray(steps[i]) && steps[i][0] === 'click' && required(steps[i][1]));
  clicks.forEach((at, k) => {
    const next = k + 1 < clicks.length ? clicks[k + 1] : steps.length;
    if (!steps.some((st, i) => i > at && i < next && Array.isArray(st) && ASSERT_OPS.has(st[0]))) {
      errs.push(`J1's click at step ${at + 1} (${sel(steps[at], 1)}) is never followed by an assertion before the next click`);
    }
  });

  // The paths table selects the journeys `--files` walks, first match wins. A
  // list or conversation diff that drops J1 would let the phone's decisions
  // rot without the gate ever walking them.
  const paths = Array.isArray(spec.paths) ? spec.paths : [];
  const mapsToJ1 = (file) => {
    const row = paths.find(([re]) => re.split('|').some((p) => file.startsWith(p)));
    return !!row && Array.isArray(row[1]) && row[1].includes('J1');
  };
  for (const file of ['ui/src/pages/SessionsPage.tsx', 'ui/src/components/mobile/MobileList.tsx', 'ui/src/pages/TaskDetailPage.tsx']) {
    if (!mapsToJ1(file)) {
      errs.push(`the paths table does not map ${file} to J1; a diff there would not walk the phone search/approve/deny leg`);
    }
  }
  return errs;
}
// J6's contract: the settings leg must change the default agent, prove the
// next new chat hosts it, and put the old value back. The chain is four
// settings surfaces (the legacy `/agents` redirect included), the default row
// read in both locales, both agents counted in the picker, the pick, the save,
// a reload that proves persistence, the `/new` read, and the restore.
// Deleting any one leaves the walk green while the default silently stayed —
// or leaves the daemon hosting Codex for every later journey.
//   node walk.mjs --check-spec [--spec path/to/journeys.json]
function checkJ6Contract(spec) {
  const journey = (((spec || {}).journeys || {}).J6) || {};
  const steps = journey.steps;
  // Registration is the point: deleting the one index line must be loud, or
  // the settings walk can be retired by an edit no gate notices.
  if (!journey.title && !Array.isArray(steps)) return ['J6 is not in the spec'];
  if (!Array.isArray(steps) || steps.length === 0) return ['J6 has no steps'];
  const errs = [];
  const sel = (st, i) => String((st || [])[i] ?? '');
  const idx = (pred, from = 0) => steps.findIndex((st, i) => i >= from && Array.isArray(st) && pred(st, i));
  const after = (from, pred) => (from < 0 ? -1 : idx(pred, from + 1));
  const SAVE = /保存默认 agent|Save default agent/;
  const STATUS = /\[role=['"]?status['"]?\]/;
  const SAVED = /已保存|Saved/;

  // No optional steps at all: every address, count, wait and click is a
  // proof, and a `?`-prefixed step that misses is logged as `skipped` — the
  // walk stays green while the default never changed.
  steps.forEach((st) => {
    if (Array.isArray(st) && st.slice(1).some((v) => typeof v === 'string' && v.startsWith('?'))) {
      errs.push('J6 step ' + JSON.stringify(st) + ' is optional; every J6 proof must be mandatory');
    }
  });

  // The default is changed at the phone and read at the Mac (the walk runs
  // both widths); one viewport would walk half the story.
  const viewports = journey.viewports;
  if (!Array.isArray(viewports) || viewports.length !== 2 || viewports[0] !== 'phone' || viewports[1] !== 'mac') {
    errs.push('J6 changes and reads the default at both widths: its viewports must be exactly ["phone","mac"]');
  }

  // The restore leg's first press — the picker option that puts claude-code
  // back — bounds the Codex leg, so a Codex leg that lost its save cannot
  // borrow the restore leg's.
  const restoreAt = idx((st) => st[0] === 'click' && sel(st, 1).includes('(claude-code)'));
  const beforeRestore = (i) => restoreAt < 0 || i < restoreAt;

  // The choice under test: the Codex picker option. Everything that reads the
  // before-picture must precede it.
  const pickAt = idx((st) => st[0] === 'click' && sel(st, 1).includes('(codex)'));

  // The four surfaces are a chain: 设置 → 运维 → the legacy /agents redirect
  // → providers. Each is its own address, and all precede the choice.
  const surfaces = ['/settings', '/settings?tab=operations', '/agents', '/settings?tab=providers'];
  const surfaceAts = surfaces.map((p) => idx((st) => st[0] === 'goto' && sel(st, 1) === p));
  surfaceAts.forEach((at, k) => {
    if (at < 0) errs.push(`J6 never visits ${surfaces[k]} among the settings surfaces before it chooses an agent`);
    else if (pickAt >= 0 && at > pickAt) errs.push(`J6's settings surfaces are out of order: ${surfaces[k]} must be visited before the first agent choice`);
  });
  for (let k = 1; k < surfaceAts.length; k += 1) {
    if (surfaceAts[k - 1] >= 0 && surfaceAts[k] >= 0 && surfaceAts[k] < surfaceAts[k - 1]) {
      errs.push(`J6 visits ${surfaces[k]} before ${surfaces[k - 1]}; the settings surfaces are a chain`);
    }
  }

  // The default row is read in both locales before the change: the walk shows
  // the before-picture, not only the after.
  const descAt = idx((st) => st[0] === 'wait' && sel(st, 1).includes('#default-agent-desc')
    && sel(st, 1).includes('新建对话默认用它') && sel(st, 1).includes('A new chat starts with this agent'));
  if (descAt < 0) {
    errs.push('J6 never reads the default-agent row in both locales (wait #default-agent-desc … 新建对话默认用它 … A new chat starts with this agent)');
  } else if (pickAt >= 0 && descAt > pickAt) {
    errs.push('J6 reads the default-agent row only after it chose an agent; the row is the before-picture');
  }

  // Both agents must be listed before the choice: a picker that quietly lost
  // one option cannot offer the change the leg claims.
  const countAt = (tag) => idx((st) => st[0] === 'count' && sel(st, 1).includes('(' + tag + ')') && sel(st, 2) === '1');
  const claudeCountAt = countAt('claude-code');
  const codexCountAt = countAt('codex');
  // The counts read the open list: a count moved before the trigger press
  // would find no visible option, and the browser walk would fail for a
  // reason the spec check should have named first.
  const openAt = idx((st) => st[0] === 'click' && sel(st, 1).includes('aria-describedby') && sel(st, 1).includes('aria-haspopup'));
  if (claudeCountAt < 0) errs.push('J6 never counts the picker listing claude-code exactly once (count … (claude-code) 1)');
  if (codexCountAt < 0) errs.push('J6 never counts the picker listing codex exactly once (count … (codex) 1)');
  [['claude-code', claudeCountAt], ['codex', codexCountAt]].forEach(([tag, at]) => {
    if (at >= 0 && pickAt >= 0 && at > pickAt) errs.push(`J6 counts the picker's ${tag} option only after the choice; both agents must be listed first`);
    if (at >= 0 && openAt >= 0 && at < openAt) errs.push(`J6 counts the picker's ${tag} option before the picker is opened; the count must read the open list`);
  });

  // The choice and the save: the trigger must move to codex, the save must be
  // pressed, and the status must say it landed. Three separate proofs — a
  // press nobody reads is a photograph of a page that may not have moved.
  const codexTriggerAt = after(pickAt, (st, i) => beforeRestore(i) && st[0] === 'wait' && /aria-label/.test(sel(st, 1)) && sel(st, 1).includes('(codex)'));
  const saveAt = after(codexTriggerAt, (st, i) => beforeRestore(i) && st[0] === 'click' && SAVE.test(sel(st, 1)));
  const savedAt = after(saveAt, (st, i) => beforeRestore(i) && st[0] === 'wait' && STATUS.test(sel(st, 1)) && SAVED.test(sel(st, 1)));
  if (pickAt < 0) errs.push('J6 never chooses Codex in the agent picker (click … (codex))');
  if (codexTriggerAt < 0) errs.push("J6 never proves the picker's trigger switched to codex (wait … aria-label … (codex))");
  if (saveAt < 0) errs.push('J6 never saves the new default (click 保存默认 agent / Save default agent)');
  if (savedAt < 0) errs.push('J6 never proves the save landed (wait [role=status] … 已保存 / Saved)');

  // Persistence: the page that saved the default cannot prove it — the walk
  // must reload /settings?tab=providers and read codex off the trigger again,
  // and it must do so before /new (the new chat reads the daemon's value, and
  // a reload after /new would prove the next chat, not this one).
  const reloadAt = after(savedAt, (st, i) => beforeRestore(i) && st[0] === 'goto' && sel(st, 1).includes('/settings?tab=providers'));
  const persistedAt = after(reloadAt, (st, i) => beforeRestore(i) && st[0] === 'wait' && /aria-label/.test(sel(st, 1)) && sel(st, 1).includes('(codex)'));
  const newAt = after(savedAt, (st, i) => beforeRestore(i) && st[0] === 'goto' && sel(st, 1) === '/new');
  if (reloadAt < 0) {
    errs.push('J6 never reloads the settings page after the save (goto /settings?tab=providers); a default that only lives in the page that saved it is not persisted');
  }
  if (persistedAt < 0) {
    errs.push('J6 never proves the default persisted across the reload (wait trigger … (codex) after the reload goto)');
  }
  if (persistedAt >= 0 && newAt >= 0 && persistedAt > newAt) {
    errs.push('J6 reads the persisted default only after it opens /new; the reload proof must precede the new chat');
  }

  // The next new chat hosts it: the composer's run-settings trigger names
  // Codex. This is the user-visible consequence of the change.
  const hostsAt = after(newAt, (st, i) => beforeRestore(i) && st[0] === 'wait' && /运行设置|Run settings/.test(sel(st, 1)) && /Codex/.test(sel(st, 1)));
  if (newAt < 0) errs.push('J6 never opens a new chat after the save (goto /new)');
  if (hostsAt < 0) errs.push('J6 never proves the next new chat hosts Codex (goto /new then wait 运行设置 … Codex)');

  // The restore leg leaves the daemon as found: the shipped default is
  // claude-code, and a walk that ends hosting Codex poisons every later
  // journey against the same daemon.
  if (restoreAt < 0) {
    errs.push('J6 never restores the shipped default after the Codex read (click … (claude-code))');
  } else {
    if (hostsAt >= 0 && restoreAt < hostsAt) {
      errs.push('J6 restores the default before it reads the new chat hosting Codex');
    }
    const restoreTriggerAt = after(restoreAt, (st) => st[0] === 'wait' && /aria-label/.test(sel(st, 1)) && sel(st, 1).includes('(claude-code)'));
    const restoreSaveAt = after(restoreTriggerAt, (st) => st[0] === 'click' && SAVE.test(sel(st, 1)));
    const restoreSavedAt = after(restoreSaveAt, (st) => st[0] === 'wait' && STATUS.test(sel(st, 1)) && SAVED.test(sel(st, 1)));
    const restoreNewAt = after(restoreSavedAt, (st) => st[0] === 'goto' && sel(st, 1) === '/new');
    const restoreHostsAt = after(restoreNewAt, (st) => st[0] === 'wait' && /运行设置|Run settings/.test(sel(st, 1)) && /Claude Code/.test(sel(st, 1)));
    if (restoreTriggerAt < 0) errs.push('J6 never proves the trigger returned to claude-code (wait … (claude-code))');
    if (restoreSaveAt < 0) errs.push('J6 never saves the restored default; the walk leaves the daemon hosting Codex');
    if (restoreSavedAt < 0) errs.push('J6 never proves the restore save landed (wait [role=status] … 已保存 / Saved)');
    if (restoreNewAt < 0) errs.push('J6 never opens a new chat after the restore (goto /new)');
    if (restoreHostsAt < 0) errs.push('J6 never proves the restored new chat hosts Claude Code (goto /new then wait 运行设置 … Claude Code)');
  }

  // Every click must be followed by the state it changed before the next
  // click starts; a press with no read is a photograph of a page that may not
  // have moved.
  const ASSERT_OPS = new Set(['wait', 'gone', 'count', 'url', 'search', 'value', 'active']);
  const clicks = steps.map((st, i) => i).filter((i) => Array.isArray(steps[i]) && steps[i][0] === 'click');
  clicks.forEach((at, k) => {
    const next = k + 1 < clicks.length ? clicks[k + 1] : steps.length;
    if (!steps.some((st, i) => i > at && i < next && Array.isArray(st) && ASSERT_OPS.has(st[0]))) {
      errs.push(`J6's click at step ${at + 1} (${sel(steps[at], 1)}) is never followed by an assertion before the next click`);
    }
  });

  // The paths table selects the journeys `--files` walks, first match wins. A
  // settings diff that drops J6 would let the default-agent walk rot without
  // the gate ever walking it.
  const paths = Array.isArray(spec.paths) ? spec.paths : [];
  const mapsToJ6 = (file) => {
    const row = paths.find(([re]) => re.split('|').some((p) => file.startsWith(p)));
    return !!row && Array.isArray(row[1]) && row[1].includes('J6');
  };
  for (const file of ['ui/src/pages/SettingsPage.tsx', 'ui/src/pages/AgentsPage.tsx', 'ui/src/components/settings/ProviderSettingsSection.tsx']) {
    if (!mapsToJ6(file)) {
      errs.push(`the paths table does not map ${file} to J6; a diff there would not walk the default-agent change`);
    }
  }
  return errs;
}
if (process.argv.includes('--check-spec')) {
  const j1 = checkJ1Contract(spec);
  const j2 = checkJ2Contract(spec);
  const j3 = checkJ3Contract(spec);
  const j4 = checkJ4Contract(spec);
  const j5 = checkJ5Contract(spec);
  const j6 = checkJ6Contract(spec);
  const j7 = checkJ7Contract(spec);
  const j8 = checkJ8Contract(spec);
  const j9 = checkJ9Contract(spec);
  const j10 = checkJ10Contract(spec);
  const j11 = checkJ11Contract(spec);
  const j12 = checkJ12Contract(spec);
  const j13 = checkJ13Contract(spec);
  const j14 = checkJ14Contract(spec);
  if (j1.length || j2.length || j3.length || j4.length || j5.length || j6.length || j7.length || j8.length || j9.length || j10.length || j11.length || j12.length || j13.length || j14.length) {
    if (j1.length) { console.log('spec red: J1'); j1.forEach((e) => console.log(' - ' + e)); }
    if (j2.length) { console.log('spec red: J2'); j2.forEach((e) => console.log(' - ' + e)); }
    if (j3.length) { console.log('spec red: J3'); j3.forEach((e) => console.log(' - ' + e)); }
    if (j4.length) { console.log('spec red: J4'); j4.forEach((e) => console.log(' - ' + e)); }
    if (j5.length) { console.log('spec red: J5'); j5.forEach((e) => console.log(' - ' + e)); }
    if (j6.length) { console.log('spec red: J6'); j6.forEach((e) => console.log(' - ' + e)); }
    if (j7.length) { console.log('spec red: J7'); j7.forEach((e) => console.log(' - ' + e)); }
    if (j8.length) { console.log('spec red: J8'); j8.forEach((e) => console.log(' - ' + e)); }
    if (j9.length) { console.log('spec red: J9'); j9.forEach((e) => console.log(' - ' + e)); }
    if (j10.length) { console.log('spec red: J10'); j10.forEach((e) => console.log(' - ' + e)); }
    if (j11.length) { console.log('spec red: J11'); j11.forEach((e) => console.log(' - ' + e)); }
    if (j12.length) { console.log('spec red: J12'); j12.forEach((e) => console.log(' - ' + e)); }
    if (j13.length) { console.log('spec red: J13'); j13.forEach((e) => console.log(' - ' + e)); }
    if (j14.length) { console.log('spec red: J14'); j14.forEach((e) => console.log(' - ' + e)); }
    process.exit(1);
  }
  console.log('spec ok: J1 searches the list, filters it, and approves one card and denies another with both controls read gone');
  console.log('spec ok: J2 comments a changed line, sends the tray, and proves path, hunk and quote in the transcript');
  console.log('spec ok: J2 keeps a saved comment across a rerun — re-anchored to its new line, then 该行已变化 when the quoted line is gone');
  console.log('spec ok: J3 sends a prompt, queues a mid-run follow-up before the reply, and marks it queued');
  console.log('spec ok: J3 stops a held round, proves Stop left, and reads the queued message discard report');
  console.log('spec ok: J4 reads the cover\'s 工作方式 block, sends the pre-filled prompt, edits the file, and proves the same cut on the cover and in the agent\'s receipt');
  console.log('spec ok: J5 opens the running row\'s menu and pins rename, pin, archive, delete and a disabled 运行中 line');
  console.log('spec ok: J6 changes the default agent at both widths, proves it persisted and hosts the next new chat, then restores it');
  console.log('spec ok: J7 lands on the named card, proves focus, consumes ?focus=, and reopens it after Back');
  console.log('spec ok: J8 taps a changed line at 390, saves the sheet, sends the tray, and proves path, hunk and quote');
  console.log('spec ok: J9 keeps the shell, the scroll and the draft across a switch');
  console.log('spec ok: J10 approves the deep-linked card, walks all four footer entries, and finds it gone on the return');
  console.log('spec ok: J11 keeps the shell, the scroll and the draft across the phone\'s switches');
  if (spec.journeys && spec.journeys.J12) console.log('spec ok: J12 walks the phone\'s edge back, row reveal and hold-to-reorder as real touch and reads the consequences');
  if (spec.journeys && spec.journeys.J13) console.log('spec ok: J13 walks the phone file link through Back to the list and the conversation, and the HTML preview/source switch without leaving the file address');
  if (spec.journeys && spec.journeys.J14) console.log('spec ok: J14 reopens the last conversation on the Mac, finds no conversation rows in ⌘K, and draws the phone home as one list at three levels');
  // With a seed log the check also prints the assertion the walk will make,
  // resolved through the same function the walker uses: the reviewer reads
  // `[data-pending-id="appr-1"]`, not a placeholder.
  const seedPath = arg('seed');
  if (seedPath) {
    const target = readJ7Target(fs.existsSync(seedPath) ? fs.readFileSync(seedPath, 'utf8') : '');
    const gotoStep = ((spec.journeys.J7 || {}).steps || []).find((st) => st[0] === 'goto' && /\/tasks\//.test(String(st[1])));
    if (target.skip || !gotoStep) console.log('J7 skip: ' + (target.skip || 'the spec has no J7 goto step'));
    else {
      console.log('J7 ' + applyJ7Target(gotoStep[1], target));
      console.log('J7 assert ' + resolvedCardSelector(target));
    }
    // J5's row: the trigger the spec clicks, resolved to the seeded task id,
    // so the reviewer reads the row the walk really acts on.
    const j5Target = readJ5Target(fs.existsSync(seedPath) ? fs.readFileSync(seedPath, 'utf8') : '');
    const j5Click = ((spec.journeys.J5 || {}).steps || []).find((st) => st[0] === 'click'
      && String(st[1]).includes('[data-row-actions]'));
    if (j5Target.skip || !j5Click) console.log('J5 skip: ' + (j5Target.skip || 'the spec has no J5 row-menu click'));
    else console.log('J5 ' + applyJ5Fields(j5Click[1], j5Target));
  }
  process.exit(0);
}
// `--rows-match --got <json rows> --want <json tokens>`: the `rows` op's
// comparison without a browser, so the walk-contract tests can prove that an
// order read tolerates rows another journey created while still rejecting a
// wrong order. Exit 0 = match, 1 = no match, 2 = bad arguments.
if (process.argv.includes('--rows-match')) {
  let got, wanted;
  try {
    got = JSON.parse(arg('got', ''));
    wanted = JSON.parse(arg('want', ''));
  } catch (e) {
    got = wanted = null;
  }
  if (!Array.isArray(got) || !Array.isArray(wanted) || wanted.length === 0) {
    console.error('usage: walk.mjs --rows-match --got <json rows> --want <json tokens>');
    process.exit(2);
  }
  const match = rowsMatch(got.map(String), wanted.map(String));
  console.log(match ? 'match' : 'no match');
  process.exit(match ? 0 : 1);
}
// J7 must land on the conversation and card a notification would name. The
// seed prints one `j7 target conversation=<task> focus=<approval> title=<title>`
// line when (and only when) it really produced both; without that line J7 is a
// skip, never a walk against an invented id. The title is the row a reader
// clicks after Back; the older two-field line still resolves (title absent).
// The spec itself keeps its placeholders and legacy literals
// (rsi/runtime/ux/journeys.json is the merge-gate spec, DECISIONS 2026-11-17);
// the walker substitutes here.
function readJ7Target(seedText) {
  const J7_TARGET = /^j7 target conversation=(\S+) focus=(\S+)(?: title=(.+))?$/m;
  const seed = typeof seedText === 'string' ? seedText : '';
  if (/no scripts\/journeys_seed|seed failed|empty daemon/i.test(seed)) return { skip: 'seed failed or empty daemon' };
  if (!seed.trim()) return { skip: 'no seeded notification target' };
  const match = J7_TARGET.exec(seed);
  if (!match) return { skip: 'no seeded notification target' };
  return { conversation: match[1], focus: match[2], title: (match[3] || '').trim() };
}
function applyJ7Target(goto, target) {
  return String(goto)
    .replace(/demo-task/g, target.conversation)
    .replace(/demo-item/g, target.focus)
    .replace(/\{conversation\}/g, target.conversation)
    .replace(/\{focus\}/g, target.focus);
}
// Every J7 step argument, not only `goto`: a card wait, the focus assertion
// and the row click all name the seeded ids. A step that does not name them
// (a shot name, a regex like /返回|Back/) passes through unchanged. The title
// is a literal, never a regex: `[seed]` as a regex is a character class.
function applyJ7Fields(value, target) {
  const out = applyJ7Target(value, target);
  return target.title ? out.replace(/\{title\}/g, target.title) : out;
}
function applyJ7Step(step, target) {
  return Array.isArray(step) ? step.map((part) => (typeof part === 'string' ? applyJ7Fields(part, target) : part)) : step;
}
// J5 must open the row menu of the conversation the seed left running. The
// seed prints one `j5 target conversation=<task> title=<title>` line when that
// fixture really reached `running`; without it J5 is a skip, never a walk
// against an invented id. The row's trigger carries the row title's id as its
// description (`aria-describedby`), so the id selects one specific row's
// menu instead of whichever trigger the list happens to render first.
function readJ5Target(seedText) {
  const J5_TARGET = /^j5 target conversation=(\S+)(?: title=(.+))?$/m;
  const seed = typeof seedText === 'string' ? seedText : '';
  if (/no scripts\/journeys_seed|seed failed|empty daemon/i.test(seed)) return { skip: 'seed failed or empty daemon' };
  if (!seed.trim()) return { skip: 'no seeded running conversation' };
  const match = J5_TARGET.exec(seed);
  if (!match) return { skip: 'no seeded running conversation' };
  return { conversation: match[1], title: (match[2] || '').trim() };
}
function applyJ5Fields(value, target) {
  return String(value)
    .replace(/\{j5\.conversation\}/g, target.conversation)
    .replace(/\{j5\.title\}/g, target.title);
}
function applyJ5Step(step, target) {
  return Array.isArray(step) ? step.map((part) => (typeof part === 'string' ? applyJ5Fields(part, target) : part)) : step;
}
// J4's mid-walk edit needs the seeded project's id. The seed prints one
// `j4 target project=<id>` line only when Alpha's One-Pager document is really
// in place; without it the journey must not PUT an invented project. The spec
// keeps the `{project}` placeholder (rsi/runtime/ux/journeys.json is the
// merge-gate spec); the walker substitutes here, like J1/J5/J7.
function readJ4Target(seedText) {
  const J4_TARGET = /^j4 target project=(\S+)$/m;
  const seed = typeof seedText === 'string' ? seedText : '';
  if (/no scripts\/journeys_seed|seed failed|empty daemon/i.test(seed)) return { skip: 'seed failed or empty daemon' };
  if (!seed.trim()) return { skip: 'no seeded project for the One-Pager edit' };
  const match = J4_TARGET.exec(seed);
  if (!match) return { skip: 'no seeded project for the One-Pager edit' };
  return { project: match[1] };
}
function applyJ4Fields(value, target) {
  return String(value).replace(/\{project\}/g, target.project);
}
function applyJ4Step(step, target) {
  return Array.isArray(step) ? step.map((part) => (typeof part === 'string' ? applyJ4Fields(part, target) : part)) : step;
}
// `{vp}` makes a step's own words viewport-specific: two widths walk the same
// seeded conversation against one daemon, so an identical comment body would
// let the second width's wait pass on the first width's message and leave its
// own send unproven. --check-spec resolves the same function it enforces.
function applyVpStep(step, vpName) {
  return Array.isArray(step) ? step.map((part) => (typeof part === 'string' ? part.split('{vp}').join(vpName) : part)) : step;
}
// The selector the landing assertion resolves to, printed by --check-spec so
// the red/green evidence names a real card rather than `{focus}`.
function resolvedCardSelector(target) {
  return `[data-pending-id="${target.focus}"]`;
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
// `--resolve-j7-plan` prints the whole resolved step list the walk will run,
// which is how the card/focus/title assertions are proved without a browser.
const j7DeepLinkStep = () => (((spec.journeys.J7 || {}).steps || []).find((st) => st[0] === 'goto' && /\/tasks\//.test(String(st[1]))));
const resolveJ7 = arg('resolve-j7');
const resolveJ7Plan = arg('resolve-j7-plan');
if (resolveJ7 || resolveJ7Plan) {
  const seedPath = resolveJ7 || resolveJ7Plan;
  const target = readJ7Target(fs.existsSync(seedPath) ? fs.readFileSync(seedPath, 'utf8') : '');
  const gotoStep = j7DeepLinkStep();
  if (target.skip) console.log('J7 skip: ' + target.skip);
  else if (!gotoStep) console.log('J7 skip: the spec has no J7 goto step');
  else if (resolveJ7Plan) {
    // Byte-for-byte the walk's own substitution, printed as data.
    const steps = (spec.journeys.J7.steps || []).map((st) => applyJ7Step(st, target));
    console.log(JSON.stringify({ journey: 'J7', steps, title: target.title }, null, 1));
  } else console.log('J7 ' + applyJ7Target(gotoStep[1], target));
  process.exit(0);
}
// `--resolve-j5 <seed.log>` answers J5's question without a browser: the
// trigger the walk clicks, resolved from the seed's `j5 target` line, or the
// skip. The selector is printed through the same field replacement the walk
// uses, so a placeholder that stopped substituting is red here.
const resolveJ5 = arg('resolve-j5');
if (resolveJ5) {
  const target = readJ5Target(fs.existsSync(resolveJ5) ? fs.readFileSync(resolveJ5, 'utf8') : '');
  const clickStep = ((spec.journeys.J5 || {}).steps || []).find((st) => st[0] === 'click'
    && String(st[1]).includes('[data-row-actions]'));
  if (target.skip) console.log('J5 skip: ' + target.skip);
  else if (!clickStep) console.log('J5 skip: the spec has no J5 row-menu click');
  else console.log('J5 ' + applyJ5Fields(clickStep[1], target));
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
// J9's element-identity book. The first `node` call tags the matched element
// with `data-kin-walk-node=<name>` and keeps the handle; every later call with
// the same name compares against it. A remount produces a different element,
// which no amount of identical markup can hide.
const walkNodes = new Map();
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
// Whether a finger (or a mouse) would actually land on this element.
//
// Playwright's `isVisible` only asks for a box: the files panel draws over the
// page's own header at 390, so the covered header Back is "visible" and a
// click on it waits out its timeout on an intercepting element. The document
// is the honest reader of "can this be pressed" — ask what is at the point.
async function receivesPointer(loc) {
  return loc.evaluate((el) => {
    const r = el.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) return false;
    const x = r.left + r.width / 2;
    const y = r.top + r.height / 2;
    if (x < 0 || y < 0 || x > innerWidth || y > innerHeight) return false;
    const hit = document.elementFromPoint(x, y);
    return !!hit && (hit === el || el.contains(hit));
  }).catch(() => false);
}
async function stepLocator(page, sel, opts = {}) {
  const usable = async (loc) => (await loc.isVisible().catch(() => false))
    && (!opts.reachable || await receivesPointer(loc));
  // `text=` is a literal the way `wait text=` is: the seeded title carries
  // `[seed]`, which as a regex is a character class and matches nothing.
  if (sel.startsWith('text=')) {
    const text = page.getByText(sel.slice('text='.length));
    const count = await text.count();
    for (let i = 0; i < count; i++) if (await usable(text.nth(i))) return text.nth(i);
    return text.first();
  }
  if (!sel.startsWith('/')) return page.locator(sel).first();
  const re = new RegExp(sel.slice(1, sel.lastIndexOf('/')), 'i');
  const text = page.getByText(re);
  const count = await text.count();
  for (let i = 0; i < count; i++) if (await usable(text.nth(i))) return text.nth(i);
  for (const role of ['button', 'link']) {
    const named = page.getByRole(role, { name: re });
    const namedCount = await named.count();
    for (let i = 0; i < namedCount; i++) if (await usable(named.nth(i))) return named.nth(i);
  }
  return text.first();
}
/**
 * Press the browser's own Back and report whether the stack actually moved.
 *
 * Playwright returns null from `page.goBack` for a same-document navigation:
 * the entries React Router pushes are `pushState` entries, so popping one has
 * no document response. The address is the honest evidence, not the return
 * value — a walk that treated null as "no entry" would redden every synthesized
 * phone queue while the browser had in fact gone back.
 */
async function historyBack(page) {
  const before = page.url();
  await page.goBack({ waitUntil: 'domcontentloaded', timeout: WAIT_MS }).catch(() => null);
  return pollUntil(page, () => page.url() !== before, 3000);
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
// How many VISIBLE matches a `text=`/`css=` needle has right now. `count` is
// an assertion, not a wait: it reports what is on screen at this instant, so a
// spec can say "the answer is not here yet" before waiting for it.
async function visibleCount(page, needle) {
  let loc;
  if (needle.startsWith('text=')) {
    const text = needle.slice('text='.length);
    if (!text) throw new Error('count text= needs a literal');
    loc = page.getByText(text);
  } else if (needle.startsWith('css=')) {
    const sel = needle.slice('css='.length);
    if (!sel) throw new Error('count css= needs a selector');
    loc = page.locator(sel);
  } else {
    throw new Error('count needs text=<literal> or css=<selector>');
  }
  const total = await loc.count();
  let visible = 0;
  for (let i = 0; i < total; i++) if (await loc.nth(i).isVisible().catch(() => false)) visible++;
  return visible;
}
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
// ---- Real touch input -------------------------------------------------------
// The phone's thumb gestures cannot be proved by dispatching a synthetic
// PointerEvent: that skips the browser's hit test, its pointer capture and its
// `touch-action` decision, which is exactly where a gesture dies under a
// finger (LESSONS 2026-10-30). `swipe` and `drag` drive Chrome's own input
// pipeline through CDP (`Input.dispatchTouchEvent`), the technique the shipped
// touch-drag.mjs proof already uses: OS-level touch to the renderer, not an
// event dispatched at a node. Both verbs are phone-only — a context without
// `hasTouch` would deliver the same points as a mouse, which is a different
// gesture — so the executor refuses them off the phone instead of pretending.
const TOUCH_ID = 7;
// A finger sized like a fingertip; the id must stay stable for the whole path
// so the renderer pairs the samples into one pointer.
const touchFinger = (x, y) => ({ x, y, id: TOUCH_ID, radiusX: 6, radiusY: 6, force: 1 });
async function touchPoint(cdp, type, x, y) {
  // `touchEnd` / `touchCancel` carry no live points; the lifted finger is the
  // empty list. A move keeps the same id from touchStart to touchEnd.
  await cdp.send('Input.dispatchTouchEvent', {
    type,
    touchPoints: type === 'touchEnd' || type === 'touchCancel' ? [] : [touchFinger(x, y)],
  });
}
// A gesture's Y may be a pixel or a target: `css=<selector>` / `text=<literal>`
// resolves to the first visible match's centre. A missing target is a hard
// failure naming the journey and viewport (the executor prefixes those), not a
// gesture at y=0 that happens to hit something else.
async function gestureAnchor(page, raw, axis) {
  const text = String(raw ?? '').trim();
  if (text !== '' && !text.startsWith('css=') && !text.startsWith('text=')) {
    const n = Number(text);
    return Number.isFinite(n) ? n : null;
  }
  let loc;
  if (text.startsWith('css=')) loc = page.locator(text.slice('css='.length));
  else if (text.startsWith('text=')) loc = page.getByText(text.slice('text='.length));
  else return null;
  const total = await loc.count();
  for (let i = 0; i < total; i++) {
    const item = loc.nth(i);
    if (!(await item.isVisible().catch(() => false))) continue;
    const box = await item.boundingBox().catch(() => null);
    if (!box) continue;
    return axis === 'x' ? box.x + box.width / 2 : box.y + box.height / 2;
  }
  return null;
}
/** One finger, in a straight line, with enough samples for a real pointer path. */
async function performSwipe(page, cdp, fromX, toX, y, ms) {
  const duration = Number.isFinite(ms) && ms > 0 ? ms : 240;
  const samples = Math.max(8, Math.min(48, Math.ceil(Math.abs(toX - fromX) / 8)));
  const frame = Math.max(8, Math.round(duration / samples));
  await touchPoint(cdp, 'touchStart', fromX, y);
  try {
    for (let i = 1; i <= samples; i++) {
      await touchPoint(cdp, 'touchMove', fromX + ((toX - fromX) * i) / samples, y);
      await page.waitForTimeout(frame);
    }
  } catch (e) {
    // A step that throws mid-gesture must not leave the renderer holding a
    // finger: the next gesture would otherwise be a second touch point.
    await touchPoint(cdp, 'touchCancel', toX, y).catch(() => {});
    throw e;
  }
  await touchPoint(cdp, 'touchEnd', toX, y);
  await page.waitForTimeout(260);
}
/** The first visible match of a selector, or null when the target is missing. */
async function firstVisibleLocator(page, selector) {
  const loc = page.locator(selector);
  const total = await loc.count();
  for (let i = 0; i < total; i++) {
    const item = loc.nth(i);
    if (await item.isVisible().catch(() => false)) return item;
  }
  return total > 0 ? loc.first() : null;
}
/** Press an element's centre, hold it, then drag vertically and release. */
async function performDrag(page, cdp, selector, dy, holdMs) {
  const loc = await firstVisibleLocator(page, selector);
  if (!loc) throw new Error(`drag target ${selector} is not on the page`);
  if (!(await loc.isVisible().catch(() => false))) throw new Error(`drag target ${selector} is not visible`);
  const box = await loc.boundingBox().catch(() => null);
  if (!box) throw new Error(`drag target ${selector} has no layout box`);
  const x = box.x + box.width / 2;
  const y = box.y + box.height / 2;
  const hold = Number.isFinite(holdMs) && holdMs >= 0 ? holdMs : 500;
  const samples = 8;
  const endY = y + dy;
  await touchPoint(cdp, 'touchStart', x, y);
  try {
    // The lift is a timer at the hold threshold; a frame of grace keeps the
    // first move from racing it on a busy machine.
    await page.waitForTimeout(hold + 60);
    for (let i = 1; i <= samples; i++) {
      await touchPoint(cdp, 'touchMove', x, y + (dy * i) / samples);
      await page.waitForTimeout(24);
    }
    await page.waitForTimeout(120);
  } catch (e) {
    await touchPoint(cdp, 'touchCancel', x, endY).catch(() => {});
    throw e;
  }
  await touchPoint(cdp, 'touchEnd', x, endY);
  await page.waitForTimeout(350);
}
/** Whether `wanted` appears in `got` as an ordered subsequence, one token per row.
 *
 * The `rows` op reads an order, not a census. Another journey walked against
 * the same daemon can leave extra conversations in the same project (J3's two
 * viewports each send `[seed] slow`, and the project label keeps them under the
 * "seed" search), so requiring the exact row list would fail J12 on every
 * combined walk. The wanted order is still the proof: a drag that did not
 * reorder the seeded rows leaves them in the old order and matches nothing.
 */
function rowsMatch(got, wanted) {
  let at = 0;
  for (const text of got) {
    if (at < wanted.length && text.includes(wanted[at])) at++;
  }
  return at === wanted.length;
}
/** The conversation rows with a layout box under a scope, in drawn order. */
async function readRows(page, scope) {
  // Resolve the scope with Playwright's engine: a spec scopes a bucket with
  // `:has-text(...)`, which native `querySelectorAll` cannot parse.
  const loc = page.locator(scope);
  const total = await loc.count();
  for (let i = 0; i < total; i++) {
    const item = loc.nth(i);
    if (!(await item.isVisible().catch(() => false))) continue;
    const texts = await item.evaluate((root) => {
      const visible = (el) => {
        const box = el.getBoundingClientRect();
        return box.width > 0 && box.height > 0 && getComputedStyle(el).visibility !== 'hidden';
      };
      return [...root.querySelectorAll('[data-session-row]')]
        .filter(visible)
        .map((el) => (el.textContent || '').replace(/\s+/g, ' ').trim());
    }).catch(() => null);
    if (texts) return texts.length ? texts : null;
  }
  return null;
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
  const seed = (j === 'J1' || j === 'J4' || j === 'J5' || j === 'J7' || j === 'J10' || j === 'J13') && fs.existsSync(path.join(out, 'seed.log')) ? fs.readFileSync(path.join(out, 'seed.log'), 'utf8') : '';
  const j1 = j === 'J1' ? readJ1Target(seed) : null;
  const j5 = j === 'J5' ? readJ5Target(seed) : null;
  // Only a J4 spec that carries `{project}` needs the seed's id; an older spec
  // (or a daemon seeded by an older script) walks its roots leg instead.
  const j4UsesProject = j === 'J4' && ((spec.journeys.J4 || {}).steps || []).some((st) => Array.isArray(st) && st.some((part) => typeof part === 'string' && part.includes('{project}')));
  const j4 = j4UsesProject ? readJ4Target(seed) : null;
  // J10 answers the same seeded card J7 only looks at. Both must resolve the
  // target the same way, and both skip rather than walk invented ids.
  // J13 walks the same seeded conversation the notification leg names, so the
  // deep link resolves to a real task with a real checkout (and the seeded
  // preview.html in it), never an invented id.
  const j7 = (j === 'J7' || j === 'J10' || j === 'J13') ? readJ7Target(seed) : null;
  if (j1 && j1.skip) { screens.push({ journey: j, viewport: 'n/a', name: 'J1-skipped-no-approval-target', url: '', lint: {}, notes: ['skipped J1: ' + j1.skip] }); continue; }
  if (j4 && j4.skip) { screens.push({ journey: j, viewport: 'n/a', name: 'J4-skipped-no-project-target', url: '', lint: {}, notes: ['skipped J4: ' + j4.skip] }); continue; }
  if (j5 && j5.skip) { screens.push({ journey: j, viewport: 'n/a', name: 'J5-skipped-no-running-conversation', url: '', lint: {}, notes: ['skipped J5: ' + j5.skip] }); continue; }
  if (j7 && j7.skip) { screens.push({ journey: j, viewport: 'n/a', name: j + '-skipped-no-fixtures', url: '', lint: {}, notes: ['skipped ' + j + ': no seeded notification target'] }); continue; }
  const J = spec.journeys[j];
  for (const vpName of J.viewports) {
    const [w, h] = spec.viewports[vpName].split('x').map(Number); const phone = w < 700;
    const ctx = await browser.newContext({ viewport: { width: w, height: h }, deviceScaleFactor: phone ? 2 : 1, isMobile: phone, hasTouch: phone });
    if (token) await ctx.addInitScript((t) => { try { localStorage.setItem('kin_token', t); } catch (_) {} }, token);
    const page = await ctx.newPage(); const errs = [], bad = [], soft = [];
    // The touch verbs speak CDP. The session is created only for the phone,
    // where the context is already a finger (`hasTouch`); it installs no
    // override, so the other journeys' hover/click semantics are untouched.
    const cdp = phone ? await ctx.newCDPSession(page) : null;
    if (DELAY_TASKS_MS > 0) {
      // Only the detail GET: /api/tasks/<one segment>, with or without a query.
      // Never the list (/api/tasks), the create POST, or /api/tasks/<id>/events:
      // those all still answer at once so the route itself is not what reddens
      // the walk. Installed before the first goto, so the first answer is late.
      await page.route((url) => /^\/api\/tasks\/[^/]+$/.test(url.pathname), async (route) => {
        if (route.request().method() !== 'GET') return route.continue();
        await new Promise((resolve) => setTimeout(resolve, DELAY_TASKS_MS));
        await route.continue().catch(() => {});
      });
    }
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
    // `["vp", "mac"]` scopes the steps that follow to one viewport and
    // `["vp", ""]` clears the scope. Some legs mutate the seeded fixture
    // irreversibly — the fake's `[seed] shift` / `[seed] rewrite` write once per
    // seed root — so replaying such a leg at the second width would walk a file
    // the first width already changed and fail for a fixture reason, not a
    // product one. The scope keeps one real walk of the leg without pretending
    // the second width ran it.
    let vpOnly = '';
    for (const rawStep of J.steps) {
      const preStep = j === 'J5' && j5 ? applyJ5Step(rawStep, j5) : (j === 'J7' || j === 'J10' || j === 'J13') && j7 ? applyJ7Step(rawStep, j7) : j === 'J4' && j4 ? applyJ4Step(rawStep, j4) : rawStep;
      const st = applyVpStep(preStep, vpName);
      const [op, a, b] = st;
      if (op === 'vp') {
        vpOnly = String(a || '').trim();
        // A name outside this journey's own viewports scopes every step below
        // to a width that never runs, silently deleting the leg from a walk
        // that still reports green. The executor is the only place that can
        // see the journey's viewport list and the scope together, so it must
        // refuse the name rather than `continue` past it.
        if (vpOnly && !(J.viewports || []).includes(vpOnly)) {
          hardFail.push(`${j}/${vpName}: vp ${JSON.stringify(vpOnly)} is not one of the journey's viewports (${(J.viewports || []).join(', ')}); the steps below would never run`);
        }
        log.push(vpOnly ? 'steps below run only at ' + vpOnly : 'viewport scope cleared');
        continue;
      }
      if (vpOnly && vpOnly !== vpName) continue;
      try {
        if (op === 'goto') {
          const href = j === 'J1' && j1 ? applyJ1Target(a, j1) : a; // J7 is already substituted above.
          await page.goto(base + href, { waitUntil: 'domcontentloaded', timeout: 20000 });
          await page.waitForTimeout(900);
        }
        else if (op === 'api') {
          // Fixture setup, nothing else: `["api", "PUT",
          // "/api/projects/{project}/one-pager", "<markdown>"]` replaces the
          // seeded project's One-Pager through the shipped endpoint, using the
          // token the walk already holds — the same write a person makes by
          // editing the file. The cover block is read-only on purpose
          // (KIN-PROJECT-003), so the edit half of the journey has to happen
          // outside the browser. Any other method, path or body shape is a
          // hard failure: this is not a general HTTP client.
          const method = String(a || '').toUpperCase();
          const apiPath = String(b || '');
          const apiBody = st[3];
          if (method !== 'PUT' || !/^\/api\/projects\/[^/]+\/one-pager$/.test(apiPath) || typeof apiBody !== 'string') {
            hardFail.push(`${j}/${vpName}: api allows only PUT /api/projects/<id>/one-pager with a markdown body, got ${JSON.stringify(st)}`);
            continue;
          }
          let res;
          try {
            res = await fetch(base.replace(/\/$/, '') + apiPath, {
              method,
              headers: { Authorization: token ? 'Bearer ' + token : '', 'Content-Type': 'application/json' },
              body: JSON.stringify({ markdown: apiBody }),
            });
          } catch (e) {
            hardFail.push(`${j}/${vpName}: api ${method} ${apiPath} failed: ${String(e.message).split('\n')[0]}`);
            continue;
          }
          const detail = await res.text().catch(() => '');
          log.push(`api ${method} ${apiPath} -> ${res.status}`);
          if (!res.ok) hardFail.push(`${j}/${vpName}: api ${method} ${apiPath} answered ${res.status} ${detail.slice(0, 120)}`);
        }
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
          // A third element is this step's own budget in ms: one wait (the
          // reply behind a held round) can need longer than the global one
          // without loosening every other proof in the journey.
          const stepWait = (() => { const n = Number(b); return Number.isFinite(n) && n > 0 ? n : WAIT_MS; })();
          let seen;
          try { seen = await waitVisible(page, needle, stepWait); }
          catch (e) { hardFail.push(`${j}/${vpName}: wait ${needle}: ${String(e.message).split('\n')[0]}`); continue; }
          if (seen) log.push('waited for ' + needle);
          else if (optional) log.push('skipped wait ' + needle + ' (not visible within ' + stepWait + 'ms)');
          else hardFail.push(`${j}/${vpName}: wait ${needle} not visible within ${stepWait}ms`);
        } else if (op === 'count') {
          // `["count", "text=<literal>"|"css=<selector>", "<n>"]`: the number of
          // VISIBLE matches must be exactly n. Used before a reply wait to
          // prove the screen did not already carry the answer.
          const want = Number(b);
          if (!Number.isInteger(want) || want < 0) {
            hardFail.push(`${j}/${vpName}: count ${String(a)} needs a non-negative integer, got ${JSON.stringify(b)}`);
            continue;
          }
          let got;
          try { got = await visibleCount(page, String(a)); }
          catch (e) { hardFail.push(`${j}/${vpName}: count ${String(a)}: ${String(e.message).split('\n')[0]}`); continue; }
          log.push(`count ${String(a)} = ${got}`);
          if (got !== want) hardFail.push(`${j}/${vpName}: count ${String(a)} is ${got}, want ${want}`);
        } else if (op === 'url') {
          // The path the person is on, as a regex over `location.pathname`.
          const { optional, value: pattern } = optionalOf(a);
          let re; try { re = new RegExp(pattern); } catch (e) { hardFail.push(`${j}/${vpName}: url ${pattern} is not a regex: ${e.message}`); continue; }
          const pathNow = () => new URL(page.url()).pathname;
          const matched = await pollUntil(page, () => re.test(pathNow()), WAIT_MS);
          if (matched) log.push('url ' + pathNow() + ' matches ' + pattern);
          else if (optional) log.push('skipped url ' + pattern + ' (still at ' + pathNow() + ')');
          else hardFail.push(`${j}/${vpName}: url ${pathNow()} did not match ${pattern} within ${WAIT_MS}ms`);
        } else if (op === 'search') {
          // `location.search`, as a regex. J7 proves the `?focus=` link was
          // consumed by asserting the parameter is gone (`^$`), not by
          // photographing a page that may still carry it.
          const { optional, value: pattern } = optionalOf(a);
          let re; try { re = new RegExp(pattern); } catch (e) { hardFail.push(`${j}/${vpName}: search ${pattern} is not a regex: ${e.message}`); continue; }
          const searchNow = () => new URL(page.url()).search;
          const matched = await pollUntil(page, () => re.test(searchNow()), WAIT_MS);
          if (matched) log.push('search ' + JSON.stringify(searchNow()) + ' matches ' + pattern);
          else if (optional) log.push('skipped search ' + pattern + ' (is ' + JSON.stringify(searchNow()) + ')');
          else hardFail.push(`${j}/${vpName}: search ${JSON.stringify(searchNow())} did not match ${pattern} within ${WAIT_MS}ms`);
        } else if (op === 'active') {
          // The landing inch: the deep link may *render* the named card and
          // still leave the keyboard on the composer. `document.activeElement`
          // is the honest test of "the reader is on that card".
          const { optional, value } = optionalOf(a);
          if (!value.startsWith('css=')) { hardFail.push(`${j}/${vpName}: active needs css=<selector>`); continue; }
          const sel = value.slice('css='.length);
          const isActive = () => page.evaluate((sel) => {
            const el = document.activeElement;
            try { return !!(el && el.matches && el.matches(sel)); } catch (_) { return false; }
          }, sel).catch(() => false);
          const hit = await pollUntil(page, isActive, WAIT_MS);
          if (hit) { log.push('active ' + sel); continue; }
          const who = await page.evaluate(() => {
            const el = document.activeElement;
            if (!el) return 'nothing';
            const id = el.getAttribute('data-pending-id');
            const label = el.getAttribute('aria-label');
            return el.tagName.toLowerCase()
              + (id ? `[data-pending-id="${id}"]` : '')
              + (label ? `[aria-label="${label}"]` : '');
          }).catch(() => 'unknown');
          if (optional) log.push('skipped active ' + sel + ' (focus is on ' + who + ')');
          else hardFail.push(`${j}/${vpName}: focus is on ${who}, not ${sel}`);
        } else if (op === 'back') {
          // The reader's Back. The phone has its own bar button (the
          // accessible path and what `goBackToList` drives); a width without
          // one (the desktop bar has no Back control) falls back to browser
          // history, which is the same entry the app's own Back returns to.
          // A control under an open panel is not the reader's: the files panel
          // covers the page header at 390, so only a button the document says
          // is at the point may be pressed — otherwise the browser's own Back
          // is the honest press.
          let pressed = false;
          const loc = await stepLocator(page, '/返回|Back/', { reachable: true });
          if ((await loc.count()) > 0 && (await loc.isVisible().catch(() => false)) && (await receivesPointer(loc))) {
            await loc.click({ timeout: 3000 });
            pressed = true;
            log.push('pressed Back');
          }
          if (!pressed) {
            const moved = await historyBack(page);
            if (!moved) { hardFail.push(`${j}/${vpName}: Back left no history entry to return to`); continue; }
            log.push('history back');
          }
          await page.waitForTimeout(400);
        } else if (op === 'history-back') {
          // The system Back: the browser's own stack, not the app's Back
          // button. `back` presses a reachable /返回|Back/ control first, so it
          // proves the in-app exit; a queue the story promises to the system
          // Back (KIN-RESULT-002: file → list → conversation → sessions) has to
          // be popped by the browser. Nothing behind this entry is a hard
          // failure — the synthesized parent is exactly what is under test.
          const moved = await historyBack(page);
          if (!moved) { hardFail.push(`${j}/${vpName}: history-back had no history entry to return to`); continue; }
          log.push('history back');
          await page.waitForTimeout(400);
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
        else if (op === 'node') {
          // `["node", "css=<selector>", "<name>"]`: first call tags the element
          // with `data-kin-walk-node=<name>`; any later call with the same name
          // asserts it is the SAME element. A shell remounted on a route change
          // is a different element, and identical markup cannot hide it.
          const { optional, value } = optionalOf(a);
          const name = String(b ?? '').trim();
          if (!value.startsWith('css=') || !name) {
            hardFail.push(`${j}/${vpName}: node needs css=<selector> and a name, got ${JSON.stringify(a)}, ${JSON.stringify(b)}`);
            continue;
          }
          const selector = value.slice('css='.length);
          const key = `${j}/${vpName}/${name}`;
          if (!walkNodes.has(key)) {
            const found = page.locator(selector).first();
            if (await found.count() === 0) {
              if (optional) { log.push('skipped node ' + name + ' (' + selector + ')'); continue; }
              hardFail.push(`${j}/${vpName}: missing required node ${selector}`); continue;
            }
            const handle = await found.elementHandle({ timeout: 3000 }).catch(() => null);
            if (!handle) {
              if (optional) { log.push('skipped node ' + name + ' (' + selector + ')'); continue; }
              hardFail.push(`${j}/${vpName}: missing required node ${selector}`); continue;
            }
            await handle.evaluate((el, n) => el.setAttribute('data-kin-walk-node', n), name).catch(() => {});
            walkNodes.set(key, handle);
            log.push('node ' + name + ' tagged (' + selector + ')');
          } else {
            // A detached handle throws; a different live element compares
            // false. Both mean the node was replaced.
            const same = await walkNodes.get(key)
              .evaluate((el, s) => el === el.ownerDocument.querySelector(s), selector)
              .catch(() => false);
            if (!same) { hardFail.push(`${j}/${vpName}: the ${name} node was replaced`); continue; }
            log.push('node ' + name + ' is the same element (' + selector + ')');
          }
        } else if (op === 'scroll') {
          // `["scroll", "css=<selector>", "<px>|bottom"]`: put the scroller
          // where the reader left it and record what it actually reached (a
          // short transcript clamps, and the log says so rather than pretending).
          const { optional, value } = optionalOf(a);
          const asked = String(b ?? '').trim();
          if (!value.startsWith('css=') || !(asked === 'bottom' || /^\d+$/.test(asked))) {
            hardFail.push(`${j}/${vpName}: scroll needs css=<selector> and <px>|bottom, got ${JSON.stringify(a)}, ${JSON.stringify(b)}`);
            continue;
          }
          const selector = value.slice('css='.length);
          const got = await page.evaluate(({ selector, asked }) => {
            const vis = (el) => {
              const r = el.getBoundingClientRect();
              return r.width > 0 && r.height > 0 && getComputedStyle(el).visibility !== 'hidden';
            };
            const el = [...document.querySelectorAll(selector)].find(vis);
            if (!el) return null;
            el.scrollTop = asked === 'bottom' ? el.scrollHeight : Number(asked);
            return { top: el.scrollTop, max: el.scrollHeight - el.clientHeight };
          }, { selector, asked }).catch(() => null);
          if (!got) {
            if (optional) { log.push('skipped scroll ' + selector); continue; }
            hardFail.push(`${j}/${vpName}: missing required scroll ${selector}`); continue;
          }
          // Let the product's own onScroll record the position before the
          // route changes; the restore effect reads the same saved value.
          await page.waitForTimeout(300);
          log.push(`scroll ${selector} to ${Math.round(got.top)} (asked ${asked}, max ${Math.round(got.max)})`);
        } else if (op === 'scroll-kept') {
          // `["scroll-kept", "css=<selector>", "<px>"]`: the scroller came back
          // within 48px of where it was left. The tolerance is the contract
          // ("where I left it", not the exact pixel); the wait is because the
          // restore is a layout effect after the pane is shown again, not an
          // instant DOM write.
          const { optional, value } = optionalOf(a);
          const want = Number(b);
          if (!value.startsWith('css=') || !Number.isFinite(want)) {
            hardFail.push(`${j}/${vpName}: scroll-kept needs css=<selector> and a pixel offset, got ${JSON.stringify(a)}, ${JSON.stringify(b)}`);
            continue;
          }
          const selector = value.slice('css='.length);
          const readTop = () => page.evaluate((selector) => {
            const vis = (el) => {
              const r = el.getBoundingClientRect();
              return r.width > 0 && r.height > 0 && getComputedStyle(el).visibility !== 'hidden';
            };
            const el = [...document.querySelectorAll(selector)].find(vis);
            return el ? el.scrollTop : null;
          }, selector).catch(() => null);
          let top = null;
          const deadline = Date.now() + WAIT_MS;
          for (;;) {
            top = await readTop();
            if (top !== null && Math.abs(top - want) <= 48) break;
            if (Date.now() >= deadline) break;
            await page.waitForTimeout(100);
          }
          if (top !== null && Math.abs(top - want) <= 48) log.push(`scroll-kept ${selector} at ${Math.round(top)} (want ${want}±48)`);
          else if (optional) log.push(`skipped scroll-kept ${selector} (at ${top === null ? 'nothing visible' : Math.round(top)})`);
          else hardFail.push(`${j}/${vpName}: scroll-kept ${selector} is at ${top === null ? 'nothing visible' : Math.round(top)}, want ${want}±48`);
        } else if (op === 'swipe') {
          // `["swipe", "<fromX>", "<toX>", "<y>", "<ms>?"]`: one finger travels
          // horizontally at a fixed Y, through Chrome's own touch pipeline.
          // `y` may be a pixel or `css=<selector>` / `text=<literal>`, resolved
          // to the first visible match's centre, so a spec names a row rather
          // than guessing its offset on the day. `ms` paces the samples.
          const fromX = Number(a), toX = Number(b);
          if (!phone || !cdp) {
            hardFail.push(`${j}/${vpName}: swipe is a phone gesture; this viewport has no touch context`);
            continue;
          }
          if (!Number.isFinite(fromX) || !Number.isFinite(toX)) {
            hardFail.push(`${j}/${vpName}: swipe needs numeric fromX and toX, got ${JSON.stringify(a)}, ${JSON.stringify(b)}`);
            continue;
          }
          if (fromX === toX) {
            hardFail.push(`${j}/${vpName}: swipe needs distinct fromX and toX; a zero-length swipe is not a gesture`);
            continue;
          }
          const y = await gestureAnchor(page, st[3], 'y');
          if (y === null) {
            hardFail.push(`${j}/${vpName}: swipe target ${JSON.stringify(st[3])} is not on the screen`);
            continue;
          }
          const ms = st[4] === undefined ? 240 : Number(st[4]);
          log.push(`swipe ${fromX} → ${toX} at y=${Math.round(y)}`);
          await performSwipe(page, cdp, fromX, toX, y, ms);
        } else if (op === 'drag') {
          // `["drag", "<selector>", "<dy>", "<holdMs>?"]`: press the element's
          // centre, hold it, move vertically in samples, release. This is the
          // pointer-level twin of touch-drag.mjs: a 500ms hold must lift the
          // row before a vertical move is allowed to reorder it.
          if (!phone || !cdp) {
            hardFail.push(`${j}/${vpName}: drag is a phone gesture; this viewport has no touch context`);
            continue;
          }
          const dy = Number(b);
          if (typeof a !== 'string' || !a.trim() || !Number.isFinite(dy)) {
            hardFail.push(`${j}/${vpName}: drag needs <selector> and a numeric dy, got ${JSON.stringify(a)}, ${JSON.stringify(b)}`);
            continue;
          }
          if (dy === 0) {
            hardFail.push(`${j}/${vpName}: drag needs a non-zero dy; a press that does not move is not a drag`);
            continue;
          }
          const holdMs = st[3] === undefined ? 500 : Number(st[3]);
          if (!Number.isFinite(holdMs) || holdMs < 0) {
            hardFail.push(`${j}/${vpName}: drag hold must be a non-negative number of ms, got ${JSON.stringify(st[3])}`);
            continue;
          }
          log.push(`drag ${a} by ${dy}px after a ${holdMs}ms hold`);
          await performDrag(page, cdp, a, dy, holdMs);
        } else if (op === 'rows') {
          // `["rows", "css=<scope>", "<token>|<token>"]`: the visible
          // conversation rows under the first visible match of `<scope>`
          // contain the tokens in this order, each in its own row. Other rows
          // may sit between or after them — a journey walked earlier in the
          // same daemon creates its own conversations, and a census would turn
          // that into a phantom failure — but the order itself is the proof:
          // a drag that did not reorder the rows fails, and so does a reorder
          // that did not survive the reload.
          const { optional, value } = optionalOf(a);
          const wanted = String(b ?? '').split('|').map((token) => token.trim()).filter(Boolean);
          if (!value.startsWith('css=') || wanted.length === 0) {
            hardFail.push(`${j}/${vpName}: rows needs css=<scope> and token|token, got ${JSON.stringify(a)}, ${JSON.stringify(b)}`);
            continue;
          }
          const got = await readRows(page, value.slice('css='.length)).catch(() => null);
          if (got === null) {
            if (optional) { log.push('skipped rows ' + value); continue; }
            hardFail.push(`${j}/${vpName}: rows scope ${value} is not on screen`); continue;
          }
          const same = rowsMatch(got, wanted);
          if (same) log.push('rows ' + value + ' = ' + wanted.join(' | '));
          else if (optional) log.push('skipped rows ' + value + ' (is ' + got.join(' | ') + ')');
          else hardFail.push(`${j}/${vpName}: rows ${value} are ${JSON.stringify(got)}, want ${JSON.stringify(wanted)}`);
        }
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
