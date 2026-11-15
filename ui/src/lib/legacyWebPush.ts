/**
 * KIN-NOTIFY-001 removed Web Push.
 *
 * A browser that ran an older console may still have the push worker
 * installed. Nothing sends to it any more, but a registration that outlives
 * the feature is still a listener nobody can see, and its subscription is a
 * delivery address with no owner. Unregister Kin's `/sw.js` and drop its
 * subscription; leave every other worker on the origin alone.
 *
 * Best-effort by design: a browser without service workers, or one that
 * refuses the call, is not an error the reader needs to see.
 */

type LegacySubscription = {
  unsubscribe?: () => Promise<boolean>;
};

type LegacyWorker = {
  scriptURL?: string;
};

type LegacyRegistration = {
  active?: LegacyWorker | null;
  installing?: LegacyWorker | null;
  waiting?: LegacyWorker | null;
  pushManager?: {
    getSubscription?: () => Promise<LegacySubscription | null>;
  };
  unregister?: () => Promise<boolean>;
};

type LegacyServiceWorkers = {
  getRegistrations?: () => Promise<LegacyRegistration[]>;
};

function browserServiceWorkers(): LegacyServiceWorkers | null {
  if (typeof navigator === "undefined") return null;
  const workers = (navigator as Navigator & { serviceWorker?: LegacyServiceWorkers })
    .serviceWorker;
  return workers ?? null;
}

/**
 * The old console's worker was served at `/sw.js`. Matching the script is what
 * keeps this cleanup from unregistering a service worker some other app on the
 * same origin installed: only Kin's push worker is ours to remove.
 */
function isLegacyKinWorker(registration: LegacyRegistration): boolean {
  return [registration.active, registration.installing, registration.waiting].some(
    (worker) => {
      if (typeof worker?.scriptURL !== "string") return false;
      try {
        return new URL(worker.scriptURL).pathname === "/sw.js";
      } catch {
        return false;
      }
    },
  );
}

export async function cleanupLegacyWebPush(
  workers: LegacyServiceWorkers | null = browserServiceWorkers(),
): Promise<void> {
  if (!workers?.getRegistrations) return;
  let registrations: LegacyRegistration[];
  try {
    registrations = await workers.getRegistrations();
  } catch {
    return;
  }
  await Promise.all(
    registrations.filter(isLegacyKinWorker).map(async (registration) => {
      try {
        const subscription = await registration.pushManager?.getSubscription?.();
        await subscription?.unsubscribe?.();
      } catch {
        // The subscription was already gone.
      }
      try {
        await registration.unregister?.();
      } catch {
        // The worker was already gone.
      }
    }),
  );
}
