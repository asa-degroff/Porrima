/// <reference lib="webworker" />

import { precacheAndRoute } from "workbox-precaching";
import { registerRoute } from "workbox-routing";
import { CacheFirst } from "workbox-strategies";
import { ExpirationPlugin } from "workbox-expiration";

declare const self: ServiceWorkerGlobalScope;

// Activate immediately on install — without this, an existing PWA install
// stays on the previous SW (no push handler) until every tab closes. With
// it, the new SW takes over the open tab on next reload.
self.addEventListener("install", () => {
  self.skipWaiting();
});
self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});

precacheAndRoute(self.__WB_MANIFEST);

// Preserve previous behavior: long-cache Google Fonts.
registerRoute(
  ({ url }) => url.origin === "https://fonts.googleapis.com",
  new CacheFirst({
    cacheName: "google-fonts-stylesheets",
    plugins: [new ExpirationPlugin({ maxEntries: 10, maxAgeSeconds: 31536000 })],
  })
);
registerRoute(
  ({ url }) => url.origin === "https://fonts.gstatic.com",
  new CacheFirst({
    cacheName: "google-fonts-webfonts",
    plugins: [new ExpirationPlugin({ maxEntries: 30, maxAgeSeconds: 31536000 })],
  })
);

// ---------------------------------------------------------------------------
// Web Push handlers
// ---------------------------------------------------------------------------

interface PushPayload {
  type?: string;
  title?: string;
  body?: string;
  url?: string;
  tag?: string;
  chatId?: string;
  data?: unknown;
}

function parsePushData(event: PushEvent): PushPayload {
  if (!event.data) return { title: "qu.je", body: "" };
  try {
    return event.data.json() as PushPayload;
  } catch {
    return { title: "qu.je", body: event.data.text() };
  }
}

self.addEventListener("push", (event) => {
  const payload = parsePushData(event);
  const title = payload.title || "qu.je";

  event.waitUntil(
    (async () => {
      const clients = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
      const visibleClient = clients.find((c) => (c as WindowClient).visibilityState === "visible");

      // Always post to clients so a foreground tab can show its own toast
      // (covers the case where the OS won't display while the PWA is front).
      for (const c of clients) {
        c.postMessage({ kind: "push", payload });
      }

      // Second line of defense for non-test pushes: if a window is visible,
      // skip the OS notification — the in-app toast covers it. Test pushes
      // (from the settings UI) always force the OS notification so the user
      // can verify the path end-to-end.
      if (visibleClient && payload.type !== "test") return;

      await self.registration.showNotification(title, {
        body: payload.body ?? "",
        tag: payload.tag,
        data: payload,
        icon: "/icons/icon-192x192.png",
        badge: "/icons/icon-192x192.png",
      });
    })()
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const data = (event.notification.data ?? {}) as PushPayload;
  const targetUrl = data.url || "/";

  event.waitUntil(
    (async () => {
      const all = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
      // Prefer focusing an existing window, then nudging it to the route.
      for (const c of all) {
        const win = c as WindowClient;
        try {
          await win.focus();
          // Send the route hint to the page so it can navigate via
          // react-router instead of full reload.
          win.postMessage({ kind: "push-click", payload: data });
          return;
        } catch {
          // try next client
        }
      }
      await self.clients.openWindow(targetUrl);
    })()
  );
});

// When the browser rotates the push endpoint, fetch a fresh subscription and
// re-register it under the same deviceId. The deviceId lives in IndexedDB
// (see client/src/lib/device-id.ts) so it survives SW restarts.
self.addEventListener("pushsubscriptionchange", (event: any) => {
  event.waitUntil(
    (async () => {
      try {
        const oldEndpoint: string | undefined = event.oldSubscription?.endpoint;
        const reg = self.registration;

        // Fetch a fresh public key from the server. We can't read localStorage
        // from the SW; the server returns the same key on every call.
        const keyResp = await fetch("/api/push/public-key", { credentials: "include" });
        if (!keyResp.ok) return;
        const { key } = await keyResp.json();

        const sub = await reg.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: urlBase64ToUint8Array(key) as BufferSource,
        });

        // Without access to localStorage, we can't recover the deviceId here.
        // Best we can do is post a message to any clients so the foreground
        // can re-subscribe. If no client is open, the next foreground load
        // will detect the mismatch (server endpoint vs current sub) via the
        // hook and re-post.
        const clients = await self.clients.matchAll({ includeUncontrolled: true });
        for (const c of clients) {
          c.postMessage({
            kind: "push-resubscribe",
            subscription: sub.toJSON(),
            oldEndpoint,
          });
        }
      } catch (err) {
        console.warn("[sw] pushsubscriptionchange failed:", err);
      }
    })()
  );
});

function urlBase64ToUint8Array(base64String: string): Uint8Array {
  const padding = "=".repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(base64);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}
