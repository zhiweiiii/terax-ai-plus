// Non-critical, single-window usage ranking. localStorage keeps it off the
// preferences store and its IPC change-broadcast path.

const KEY = "terax-palette-mru";
const MAX_ENTRIES = 120;
const MAX_STORAGE_CHARS = 64 * 1024;

type MruMap = Record<string, number>;

function read(): MruMap {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw || raw.length > MAX_STORAGE_CHARS) return {};
    const value: unknown = JSON.parse(raw);
    if (!value || typeof value !== "object" || Array.isArray(value)) return {};
    const entries = Object.entries(value)
      .filter((entry): entry is [string, number] => {
        const [id, timestamp] = entry;
        return (
          id.length > 0 &&
          id.length <= 256 &&
          typeof timestamp === "number" &&
          Number.isSafeInteger(timestamp) &&
          timestamp >= 0
        );
      })
      .sort((a, b) => b[1] - a[1])
      .slice(0, MAX_ENTRIES);
    return Object.fromEntries(entries);
  } catch {
    return {};
  }
}

export function recordUse(id: string): void {
  const map = read();
  if (!id || id.length > 256) return;
  Object.defineProperty(map, id, {
    value: Date.now(),
    enumerable: true,
    configurable: true,
  });
  const ids = Object.keys(map);
  if (ids.length > MAX_ENTRIES) {
    for (const k of ids
      .sort((a, b) => map[a] - map[b])
      .slice(0, ids.length - MAX_ENTRIES)) {
      delete map[k];
    }
  }
  try {
    localStorage.setItem(KEY, JSON.stringify(map));
  } catch {
    /* ignore */
  }
}

export function mruSnapshot(): MruMap {
  return read();
}

export function mruRank(snapshot: MruMap, id: string): number {
  return Object.getOwnPropertyDescriptor(snapshot, id)?.value ?? 0;
}
