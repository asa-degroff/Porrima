// Per-install device id used to identify a single PWA/browser install for
// push subscriptions and presence tracking. Generated lazily and persisted in
// localStorage so it survives page reloads.
import { readStoredValue, writeStoredValue } from "./storage";

const STORAGE_KEY = "porrima-device-id";
const LEGACY_STORAGE_KEY = "quje-device-id";

export function getOrCreateDeviceId(): string {
  try {
    const existing = readStoredValue(STORAGE_KEY, LEGACY_STORAGE_KEY);
    if (existing) return existing;
    const fresh = crypto.randomUUID();
    writeStoredValue(STORAGE_KEY, fresh, LEGACY_STORAGE_KEY);
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
    return readStoredValue(STORAGE_KEY, LEGACY_STORAGE_KEY);
  } catch {
    return null;
  }
}
