export function readStoredValue(key: string, legacyKey?: string): string | null {
  const value = localStorage.getItem(key);
  if (value !== null || !legacyKey) return value;
  const legacyValue = localStorage.getItem(legacyKey);
  if (legacyValue !== null) {
    localStorage.setItem(key, legacyValue);
  }
  return legacyValue;
}

export function writeStoredValue(key: string, value: string, legacyKey?: string): void {
  localStorage.setItem(key, value);
  if (legacyKey) localStorage.removeItem(legacyKey);
}

export function removeStoredValue(key: string, legacyKey?: string): void {
  localStorage.removeItem(key);
  if (legacyKey) localStorage.removeItem(legacyKey);
}
