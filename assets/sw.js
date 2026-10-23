"use strict";
// Shows alert notifications for browsers that only allow them through a service worker (Android Chrome).
// No fetch handler, no cache and no push subscription: the page itself decides when to notify, while it is open.
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));
self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  event.waitUntil((async () => {
    const pages = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    const page = pages.find((c) => "focus" in c);
    if (page) {
      await page.focus();
      page.postMessage({ openAlert: event.notification.tag });
    }
  })());
});
