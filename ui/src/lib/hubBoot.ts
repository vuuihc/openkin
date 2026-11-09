/**
 * Where the shell should open, decided before the console renders.
 *
 * The iOS shell keeps the Hub origin the person connected to. The webview,
 * however, starts on whatever page the build shipped with: the bundled console
 * for a generic build, or a Hub origin baked in at compile time. Without this
 * step every reopen lands on the connect screen even though the address (and
 * its session cookie) is already on the phone.
 *
 * The decision lives in the console because the bundled page is the first
 * thing the shell loads, and the plugin's `setHubUrl` is a web-callable
 * primitive: it persists the origin, moves the cookie keeper to that host,
 * restores the saved session, and navigates in one action — the same path the
 * connect screen uses. The bundled console therefore never paints; `main.tsx`
 * renders nothing until this answer is known.
 */

export type HubBootPlan = { kind: "stay" } | { kind: "navigate"; url: string };

/**
 * Whether to move the webview to the stored Hub instead of rendering here.
 *
 * `here` is the address the shell loaded. A visit carrying a query or fragment
 * is left alone: a sign-in link, a pairing secret or a claim code is an action
 * on *this* origin, and navigating away would spend it where the console that
 * reads it is not. The same goes for a browser (no shell) and for a first-run
 * app with nothing stored.
 */
export function hubBootPlan(input: {
  inShell: boolean;
  storedUrl: string;
  here: string;
}): HubBootPlan {
  if (!input.inShell) return { kind: "stay" };
  const stored = input.storedUrl.trim();
  if (!stored) return { kind: "stay" };

  let here: URL;
  let target: URL;
  try {
    here = new URL(input.here);
    target = new URL(stored);
  } catch {
    // A stored value that no longer parses is not an address the shell can
    // act on. The connect screen still offers the form.
    return { kind: "stay" };
  }
  if (here.search || here.hash) return { kind: "stay" };
  // Already there: a baked build whose stored origin is its own, or the Hub
  // console booting after the shell moved the webview. Redirecting to the
  // same origin would reload forever.
  if (target.origin === here.origin) return { kind: "stay" };
  return { kind: "navigate", url: stored };
}

/**
 * Whether the stored Hub answers at all.
 *
 * A liveness check, not an API call: any response — 200, 401, even a 405 from
 * a route that does not take HEAD — means the address is up, and the console
 * that loads next decides what to show. Only a network failure (or the
 * deadline) means "unreachable", which is the one case that keeps the bundled
 * console on screen. `no-cors` keeps the probe from depending on the Hub
 * allowing requests from a `capacitor://` page.
 */
export async function hubAnswers(
  url: string,
  options: {
    timeoutMs?: number;
    fetchImpl?: (url: string, init: RequestInit) => Promise<unknown>;
  } = {},
): Promise<boolean> {
  const timeoutMs = options.timeoutMs ?? 2500;
  const fetchImpl = options.fetchImpl ?? fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    await fetchImpl(url, {
      method: "HEAD",
      mode: "no-cors",
      cache: "no-store",
      signal: controller.signal,
    });
    return true;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}
