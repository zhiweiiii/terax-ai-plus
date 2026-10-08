export function pathIdentity(path: string): string {
  const slashed = path.replace(/\\/g, "/");
  const normalized = slashed === "/" ? slashed : slashed.replace(/\/+$/, "");
  return /^[A-Za-z]:(?:\/|$)/.test(normalized) || normalized.startsWith("//")
    ? normalized.toLowerCase()
    : normalized;
}
