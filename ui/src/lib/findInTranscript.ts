/**
 * Find-in-conversation, as pure data.
 *
 * The transcript can be hundreds of turns; the bar needs an ordered list of the
 * messages that contain the text, the count, and a wrap-around step. None of
 * that needs the DOM, so it is testable without mounting a conversation.
 *
 * The query is user input and is matched literally: `(` must not throw and `.`
 * must not match every character. Case folding is the same `toLowerCase` the
 * rest of the console uses.
 */
export type FindableMessage = { key: string; text: string };

export function findMatches(items: readonly FindableMessage[], query: string): string[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return [];
  return items
    .filter((item) => item.text.toLowerCase().includes(needle))
    .map((item) => item.key);
}

/**
 * The next index in a wrap-around list, or -1 when there is nothing to step
 * through. An empty result set is not "index 0 of 0": the bar has to be able to
 * say "no matches" instead of pointing at a message that is not there.
 */
export function stepMatch(index: number, delta: number, total: number): number {
  if (total <= 0) return -1;
  return (((index + delta) % total) + total) % total;
}
