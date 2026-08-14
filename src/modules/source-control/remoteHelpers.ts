/** What a push should do with tags. */
export type PushTagsMode = "none" | "current" | "all";

/**
 * The remote half of an upstream ref like "origin/main" or "upstream/feature/x".
 * Returns the whole string when there is no slash (defensive; upstreams are
 * always "remote/branch" but a bare name should not collapse to nothing).
 */
export function parseUpstreamRemote(
  upstream: string | null | undefined,
): string | null {
  if (!upstream) return null;
  const slash = upstream.indexOf("/");
  if (slash <= 0) return upstream;
  return upstream.slice(0, slash);
}

/**
 * True when a push failure means the remote refused the refs: the common
 * "! [rejected] ... (non-fast-forward)" shape as well as the modern
 * "Updates were rejected because the remote contains work that you do not have
 * locally." Force is a meaningful retry only for these.
 */
export function isRejectedPushError(error: string): boolean {
  return /rejected|non-fast-forward/i.test(error);
}

/** Maps the dialog's three-way tag choice onto the native optional value. */
export function pushTagsValue(
  tags: PushTagsMode,
): "current" | "all" | undefined {
  return tags === "none" ? undefined : tags;
}
