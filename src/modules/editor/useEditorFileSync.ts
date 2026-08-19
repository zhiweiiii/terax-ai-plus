import { parentDir, watchAdd, watchRemove } from "@/modules/explorer/lib/watch";
import { useAppEvent } from "@/modules/events";
import type { Tab } from "@/modules/tabs";
import { type RefObject, useEffect, useRef } from "react";
import type { EditorPaneHandle } from "./EditorPane";

// Fast enough that an agent's edit shows up while you are still looking at the
// file, slow enough that the stats stay invisible next to everything else.
const POLL_INTERVAL_MS = 1500;

type Params = {
  tabs: Tab[];
  tabsRef: RefObject<Tab[]>;
  editorRefs: RefObject<Map<number, EditorPaneHandle>>;
};

/**
 * Keeps open editor tabs in sync with on-disk changes: reloads on external
 * writes and fs-watch events, and maintains the watch set for the directories
 * of open editor files.
 */
export function useEditorFileSync({ tabs, tabsRef, editorRefs }: Params) {
  useAppEvent("fs:written", (payload) => {
    if (payload.source === "editor") return;
    const normalizedPath = payload.path.replace(/\\/g, "/");
    const currentTabs = tabsRef.current;
    for (const t of currentTabs) {
      if (t.kind !== "editor") continue;
      if (t.path.replace(/\\/g, "/") === normalizedPath) {
        editorRefs.current.get(t.id)?.reload();
      }
    }
  });

  const editorWatchRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    const want = new Set<string>();
    for (const t of tabs) if (t.kind === "editor") want.add(parentDir(t.path));
    const prev = editorWatchRef.current;
    const toAdd = [...want].filter((d) => !prev.has(d));
    const toRemove = [...prev].filter((d) => !want.has(d));
    watchAdd(toAdd);
    watchRemove(toRemove);
    editorWatchRef.current = want;
  }, [tabs]);

  useAppEvent("fs:changed", (payload) => {
    const changed = new Set(payload.paths.map((p) => p.replace(/\\/g, "/")));
    for (const t of tabsRef.current) {
      if (t.kind !== "editor") continue;
      if (changed.has(t.path.replace(/\\/g, "/"))) {
        editorRefs.current.get(t.id)?.reload();
      }
    }
  });

  // Backstop for edits the watch above never reports. It misses whenever
  // fs_watch_add was refused (the directory is outside every authorized
  // workspace root, and both the command and the invoke swallow that), and
  // whenever the tab's path differs in case from the canonical path notify
  // echoes back, since the lookup is an exact string match.
  //
  // Re-reading on window focus and on tab activation covers all of those:
  // an agent editing files in another window is exactly the case where focus
  // returns afterwards. reload() is a no-op while the buffer is dirty and
  // skips the re-render when disk already matches, so this stays cheap.
  // Periodic sweep. The watch above is best-effort and silently misses whole
  // classes of edits: fs_watch_add is refused for any directory outside an
  // authorized workspace root (both the command and the invoke swallow that),
  // and the event lookup is an exact string match, so a tab path whose case
  // differs from the canonical path notify echoes back never matches.
  //
  // revalidate() stats first and only re-reads when the mtime moved, and it
  // returns early while the buffer is dirty, so the steady-state cost is one
  // stat per mounted pane per tick.
  useEffect(() => {
    const timer = setInterval(() => {
      if (document.hidden) return;
      for (const t of tabsRef.current) {
        if (t.kind === "editor") editorRefs.current.get(t.id)?.revalidate();
      }
    }, POLL_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [tabsRef, editorRefs]);
}
