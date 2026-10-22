import { resolve, sep } from "path";

/**
 * True for a single, literal path segment: no separators, no traversal,
 * no NUL, not empty, not "." or "..".
 *
 * IDs, version numbers, and history filenames that arrive from HTTP params,
 * request bodies, or tool arguments must pass this before being joined onto a
 * storage root. Express 5 percent-decodes route params, so `..%2F..` reaches
 * handlers as `../..` — checking the decoded value is the only reliable gate.
 */
export function isSafePathSegment(value: unknown): value is string {
  if (typeof value !== "string") return false;
  if (value.length === 0 || value.length > 255) return false;
  if (value === "." || value === "..") return false;
  if (value.includes("/") || value.includes("\\") || value.includes("\0")) return false;
  return true;
}

/** Throwing form for internal call sites (services that should never see an id
 *  from an unvalidated request). */
export function assertSafePathSegment(value: unknown, label: string): asserts value is string {
  if (!isSafePathSegment(value)) {
    throw new Error(`Invalid ${label}`);
  }
}

/**
 * Resolve `segments` beneath `root`, or null when any segment is unsafe or the
 * resolved path escapes the root.
 *
 * Containment is checked on the resolved absolute path with a separator
 * boundary, so a sibling such as `<root>-backup` cannot satisfy the check the
 * way a raw `startsWith(root)` would.
 */
export function resolveWithin(root: string, ...segments: string[]): string | null {
  if (!segments.every(isSafePathSegment)) return null;
  const base = resolve(root);
  const target = resolve(base, ...segments);
  if (target === base) return target;
  return target.startsWith(base + sep) ? target : null;
}

/** Version numbers are non-negative integers in every on-disk artifact layout. */
export function isNumericVersion(value: unknown): value is string {
  return typeof value === "string" && /^\d+$/.test(value);
}