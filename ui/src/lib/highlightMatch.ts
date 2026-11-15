/**
 * Split text into the runs a search result highlights.
 *
 * A result whose row looks like every other row still costs the reader a
 * re-read to trust it: the list says this row matched, and the eye has to find
 * out where. Marking the runs is what turns the answer from "one of these" into
 * "here".
 *
 * The query is user input, so this deliberately does not build a RegExp: a `(`
 * in the search box would throw and a `.` would match every character. Plain
 * case-insensitive `indexOf` over a lowercased copy keeps positions exact for
 * any input, including one longer than the text.
 */
export type MatchPart = { text: string; match: boolean };

export function splitMatches(text: string, query: string): MatchPart[] {
  const needle = query.trim().toLowerCase();
  if (!needle || !text) return [{ text, match: false }];
  const haystack = text.toLowerCase();
  // Some case folds change length — `İ` lowercases to `i` plus a combining dot
  // — which shifts every index after them. A wrong run marked is worse than no
  // run marked, and the row is still in the results either way.
  if (haystack.length !== text.length) return [{ text, match: false }];
  const parts: MatchPart[] = [];
  let at = 0;
  for (;;) {
    const hit = haystack.indexOf(needle, at);
    if (hit === -1) break;
    if (hit > at) parts.push({ text: text.slice(at, hit), match: false });
    parts.push({ text: text.slice(hit, hit + needle.length), match: true });
    at = hit + needle.length;
  }
  if (at < text.length) parts.push({ text: text.slice(at), match: false });
  // Only matches (the whole string) or only misses (an empty parts list when
  // the needle is absent) still have to name the text once.
  return parts.length > 0 ? parts : [{ text, match: false }];
}
