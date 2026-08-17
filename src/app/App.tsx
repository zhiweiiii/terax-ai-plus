import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from "@/components/ui/resizable";
import { Toaster } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import {
  consumeLaunchCommand,
  consumeLaunchFiles,
  getLaunchDir,
} from "@/lib/launchDir";
import { quoteShellArg } from "@/lib/shellQuote";
import { useZoom } from "@/lib/useZoom";
import { isMarkdownPath } from "@/lib/utils";
import { native } from "@/lib/native";
import { CommandPalette, createCommandItems } from "@/modules/command-palette";
import { useControlBridge } from "@/modules/control";
import {
  type EditorPaneHandle,
  NewEditorDialog,
  useApplyEditorFontSize,
  useEditorFileSync,
} from "@/modules/editor";
import { FileExplorer, type FileExplorerHandle } from "@/modules/explorer";
import {
  Header,
  type SearchInlineHandle,
} from "@/modules/header";
import { setLspNavigator } from "@/modules/lsp";
import type { PreviewPaneHandle } from "@/modules/preview";
import { openSettingsWindow } from "@/modules/settings/openSettingsWindow";
import { usePreferencesStore } from "@/modules/settings/preferences";
import {
  type ShortcutHandlers,
  type ShortcutId,
  shouldDisablePaneSwapShortcut,
  useGlobalShortcuts,
} from "@/modules/shortcuts";
import type { SidebarViewId } from "@/modules/sidebar";
import {
  OpenFilesPanel,
  SIDEBAR_MAX_WIDTH,
  SIDEBAR_MIN_WIDTH,
  useSidebarPanel,
} from "@/modules/sidebar";
import {
  CloneRepositoryDialog,
  RemoteManagerDialog,
  RepoBranchSelector,
  SourceControlPanel,
  useRepositoryTargeting,
  useSourceControlContext,
} from "@/modules/source-control";
import { FileHistoryDialog } from "@/modules/git-history";
import {
  GroupSwitcher,
  useSpacePersistence,
  useSpaces,
  useSpacesBoot,
} from "@/modules/spaces";
import { StatusBar } from "@/modules/statusbar";
import {
  TabSwitcherHud,
  useTabSwitcher,
  useTabs,
  useWindowTitle,
  useWorkspaceCwd,
} from "@/modules/tabs";
import { DEFAULT_SPACE_ID } from "@/modules/tabs/lib/useTabs";
import {
  clearFocusedTerminal,
  disposeSession,
  findLeafCwd,
  hasLeaf,
  leafCwd,
  leafIds,
  navigateFocusedBlocks,
  type PaneBounds,
  pasteToLeaf,
  ptyIdForLeaf,
  type TerminalPaneHandle,
  useAgentActivityStore,
  useTerminalFileDrop,
  whenSessionReady,
  writeToSession,
} from "@/modules/terminal";
import { ThemeProvider, useThemeFileEditing } from "@/modules/theme";
import { UpdaterDialog } from "@/modules/updater";
import {
  useWorkspaceEnvStore,
  type WorkspaceEnv,
  workspaceScopeKey,
} from "@/modules/workspace";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { toast } from "sonner";
import { CloseDialogs } from "./components/CloseDialogs";
import { SelectionAskButton } from "./components/SelectionAskButton";
import {
  TOGGLE_BLOCK_INPUT_EVENT,
  WorkspaceInputBar,
} from "./components/WorkspaceInputBar";
import { WorkspaceSurface } from "./components/WorkspaceSurface";
import { useSelectionAsk } from "./components/useSelectionAsk";
import { useAppCloseGuard } from "./hooks/useAppCloseGuard";
import { useWebTerminalSync } from "./hooks/useWebTerminalSync";

function HeaderTabs({
  active,
  sourceControlChanged,
  onSelect,
}: {
  active: SidebarViewId | null;
  sourceControlChanged: number;
  onSelect: (id: SidebarViewId) => void;
}) {
  const tabs: { id: SidebarViewId; label: string; badge?: number }[] = [
    { id: "explorer", label: "文件" },
    {
      id: "source-control",
      label: "版本",
      badge: sourceControlChanged,
    },
    { id: "open-files", label: "窗口" },
  ];
  return (
    <>
      {tabs.map((t) => (
        <button
          key={t.id}
          type="button"
          onClick={() => onSelect(t.id)}
          className={
            active === t.id
              ? "rounded-md bg-foreground/[0.08] px-1.5 py-0.5 text-[10.5px] font-medium text-foreground"
              : "rounded-md px-1.5 py-0.5 text-[10.5px] text-muted-foreground hover:bg-foreground/[0.04] hover:text-foreground"
          }
        >
          {t.label}
          {t.badge && t.badge > 0 ? (
            <span className="ml-1 inline-flex h-3.5 min-w-3.5 items-center justify-center rounded-full bg-primary px-1 text-[8px] font-bold leading-none text-primary-foreground">
              {t.badge > 99 ? "99+" : t.badge}
            </span>
          ) : null}
        </button>
      ))}
    </>
  );
}

import { useTabCloseGuards } from "./hooks/useTabCloseGuards";
import { useWorkspaceSwitcher } from "./hooks/useWorkspaceSwitcher";

