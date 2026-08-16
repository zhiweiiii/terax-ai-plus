import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { useEffect } from "react";
import { leafIds, ptyIdForLeaf } from "@/modules/terminal";
import { useSpaces } from "@/modules/spaces";
import type { Tab } from "@/modules/tabs";

type WebTab = {
  leaf_id: number;
  cwd: string | null;
  title: string | null;
  active: boolean;
  pty_id: number | null;
  space_id: string | null;
};

type Params = {
  /** All terminal tabs, in the desktop's tab order. */
  terminalTabs: Tab[];
  activeId: number;
  /** Open a tab by id (activates it, which spawns the pty if cold). */
  activateTab: (id: number) => void;
};

/**
 * Keeps the Rust web-terminal layer in sync with the desktop's command-line
 * tabs so the phone can list and attach to every terminal, including ones the
 * desktop has never opened yet. Also handles "activate this leaf" requests
 * coming from the web page.
 */
export function useWebTerminalSync({
  terminalTabs,
  activeId,
  activateTab,
}: Params) {
  const spaces = useSpaces((s) => s.spaces);

  useEffect(() => {
    const spaceName = new Map(spaces.map((sp) => [sp.id, sp.name]));
    const tabs: WebTab[] = [];
    for (const tab of terminalTabs) {
      if (tab.kind !== "terminal") continue;
      for (const leafId of leafIds(tab.paneTree)) {
        const ptyId = ptyIdForLeaf(leafId);
        const space = spaceName.get(tab.spaceId);
        tabs.push({
          leaf_id: leafId,
          cwd: tab.cwd ?? null,
          title: tab.customTitle ?? tab.title ?? null,
          active: tab.id === activeId,
          pty_id: ptyId,
          space_id: space ?? tab.spaceId,
        });
      }
    }
    void invoke("web_sync_tabs", { tabs }).catch((e) => {
      console.warn("web_sync_tabs failed:", e);
    });
  }, [terminalTabs, activeId, spaces]);

  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let disposed = false;
    (async () => {
      const off = await listen<number>("terax:web-activate", (e) => {
        const leafId = e.payload;
        const tab = terminalTabs.find(
          (t) => t.kind === "terminal" && leafIds(t.paneTree).includes(leafId),
        );
        if (tab) activateTab(tab.id);
      });
      if (disposed) off();
      else unlisten = off;
    })();
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [terminalTabs, activateTab]);
}
