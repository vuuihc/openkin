/**
 * The two lists behind the conversation list share one parameter shape.
 *
 * The phone renders 100 recent rows; a search must reach past them, so it asks
 * for more and lets the daemon match. Keeping that rule in one function is what
 * stops the tasks and the imported sessions from answering different questions
 * — a search that covers one list and not the other looks complete and is not.
 *
 * The daemon clamps a task page at 200 (`store.ListTasksOpts`), so `SEARCH_LIMIT`
 * is the same number the server will honour; a larger value here would silently
 * stop at 200 for tasks while agent sessions reached 500.
 */
export const LIST_LIMIT = 100;
export const SEARCH_LIMIT = 200;

export type SessionListParams = { limit: number; q?: string };

export function sessionListParams(term: string): SessionListParams {
  const q = term.trim();
  return q ? { limit: SEARCH_LIMIT, q } : { limit: LIST_LIMIT };
}
