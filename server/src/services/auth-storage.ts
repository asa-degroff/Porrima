import { chmod, readFile, writeFile, mkdir, unlink } from "fs/promises";
import { join } from "path";
import { createHash, randomBytes, timingSafeEqual } from "crypto";
import { APP_DATA_DIR } from "./paths.js";

const BASE_DIR = APP_DATA_DIR;
const AUTH_DIR = join(BASE_DIR, "auth");
const CREDENTIALS_FILE = join(AUTH_DIR, "credentials.json");
const SECRET_FILE = join(AUTH_DIR, "session-secret.txt");
const SETUP_TOKEN_FILE = join(AUTH_DIR, "setup-token.txt");

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

async function ensureAuthDir() {
  await mkdir(AUTH_DIR, { recursive: true });
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
  await writeFile(SECRET_FILE, secret);
  return secret;
}

function hashToken(token: string): Buffer {
  return createHash("sha256").update(token).digest();
}

export function getSetupTokenFilePath(): string {
  return SETUP_TOKEN_FILE;
}

export async function getOrCreateSetupToken(): Promise<string> {
  await ensureAuthDir();
  try {
    const existing = (await readFile(SETUP_TOKEN_FILE, "utf-8")).trim();
    if (existing) return existing;
  } catch {
    // file doesn't exist yet
  }

  const token = randomBytes(24).toString("base64url");
  await writeFile(SETUP_TOKEN_FILE, `${token}\n`, { mode: 0o600 });
  try {
    await chmod(SETUP_TOKEN_FILE, 0o600);
  } catch {
    // Non-fatal; writeFile(mode) is best-effort across platforms/filesystems.
  }
  console.warn(`[auth] First-run setup token written to ${SETUP_TOKEN_FILE}`);
  return token;
}

export async function ensureSetupTokenForFirstRun(): Promise<void> {
  if (!(await isSetupComplete())) {
    await getOrCreateSetupToken();
  }
}

export async function verifySetupToken(token: unknown): Promise<boolean> {
  if (typeof token !== "string") return false;
  const normalized = token.trim();
  if (!normalized) return false;

  const expected = await getOrCreateSetupToken();
  return timingSafeEqual(hashToken(normalized), hashToken(expected));
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
  await writeFile(CREDENTIALS_FILE, JSON.stringify(store, null, 2));
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
