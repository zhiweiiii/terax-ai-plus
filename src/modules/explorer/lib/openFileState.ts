import { scopedWindowTabs } from "@/modules/statusbar/lib/windowTabs";
import type { Tab } from "@/modules/tabs";

export function filePathForTab(tab: Tab): string | null {
  if (tab.kind === "editor" || tab.kind === "markdown") return tab.path;
  if (tab.kind !== "git-diff" && tab.kind !== "git-commit-file") return null;
  return /^([A-Za-z]:|\/|\\)/.test(tab.path)
    ? tab.path
    : `${tab.repoRoot.replace(/[\\/]+$/, "")}/${tab.path.replace(/^[\\/]+/, "")}`;
}

export function explorerFileState(
  tabs: readonly Tab[],
  spaceId: string,
  ownerId: number | null,
  activeId: number,
): { activePath: string | null; openPaths: string[] } {
  const windows = scopedWindowTabs(tabs, spaceId, ownerId);
  const active = windows.find((tab) => tab.id === activeId);
  return {
    activePath: active ? filePathForTab(active) : null,
    openPaths: windows.flatMap((tab) => {
      const path = filePathForTab(tab);
      return path === null ? [] : [path];
    }),
  };
}
