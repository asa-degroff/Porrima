import { useCallback, useEffect, useRef, useState } from "react";
import { getOrCreateDeviceId } from "../lib/device-id";
import {
  fetchPushDevices,
  fetchPushPublicKey,
  postPushPresence,
  subscribePush,
  unsubscribePush,
  type PushDevice,
} from "../api/push";

export type PushSupport = "supported" | "unsupported" | "needs-install";
export type PushStatus = "idle" | "loading" | "subscribed" | "denied" | "error";

interface UsePushNotificationsResult {
  support: PushSupport;
  status: PushStatus;
  permission: NotificationPermission | "unsupported";
  devices: PushDevice[];
  error: string | null;
  isStandalone: boolean;
  enable: () => Promise<void>;
  disable: () => Promise<void>;
  refreshDevices: () => Promise<void>;
}

function detectStandalone(): boolean {
  if (typeof window === "undefined") return false;
  if (window.matchMedia("(display-mode: standalone)").matches) return true;
  if ((navigator as unknown as { standalone?: boolean }).standalone === true) return true;
  return false;
}

function detectIos(): boolean {
  if (typeof navigator === "undefined") return false;
  // iPadOS reports MacIntel — also probe touch points to disambiguate.
  const ua = navigator.userAgent || "";
  if (/iPad|iPhone|iPod/.test(ua)) return true;
  return navigator.platform === "MacIntel" && (navigator as any).maxTouchPoints > 1;
}

function urlBase64ToUint8Array(base64String: string): Uint8Array {
  const padding = "=".repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(base64);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

function detectSupport(): PushSupport {
  if (typeof window === "undefined") return "unsupported";
  const hasNotification = "Notification" in window;
  const hasSW = "serviceWorker" in navigator;
  const hasPush = "PushManager" in window;
  if (hasNotification && hasSW && hasPush) return "supported";
  if (detectIos() && !detectStandalone()) return "needs-install";
  return "unsupported";
}

const PRESENCE_PING_INTERVAL_MS = 20_000;

export function usePushNotifications(): UsePushNotificationsResult {
  const [support, setSupport] = useState<PushSupport>(() => detectSupport());
  const [status, setStatus] = useState<PushStatus>("idle");
  const [permission, setPermission] = useState<NotificationPermission | "unsupported">(
    () => (typeof Notification !== "undefined" ? Notification.permission : "unsupported")
  );
  const [devices, setDevices] = useState<PushDevice[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [isStandalone] = useState<boolean>(() => detectStandalone());

  const deviceIdRef = useRef<string>("");
  if (!deviceIdRef.current) deviceIdRef.current = getOrCreateDeviceId();

  // ---- Presence pinging ------------------------------------------------------
  // Stamp presence whenever the tab is visible. We send keepalive presence
  // pings so the server's 30s presence window stays warm. We always run this,
  // even when the user hasn't opted into push — the server discards the ping
  // if no subscription matches the deviceId.

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setInterval> | null = null;

    const pingNow = () => {
      if (cancelled) return;
      if (typeof document !== "undefined" && document.visibilityState === "visible") {
        postPushPresence(deviceIdRef.current, true);
      }
    };

    const handleVisibility = () => {
      if (document.visibilityState === "visible") {
        pingNow();
      } else {
        // We don't tell the server "not visible" — the 30s window expires on
        // its own and avoids races with a stream that's about to end.
      }
    };

    pingNow();
    timer = setInterval(pingNow, PRESENCE_PING_INTERVAL_MS);
    document.addEventListener("visibilitychange", handleVisibility);

    return () => {
      cancelled = true;
      if (timer) clearInterval(timer);
      document.removeEventListener("visibilitychange", handleVisibility);
    };
  }, []);

  // ---- Initial subscription state probe -------------------------------------

  const probe = useCallback(async () => {
    if (support !== "supported") return;
    try {
      const reg = await navigator.serviceWorker.ready;
      const sub = await reg.pushManager.getSubscription();
      if (sub) {
        setStatus("subscribed");
      } else {
        setStatus("idle");
      }
      setPermission(Notification.permission);
    } catch (err: any) {
      setError(err?.message || String(err));
    }
  }, [support]);

  useEffect(() => {
    probe();
  }, [probe]);

  // ---- Devices list --------------------------------------------------------

  const refreshDevices = useCallback(async () => {
    try {
      const list = await fetchPushDevices();
      setDevices(list);
    } catch (err: any) {
      setError(err?.message || String(err));
    }
  }, []);

  useEffect(() => {
    refreshDevices();
  }, [refreshDevices]);

  // ---- Re-subscription handler from SW -------------------------------------

  useEffect(() => {
    if (typeof navigator === "undefined" || !("serviceWorker" in navigator)) return;
    const handler = async (event: MessageEvent) => {
      const data = event.data;
      if (!data || data.kind !== "push-resubscribe") return;
      try {
        const sub = data.subscription;
        if (!sub?.endpoint) return;
        await subscribePush({
          deviceId: deviceIdRef.current,
          subscription: {
            endpoint: sub.endpoint,
            keys: { p256dh: sub.keys.p256dh, auth: sub.keys.auth },
          },
          userAgent: navigator.userAgent,
        });
        await refreshDevices();
      } catch (err) {
        console.warn("[push] re-subscribe failed:", err);
      }
    };
    navigator.serviceWorker.addEventListener("message", handler);
    return () => navigator.serviceWorker.removeEventListener("message", handler);
  }, [refreshDevices]);

  // ---- Enable / disable ----------------------------------------------------

  const enable = useCallback(async () => {
    if (support !== "supported") {
      setError(
        support === "needs-install"
          ? "Install qu.je to your Home Screen first to enable push notifications."
          : "Push notifications aren't supported on this browser."
      );
      return;
    }

    setStatus("loading");
    setError(null);

    try {
      const perm = await Notification.requestPermission();
      setPermission(perm);
      if (perm !== "granted") {
        setStatus("denied");
        return;
      }

      const reg = await navigator.serviceWorker.ready;
      let sub = await reg.pushManager.getSubscription();
      if (!sub) {
        const key = await fetchPushPublicKey();
        sub = await reg.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: urlBase64ToUint8Array(key) as BufferSource,
        });
      }
      const json = sub.toJSON();
      if (!json.endpoint || !json.keys?.p256dh || !json.keys?.auth) {
        throw new Error("Invalid subscription returned by browser");
      }
      await subscribePush({
        deviceId: deviceIdRef.current,
        subscription: {
          endpoint: json.endpoint,
          keys: { p256dh: json.keys.p256dh, auth: json.keys.auth },
        },
        userAgent: navigator.userAgent,
      });
      setStatus("subscribed");
      await refreshDevices();
    } catch (err: any) {
      setStatus("error");
      setError(err?.message || String(err));
    }
  }, [support, refreshDevices]);

  const disable = useCallback(async () => {
    setStatus("loading");
    setError(null);
    try {
      if ("serviceWorker" in navigator) {
        const reg = await navigator.serviceWorker.ready;
        const sub = await reg.pushManager.getSubscription();
        if (sub) await sub.unsubscribe();
      }
      await unsubscribePush(deviceIdRef.current);
      setStatus("idle");
      await refreshDevices();
    } catch (err: any) {
      setStatus("error");
      setError(err?.message || String(err));
    }
  }, [refreshDevices]);

  return {
    support,
    status,
    permission,
    devices,
    error,
    isStandalone,
    enable,
    disable,
    refreshDevices,
  };
}
