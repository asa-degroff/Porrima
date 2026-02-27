import { readFile, writeFile, mkdir } from "fs/promises";
import { join } from "path";
import { homedir } from "os";
import { randomBytes } from "crypto";

const BASE_DIR = join(homedir(), ".quje-agent");
const AUTH_DIR = join(BASE_DIR, "auth");
const CREDENTIALS_FILE = join(AUTH_DIR, "credentials.json");
const SECRET_FILE = join(AUTH_DIR, "session-secret.txt");

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
