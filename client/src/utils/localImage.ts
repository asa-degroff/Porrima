const LOCAL_IMAGE_API_PATH = "/api/local-images";

/**
 * Map a markdown image src that points at the server's own filesystem into the
 * on-demand `/api/local-images` route. The server serves these straight from
 * disk (allowed roots + magic-byte image check) rather than persisting a copy,
 * so scratch renders keep working only while the file exists.
 *
 * Returns undefined for everything that is already browser-resolvable or not
 * a local path: http(s), data:, blob:, protocol-relative, relative paths, and
 * app API URLs.
 */
export function toLocalImageApiSrc(src?: string): string | undefined {
  if (!src) return undefined;
  const value = src.trim();
  if (!value || value.startsWith("data:") || value.startsWith("blob:")) return undefined;
  if (value.startsWith("//")) return undefined;
  if (/^https?:/i.test(value)) return undefined;
  if (value.startsWith("/api/")) return undefined;

  let path: string;
  if (/^file:/i.test(value)) {
    let url: URL;
    try {
      url = new URL(value);
    } catch {
      return undefined;
    }
    if (url.host && url.host !== "localhost") return undefined;
    try {
      path = decodeURIComponent(url.pathname);
    } catch {
      return undefined;
    }
  } else if (value === "~" || value.startsWith("~/") || value.startsWith("/")) {
    path = value;
  } else {
    return undefined;
  }

  return `${LOCAL_IMAGE_API_PATH}?path=${encodeURIComponent(path)}`;
}
