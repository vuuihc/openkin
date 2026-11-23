#!/usr/bin/env node
// walk-log.test.mjs — the evidence a wedged walk must leave on disk.
//
// A walk that hangs used to leave nothing: the only walk.json write happens
// after `browser.close()`, so a kill at any step discards every step name and
// the merge lane cannot say which of ~40 steps died. Measured 2026-11-23 on
// #626: 21 minutes of a parked node and Chrome, both log files 0 bytes, one
// whole verification slot re-spent on a nameless retry. The step writer's one
// rule is that a line is on disk before the step does anything else; these
// cases hold it to that, without a browser, timers, network or daemon.
//
// The file is `walk.steps.log`, not `walk.log`: ux-walk.sh redirects the
// walker's own stdout to `$OUT/walk.log`, and a second writer appending to the
// same inode would be overwritten by fd 1 when the walker prints its summary.
// Run with `node rsi/runtime/ux/walk-log.test.mjs`.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createStepLog, STEP_LOG_NAME } from './walk-log.mjs';

function tempDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'walk-log-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

const fileOf = (dir) => path.join(dir, STEP_LOG_NAME);
const read = (dir) => fs.readFileSync(fileOf(dir), 'utf8');
const lastLine = (dir) => read(dir).trimEnd().split('\n').pop();

test('test_walk_log_writes_each_step_line_to_disk_before_the_run_ends', (t) => {
  const dir = tempDir(t);
  const log = createStepLog({ dir });
  log.begin('J4/mac', 1, 'click', "css=button[aria-label*='Project Alpha']");
  // No close(): the line must be readable while the walk is still running.
  assert.match(read(dir), /^J4\/mac step 1 start click css=button\[aria-label\*='Project Alpha'\]$/m);
});

test('test_walk_log_a_step_that_begins_and_never_ends_is_the_last_line_on_disk', (t) => {
  const dir = tempDir(t);
  const log = createStepLog({ dir });
  log.begin('J4/mac', 1, 'click', 'css=[data-testid=project-alpha]');
  log.end('done');
  // The wedge: begin the step the walk dies on, and never reach its end.
  log.begin('J4/mac', 2, 'wait', 'css=[data-testid=reply-body]');
  assert.equal(lastLine(dir), 'J4/mac step 2 start wait css=[data-testid=reply-body]');
  // A completed step says so, so "began but never ended" is a fact, not a guess.
  assert.match(read(dir), /^J4\/mac step 1 end done$/m);
});

test('test_walk_log_the_in_memory_lines_and_the_file_agree', (t) => {
  const dir = tempDir(t);
  const log = createStepLog({ dir });
  log.begin('J9/phone', 1, 'goto', '/routines');
  log.push('url /routines matches /routines');
  log.end('done');
  log.begin('J9/phone', 2, 'click', 'css=[data-area="projects"]');
  log.end('done');
  log.close();
  assert.deepEqual(log.lines, [
    'J9/phone step 1 start goto /routines',
    'url /routines matches /routines',
    'J9/phone step 1 end done',
    'J9/phone step 2 start click css=[data-area="projects"]',
    'J9/phone step 2 end done',
  ]);
  // The same array the walker attaches to every screen's notes is exactly the
  // file's content, so walk.json and the surviving log cannot tell different
  // stories about which step ran.
  assert.equal(log.lines.join('\n'), read(dir).trimEnd());
});

test('test_walk_log_an_unwritable_directory_does_not_throw', (t) => {
  const dir = tempDir(t);
  const blocker = path.join(dir, 'blocker');
  fs.writeFileSync(blocker, 'not a directory');
  let log;
  assert.doesNotThrow(() => {
    log = createStepLog({ dir: path.join(blocker, 'sub') });
    log.begin('J2/mac', 1, 'click', 'css=button');
    log.end('done');
    log.push('soft: still walked');
  });
  assert.deepEqual(log.lines, [
    'J2/mac step 1 start click css=button',
    'J2/mac step 1 end done',
    'soft: still walked',
  ]);
});

test('test_walk_log_a_pushed_outcome_line_reaches_the_file_immediately', (t) => {
  const dir = tempDir(t);
  const log = createStepLog({ dir });
  log.begin('J15/phone', 1, 'click', 'css=button:has-text("Approve")');
  log.push('pressed css=button:has-text("Approve")');
  assert.equal(lastLine(dir), 'pressed css=button:has-text("Approve")');
});

test('test_walk_log_each_leg_keeps_its_own_lines_while_the_file_accumulates', (t) => {
  const dir = tempDir(t);
  const root = createStepLog({ dir });
  const first = root.group();
  first.begin('J1/phone', 1, 'goto', '/');
  first.push('url / matches /');
  first.end('done');
  const second = root.group();
  second.begin('J2/mac', 1, 'click', 'css=button');
  second.end('done');
  root.close();
  // A screen's notes carry only its own leg, exactly as the per-leg array did...
  assert.deepEqual(second.lines, [
    'J2/mac step 1 start click css=button',
    'J2/mac step 1 end done',
  ]);
  // ...while the surviving file names every leg in walk order, so a wedge in
  // J2 does not erase J1's steps and the last line is still J2's.
  assert.equal(read(dir), [
    'J1/phone step 1 start goto /',
    'url / matches /',
    'J1/phone step 1 end done',
    'J2/mac step 1 start click css=button',
    'J2/mac step 1 end done',
    '',
  ].join('\n'));
});

test('test_walk_log_a_new_walk_in_the_same_dir_starts_a_fresh_file', (t) => {
  const dir = tempDir(t);
  const old = createStepLog({ dir });
  old.begin('J1/phone', 1, 'goto', '/');
  old.end('done');
  const retry = createStepLog({ dir });
  retry.begin('J1/phone', 1, 'goto', '/');
  retry.end('done');
  // Two runs in one output dir must not read as one walk: the retry's file
  // starts at its own first step.
  assert.equal(read(dir), [
    'J1/phone step 1 start goto /',
    'J1/phone step 1 end done',
    '',
  ].join('\n'));
});
