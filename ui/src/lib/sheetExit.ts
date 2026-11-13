/**
 * Close the phone's open sheet and wait until its history entry is gone.
 *
 * A tap outside the console (a notification) is a departure the sheet cannot
 * see. Navigating while the sheet is still current would strand its entry
 * under the destination, so `[list, agents, target]` becomes the stack and
 * Back revisits a screen the reader already left. The caller waits for the
 * same cleanup every in-page sheet action waits for (`Sheet` pops its entry
 * before `onCloseComplete`), then runs the leave guard.
 */
export type SheetExit = {
  close: () => void;
  finish: () => void;
  done: Promise<void>;
};

const handles: SheetExit[] = [];

export function registerSheetExit(close: () => void): SheetExit {
  let settled = false;
  let resolve!: () => void;
  const done = new Promise<void>((r) => {
    resolve = r;
  });
  const handle: SheetExit = {
    close,
    done,
    finish() {
      if (settled) return;
      settled = true;
      const at = handles.lastIndexOf(handle);
      if (at >= 0) handles.splice(at, 1);
      resolve();
    },
  };
  handles.push(handle);
  return handle;
}

/**
 * Close the topmost sheet and resolve once its entry is behind the route.
 *
 * The timeout is a liveness guard, not a normal path: a sheet whose parent
 * failed to close would otherwise leave the tap waiting forever.
 */
export function closeTopSheet(timeoutMs = 1000): Promise<void> {
  const handle = handles[handles.length - 1];
  if (!handle) return Promise.resolve();
  const closed = handle.done;
  handle.close();
  return Promise.race([
    closed,
    new Promise<void>((resolve) => {
      window.setTimeout(resolve, timeoutMs);
    }),
  ]);
}

/** Test hook: drop handles a failed test left behind. */
export function resetSheetExits(): void {
  handles.length = 0;
}
