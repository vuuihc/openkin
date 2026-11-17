/**
 * One, coarse way to say how long something took: one unit past the one that
 * matters, never a decimal. The running-task card, the tray and the transcript's
 * process rows all read their numbers from here, so a tool call that took
 * 2.5 s and a task that took 2.5 s cannot end up worded differently.
 */
export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "0s";
  // A settled tool call can be faster than the second the rest of the shapes
  // are cut in; saying "0s" would read as "no time at all".
  if (ms < 1000) return "<1s";
  return formatSeconds(Math.floor(ms / 1000));
}

/**
 * Whole seconds in the shape `formatElapsed` has always returned. Kept separate
 * from `formatDuration` because a task's elapsed time counts whole seconds from
 * the start: a task that began and finished in the same millisecond says `0s`,
 * not `<1s`.
 */
export function formatSeconds(totalSeconds: number): string {
  const s = Math.max(0, Math.floor(totalSeconds));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const rem = s % 60;
  if (m < 60) return `${m}m ${rem}s`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}
