import { chmod, readFile, writeFile, mkdir, unlink } from "fs/promises";
import { join } from "path";
import { createHash, randomBytes, timingSafeEqual } from "crypto";
import { APP_DATA_DIR } from "./paths.js";

const BASE_DIR = APP_DATA_DIR;
const AUTH_DIR = join(BASE_DIR, "auth");
const CREDENTIALS_FILE = join(AUTH_DIR, "credentials.json");
const SECRET_FILE = join(AUTH_DIR, "session-secret.txt");
const SETUP_TOKEN_FILE = join(AUTH_DIR, "setup-token.txt");
export const SETUP_TOKEN_TTL_MS = 30 * 60 * 1000;
export const SETUP_TOKEN_MAX_FAILED_ATTEMPTS = 10;
/** A locked token unlocks again after this cooldown. A permanent lock let an
 *  unauthenticated caller deny first-run setup until the service restarted. */
export const SETUP_TOKEN_LOCK_MS = 15 * 60 * 1000;
const SETUP_TOKEN_STATE_VERSION = 1;

export interface StoredCredential {
  id: string;
  publicKey: string;
  counter: number;
  transports?: string[];
  createdAt: string;
}

interface AuthStore {
  ownerId: string;
  credentials: StoredCredential[];
}

interface SetupTokenState {
  version: typeof SETUP_TOKEN_STATE_VERSION;
  tokenSha256: string;
  createdAt: string;
  expiresAt: string;
  failedAttempts: number;
  maxFailedAttempts: number;
  lockedAt?: string;
  /** Session that successfully presented the token. Bound so the token is
   *  single-use across clients while allowing the same browser to retry a
   *  failed WebAuthn ceremony. */
  consumedBy?: string;
  consumedAt?: string;
}

type SetupTokenFile =
  | { kind: "missing" }
  | { kind: "state"; state: SetupTokenState }
  | { kind: "invalid" };

async function ensureAuthDir() {
  await mkdir(AUTH_DIR, { recursive: true, mode: 0o700 });
  try {
    await chmod(AUTH_DIR, 0o700);
  } catch {
    // Best effort: some filesystems do not support chmod.
  }
}

export async function getSessionSecret(): Promise<string> {
  await ensureAuthDir();
  try {
    const secret = await readFile(SECRET_FILE, "utf-8");
    if (secret.trim()) return secret.trim();
  } catch {
    // file doesn't exist yet
  }
  const secret = randomBytes(64).toString("hex");
  await writeFile(SECRET_FILE, secret, { mode: 0o600 });
  try {
    await chmod(SECRET_FILE, 0o600);
  } catch {
    // Best effort.
  }
  return secret;
}

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function isSha256Hex(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/i.test(value);
}

function parseIsoTime(value: string): number {
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : Number.NaN;
}

function parseSetupTokenState(raw: string): SetupTokenState | null {
  try {
    const parsed = JSON.parse(raw) as Partial<SetupTokenState>;
    if (parsed.version !== SETUP_TOKEN_STATE_VERSION) return null;
    if (!isSha256Hex(parsed.tokenSha256)) return null;
    if (typeof parsed.createdAt !== "string") return null;
    if (typeof parsed.expiresAt !== "string") return null;
    if (!Number.isFinite(parseIsoTime(parsed.createdAt))) return null;
    if (!Number.isFinite(parseIsoTime(parsed.expiresAt))) return null;
    const failedAttempts = parsed.failedAttempts;
    const maxFailedAttempts = parsed.maxFailedAttempts;
    if (
      typeof failedAttempts !== "number" ||
      !Number.isInteger(failedAttempts) ||
      failedAttempts < 0
    ) {
      return null;
    }
    if (
      typeof maxFailedAttempts !== "number" ||
      !Number.isInteger(maxFailedAttempts) ||
      maxFailedAttempts < 1
    ) {
      return null;
    }
    if (
      parsed.lockedAt !== undefined &&
      (typeof parsed.lockedAt !== "string" ||
        !Number.isFinite(parseIsoTime(parsed.lockedAt)))
    ) {
      return null;
    }
    if (parsed.consumedBy !== undefined && typeof parsed.consumedBy !== "string") {
      return null;
    }
    if (
      parsed.consumedAt !== undefined &&
      (typeof parsed.consumedAt !== "string" ||
        !Number.isFinite(parseIsoTime(parsed.consumedAt)))
    ) {
      return null;
    }
    return {
      version: SETUP_TOKEN_STATE_VERSION,
      tokenSha256: parsed.tokenSha256.toLowerCase(),
      createdAt: parsed.createdAt,
      expiresAt: parsed.expiresAt,
      failedAttempts,
      maxFailedAttempts,
      lockedAt: parsed.lockedAt,
      consumedBy: parsed.consumedBy,
      consumedAt: parsed.consumedAt,
    };
  } catch {
    return null;
  }
}

