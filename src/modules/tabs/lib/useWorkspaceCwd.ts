import { useCallback, useEffect, useMemo, useRef } from "react";
import type { Tab } from "./useTabs";

type Result = {
  /** The terminal tab whose cwd the side panels follow; null when none. */
  currentTerminalTab: Extract<Tab, { kind: "terminal" }> | null;
  /** Root for the file explorer / source control, tied to the current command line. */
  explorerRoot: string | null;
  inheritedCwdForNewTab: () => string | undefined;
};

export function useWorkspaceCwd(
  activeTab: Tab | undefined,
  tabs: Tab[],
  home: string | null,
): Result {
  const lastTerminalCwd = useRef<string | null>(null);
  const lastTerminalBySpaceRef = useRef<Map<string, number>>(new Map());

  useEffect(() => {
    if (activeTab?.kind === "terminal" && activeTab.cwd) {
      lastTerminalCwd.current = activeTab.cwd;
      lastTerminalBySpaceRef.current.set(activeTab.spaceId, activeTab.id);
    }
  }, [activeTab]);

  // The command line the side panels follow: the active terminal itself, the
  // owner of the active file tab, or the last-focused terminal of the space.
  const currentTerminalTab = useMemo(() => {
    const t = tabs.find((x) => x.id === activeTab?.id);
    if (t?.kind === "terminal") return t;
    if (
      t &&
      (t.kind === "editor" ||
        t.kind === "markdown" ||
        t.kind === "git-diff") &&
      t.ownerTabId !== undefined
    ) {
      const owner = tabs.find((x) => x.id === t.ownerTabId);
      if (owner?.kind === "terminal") return owner;
    }
    const remembered = lastTerminalBySpaceRef.current.get(t?.spaceId ?? "");
    const candidates = tabs.filter(
      (x) =>
        x.kind === "terminal" &&
        x.spaceId === (t?.spaceId ?? ""),
    );
    const hit =
      candidates.find((x) => x.id === remembered) ??
      candidates[candidates.length - 1] ??
      null;
    return (hit as Extract<Tab, { kind: "terminal" }> | undefined) ?? null;
  }, [tabs, activeTab]);

  const explorerRoot = useMemo<string | null>(() => {
    if (currentTerminalTab?.cwd) return currentTerminalTab.cwd;
    if (lastTerminalCwd.current) return lastTerminalCwd.current;
    return home;
  }, [currentTerminalTab, home]);

  const inheritedCwdForNewTab = useCallback((): string | undefined => {
    if (currentTerminalTab?.cwd) return currentTerminalTab.cwd;
    return lastTerminalCwd.current ?? home ?? undefined;
  }, [currentTerminalTab, home]);

  return { currentTerminalTab, explorerRoot, inheritedCwdForNewTab };
}
