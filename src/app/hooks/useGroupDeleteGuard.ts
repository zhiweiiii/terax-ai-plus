import {
  type RefObject,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import { useSpaces } from "@/modules/spaces";
import type { Tab } from "@/modules/tabs";
import { leafHasForegroundProcess, leafIds } from "@/modules/terminal";

export type GroupDeleteBlocker = { id: string; name: string };

export function useGroupDeleteGuard(
  tabsRef: RefObject<Tab[]>,
  onDelete: (id: string) => void,
) {
  const [pendingGroupDelete, setPendingGroupDelete] =
    useState<GroupDeleteBlocker | null>(null);
  const epoch = useRef(0);
  const mounted = useRef(false);
  const deleteRef = useRef(onDelete);
  deleteRef.current = onDelete;
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      epoch.current++;
    };
  }, []);

  const requestGroupDelete = useCallback(
    async (id: string) => {
      const request = ++epoch.current;
      setPendingGroupDelete(null);
      const initial = tabsRef.current.filter((tab) => tab.spaceId === id);
      const leaves = initial.flatMap((tab) =>
        tab.kind === "terminal" ? leafIds(tab.paneTree) : [],
      );
      const checks = await Promise.all(
        leaves.map((leaf) => leafHasForegroundProcess(leaf).catch(() => true)),
      );
      if (!mounted.current || request !== epoch.current) return;
      const spaces = useSpaces.getState().spaces;
      const space = spaces.find((item) => item.id === id);
      if (!space || spaces.length <= 1) return;
      const current = tabsRef.current.filter((tab) => tab.spaceId === id);
      const changed =
        current.length !== initial.length ||
        current.some((tab, i) => tab !== initial[i]);
      if (
        changed ||
        checks.some(Boolean) ||
        current.some((tab) => tab.kind === "editor" && tab.dirty)
      ) {
        setPendingGroupDelete({ id, name: space.name });
      } else deleteRef.current(id);
    },
    [tabsRef],
  );

  const cancelGroupDelete = useCallback(() => {
    epoch.current++;
    setPendingGroupDelete(null);
  }, []);
  const confirmGroupDelete = useCallback(() => {
    if (pendingGroupDelete) deleteRef.current(pendingGroupDelete.id);
    cancelGroupDelete();
  }, [pendingGroupDelete, cancelGroupDelete]);
  return {
    pendingGroupDelete,
    requestGroupDelete,
    cancelGroupDelete,
    confirmGroupDelete,
  };
}
