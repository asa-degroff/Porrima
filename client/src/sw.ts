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

// Store the most recent push-click payload + timestamp so a freshly-opened
// window can request it as a fallback if the postMessage was missed.
interface StoredPushPayload {
  payload: PushPayload;
  timestamp: number;
}
let lastPushClickPayload: StoredPushPayload | null = null;

function parsePushData(event: PushEvent): PushPayload {
  if (!event.data) return { title: "Porrima", body: "" };
  try {
    return event.data.json() as PushPayload;
  } catch {
    return { title: "Porrima", body: event.data.text() };
  }
}

self.addEventListener("push", (event) => {
  const payload = parsePushData(event);
  const title = payload.title || "Porrima";

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

  // Store the payload + timestamp so the app can request it on mount as
  // a fallback if the postMessage was missed (race: focus + postMessage
  // fires before the React listener is attached).
  lastPushClickPayload = { payload: data, timestamp: Date.now() };

  event.waitUntil(
    (async () => {
      // Always use openWindow — it focuses existing windows AND navigates
      // them to the target URL. The URL ?chat= param provides a reliable
      // navigation path that doesn't depend on postMessage timing.
      const win = await self.clients.openWindow(targetUrl);

      // Also send the route hint for immediate react-router navigation
      // (avoids a full page reload). This is best-effort — the URL param
      // is the primary path.
      if (win) {
        (win as WindowClient).postMessage({ kind: "push-click", payload: data });
      }
    })()
  );
});

// Respond to mount-time requests from the app — the app asks "did a
// notification click happen while I wasn't ready to listen?" and we hand
// it the stored payload if so. Only deliver payloads within a short window
// to avoid stale navigation on normal app opens.
const PUSH_CLICK_MAX_AGE_MS = 30_000; // 30s — covers app launch + mount timing
self.addEventListener("message", (event) => {
  if (event.data?.kind === "get-last-push-click") {
    const source = event.source as MessageEventSource | null;
    if (source && lastPushClickPayload && Date.now() - lastPushClickPayload.timestamp < PUSH_CLICK_MAX_AGE_MS) {
      source.postMessage({
        kind: "last-push-click",
        payload: lastPushClickPayload.payload,
      });
      // Clear after delivering — the app either used it or missed the window.
      lastPushClickPayload = null;
    }
  }
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
