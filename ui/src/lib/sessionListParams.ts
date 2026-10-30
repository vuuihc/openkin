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

export type SessionListParams = {
  limit: number;
  q?: string;
  status?: string;
  /** The archived view: the other side of the archive, not a narrowing. */
  archived?: boolean;
};

/**
 * `status` is the daemon's own filter (`?status=`), not a narrowing of the
 * page: filtering loaded rows in the browser would say "no running chats"
 * about a page that merely ended. Imported agent sessions have no status, so
 * the page hides them whenever this is set.
 */
export function sessionListParams(
  term: string,
  status?: string,
  archived?: boolean,
): SessionListParams {
  const q = term.trim();
  const params: SessionListParams = q ? { limit: SEARCH_LIMIT, q } : { limit: LIST_LIMIT };
  if (status) params.status = status;
  // Only Kin's own tasks have an archive; imported agent sessions are filed
  // by project and never carry this flag.
  if (archived) params.archived = true;
  return params;
}
