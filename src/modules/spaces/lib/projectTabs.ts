import type { Tab, TerminalTab } from "@/modules/tabs/lib/useTabs";
import {
  leafIds,
  ptyIdForLeaf,
  useAgentActivityStore,
} from "@/modules/terminal";
import { useMemo } from "react";

export function runningProjectIds(
  tabs: readonly Tab[],
  agents: Readonly<Record<number, string>>,
  ptyForLeaf: (leaf: number) => number | null,
): Set<number> {
  const running = new Set<number>();
  for (const tab of tabs) {
    if (tab.kind !== "terminal" || tab.cold) continue;
    if (
      leafIds(tab.paneTree).some((leaf) => {
        const pty = ptyForLeaf(leaf);
        return pty !== null && Boolean(agents[pty]);
      })
    )
      running.add(tab.id);
  }
  return running;
}

export function useRunningProjects(tabs: readonly Tab[]): Set<number> {
  const agents = useAgentActivityStore((state) => state.agents);
  return useMemo(
    () => runningProjectIds(tabs, agents, ptyIdForLeaf),
    [tabs, agents],
  );
}

export function projectReorderGap(
  tabs: readonly Tab[],
  visible: readonly TerminalTab[],
  fromId: number,
  gap: number,
): number | null {
  const moved = visible.find((tab) => tab.id === fromId);
  if (!moved || !Number.isInteger(gap) || gap < 0 || gap > visible.length)
    return null;
  const anchor = visible[gap] ?? visible[visible.length - 1];
  if (!anchor) return null;
  const index = tabs.findIndex((tab) => tab.id === anchor.id);
  return index < 0 ? null : index + (gap === visible.length ? 1 : 0);
}
