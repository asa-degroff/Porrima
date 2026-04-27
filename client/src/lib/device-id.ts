// Per-install device id used to identify a single PWA/browser install for
// push subscriptions and presence tracking. Generated lazily and persisted in
// localStorage so it survives page reloads.

const STORAGE_KEY = "quje-device-id";

export function getOrCreateDeviceId(): string {
  try {
    const existing = localStorage.getItem(STORAGE_KEY);
    if (existing) return existing;
    const fresh = crypto.randomUUID();
    localStorage.setItem(STORAGE_KEY, fresh);
    return fresh;
  } catch {
    // localStorage unavailable (private mode on some platforms). Return a
    // session-only id so the caller can still talk to the server in this
    // session — push subscriptions will be ephemeral.
    return crypto.randomUUID();
  }
}

export function readDeviceId(): string | null {
  try {
    return localStorage.getItem(STORAGE_KEY);
  } catch {
    return null;
  }
}