async function readSetupTokenFile(): Promise<SetupTokenFile> {
  try {
    const raw = (await readFile(SETUP_TOKEN_FILE, "utf-8")).trim();
    if (!raw) return { kind: "invalid" };
    const state = parseSetupTokenState(raw);
    return state ? { kind: "state", state } : { kind: "invalid" };
  } catch (err: any) {
    if (err?.code === "ENOENT") return { kind: "missing" };
    return { kind: "invalid" };
  }
}

function createSetupTokenState(token: string, now = Date.now()): SetupTokenState {
  return {
    version: SETUP_TOKEN_STATE_VERSION,
    tokenSha256: hashToken(token),
    createdAt: new Date(now).toISOString(),
    expiresAt: new Date(now + SETUP_TOKEN_TTL_MS).toISOString(),
    failedAttempts: 0,
    maxFailedAttempts: SETUP_TOKEN_MAX_FAILED_ATTEMPTS,
  };
}

function isSetupTokenStateActive(state: SetupTokenState, now = Date.now()): boolean {
  if (parseIsoTime(state.expiresAt) <= now) return false;
  if (state.lockedAt) {
    const lockedAt = parseIsoTime(state.lockedAt);
    // Locked tokens recover after the cooldown instead of requiring a restart.
    return Number.isFinite(lockedAt) && now - lockedAt >= SETUP_TOKEN_LOCK_MS;
  }
  return state.failedAttempts < state.maxFailedAttempts;
}

async function writeSetupTokenState(state: SetupTokenState): Promise<void> {
  await ensureAuthDir();
  await writeFile(SETUP_TOKEN_FILE, `${JSON.stringify(state, null, 2)}\n`, {
    mode: 0o600,
  });
  try {
    await chmod(SETUP_TOKEN_FILE, 0o600);
  } catch {
    // Non-fatal; writeFile(mode) is best-effort across platforms/filesystems.
  }
}

