import { pathIdentity } from "@/lib/pathIdentity";
import { useAppEvent } from "@/modules/events";
import { parentDir, watchAdd } from "@/modules/explorer/lib/watch";
import type { MarkdownPreviewPaneHandle } from "@/modules/markdown/MarkdownPreviewPane";
import type { SpaceMeta } from "@/modules/spaces/lib/store";
import type { Tab } from "@/modules/tabs";
import { type WorkspaceEnv, workspaceScopeKey } from "@/modules/workspace";
import { type RefObject, useEffect, useRef } from "react";
import type { EditorPaneHandle } from "./EditorPane";

// Fast enough that an agent's edit shows up while you are still looking at the
// file, slow enough that the stats stay invisible next to everything else.
const POLL_INTERVAL_MS = 1500;

type Params = {
  tabs: Tab[];
  spaces: readonly SpaceMeta[];
  tabsRef: RefObject<Tab[]>;
  editorRefs: RefObject<Map<number, EditorPaneHandle>>;
  markdownRefs: RefObject<Map<number, MarkdownPreviewPaneHandle>>;
};

/**
 * Keeps open editor tabs in sync with on-disk changes: reloads on external
 * writes and fs-watch events, and maintains the watch set for the directories
 * of open editor files.
 */
export function useEditorFileSync({
  tabs,
  spaces,
  tabsRef,
  editorRefs,
  markdownRefs,
}: Params) {
  const handle = (tab: Tab) =>
    tab.kind === "editor"
      ? editorRefs.current.get(tab.id)
      : tab.kind === "markdown"
        ? markdownRefs.current.get(tab.id)
        : undefined;
  useAppEvent("fs:written", (payload) => {
    const normalizedPath = pathIdentity(payload.path);
    const currentTabs = tabsRef.current;
    for (const t of currentTabs) {
      if (t.kind !== "editor" && t.kind !== "markdown") continue;
      if (payload.workspace) {
        const space = spaces.find((item) => item.id === t.spaceId);
        if (
          !space ||
          workspaceScopeKey(space.env) !== workspaceScopeKey(payload.workspace)
        )
          continue;
      }
      if (payload.source === "editor" && t.kind === "editor") continue;
      if (pathIdentity(t.path) === normalizedPath) {
        handle(t)?.reload();
      }
    }
  });

  const editorWatchRef = useRef<Map<string, () => void>>(new Map());
  useEffect(
    () => () => {
      for (const release of editorWatchRef.current.values()) release();
      editorWatchRef.current = new Map();
    },
    [],
  );
  useEffect(() => {
    const want = new Map<string, { dir: string; workspace: WorkspaceEnv }>();
    for (const t of tabs) {
      if ((t.kind !== "editor" && t.kind !== "markdown") || t.cold) continue;
      const space = spaces.find((item) => item.id === t.spaceId);
      if (!space) continue;
      const dir = parentDir(t.path);
      want.set(`${workspaceScopeKey(space.env)}\0${dir}`, {
        dir,
        workspace: space.env,
      });
    }
    const prev = editorWatchRef.current;
    for (const [dir, release] of prev) {
      if (!want.has(dir)) {
        release();
        prev.delete(dir);
      }
    }
    for (const [key, { dir, workspace }] of want) {
      if (!prev.has(key)) prev.set(key, watchAdd([dir], workspace));
    }
  }, [tabs, spaces]);

  useAppEvent("fs:changed", (payload) => {
    const changed = new Set(payload.paths.map(pathIdentity));
    for (const t of tabsRef.current) {
      if (t.kind !== "editor" && t.kind !== "markdown") continue;
      if (payload.workspace) {
        const space = spaces.find((item) => item.id === t.spaceId);
        if (
          !space ||
          workspaceScopeKey(space.env) !== workspaceScopeKey(payload.workspace)
        )
          continue;
      }
      if (payload.rescan) {
        handle(t)?.revalidate();
        continue;
      }
      if (changed.has(pathIdentity(t.path))) {
        handle(t)?.reload();
      }
    }
  });

  // Watches are best-effort outside authorized roots or after native IO failure.
  // Visible panes stat first; dirty buffers never reload automatically.
  useEffect(() => {
    const timer = setInterval(() => {
      if (document.hidden) return;
      for (const t of tabsRef.current) {
        if (t.kind === "editor") editorRefs.current.get(t.id)?.revalidate();
        else if (t.kind === "markdown")
          markdownRefs.current.get(t.id)?.revalidate();
      }
    }, POLL_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [tabsRef, editorRefs, markdownRefs]);
}
