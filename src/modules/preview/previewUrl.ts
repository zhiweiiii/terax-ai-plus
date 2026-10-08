const MAX_URL_LENGTH = 8192;
const INTERNAL_HOSTS = new Set(["tauri.localhost", "asset.localhost"]);

export function normalizePreviewUrl(raw: string): string | null {
  const value = raw.trim();
  if (!value || value.length > MAX_URL_LENGTH || /[\x00-\x1f\x7f]/.test(value))
    return null;
  let candidate = value;
  if (!/^https?:\/\//i.test(candidate)) {
    if (
      /^(localhost|\d{1,3}(?:\.\d{1,3}){3}|\[[\da-f:]+\])(?::\d+)?(?:[/?#]|$)/i.test(
        value,
      ) ||
      /^[\w.-]+:\d+(?:[/?#]|$)/.test(value)
    )
      candidate = `http://${value}`;
    else if (/^[\w.-]+\.[a-z]{2,}(?:[/:?#]|$)/i.test(value))
      candidate = `https://${value}`;
    else return null;
  }
  try {
    const url = new URL(candidate);
    const host = url.hostname.replace(/\.$/, "");
    if (
      (url.protocol !== "http:" && url.protocol !== "https:") ||
      !host ||
      INTERNAL_HOSTS.has(host) ||
      url.username ||
      url.password
    )
      return null;
    if (typeof window !== "undefined" && url.origin === window.location.origin)
      return null;
    return url.href;
  } catch {
    return null;
  }
}