export default function App() {
  const {
    tabs,
    activeId,
    setActiveId,
    allocId,
    booted,
    replaceTabs,
    reorderTabByGap,
    removeTabsForSpace,
    markBooted,
    setActiveSpaceForNewTabs,
    newTab,
    newBlockTab,
    newCommandTab,
    newPrivateTab,
    openFileTab,
    pinTab,
    newPreviewTab,
    newMarkdownTab,
    setMarkdownView,
    setOverrideLanguage,
    openGitDiffTab,
    openCommitHistoryTab,
    openCommitFileDiffTab,
    closeTab,
    updateTab,
    selectByIndex,
    setLeafCwd,
    focusPane,
    focusNextPaneInTab,
    swapActivePaneInDirection,
    splitActivePane,
    closeActivePane,
    closePaneByLeaf,
    resetWorkspace,
  } = useTabs(getLaunchDir() ? { cwd: getLaunchDir() } : undefined);

  // Mirror `tabs` into a ref so callbacks scheduled with `setTimeout`
  // (e.g. cdInNewTab) read the latest pane state instead of a stale closure.
  const tabsRef = useRef(tabs);
  const activeIdRef = useRef(activeId);

  const activeTerminalTab = useMemo(() => {
    const t = tabs.find((x) => x.id === activeId);
    return t && t.kind === "terminal" ? t : null;
  }, [tabs, activeId]);
  const activeLeafId = activeTerminalTab?.activeLeafId ?? null;

  const searchInlineRef = useRef<SearchInlineHandle | null>(null);
  const terminalRefs = useRef<Map<number, TerminalPaneHandle>>(new Map());
  const editorRefs = useRef<Map<number, EditorPaneHandle>>(new Map());
  const previewRefs = useRef<Map<number, PreviewPaneHandle>>(new Map());
  const { zoomIn, zoomOut, zoomReset } = useZoom();
  useApplyEditorFontSize();
  const terminalPathDropTarget = useTerminalFileDrop();
  const explorerRef = useRef<FileExplorerHandle>(null);

  // Drives session disposal off the pane tree, not React lifecycles —
  // split/unsplit re-mount components but the leaf is still live.
  const liveLeavesRef = useRef<Set<number>>(new Set());

  const clearWorkspaceState = useCallback(() => {
    for (const id of liveLeavesRef.current) disposeSession(id);
    terminalRefs.current.clear();
    editorRefs.current.clear();
    previewRefs.current.clear();
  }, []);

  const workspaceEnv = useWorkspaceEnvStore((s) => s.env);
  const setWorkspaceEnv = useWorkspaceEnvStore((s) => s.setEnv);
  const {
    home,
    launchCwd,
    launchCwdResolved,
    switchWorkspace,
    adoptWorkspaceEnv,
  } = useWorkspaceSwitcher({
    tabsRef,
    workspaceEnv,
    setWorkspaceEnv,
    resetWorkspace,
    clearWorkspaceState,
  });

  const activeSpaceId = useSpaces((s) => s.activeId);
  const spacesHydrated = useSpaces((s) => s.hydrated);
  const activeSpaceIdRef = useRef(activeSpaceId);
  useLayoutEffect(() => {
    tabsRef.current = tabs;
    activeIdRef.current = activeId;
    activeSpaceIdRef.current = activeSpaceId;
  }, [tabs, activeId, activeSpaceId]);
  const sourceControlSpaceId = activeSpaceId ?? DEFAULT_SPACE_ID;

  const handleWorkspaceChange = useCallback(
    async (env: WorkspaceEnv) => {
      const switched = await switchWorkspace(env);
      if (switched && activeSpaceId) {
        useSpaces.getState().setEnv(activeSpaceId, env);
      }
    },
    [switchWorkspace, activeSpaceId],
  );

  useSpacesBoot({
    ready: launchCwdResolved,
    launchCwd,
    home,
    allocId,
    replaceTabs,
    markBooted,
    setActiveSpaceForNewTabs,
    adoptWorkspaceEnv,
  });

  useSpacePersistence({
    tabs,
    activeId,
    activeSpaceId: activeSpaceId ?? DEFAULT_SPACE_ID,
    enabled: spacesHydrated,
  });

  // Per-space memory of the terminal tab last focused there. Switching groups
  // should land back on the shell you were working in, so file tabs are never
  // the restore target even when one sits last in tab order.
  const lastTerminalBySpaceRef = useRef<Map<string, number>>(new Map());
  useEffect(() => {
    const t = tabsRef.current.find((x) => x.id === activeId);
    if (t?.kind === "terminal")
      lastTerminalBySpaceRef.current.set(t.spaceId, t.id);
  }, [activeId]);

  const prevSpaceRef = useRef(activeSpaceId);
  useEffect(() => {
    if (!spacesHydrated || !activeSpaceId) return;
    setActiveSpaceForNewTabs(activeSpaceId);
    const prev = prevSpaceRef.current;
    prevSpaceRef.current = activeSpaceId;
    if (prev === null || prev === activeSpaceId) return;
    const meta = useSpaces
      .getState()
      .spaces.find((s) => s.id === activeSpaceId);
    if (meta) void adoptWorkspaceEnv(meta.env);
    const inSpace = tabsRef.current.filter((t) => t.spaceId === activeSpaceId);
    if (inSpace.length === 0) return;
    // Keep the active tab if it already belongs to the newly active space (a
    // cross-space jump set it explicitly).
    if (inSpace.some((t) => t.id === activeId)) return;
    // Otherwise: the terminal last focused here, then this space's last
    // terminal, and only if it has none at all fall back to its last tab.
    const remembered = lastTerminalBySpaceRef.current.get(activeSpaceId);
    const target =
      inSpace.find((t) => t.id === remembered && t.kind === "terminal") ??
      [...inSpace].reverse().find((t) => t.kind === "terminal") ??
      inSpace[inSpace.length - 1];
    setActiveId(target.id);
  }, [
    activeSpaceId,
    activeId,
    spacesHydrated,
    setActiveSpaceForNewTabs,
    setActiveId,
    adoptWorkspaceEnv,
  ]);

  const spaceTabs = useMemo(
    () => tabs.filter((t) => t.spaceId === (activeSpaceId ?? DEFAULT_SPACE_ID)),
    [tabs, activeSpaceId],
  );

  // Only terminal tabs go to the Header TabBar; editor/file tabs only show in the Open Files panel.
  const headerTabs = useMemo(
    () => spaceTabs.filter((t) => t.kind === "terminal"),
    [spaceTabs],
  );

  // ALL terminal tabs across every group: the phone's switcher lists every
  // group's terminals, not just the currently active group's.
  const allTerminalTabs = useMemo(
    () => tabs.filter((t) => t.kind === "terminal"),
    [tabs],
  );

  // Sync the desktop's command-line tabs to the web layer (phone list) and
  // react to the phone asking to activate a terminal.
  useWebTerminalSync({
    terminalTabs: allTerminalTabs,
    activeId,
    activateTab: (id) => setActiveId(id),
  });

  const {
    sidebarRef,
    sidebarWidthRef,
    sidebarView,
    sidebarOpen,
    initialSidebarCollapsed,
    persistSidebarView,
    persistSidebarCollapsed,
    toggleSidebar,
    cycleSidebarView,
    openSidebarView,
    persistSidebarWidth,
    toggleExplorerFocus,
  } = useSidebarPanel(explorerRef);

  const [newEditorOpen, setNewEditorOpen] = useState(false);
  const [commandPaletteOpen, setCommandPaletteOpen] = useState(false);
  const [paletteInitialMode, setPaletteInitialMode] = useState<
    "commands" | "content"
  >("commands");
  const openCommandPalette = useCallback(
    (mode: "commands" | "content" = "commands") => {
      setPaletteInitialMode(mode);
      setCommandPaletteOpen(true);
    },
    [],
  );

  const activeTab = tabs.find((t) => t.id === activeId);
  const isTerminalTab = activeTab?.kind === "terminal";
  const isBlockTab = activeTerminalTab?.blocks === true;

  useEditorFileSync({ tabs, tabsRef, editorRefs });
  useThemeFileEditing({ tabsRef, openFileTab });

  // One source of truth for the side panels: the command line (terminal tab)
  // they all follow. 文件 / 版本 / 窗口 switch together with it.
  const {
    currentTerminalTab: currentOwnerTab,
    explorerRoot,
    inheritedCwdForNewTab,
  } = useWorkspaceCwd(activeTab, tabs, launchCwd ?? home);
  const currentOwnerTabId = currentOwnerTab?.id ?? null;

  useWindowTitle(activeTab, explorerRoot);

  const disposeTab = useCallback(
    (id: number) => {
      // Terminal-leaf-keyed maps (terminalRefs) are pruned by the effect
      // below as the pane tree changes; only the tab-id-keyed handles need
      // explicit cleanup here.
      editorRefs.current.delete(id);
      previewRefs.current.delete(id);
      closeTab(id);
    },
    [closeTab],
  );

  const {
    pendingCloseTab,
    pendingTerminalCloseTab,
    pendingDeleteTabs,
    handleClose,
    confirmClose,
    cancelClose,
    confirmTerminalClose,
    cancelTerminalClose,
    confirmDeleteClose,
    cancelDeleteClose,
    handlePathDeleted,
  } = useTabCloseGuards({ tabs, disposeTab });

  const { pendingAppClose, confirmAppClose, cancelAppClose } =
    useAppCloseGuard(tabsRef);

  useEffect(() => {
    const live = new Set<number>();
    for (const t of tabs) {
      if (t.kind === "terminal") {
        for (const id of leafIds(t.paneTree)) live.add(id);
      }
    }
    for (const id of liveLeavesRef.current) {
      if (!live.has(id)) disposeSession(id);
    }
    liveLeavesRef.current = live;
    for (const k of [...terminalRefs.current.keys()])
      if (!live.has(k)) terminalRefs.current.delete(k);
  }, [tabs]);

  useEffect(() => {
    const tab = tabsRef.current.find((t) => t.id === activeId);
    if (tab?.kind !== "terminal") return;
    const ptyIds = leafIds(tab.paneTree).flatMap((leafId) => {
      const ptyId = ptyIdForLeaf(leafId);
      return ptyId === null ? [] : [ptyId];
    });
    useAgentActivityStore.getState().acknowledgeAttention(ptyIds);
  }, [activeId]);

  // Most-recently-used tab ids, most recent first, pruned to live tabs. Drives
  // the Ctrl+Tab quick switcher so it cycles by recency, not strip order.
  const mruRef = useRef<number[]>([activeId]);
  useEffect(() => {
    mruRef.current = [
      activeId,
      ...mruRef.current.filter((id) => id !== activeId),
    ];
  }, [activeId]);
  useEffect(() => {
    const live = new Set(tabs.map((t) => t.id));
    mruRef.current = mruRef.current.filter((id) => live.has(id));
  }, [tabs]);

  const getSwitcherOrder = useCallback(() => {
    const space = activeSpaceId ?? DEFAULT_SPACE_ID;
    const inSpace = tabsRef.current
      .filter((t) => t.spaceId === space)
      .map((t) => t.id);
    const present = new Set(inSpace);
    const ordered = mruRef.current.filter((id) => present.has(id));
    for (const id of inSpace) if (!ordered.includes(id)) ordered.push(id);
    return [activeId, ...ordered.filter((id) => id !== activeId)];
  }, [activeId, activeSpaceId]);

  const { state: switcherState, step: stepSwitcher } = useTabSwitcher({
    getOrder: getSwitcherOrder,
    onCommit: (id) => {
      if (tabsRef.current.some((t) => t.id === id)) setActiveId(id);
    },
  });

  const captureActiveSelection = useCallback((): string | null => {
    const t = tabs.find((x) => x.id === activeId);
    if (!t) return null;
    if (t.kind === "terminal") {
      const lid = t.activeLeafId;
      return terminalRefs.current.get(lid)?.getSelection() ?? null;
    }
    if (t.kind === "editor") {
      return editorRefs.current.get(activeId)?.getSelection() ?? null;
    }
    if (t.kind === "markdown") {
      // Rendered markdown preview is plain selectable HTML.
      const sel = window.getSelection();
      return sel && !sel.isCollapsed ? sel.toString() : null;
    }
    return null;
  }, [tabs, activeId]);

  // Pick the terminal leaf to receive a selection. With several Claude Code
  // panes open, the right one is whichever runs in the directory that contains
  // the file — the deepest matching cwd wins, so a nested repo beats its parent.
  const findClaudeLeaf = useCallback(
    (filePath?: string | null): number | null => {
      const { agents } = useAgentActivityStore.getState();
      const isAgentLeaf = (leafId: number) => {
        const ptyId = ptyIdForLeaf(leafId);
        return ptyId !== null && !!agents[ptyId];
      };

      const norm = (p: string) =>
        p.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();

      const agentLeaves: number[] = [];
      for (const tab of tabsRef.current) {
        if (tab.kind !== "terminal") continue;
        for (const leafId of leafIds(tab.paneTree)) {
          if (isAgentLeaf(leafId)) agentLeaves.push(leafId);
        }
      }

      if (agentLeaves.length === 0) {
        // No agent running — fall back to the active terminal pane.
        return activeLeafId;
      }
      if (agentLeaves.length === 1) return agentLeaves[0];

      // Several agents: match on cwd containing the file.
      if (filePath) {
        const file = norm(filePath);
        let best: { leafId: number; depth: number } | null = null;
        for (const leafId of agentLeaves) {
          const cwd = leafCwd(leafId);
          if (!cwd) continue;
          const root = norm(cwd);
          if (file === root || file.startsWith(`${root}/`)) {
            const depth = root.split("/").length;
            if (!best || depth > best.depth) best = { leafId, depth };
          }
        }
        if (best) return best.leafId;
      }

      // No cwd match — prefer the pane the user is already in.
      if (activeLeafId !== null && agentLeaves.includes(activeLeafId)) {
        return activeLeafId;
      }
      return agentLeaves[0];
    },
    [activeLeafId],
  );

  /** Paste a file path into the Claude Code pane that owns that directory. */
  const handleAttachFileToAgent = useCallback(
    (path: string) => {
      const leafId = findClaudeLeaf(path);
      if (leafId === null) {
        toast.error("没有可用的终端");
        return;
      }
      if (pasteToLeaf(leafId, `${quoteShellArg(path)} `)) {
        const tab = tabsRef.current.find(
          (t) => t.kind === "terminal" && hasLeaf(t.paneTree, leafId),
        );
        if (tab) {
          setActiveId(tab.id);
          focusPane(tab.id, leafId);
        }
      } else {
        toast.error("该终端已关闭");
      }
    },
    [findClaudeLeaf, setActiveId, focusPane],
  );

  const sendSelectionToClaude = useCallback(
    (targetLeafId?: number) => {
      const selection = captureActiveSelection();
      if (!selection || !selection.trim()) return;

      // Resolve the source file first — it both labels the block and decides
      // which Claude Code pane receives it. Git tabs carry a repo-relative path,
      // so join them onto their repo root to get something absolute.
      let filePath: string | null = null;
      if (activeTab?.kind === "editor" || activeTab?.kind === "markdown") {
        filePath = activeTab.path;
      } else if (
        activeTab?.kind === "git-diff" ||
        activeTab?.kind === "git-commit-file"
      ) {
        filePath = /^([A-Za-z]:|\/|\\)/.test(activeTab.path)
          ? activeTab.path
          : `${activeTab.repoRoot.replace(/[\\/]+$/, "")}/${activeTab.path.replace(/^[\\/]+/, "")}`;
      }

      // An explicit multi-agent target wins; otherwise pick the best pane.
      const leafId = targetLeafId ?? findClaudeLeaf(filePath);
      if (leafId === null) {
        toast.error("No terminal pane to send the selection to");
        return;
      }

      // Label the block with its file and line range so the agent can locate it.
      // Pasted without a trailing CR so the user can add a question first.
      let location = filePath;
      if (
        location &&
        (activeTab?.kind === "editor" || activeTab?.kind === "markdown")
      ) {
        const range = editorRefs.current.get(activeId)?.getSelectionRange?.();
        if (range) {
          location +=
            range.startLine === range.endLine
              ? `:${range.startLine}`
              : `:${range.startLine}-${range.endLine}`;
        }
      }

      const header = location ? `${location}\n` : "";
      const body = `${header}\`\`\`\n${selection.trimEnd()}\n\`\`\`\n`;

      if (pasteToLeaf(leafId, body)) {
        const tab = tabsRef.current.find(
          (t) => t.kind === "terminal" && hasLeaf(t.paneTree, leafId),
        );
        if (tab) {
          setActiveId(tab.id);
          focusPane(tab.id, leafId);
        }
        toast.success("Selection sent — add your question and press Enter");
      } else {
        toast.error("That terminal is no longer running");
      }
    },
    [
      captureActiveSelection,
      findClaudeLeaf,
      activeTab,
      activeId,
      setActiveId,
      focusPane,
    ],
  );

  // All running agent terminals (claude / codex / gemini / opencode / ...),
  // used to let the user pick a target when several agents are open.
  const agentTargets = useMemo(() => {
    const { agents } = useAgentActivityStore.getState();
    const targets: { leafId: number; agent: string; cwd: string | null }[] = [];
    for (const tab of tabsRef.current) {
      if (tab.kind !== "terminal") continue;
      for (const leafId of leafIds(tab.paneTree)) {
        const ptyId = ptyIdForLeaf(leafId);
        const agent = ptyId !== null ? agents[ptyId] : undefined;
        if (!agent) continue;
        targets.push({ leafId, agent, cwd: leafCwd(leafId) });
      }
    }
    return targets;
  }, [tabs]);

  const { popup: selectionAskPopup, setPopup: setSelectionAskPopup, send: sendSelection } =
    useSelectionAsk({
      captureActiveSelection,
      onSend: sendSelectionToClaude,
    });

  const openNewTab = useCallback(() => {
    newTab(inheritedCwdForNewTab());
  }, [newTab, inheritedCwdForNewTab]);

  const openNewPrivateTab = useCallback(() => {
    newPrivateTab(inheritedCwdForNewTab());
  }, [newPrivateTab, inheritedCwdForNewTab]);

  const openNewBlockTab = useCallback(() => {
    newBlockTab(inheritedCwdForNewTab());
  }, [newBlockTab, inheritedCwdForNewTab]);

  const sendCd = useCallback(
    (path: string) => {
      if (activeLeafId === null) return;
      const term = terminalRefs.current.get(activeLeafId);
      if (!term) return;
      term.write(`cd ${quoteShellArg(path)}\r`);
      term.focus();
    },
    [activeLeafId],
  );

  const cdInNewTab = useCallback(
    (path: string) => {
      const tabId = newTab(path);
      setTimeout(() => {
        const tab = tabsRef.current.find((x) => x.id === tabId);
        if (!tab || tab.kind !== "terminal") return;
        const t = terminalRefs.current.get(tab.activeLeafId);
        if (!t) return;
        t.write(`cd ${quoteShellArg(path)}\r`);
        t.focus();
      }, 80);
    },
    [newTab],
  );

  const handleOpenFile = useCallback(
    (path: string, pin?: boolean) => {
      // Markdown opens in its rendered view by default; a per-tab toggle flips
      // it to the raw editor. Other files default to preview (pin=false);
      // explicit actions like context-menu "Open" pass pin=true to persist.
      // Files always belong to the current command line.
      if (isMarkdownPath(path)) newMarkdownTab(path, currentOwnerTabId ?? undefined);
      else openFileTab(path, pin ?? false, { ownerTabId: currentOwnerTabId ?? undefined });
    },
    [openFileTab, newMarkdownTab, currentOwnerTabId],
  );

  const openLaunchFiles = useCallback(
    (paths: string[]) => {
      for (const path of paths) handleOpenFile(path, true);
    },
    [handleOpenFile],
  );

  // Warm start: the backend emits once the window already exists. Attach on
  // mount so an "Open With" that lands mid-restore isn't dropped — the backend
  // also seeds the drain-once state, so the boot drain below is the safety net.
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let disposed = false;
    (async () => {
      const off = await listen<string[]>("terax:open-file", (e) => {
        openLaunchFiles(e.payload);
      });
      if (disposed) off();
      else unlisten = off;
    })();
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [openLaunchFiles]);

  // Cold start: files arrive as CLI args (Linux/Windows) or the macOS open-files
  // event, and get_launch_files drains them once. Wait for `booted` — the spaces
  // restore ends in replaceTabs(), which overwrites the whole tab list and would
  // discard a launch tab opened before it, making the file flash open and vanish.
  // Booting first also lands the tab in the restored active space, and lets
  // openFileTab dedupe against a session that already had the file open.
  useEffect(() => {
    if (!booted) return;
    void (async () => {
      openLaunchFiles(await consumeLaunchFiles());
    })();
  }, [booted, openLaunchFiles]);

  // Cold start: `--run` opens one terminal tab in the launch dir and types the
  // command. Gated on `booted` for the same reason as launch files above, and
  // drained once so a dev-mode remount can't run the command twice.
  useEffect(() => {
    if (!booted) return;
    void (async () => {
      const command = await consumeLaunchCommand();
      if (!command) return;
      const { leafId } = newCommandTab(getLaunchDir());
      await whenSessionReady(leafId);
      if (!writeToSession(leafId, `${command}\r`)) {
        console.error(
          "[terax] launch terminal closed before --run could start",
        );
      }
    })();
  }, [booted, newCommandTab]);

  const handlePathRenamed = useCallback(
    (from: string, to: string) => {
      for (const t of tabs) {
        if (t.kind !== "editor") continue;
        if (t.path === from) {
          const i = to.lastIndexOf("/");
          updateTab(t.id, { path: to, title: i === -1 ? to : to.slice(i + 1) });
        } else if (t.path.startsWith(`${from}/`)) {
          const suffix = t.path.slice(from.length);
          const newPath = `${to}${suffix}`;
          const i = newPath.lastIndexOf("/");
          updateTab(t.id, {
            path: newPath,
            title: i === -1 ? newPath : newPath.slice(i + 1),
          });
        }
      }
    },
    [tabs, updateTab],
  );

  // The cwd of the command line the side panels follow; falls back to the
  // active terminal leaf's cwd for the leaf-level detail (e.g. split panes).
  const activeTerminalLeafCwd =
    activeTab?.kind === "terminal"
      ? (findLeafCwd(activeTab.paneTree, activeTab.activeLeafId) ??
        activeTab.cwd ??
        null)
      : null;

  const activeFilePath = (() => {
    if (activeTab?.kind === "editor") return activeTab.path;
    if (activeTab?.kind === "git-diff") {
      if (/^([A-Za-z]:|\/|\\)/.test(activeTab.path)) return activeTab.path;
      const root = activeTab.repoRoot.replace(/[\\/]+$/, "");
      const rel = activeTab.path.replace(/^[\\/]+/, "");
      return `${root}/${rel}`;
    }
    if (activeTab?.kind === "git-commit-file") {
      const root = activeTab.repoRoot.replace(/[\\/]+$/, "");
      const rel = activeTab.path.replace(/^[\\/]+/, "");
      return `${root}/${rel}`;
    }
    return null;
  })();
  const explorerActiveFilePath =
    activeTab?.kind === "editor" || activeTab?.kind === "markdown"
      ? activeTab.path
      : null;
  // Marks every open file in the tree, across spaces, not just this space's.
  const explorerOpenFilePaths = useMemo(
    () =>
      tabs
        .filter((t) => t.kind === "editor" || t.kind === "markdown")
        .map((t) => t.path),
    [tabs],
  );
  const isRepositoryContextCurrent = useCallback(
    (spaceId: string, workspaceKey: string) => {
      const currentSpaceId = useSpaces.getState().activeId ?? DEFAULT_SPACE_ID;
      const currentWorkspaceKey = workspaceScopeKey(
        useWorkspaceEnvStore.getState().env,
      );
      return spaceId === currentSpaceId && workspaceKey === currentWorkspaceKey;
    },
    [],
  );
  const openSourceControl = useCallback(() => {
    openSidebarView("source-control");
  }, [openSidebarView]);
  const [remoteManagerOpen, setRemoteManagerOpen] = useState(false);
  const [cloneRepositoryOpen, setCloneRepositoryOpen] = useState(false);
  // File-history dialog target; null keeps the dialog closed.
  const [fileHistory, setFileHistory] = useState<{
    repoRoot: string;
    path: string;
  } | null>(null);
  const {
    repositoryTarget: sourceControlRepositoryTarget,
    openInSourceControl: handleOpenRepositoryInSourceControl,
    openGitHistory: handleOpenGitHistoryForPath,
    followActiveContext: handleFollowRepositoryContext,
  } = useRepositoryTargeting({
    spaceId: sourceControlSpaceId,
    workspaceKey: workspaceScopeKey(workspaceEnv),
    isContextCurrent: isRepositoryContextCurrent,
    openSourceControl,
    openCommitHistoryTab,
  });
  const handleOpenFileHistory = useCallback(async (path: string) => {
    const repo = await native.gitResolveRepo(path).catch(() => null);
    if (!repo) {
      toast.info("No Git repository contains this file.");
      return;
    }
    const relative = path
      .slice(repo.repoRoot.length)
      .replace(/^[\\/]+/, "")
      .replace(/\\/g, "/");
    setFileHistory({ repoRoot: repo.repoRoot, path: relative });
  }, []);
  const {
    sourceControl,
    multiRepo,
    toggleSourceControl,
    openGitGraphFromContext,
  } = useSourceControlContext({
    activeTab,
    tabs,
    activeTerminalLeafCwd: currentOwnerTab?.cwd ?? null,
    explorerRoot,
    launchCwd,
    launchCwdResolved,
    home,
    sidebarView,
    repositoryTarget: sourceControlRepositoryTarget,
    cycleSidebarView,
    openCommitHistoryTab,
  });
  const explorerGitDecorations = usePreferencesStore(
    (s) => s.explorerGitDecorations,
  );
  // Switch which repo an open history tab shows without opening a new tab; the
  // pane reloads off the changed repoRoot and the title follows the branch.
  const handleSwitchHistoryRepo = useCallback(
    (tabId: number, repoRoot: string, branch: string | null) => {
      updateTab(tabId, {
        repoRoot,
        title: branch ? `History · ${branch}` : "Git History",
      });
    },
    [updateTab],
  );
  // Decorations take every repo's snapshot: each file is colored by whichever
  // repo contains it. The active repo's snapshot already rides inside
  // repoStatusEntries when multi-repo; the merge only matters for the
  // single-repo case where the scan found nothing but the context resolved one.
  const explorerGitStatuses = useMemo(() => {
    const entries = multiRepo.repoStatusEntries.map((e) => e.status);
    const active = sourceControl.status;
    if (!active || entries.some((s) => s.repoRoot === active.repoRoot)) {
      return entries;
    }
    return [active, ...entries];
  }, [multiRepo.repoStatusEntries, sourceControl.status]);

  const openPreviewTab = useCallback(
    (url: string) => {
      const id = newPreviewTab(url);
      // Focus the address bar if the URL is empty so the user can type.
      if (!url) {
        setTimeout(() => previewRefs.current.get(id)?.focusAddressBar(), 0);
      }
      return id;
    },
    [newPreviewTab],
  );

  const splitActivePaneInActiveTab = useCallback(
    (dir: "row" | "col") => {
      const t = tabsRef.current.find((x) => x.id === activeId);
      if (!t || t.kind !== "terminal") return;
      splitActivePane(activeId, dir);
    },
    [activeId, splitActivePane],
  );

  const livePaneBounds = useCallback((tabId: number): PaneBounds[] => {
    const tab = document.querySelector<HTMLElement>(
      `[data-terminal-tab="${tabId}"]`,
    );
    if (!tab) return [];
    return [...tab.querySelectorAll<HTMLElement>("[data-pane-leaf]")].flatMap(
      (element) => {
        const id = Number(element.dataset.paneLeaf);
        if (!Number.isFinite(id)) return [];
        const { left, right, top, bottom } = element.getBoundingClientRect();
        return [{ id, left, right, top, bottom }];
      },
    );
  }, []);

  const swapActivePane = useCallback(
    (direction: "left" | "right" | "up" | "down") => {
      swapActivePaneInDirection(activeId, direction, livePaneBounds(activeId));
    },
    [activeId, livePaneBounds, swapActivePaneInDirection],
  );

  const handleCloseTabOrPane = useCallback(() => {
    const t = tabsRef.current.find((x) => x.id === activeId);
    if (t?.kind === "terminal" && leafIds(t.paneTree).length > 1) {
      closeActivePane(activeId);
      return;
    }
    void handleClose(activeId);
  }, [activeId, closeActivePane, handleClose]);

  const [zenMode, setZenMode] = useState(false);

  const shortcutHandlers = useMemo<ShortcutHandlers>(
    () => ({
      "commandPalette.open": () => openCommandPalette("commands"),
      "commandPalette.content": () => openCommandPalette("content"),
      "tab.new": openNewTab,
      "tab.newBlock": openNewBlockTab,
      "tab.newPrivate": openNewPrivateTab,
      "tab.newPreview": () => openPreviewTab(""),
      "tab.newEditor": () => setNewEditorOpen(true),
      "tab.close": handleCloseTabOrPane,
      "tab.next": () => stepSwitcher(1),
      "tab.prev": () => stepSwitcher(-1),
      "tab.selectByIndex": (e) =>
        selectByIndex(
          parseInt(e.key, 10) - 1,
          activeSpaceId ?? DEFAULT_SPACE_ID,
        ),
      "pane.splitRight": () => splitActivePaneInActiveTab("row"),
      "pane.splitDown": () => splitActivePaneInActiveTab("col"),
      "pane.focusNext": () => focusNextPaneInTab(activeId, 1),
      "pane.focusPrev": () => focusNextPaneInTab(activeId, -1),
      "pane.swapLeft": () => swapActivePane("left"),
      "pane.swapRight": () => swapActivePane("right"),
      "pane.swapUp": () => swapActivePane("up"),
      "pane.swapDown": () => swapActivePane("down"),
      "pane.source": toggleSourceControl,
      "terminal.clear": () => {
        clearFocusedTerminal();
      },
      "terminal.toggleInput": () =>
        window.dispatchEvent(new CustomEvent(TOGGLE_BLOCK_INPUT_EVENT)),
      "blocks.prev": () => navigateFocusedBlocks(-1),
      "blocks.next": () => navigateFocusedBlocks(1),
      "search.focus": () => {
        const editor = editorRefs.current.get(activeId);
        if (editor) editor.openSearch();
        else searchInlineRef.current?.focus();
      },
      "selection.sendToAgent": () => sendSelectionToClaude(),
      "settings.open": () => void openSettingsWindow(),
      "sidebar.toggle": toggleSidebar,
      "explorer.focus": toggleExplorerFocus,
      "view.zoomIn": zoomIn,
      "view.zoomOut": zoomOut,
      "view.zoomReset": zoomReset,
      "view.zenMode": () => setZenMode((v) => !v),
      "editor.undo": () => editorRefs.current.get(activeId)?.undo(),
      "editor.redo": () => editorRefs.current.get(activeId)?.redo(),
    }),
    [
      activeId,
      openCommandPalette,
      stepSwitcher,
      handleCloseTabOrPane,
      openNewTab,
      openNewBlockTab,
      openNewPrivateTab,
      openPreviewTab,
      activeSpaceId,
      selectByIndex,
      splitActivePaneInActiveTab,
      focusNextPaneInTab,
      swapActivePane,
      toggleSourceControl,
      sendSelectionToClaude,
      toggleSidebar,
      toggleExplorerFocus,
      zoomIn,
      zoomOut,
      zoomReset,
    ],
  );

  const shortcutsDisabled = useCallback(
    (id: ShortcutId, e: KeyboardEvent) => {
      const terminalPaneCount =
        activeTab?.kind === "terminal"
          ? leafIds(activeTab.paneTree).length
          : null;
      if (shouldDisablePaneSwapShortcut(id, terminalPaneCount)) return true;
      if (id === "editor.undo" || id === "editor.redo") {
        return activeTab?.kind !== "editor";
      }
      if (id === "selection.sendToAgent") {
        const target =
          (e.target as HTMLElement | null) ?? document.activeElement;
        const inTerminal = !!(target as HTMLElement | null)?.closest?.(
          ".xterm",
        );
        if (!inTerminal) return false;
        const sel = captureActiveSelection();
        return !sel || !sel.trim();
      }
      if (id === "terminal.clear") {
        // Only intercept ⌘K while a terminal is focused; elsewhere let the key
        // fall through (we never preventDefault when disabled).
        const target =
          (e.target as HTMLElement | null) ?? document.activeElement;
        return !(target as HTMLElement | null)?.closest?.(".xterm");
      }
      if (
        id === "terminal.toggleInput" ||
        id === "blocks.prev" ||
        id === "blocks.next"
      ) {
        return !(activeTab?.kind === "terminal" && activeTab.blocks === true);
      }
      if (id === "sidebar.toggle") {
        // Ctrl+B is also Claude Code's "run in background" key. While a terminal
        // is focused, let Ctrl+B reach the shell/Claude instead of toggling the
        // sidebar. Ctrl+Shift+B (second binding) still toggles it from anywhere.
        const target =
          (e.target as HTMLElement | null) ?? document.activeElement;
        const inTerminal = !!(target as HTMLElement | null)?.closest?.(
          ".xterm",
        );
        // Only defer the plain (no-shift) Ctrl/⌘+B binding; the Shift variant
        // is the always-on toggle and is never claimed by the terminal.
        return inTerminal && !e.shiftKey;
      }
      return false;
    },
    [activeTab],
  );

  useGlobalShortcuts(shortcutHandlers, { isDisabled: shortcutsDisabled });

  const registerTerminalHandle = useCallback(
    (leafId: number, h: TerminalPaneHandle | null) => {
      if (h) terminalRefs.current.set(leafId, h);
      else terminalRefs.current.delete(leafId);
    },
    [],
  );

  const registerEditorHandle = useCallback(
    (id: number, h: EditorPaneHandle | null) => {
      if (h) {
        editorRefs.current.set(id, h);
        const pending = pendingEditorNavigation.current.get(id);
        if (pending != null) {
          pendingEditorNavigation.current.delete(id);
          if (pending.line === undefined) h.focus();
          else h.gotoLine(pending.line, { focus: pending.focus });
        }
      } else {
        editorRefs.current.delete(id);
      }
    },
    [],
  );

  const registerPreviewHandle = useCallback(
    (id: number, h: PreviewPaneHandle | null) => {
      if (h) previewRefs.current.set(id, h);
      else previewRefs.current.delete(id);
    },
    [],
  );

  const handlePreviewUrl = useCallback(
    (id: number, url: string) => updateTab(id, { url }),
    [updateTab],
  );

  const authorizedCwds = useRef(new Set<string>());
  const handleTerminalCwd = useCallback(
    (leafId: number, cwd: string) => {
      setLeafCwd(leafId, cwd);
      if (cwd && !authorizedCwds.current.has(cwd)) {
        authorizedCwds.current.add(cwd);
        native.workspaceAuthorize(cwd).catch(() => {
          authorizedCwds.current.delete(cwd);
        });
      }
    },
    [setLeafCwd],
  );

  const handleFocusLeaf = useCallback(
    (tabId: number, leafId: number) => focusPane(tabId, leafId),
    [focusPane],
  );

  const handleLeafExit = useCallback(
    (leafId: number, _code: number) => {
      const all = tabsRef.current;
      const tab = all.find(
        (t) => t.kind === "terminal" && hasLeaf(t.paneTree, leafId),
      );
      if (!tab || tab.kind !== "terminal") return;
      // Last pane of the last tab: quit instead of respawning a shell.
      if (leafIds(tab.paneTree).length === 1 && all.length === 1) {
        void getCurrentWindow().close();
      } else {
        closePaneByLeaf(leafId);
      }
    },
    [closePaneByLeaf],
  );

  const handleEditorDirty = useCallback(
    (id: number, dirty: boolean) => updateTab(id, { dirty }),
    [updateTab],
  );

  const handleRenameTab = useCallback(
    (id: number, title: string) => updateTab(id, { customTitle: title.trim() }),
    [updateTab],
  );

  const searchRoot = explorerRoot;

  // The command line's cwd — follows the active file's owner, not just the
  // active terminal tab, so the status bar / new groups stay in context.
  const activeCwd =
    activeTerminalLeafCwd ?? currentOwnerTab?.cwd ?? explorerRoot;

  // ── Group (space) management ────────────────────────────────────────
  const handleCreateGroup = useCallback(
    (name: string) => {
      const { create, setActive } = useSpaces.getState();
      const meta = create({
        name,
        root: activeCwd ?? home ?? null,
        env: workspaceEnv,
      });
      setActiveSpaceForNewTabs(meta.id);
      newTab(activeCwd ?? undefined);
      setActive(meta.id);
    },
    [activeCwd, home, workspaceEnv, newTab, setActiveSpaceForNewTabs],
  );

  const handleRenameGroup = useCallback((id: string, name: string) => {
    useSpaces.getState().rename(id, name);
  }, []);

  const handleDeleteGroup = useCallback(
    (id: string) => {
      const nextSpaceId = useSpaces.getState().remove(id);
      if (!nextSpaceId) return;
      const root = useSpaces
        .getState()
        .spaces.find((s) => s.id === nextSpaceId)?.root;
      removeTabsForSpace(id, nextSpaceId, root ?? undefined);
    },
    [removeTabsForSpace],
  );

  const handleSwitchGroup = useCallback((id: string) => {
    useSpaces.getState().setActive(id);
  }, []);

  const spacesList = useSpaces((s) => s.spaces);

  const commandPaletteItems = useMemo(
    () =>
      commandPaletteOpen
        ? createCommandItems({
            tabs,
            activeId,
            searchRoot,
            explorerRoot,
            home,
            openNewTab,
            openNewBlock: openNewBlockTab,
            openNewPrivate: openNewPrivateTab,
            openNewEditor: () => setNewEditorOpen(true),
            openNewPreview: () => openPreviewTab(""),
            openGitGraph: openGitGraphFromContext,
            toggleSourceControl,
            closeActiveTabOrPane: handleCloseTabOrPane,
            splitPaneRight: () => splitActivePaneInActiveTab("row"),
            splitPaneDown: () => splitActivePaneInActiveTab("col"),
            focusSearch: () => searchInlineRef.current?.focus(),
            focusExplorerSearch: () => explorerRef.current?.focusSearch(),
            toggleSidebar,
            openSettings: () => void openSettingsWindow(),
            openKeyboardShortcuts: () => void openSettingsWindow("shortcuts"),
          })
        : [],
    [
      commandPaletteOpen,
      tabs,
      activeId,
      searchRoot,
      explorerRoot,
      home,
      openNewTab,
      openNewBlockTab,
      openNewPrivateTab,
      openPreviewTab,
      openGitGraphFromContext,
      toggleSourceControl,
      handleCloseTabOrPane,
      splitActivePaneInActiveTab,
      toggleSidebar,
      sendSelectionToClaude,
    ],
  );

  const pendingEditorNavigation = useRef<
    Map<number, { line?: number; focus: boolean }>
  >(new Map());
  const openContentHit = useCallback(
    (path: string, line: number) => {
      const id = openFileTab(path, true, {
        ownerTabId: currentOwnerTabId ?? undefined,
      });
      if (id == null) return;
      const h = editorRefs.current.get(id);
      if (h) h.gotoLine(line);
      else pendingEditorNavigation.current.set(id, { line, focus: true });
    },
    [openFileTab, currentOwnerTabId],
  );

  const openControlFile = useCallback(
    ({
      path,
      line,
      focus,
      spaceId,
    }: {
      path: string;
      line?: number;
      focus: boolean;
      spaceId: string;
    }) => {
      if (focus && useSpaces.getState().activeId !== spaceId) {
        useSpaces.getState().setActive(spaceId);
      }
      const id = openFileTab(path, true, {
        spaceId,
        activate: focus,
      });
      const editor = editorRefs.current.get(id);
      if (line !== undefined) {
        if (editor) editor.gotoLine(line, { focus });
        else pendingEditorNavigation.current.set(id, { line, focus });
      } else if (focus) {
        if (editor) editor.focus();
        else pendingEditorNavigation.current.set(id, { focus: true });
      }
      return id;
    },
    [openFileTab],
  );

  useControlBridge({
    ready: spacesHydrated && launchCwdResolved,
    tabsRef,
    activeTabIdRef: activeIdRef,
    activeSpaceIdRef,
    onOpen: openControlFile,
  });

  useEffect(() => {
    setLspNavigator({ openFile: openContentHit });
    return () => setLspNavigator(null);
  }, [openContentHit]);

  const insertHistoryCommand = useMemo(
    () =>
      isTerminalTab && activeLeafId !== null
        ? (cmd: string) => {
            writeToSession(activeLeafId, cmd);
            terminalRefs.current.get(activeLeafId)?.focus();
          }
        : null,
    [isTerminalTab, activeLeafId],
  );

  return (
    <ThemeProvider>
      <TooltipProvider>
        <div className="relative flex h-screen flex-col overflow-hidden bg-background text-foreground">
          {!zenMode && (
            <Header
              tabs={headerTabs}
              activeId={activeId}
              activeOwnerTabId={currentOwnerTabId}
              onSelect={setActiveId}
              onNew={openNewTab}
              onNewBlock={openNewBlockTab}
              onNewPrivate={openNewPrivateTab}
              onNewPreview={() => openPreviewTab("")}
              onNewEditor={() => setNewEditorOpen(true)}
              onNewGitGraph={openGitGraphFromContext}
              onClose={handleClose}
              onPin={pinTab}
              onRename={handleRenameTab}
              onReorder={reorderTabByGap}
              onOverrideLanguage={setOverrideLanguage}
              onOpenCommandPalette={() => openCommandPalette("commands")}
              onOpenSettings={() => void openSettingsWindow()}
              searchRoot={searchRoot}
              onSearchOpenHit={openContentHit}
              searchRef={searchInlineRef}
              groupSwitcher={
                <GroupSwitcher
                  spaces={spacesList}
                  activeId={activeSpaceId}
                  onSwitch={handleSwitchGroup}
                  onCreate={handleCreateGroup}
                  onRename={handleRenameGroup}
                  onDelete={handleDeleteGroup}
                />
              }
              onLaunchClaude={() => {
                if (activeLeafId !== null) {
                  writeToSession(activeLeafId, "claude\r");
                }
              }}
              onLaunchClaudeC={() => {
                if (activeLeafId !== null) {
                  writeToSession(activeLeafId, "claude -c\r");
                }
              }}
              headerTabs={
                <HeaderTabs
                  active={sidebarOpen ? sidebarView : null}
                  sourceControlChanged={
                    multiRepo.repos.length > 0
                      ? multiRepo.aggregatedChanges
                      : sourceControl.changedCount
                  }
                  onSelect={(id) => {
                    if (sidebarView === id && sidebarOpen) {
                      sidebarRef.current?.collapse();
                    } else {
                      persistSidebarView(id as SidebarViewId);
                      if (!sidebarOpen) {
                        sidebarRef.current?.resize(
                          `${sidebarWidthRef.current}px`,
                        );
                      }
                      if (id === "source-control") {
                        void multiRepo.scanRepos().then(() => {
                          sourceControl.refresh({ remote: "always" });
                        });
                      }
                    }
                  }}
                />
              }
            />
          )}

          <main className="zoom-content flex min-h-0 flex-1 flex-col">
            <ResizablePanelGroup
              orientation="horizontal"
              className="min-h-0 flex-1"
              onLayoutChanged={(_, { isUserInteraction }) => {
                const width = sidebarRef.current?.getSize().inPixels ?? 0;
                persistSidebarWidth(width, isUserInteraction);
              }}
            >
              <ResizablePanel
                id="sidebar"
                panelRef={sidebarRef}
                defaultSize={
                  initialSidebarCollapsed
                    ? "0px"
                    : `${sidebarWidthRef.current}px`
                }
                minSize={`${SIDEBAR_MIN_WIDTH}px`}
                maxSize={`${SIDEBAR_MAX_WIDTH}px`}
                collapsible
                collapsedSize={0}
                onResize={(size) => {
                  persistSidebarCollapsed(size.inPixels <= 0);
                }}
              >
                <div className="flex h-full min-h-0 flex-col border-r border-border/60 bg-card">
                  <div
                    key={sidebarView}
                    className="min-h-0 flex-1 terax-panel-in"
                  >
                    {sidebarView === "open-files" ? (
                      <OpenFilesPanel
                        tabs={tabs}
                        activeId={activeId}
                        currentOwnerTabId={currentOwnerTabId}
                        onSelectTab={setActiveId}
                        onCloseTab={handleClose}
                      />
                    ) : sidebarView === "explorer" ? (
                      <FileExplorer
                        ref={explorerRef}
                        rootPath={explorerRoot}
                        gitStatuses={
                          explorerGitDecorations ? explorerGitStatuses : null
                        }
                        activeFilePath={explorerActiveFilePath}
                        openFilePaths={explorerOpenFilePaths}
                        onOpenFile={handleOpenFile}
                        onOpenSearchHit={openContentHit}
                        onPathRenamed={handlePathRenamed}
                        onPathDeleted={handlePathDeleted}
                        onRevealInTerminal={cdInNewTab}
                        onOpenInSourceControl={
                          handleOpenRepositoryInSourceControl
                        }
                        onOpenGitHistory={handleOpenGitHistoryForPath}
                        onOpenFileHistory={handleOpenFileHistory}
                        onAttachToAgent={handleAttachFileToAgent}
                        pathDropTarget={terminalPathDropTarget}
                      />
                    ) : (
                      <SourceControlPanel
                        open={sidebarOpen}
                        sourceControl={sourceControl}
                        repos={multiRepo.repos}
                        repoStatusEntries={multiRepo.repoStatusEntries}
                        applyRepoStatus={multiRepo.applyRepoStatus}
                        refreshRepoStatus={multiRepo.refreshRepoStatus}
                        refreshAllRepoStatuses={
                          multiRepo.refreshAllRepoStatuses
                        }
                        syncProgress={multiRepo.syncProgress}
                        onDismissSyncProgress={multiRepo.clearSyncProgress}
                        buildPushPlan={multiRepo.buildPushPlan}
                        pushAllAdvanced={multiRepo.pushAllAdvanced}
                        onManageRemotes={() => setRemoteManagerOpen(true)}
                        onCloneRepository={() => setCloneRepositoryOpen(true)}
                        onOpenDiff={openGitDiffTab}
                        onOpenGitGraph={openGitGraphFromContext}
                        onOpenFile={handleOpenFile}
                        onNavigateToPath={cdInNewTab}
                        repositoryTarget={sourceControlRepositoryTarget}
                        onFollowRepositoryContext={
                          handleFollowRepositoryContext
                        }
                        headerExtra={
                          <RepoBranchSelector
                            repos={multiRepo.repos}
                            activeRepo={multiRepo.activeRepo}
                            activeBranch={
                              multiRepo.summary.status?.branch ?? null
                            }
                            onChangeRepo={multiRepo.setActiveRepo}
                            onRescan={multiRepo.scanRepos}
                            onCheckedOut={() =>
                              void multiRepo.summary.refresh({
                                remote: "never",
                              })
                            }
                            onOpenPath={cdInNewTab}
                          />
                        }
                      />
                    )}
                  </div>
                </div>
              </ResizablePanel>
              <ResizableHandle withHandle />
              <ResizablePanel id="workspace" defaultSize="78%" minSize="30%">
                <div className="flex h-full min-h-0 flex-col">
                  <div className="relative min-h-0 flex-1">
                    <WorkspaceSurface
                      tabs={tabs}
                      activeId={activeId}
                      activeTab={activeTab}
                      registerTerminalHandle={registerTerminalHandle}
                      onCwd={handleTerminalCwd}
                      onExit={handleLeafExit}
                      onFocusLeaf={handleFocusLeaf}
                      registerEditorHandle={registerEditorHandle}
                      onEditorDirtyChange={handleEditorDirty}
                      onEditorCloseTab={disposeTab}
                      registerPreviewHandle={registerPreviewHandle}
                      onPreviewUrlChange={handlePreviewUrl}
                      onOpenCommitFile={openCommitFileDiffTab}
                      gitHistoryRepos={multiRepo.repos}
                      onSwitchGitHistoryRepo={handleSwitchHistoryRepo}
                      onSetMarkdownView={setMarkdownView}
                      onOpenMarkdownPath={handleOpenFile}
                    />
                  </div>

                  <WorkspaceInputBar
                    isBlockTab={isBlockTab}
                    isTerminalTab={isTerminalTab}
                    activeLeafId={activeLeafId}
                    cwd={activeCwd}
                    home={home}
                  />
                </div>
              </ResizablePanel>
            </ResizablePanelGroup>
          </main>

          {!zenMode && (
            <StatusBar
              cwd={activeCwd}
              filePath={activeFilePath}
              home={home}
              onCd={sendCd}
              onWorkspaceChange={handleWorkspaceChange}
              privateActive={
                activeTab?.kind === "terminal" && activeTab.private === true
              }
            />
          )}

          <Toaster position="bottom-right" />

          {selectionAskPopup && (
            <SelectionAskButton
              x={selectionAskPopup.x}
              y={selectionAskPopup.y}
              targets={agentTargets}
              onSend={sendSelection}
              onDismiss={() => setSelectionAskPopup(null)}
            />
          )}

          {switcherState && (
            <TabSwitcherHud tabs={spaceTabs} state={switcherState} />
          )}

          <CommandPalette
            open={commandPaletteOpen}
            onOpenChange={setCommandPaletteOpen}
            initialMode={paletteInitialMode}
            commandItems={commandPaletteItems}
            workspaceRoot={explorerRoot}
            onOpenContentHit={openContentHit}
            insertCommand={insertHistoryCommand}
          />

          <NewEditorDialog
            open={newEditorOpen}
            onOpenChange={setNewEditorOpen}
            rootPath={explorerRoot ?? home}
            onCreated={(path) => openFileTab(path)}
          />

          <RemoteManagerDialog
            open={remoteManagerOpen}
            onOpenChange={setRemoteManagerOpen}
            repoRoot={multiRepo.activeRepo}
            onAdd={multiRepo.addRemote}
            onRemove={multiRepo.removeRemote}
            onSetUrl={multiRepo.setRemoteUrl}
          />

          <CloneRepositoryDialog
            open={cloneRepositoryOpen}
            onOpenChange={setCloneRepositoryOpen}
            defaultTargetDir={explorerRoot ?? home ?? null}
            onClone={multiRepo.cloneRepository}
            onCloned={() => {
              void multiRepo.scanRepos().then(() => {
                sourceControl.refresh({ remote: "never" });
              });
            }}
          />

          <FileHistoryDialog
            open={fileHistory !== null}
            onOpenChange={(open) => {
              if (!open) setFileHistory(null);
            }}
            repoRoot={fileHistory?.repoRoot ?? ""}
            path={fileHistory?.path ?? ""}
            onOpenCommitFile={(input) => {
              setFileHistory(null);
              openCommitFileDiffTab(input);
            }}
          />

          <UpdaterDialog />

          <CloseDialogs
            tabs={tabs}
            pendingCloseTab={pendingCloseTab}
            onCancelClose={cancelClose}
            onConfirmClose={confirmClose}
            pendingTerminalCloseTab={pendingTerminalCloseTab}
            onCancelTerminalClose={cancelTerminalClose}
            onConfirmTerminalClose={confirmTerminalClose}
            pendingDeleteTabs={pendingDeleteTabs}
            onCancelDeleteClose={cancelDeleteClose}
            onConfirmDeleteClose={confirmDeleteClose}
            pendingAppClose={pendingAppClose}
            onCancelAppClose={cancelAppClose}
            onConfirmAppClose={confirmAppClose}
          />
        </div>
      </TooltipProvider>
    </ThemeProvider>
  );
}
