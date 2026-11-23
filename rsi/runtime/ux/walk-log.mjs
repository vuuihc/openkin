// walk-log.mjs — the step log a wedged UX walk leaves behind.
//
// A walk that hangs used to leave nothing: every step line lived in an array
// and the one walk.json write came after `browser.close()`, so a kill at any
// point discarded every name. Measured 2026-11-23 on #626: the walk started
// 23:39, the last screenshot landed 23:43, then 21 minutes of a parked node
// and Chrome with both log files at 0 bytes — one whole verification slot
// re-spent on a retry that could not say which of ~40 steps died.
//
// This writer puts each line on disk the moment it is produced: `begin` names
// journey/viewport, step index, op and target before the step's first await,
// so the last `start` without an `end` is the step that wedged. One file spans
// the whole walk (a wedge in J13 must not erase J1-J12), while `group()` gives
// each journey/viewport its own `lines`, the same array the walker attaches to
// that leg's screens' notes. walk.json therefore repeats the file rather than
// inventing a second, divergent story.
//
// The file is `walk.steps.log`, not `walk.log`: ux-walk.sh redirects the
// walker's own stdout to `$OUT/walk.log` (and cats it for the operator), so a
// second writer appending to that inode would be overwritten by fd 1's
// offset-0 writes when the walker prints its summary.
//
// Logging is evidence, never a verdict: a directory that cannot be created or
// a failed append is swallowed, and the walk carries on (AGENTS §13 — report
// no verdict rather than a fabricated one).
import fs from 'node:fs';
import path from 'node:path';

export const STEP_LOG_NAME = 'walk.steps.log';

// Targets are selectors and needles from the journey spec: keep one line per
// line and a bounded width, so a stray newline or a long markdown body cannot
// turn one step into half a screen of log.
const TARGET_MAX = 200;
const oneLine = (v) => String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, TARGET_MAX);

// → { begin, end, push, close, lines, group }
//   begin(where, index, op, ...targets) — writes `<where> step <index> start <op> <target>`
//   end(text)                           — writes `<where> step <index> end <text>`
//   push(...items)                      — the walker's existing outcome lines, unchanged
//   lines                               — this leg's lines in memory, in file order
//   group()                             — a fresh `lines` for the next leg, same file
export function createStepLog({ dir, file = STEP_LOG_NAME } = {}) {
  let filePath = null;
  try {
    fs.mkdirSync(dir, { recursive: true });
    filePath = path.join(dir, file);
    fs.writeFileSync(filePath, ''); // a new walk in this dir starts a fresh file
  } catch (_) { filePath = null; }

  const writeLine = (text) => {
    if (filePath == null) return;
    try { fs.appendFileSync(filePath, text + '\n'); }
    catch (_) { filePath = null; } // a full or vanished disk must not change the walk's verdict
  };

  const group = () => {
    const lines = [];
    let current = { where: 'walk', index: 0 };
    const append = (text) => { lines.push(text); writeLine(text); };
    return {
      lines,
      begin(where, index, op, ...targets) {
        current = { where: String(where), index: Number(index) };
        const target = targets.map(oneLine).filter(Boolean).join(' ');
        append(`${current.where} step ${current.index} start ${oneLine(op)}${target ? ' ' + target : ''}`);
      },
      end(text) {
        append(`${current.where} step ${current.index} end${text ? ' ' + oneLine(text) : ''}`);
      },
      push(...items) { items.forEach((item) => append(String(item))); },
      close() { /* every line is already on disk; there is nothing to flush */ },
    };
  };

  return { ...group(), group };
}
