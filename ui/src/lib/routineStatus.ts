/**
 * The one word a run's state is shown as.
 *
 * Shared by the Routines feed and the run detail page so a run reads the same in
 * both places: a row that says "Running" and a page that says "running" is the
 * same run wearing two names, which is exactly what a reader notices.
 */
export function routineStatusLabel(status: string, tr: (key: string) => string): string {
  switch (status) {
    case "queued":
      return tr("routines.statusQueued");
    case "running":
      return tr("routines.statusRunning");
    case "succeeded":
      return tr("routines.statusSucceeded");
    case "failed":
      return tr("routines.statusFailed");
    case "canceled":
      return tr("routines.statusCanceled");
    case "waiting_approval":
    case "waiting_input":
      return tr("routines.statusWaiting");
    default:
      return status;
  }
}
