#!/usr/bin/env node
// Journey walk of the REAL console. Usage:
//   node walk.mjs --base http://127.0.0.1:PORT --token T --out DIR [--journeys J1,J2] [--files changed-files.txt] [--spec path/to/journeys.json] [--delay-tasks MS]
//   node walk.mjs --resolve-j1 DIR/seed.log [--spec path/to/journeys.json]   (print the J1 approve/deny URLs or skip; no browser)
//   node walk.mjs --resolve-j5 DIR/seed.log [--spec path/to/journeys.json]   (print the resolved J5 row-menu step or skip; no browser)
//   node walk.mjs --resolve-j7 DIR/seed.log [--spec path/to/journeys.json]   (print the J7 URL or skip; no browser)
//   node walk.mjs --resolve-j7-plan DIR/seed.log [--spec path/to/journeys.json] (print the resolved J7 steps as JSON; no browser)
//   node walk.mjs --check-spec [--seed DIR/seed.log] [--spec path/to/journeys.json] (J2/J8's review loop, J3's send + mid-run follow-up, J5's row menu, J7's landing contract; no browser)
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
if (process.argv.includes('--check-spec')) {
  const j2 = checkJ2Contract(spec);
  const j3 = checkJ3Contract(spec);
  const j5 = checkJ5Contract(spec);
  const j7 = checkJ7Contract(spec);
  const j8 = checkJ8Contract(spec);
  const j9 = checkJ9Contract(spec);
  const j10 = checkJ10Contract(spec);
  if (j2.length || j3.length || j5.length || j7.length || j8.length || j9.length || j10.length) {
    if (j2.length) { console.log('spec red: J2'); j2.forEach((e) => console.log(' - ' + e)); }
    if (j3.length) { console.log('spec red: J3'); j3.forEach((e) => console.log(' - ' + e)); }
    if (j5.length) { console.log('spec red: J5'); j5.forEach((e) => console.log(' - ' + e)); }
    if (j7.length) { console.log('spec red: J7'); j7.forEach((e) => console.log(' - ' + e)); }
    if (j8.length) { console.log('spec red: J8'); j8.forEach((e) => console.log(' - ' + e)); }
    if (j9.length) { console.log('spec red: J9'); j9.forEach((e) => console.log(' - ' + e)); }
    if (j10.length) { console.log('spec red: J10'); j10.forEach((e) => console.log(' - ' + e)); }
    process.exit(1);
  }
  console.log('spec ok: J2 comments a changed line, sends the tray, and proves path, hunk and quote in the transcript');
  console.log('spec ok: J2 keeps a saved comment across a rerun — re-anchored to its new line, then 该行已变化 when the quoted line is gone');
  console.log('spec ok: J3 sends a prompt, queues a mid-run follow-up before the reply, and marks it queued');
  console.log('spec ok: J3 stops a held round, proves Stop left, and reads the queued message discard report');
  console.log('spec ok: J5 opens the running row\'s menu and pins rename, pin, archive, delete and a disabled 运行中 line');
  console.log('spec ok: J7 lands on the named card, proves focus, consumes ?focus=, and reopens it after Back');
  console.log('spec ok: J8 taps a changed line at 390, saves the sheet, sends the tray, and proves path, hunk and quote');
  console.log('spec ok: J9 keeps the shell, the scroll and the draft across a switch');
  console.log('spec ok: J10 approves the deep-linked card, walks all four footer entries, and finds it gone on the return');
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
async function stepLocator(page, sel) {
  // `text=` is a literal the way `wait text=` is: the seeded title carries
  // `[seed]`, which as a regex is a character class and matches nothing.
  if (sel.startsWith('text=')) {
    const text = page.getByText(sel.slice('text='.length));
    const count = await text.count();
    for (let i = 0; i < count; i++) if (await text.nth(i).isVisible().catch(() => false)) return text.nth(i);
    return text.first();
  }
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
  const seed = (j === 'J1' || j === 'J5' || j === 'J7' || j === 'J10') && fs.existsSync(path.join(out, 'seed.log')) ? fs.readFileSync(path.join(out, 'seed.log'), 'utf8') : '';
  const j1 = j === 'J1' ? readJ1Target(seed) : null;
  const j5 = j === 'J5' ? readJ5Target(seed) : null;
  // J10 answers the same seeded card J7 only looks at. Both must resolve the
  // target the same way, and both skip rather than walk invented ids.
  const j7 = (j === 'J7' || j === 'J10') ? readJ7Target(seed) : null;
  if (j1 && j1.skip) { screens.push({ journey: j, viewport: 'n/a', name: 'J1-skipped-no-approval-target', url: '', lint: {}, notes: ['skipped J1: ' + j1.skip] }); continue; }
  if (j5 && j5.skip) { screens.push({ journey: j, viewport: 'n/a', name: 'J5-skipped-no-running-conversation', url: '', lint: {}, notes: ['skipped J5: ' + j5.skip] }); continue; }
  if (j7 && j7.skip) { screens.push({ journey: j, viewport: 'n/a', name: j + '-skipped-no-fixtures', url: '', lint: {}, notes: ['skipped ' + j + ': no seeded notification target'] }); continue; }
  const J = spec.journeys[j];
  for (const vpName of J.viewports) {
    const [w, h] = spec.viewports[vpName].split('x').map(Number); const phone = w < 700;
    const ctx = await browser.newContext({ viewport: { width: w, height: h }, deviceScaleFactor: phone ? 2 : 1, isMobile: phone, hasTouch: phone });
    if (token) await ctx.addInitScript((t) => { try { localStorage.setItem('kin_token', t); } catch (_) {} }, token);
    const page = await ctx.newPage(); const errs = [], bad = [], soft = [];
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
      const preStep = j === 'J5' && j5 ? applyJ5Step(rawStep, j5) : (j === 'J7' || j === 'J10') && j7 ? applyJ7Step(rawStep, j7) : rawStep;
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
          let pressed = false;
          const loc = await stepLocator(page, '/返回|Back/');
          if ((await loc.count()) > 0 && (await loc.isVisible().catch(() => false))) {
            await loc.click({ timeout: 3000 });
            pressed = true;
            log.push('pressed Back');
          }
          if (!pressed) {
            const went = await page.goBack({ waitUntil: 'domcontentloaded', timeout: WAIT_MS }).catch(() => null);
            if (!went) { hardFail.push(`${j}/${vpName}: Back left no history entry to return to`); continue; }
            log.push('history back');
          }
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
