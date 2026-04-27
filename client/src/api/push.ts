import { apiFetch } from "./client";

const BASE = "/api/push";

function pushFetch(path: string, init?: RequestInit): Promise<Response> {
  return apiFetch(`${BASE}${path}`, init);
}

export async function fetchPushPublicKey(): Promise<string> {
  const res = await pushFetch("/public-key");
  if (!res.ok) throw new Error("Failed to fetch push public key");
  const data = await res.json();
  return data.key as string;
}

export interface SerializedSubscription {
  endpoint: string;
  keys: { p256dh: string; auth: string };
}

export async function subscribePush(params: {
  deviceId: string;
  subscription: SerializedSubscription;
  userAgent?: string;
  label?: string;
}): Promise<void> {
  const res = await pushFetch("/subscribe", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(params),
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.error || "Failed to subscribe");
  }
}

export async function unsubscribePush(deviceId: string): Promise<void> {
  const res = await pushFetch("/unsubscribe", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ deviceId }),
  });
  if (!res.ok) throw new Error("Failed to unsubscribe");
}

export async function postPushPresence(deviceId: string, visible: boolean): Promise<void> {
  // Presence is best-effort; never surface errors to the UI. Use raw fetch
  // here (not apiFetch) so a 401 on a stale tab doesn't trigger the global
  // unauthorized handler — if the user's session expired, the next real call
  // will surface that.
  try {
    await fetch(`${BASE}/presence`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ deviceId, visible }),
      keepalive: true,
      credentials: "include",
    });
  } catch {
    // ignore
  }
}

export interface PushDevice {
  deviceId: string;
  userAgent: string | null;
  label: string | null;
  createdAt: string;
  lastSeenAt: string;
}

export async function fetchPushDevices(): Promise<PushDevice[]> {
  const res = await pushFetch("/devices");
  if (!res.ok) throw new Error("Failed to fetch push devices");
  const data = await res.json();
  return data.devices as PushDevice[];
}

export async function sendPushTest(): Promise<{ delivered: number; suppressed: number; expired: number; failed: number }> {
  const res = await pushFetch("/test", { method: "POST" });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.error || "Failed to send test push");
  }
  return res.json();
}
