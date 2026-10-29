/* Kin's push worker.
 *
 * It exists for one reason: a browser only delivers a push to a page it can
 * wake without the page being open. The message is JSON written by the daemon
 * (`internal/webpush.Payload`), and the URL in it is the same deep link the
 * Bark and ntfy channels already carry.
 *
 * Deliberately not a cache: this console has no offline story worth lying
 * about, and a stale service worker serving an old shell is the classic way to
 * make a deploy look broken.
 */

self.addEventListener("push", (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    data = { body: event.data ? event.data.text() : "" };
  }
  const title = data.title || "Kin";
  event.waitUntil(
    self.registration.showNotification(title, {
      body: data.body || "",
      icon: "/icons/icon-192.png",
      badge: "/icons/icon-192.png",
      // One tag collapses repeated notifications for the same kind of event
      // into the newest, which is what a queue of approvals wants.
      tag: "kin-notification",
      renotify: true,
      data: { url: data.url || "/" },
    }),
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const url =
    (event.notification.data && event.notification.data.url) || "/";
  event.waitUntil(
    (async () => {
      const windows = await self.clients.matchAll({
        type: "window",
        includeUncontrolled: true,
      });
      for (const client of windows) {
        if ("focus" in client) {
          await client.focus();
          if ("navigate" in client) {
            try {
              await client.navigate(url);
            } catch {
              /* a cross-origin or closed window; the focus is still useful */
            }
          }
          return;
        }
      }
      await self.clients.openWindow(url);
    })(),
  );
});
