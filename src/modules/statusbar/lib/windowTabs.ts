import type { Tab } from "@/modules/tabs";

export type WindowTab = Exclude<Tab, { kind: "terminal" }>;

export function canEvictWindow(
  tab: Tab,
  tabs: readonly Tab[],
  activeId: number,
  spaceId: string,
  ownerId: number | null,
): boolean {
  const windows = scopedWindowTabs(tabs, spaceId, ownerId);
  return (
    windows.some((entry) => entry.id === tab.id) &&
    tab.id !== activeId &&
    tab.id !== windows[windows.length - 1]?.id &&
    !(tab.kind === "editor" && tab.dirty)
  );
}

export function scopedWindowTabs(
  tabs: readonly Tab[],
  spaceId: string,
  ownerId: number | null,
): WindowTab[] {
  return tabs
    .filter(
      (tab): tab is WindowTab =>
        tab.kind !== "terminal" &&
        tab.spaceId === spaceId &&
        (ownerId === null
          ? tab.ownerTabId === undefined
          : tab.ownerTabId === ownerId),
    )
    .sort((a, b) => a.id - b.id);
}

export function overflowWindowIds(
  tabs: readonly WindowTab[],
  capacity: number,
  activeId: number,
): number[] {
  let remaining = tabs.length - Math.max(1, capacity);
  const newest = tabs[tabs.length - 1]?.id;
  const evicted: number[] = [];
  for (const tab of tabs) {
    if (remaining <= 0) break;
    if (
      tab.id === activeId ||
      tab.id === newest ||
      (tab.kind === "editor" && tab.dirty)
    )
      continue;
    evicted.push(tab.id);
    remaining--;
  }
  return evicted;
}
