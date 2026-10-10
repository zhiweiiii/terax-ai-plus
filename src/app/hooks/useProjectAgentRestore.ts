import { errorToast } from "@/lib/errorToast";
import type { Tab } from "@/modules/tabs";
import { resumeAgentInLeaf } from "@/modules/terminal/lib/useTerminalSession";
import { useSpaces } from "@/modules/spaces/lib/useSpaces";
import { useEffect, useRef } from "react";

export function useProjectAgentRestore(tabs: Tab[], booted: boolean) {
  const latest = useRef(tabs);
  latest.current = tabs;
  const attempted = useRef(new Set<number>());
  const mounted = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  useEffect(() => {
    if (!booted) return;
    for (const tab of tabs) {
      if (
        tab.kind !== "terminal" ||
        !tab.autoResume ||
        !tab.lastAgentSession ||
        attempted.current.has(tab.id)
      )
        continue;
      attempted.current.add(tab.id);
      const workspace = useSpaces
        .getState()
        .spaces.find((space) => space.id === tab.spaceId)?.env;
      if (!workspace) continue;
      const current = () =>
        mounted.current &&
        latest.current.some(
          (item) =>
            item.kind === "terminal" &&
            item.id === tab.id &&
            item.activeLeafId === tab.activeLeafId,
        );
      void resumeAgentInLeaf(
        tab.activeLeafId,
        tab.lastAgentSession,
        workspace,
        current,
      ).catch((error) => {
        if (current()) errorToast(`恢复 ${tab.title} 的 agent 会话失败`, error);
      });
    }
  }, [tabs, booted]);
}