function setupTokenBuffersMatch(token: string, tokenSha256: string): boolean {
  const actual = Buffer.from(hashToken(token), "hex");
  const expected = Buffer.from(tokenSha256, "hex");
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

export function getSetupTokenFilePath(): string {
  return SETUP_TOKEN_FILE;
}

export async function getOrCreateSetupToken(
  options: { rotateExpired?: boolean } = {}
): Promise<string | null> {
  await ensureAuthDir();
  const rotateExpired = options.rotateExpired ?? true;
  const current = await readSetupTokenFile();
  if (current.kind === "state") {
    const active = isSetupTokenStateActive(current.state);
    if (active || !rotateExpired) return null;
  }

  const token = randomBytes(24).toString("base64url");
  const state = createSetupTokenState(token);
  await writeSetupTokenState(state);
  console.log(`[auth] First-run setup token: ${token}`);
  console.log(
    `[auth] Setup token SHA-256 state stored at ${SETUP_TOKEN_FILE}; expires at ${state.expiresAt}; locks after ${state.maxFailedAttempts} failed attempts`
  );
  return token;
}

export async function ensureSetupTokenForFirstRun(
  options: { rotateExpired?: boolean } = {}
): Promise<void> {
  if (!(await isSetupComplete())) {
    await releaseConsumedSetupToken();
    await getOrCreateSetupToken(options);
  } else {
    await clearSetupToken();
  }
}

export async function verifySetupToken(token: unknown, sessionId?: string): Promise<boolean> {
  const normalized = typeof token === "string" ? token.trim() : "";
  if (await isSetupComplete()) {
    await clearSetupToken();
    return false;
  }

  const current = await readSetupTokenFile();
  if (current.kind !== "state") return false;
  if (!isSetupTokenStateActive(current.state)) return false;

  // Once a session has presented the token, only that session may continue
  // (a failed WebAuthn ceremony can retry without re-entering it). A different
  // client holding a leaked token is rejected without incrementing the lock
  // counter, so it cannot grief the legitimate session.
  if (current.state.consumedBy) {
    return Boolean(sessionId) && current.state.consumedBy === sessionId;
  }

  if (!normalized) return false;

  if (setupTokenBuffersMatch(normalized, current.state.tokenSha256)) {
    if (sessionId) {
      await writeSetupTokenState({
        ...current.state,
        consumedBy: sessionId,
        consumedAt: new Date().toISOString(),
      });
    }
    return true;
  }

  const failedAttempts = current.state.failedAttempts + 1;
  const nextState: SetupTokenState = {
    ...current.state,
    failedAttempts,
    lockedAt:
      failedAttempts >= current.state.maxFailedAttempts
        ? new Date().toISOString()
        : current.state.lockedAt,
  };
  await writeSetupTokenState(nextState);
  return false;
}

/** A process restart loses the in-memory session store, so a token consumed by
 *  a now-gone session is re-armed on boot rather than bricking first-run setup
 *  until the 30-minute TTL expires. */
export async function releaseConsumedSetupToken(): Promise<void> {
  const current = await readSetupTokenFile();
  if (current.kind !== "state" || !current.state.consumedBy) return;
  const { consumedBy: _consumedBy, consumedAt: _consumedAt, ...remaining } = current.state;
  await writeSetupTokenState(remaining);
}

export async function clearSetupToken(): Promise<void> {
  try {
    await unlink(SETUP_TOKEN_FILE);
  } catch {
    // Already removed or never created.
  }
}

export async function loadAuthStore(): Promise<AuthStore> {
  await ensureAuthDir();
  try {
    const data = await readFile(CREDENTIALS_FILE, "utf-8");
    return JSON.parse(data) as AuthStore;
  } catch {
    return { ownerId: "", credentials: [] };
  }
}

async function saveAuthStore(store: AuthStore): Promise<void> {
  await ensureAuthDir();
  await writeFile(CREDENTIALS_FILE, JSON.stringify(store, null, 2), { mode: 0o600 });
  try {
    await chmod(CREDENTIALS_FILE, 0o600);
  } catch {
    // Best effort.
  }
}

export async function isSetupComplete(): Promise<boolean> {
  const store = await loadAuthStore();
  return store.credentials.length > 0;
}

export async function addCredential(
  ownerId: string,
  credential: StoredCredential
): Promise<void> {
  const store = await loadAuthStore();
  if (!store.ownerId) {
    store.ownerId = ownerId;
  }
  store.credentials.push(credential);
  await saveAuthStore(store);
}

export async function getCredentialById(
  id: string
): Promise<StoredCredential | undefined> {
  const store = await loadAuthStore();
  return store.credentials.find((c) => c.id === id);
}

export async function updateCredentialCounter(
  id: string,
  newCounter: number
): Promise<void> {
  const store = await loadAuthStore();
  const cred = store.credentials.find((c) => c.id === id);
  if (cred) {
    cred.counter = newCounter;
    await saveAuthStore(store);
  }
}
