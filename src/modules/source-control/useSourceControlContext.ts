import { native } from "@/lib/native";
import { pathIdentity } from "@/lib/pathIdentity";
import { useAppEvent } from "@/modules/events";
import type { SidebarViewId } from "@/modules/sidebar";
import type { Tab } from "@/modules/tabs";
import {
  currentWorkspaceScopeKey,
  workspaceScopeKey,
} from "@/modules/workspace/env";
import { useCallback, useEffect, useMemo, useRef } from "react";
import {
  activeRepositoryContextPath,
  gitGraphRepositoryPath,
  type SourceControlRepositoryTarget,
  sourceControlRepositoryPath,
} from "./repositoryTarget";
import { useMultiRepoSourceControl } from "./useMultiRepoSourceControl";
import { useSourceControl } from "./useSourceControl";

type Params = {
  activeTab: Tab | undefined;
  tabs: Tab[];
  activeTerminalLeafCwd: string | null;
  explorerRoot: string | null;
  launchCwd: string | null;
  launchCwdResolved: boolean;
  home: string | null;
  sidebarView: SidebarViewId;
  repositoryTarget: SourceControlRepositoryTarget;
  cycleSidebarView: (view: SidebarViewId) => void;
  openCommitHistoryTab: (args: {
    repoRoot: string;
    branch: string | null;
  }) => void;
};

/**
 * Resolves the source-control context path off the active tab and feeds the
 * source-control summary. When git is not active the badge tracks a stable
 * per-session path so tab switches / cd don't re-fire git IPC.
 */
export function useSourceControlContext({
  activeTab,
  tabs,
  activeTerminalLeafCwd,
  explorerRoot,
  launchCwd,
  launchCwdResolved,
  home,
  sidebarView,
  repositoryTarget,
  cycleSidebarView,
  openCommitHistoryTab,
}: Params) {
  const workspaceFallbackPath = launchCwdResolved
    ? (launchCwd ?? home ?? null)
    : null;
  const sourceControlContextPath = activeRepositoryContextPath({
    activeTab,
    activeTerminalLeafCwd,
    explorerRoot,
    workspaceFallbackPath,
  });
  const hasOpenGitTab = useMemo(
    () =>
      tabs.some(
        (t) =>
          t.kind === "git-diff" ||
          t.kind === "git-history" ||
          t.kind === "git-commit-file",
      ),
    [tabs],
  );
  // Ambient path tracks the explorer root so the rail badge and explorer git
  // decorations reflect the repo you are actually looking at. cd-within-repo
  // churn is absorbed by the status TTL + reusable-root path in useSourceControl.
  const badgeContextPath = explorerRoot ?? workspaceFallbackPath;
  const sourceControlPath = sourceControlRepositoryPath({
    contextPath: sourceControlContextPath,
    badgeContextPath,
    sidebarView,
    hasOpenGitTab,
    target: repositoryTarget,
  });
  const graphContextPath = gitGraphRepositoryPath({
    contextPath: sourceControlContextPath,
    sidebarView,
    target: repositoryTarget,
  });
  const sourceControl = useSourceControl(sourceControlPath, true);
  // Multi-repo layer: scans the explorer root for nested git repos.
  const scanRoot = explorerRoot ?? workspaceFallbackPath;
  const multiRepo = useMultiRepoSourceControl(sourceControlPath, scanRoot);

  const toggleSourceControl = useCallback(() => {
    cycleSidebarView("source-control");
  }, [cycleSidebarView]);

  // When multiple repos are discovered, prefer the multi-repo summary so
  // BranchDropdown and the file list follow the selected repo.
  const effectiveSourceControl =
    multiRepo.repos.length > 0 ? multiRepo.summary : sourceControl;

  // Working-tree data changes under the app all the time — the agent, another
  // editor, git commands in a terminal. The panels (files, source control,
  // windows) must not keep showing cached statuses and diffs once the files on
  // disk moved. Subscribe to the unified events: `fs:changed` for file moves
  // and `context:changed` for a command-line (project) switch, then refresh
  // whichever repos the change landed in — the active repo (which also
  // invalidates its diff cache through doRefresh), plus any secondary repo
  // directly. Debounced so an agent writing a burst of files coalesces into
  // one refresh.
  const effectiveRef = useRef(effectiveSourceControl);
  effectiveRef.current = effectiveSourceControl;
  const reposRef = useRef(multiRepo.repos);
  reposRef.current = multiRepo.repos;
  const refreshRepoRef = useRef(multiRepo.refreshRepoStatus);
  refreshRepoRef.current = multiRepo.refreshRepoStatus;
  const timerRef = useRef(0);
  const pendingRef = useRef<{ active: boolean; others: Set<string> }>({
    active: false,
    others: new Set(),
  });
  useEffect(() => () => window.clearTimeout(timerRef.current), []);

  const scheduleRefresh = (inActive: boolean, repoRoot: string) => {
    const pending = pendingRef.current;
    if (inActive) {
      pending.active = true;
    } else {
      pending.others.add(repoRoot);
    }
    if (timerRef.current) window.clearTimeout(timerRef.current);
    timerRef.current = window.setTimeout(() => {
      timerRef.current = 0;
      const refreshActive = pending.active;
      pending.active = false;
      const others = [...pending.others];
      pending.others.clear();
      if (refreshActive)
        void effectiveRef.current
          .refresh({ remote: "never" })
          .catch((error) => console.warn("[terax] Git refresh failed:", error));
      const activeRoot = effectiveRef.current.repo?.repoRoot;
      for (const root of others) {
        if (refreshActive && root === activeRoot) continue;
        if (reposRef.current.some((repo) => repo.repoRoot === root))
          void refreshRepoRef
            .current(root)
            .catch((error) =>
              console.warn("[terax] Git refresh failed:", error),
            );
      }
    }, 150);
  };

  useAppEvent("fs:changed", (payload) => {
    if (
      payload.workspace &&
      workspaceScopeKey(payload.workspace) !== currentWorkspaceScopeKey()
    )
      return;
    if (payload.rescan) {
      const activeRoot = effectiveRef.current.repo?.repoRoot ?? "";
      scheduleRefresh(true, activeRoot);
      for (const repo of reposRef.current)
        if (repo.repoRoot !== activeRoot) scheduleRefresh(false, repo.repoRoot);
      return;
    }
    const norm = pathIdentity;
    const changed = payload.paths.map(norm);
    const inside = (path: string, root: string) =>
      path === root || path.startsWith(`${root.replace(/\/$/, "")}/`);
    const activeRoot = effectiveRef.current.repo?.repoRoot ?? null;
    if (activeRoot && changed.some((p) => inside(p, norm(activeRoot)))) {
      scheduleRefresh(true, activeRoot);
    }
    const activeNorm = activeRoot ? norm(activeRoot) : null;
    for (const repo of reposRef.current) {
      const root = norm(repo.repoRoot);
      if (root === activeNorm) continue;
      if (changed.some((p) => inside(p, root))) {
        scheduleRefresh(false, repo.repoRoot);
      }
    }
  });

  useAppEvent("context:changed", () => {
    // A command-line (project) switch: the panel must not keep showing the
    // previous repo. The cross-repo path in useSourceControl refreshes on its
    // own when the context really moved; treat the event as a nudge so a
    // switch that produced no context-path change (e.g. same repo, new shell)
    // still re-reads the working tree.
    scheduleRefresh(true, effectiveRef.current.repo?.repoRoot ?? "");
  });

  const openGitGraphFromContext = useCallback(async () => {
    const known = effectiveSourceControl.hasRepo
      ? effectiveSourceControl.repo
      : null;
    const fixedTargetIsLoaded =
      sidebarView !== "source-control" ||
      repositoryTarget.mode !== "fixed" ||
      known?.repoRoot === repositoryTarget.repoRoot;
    if (known && fixedTargetIsLoaded) {
      openCommitHistoryTab({
        repoRoot: known.repoRoot,
        branch: effectiveSourceControl.status?.branch ?? null,
      });
      return;
    }
    if (!graphContextPath) return;
    try {
      const repo = await native.gitResolveRepo(graphContextPath);
      if (!repo) return;
      openCommitHistoryTab({ repoRoot: repo.repoRoot, branch: repo.branch });
    } catch {
      /* noop */
    }
  }, [
    openCommitHistoryTab,
    effectiveSourceControl.hasRepo,
    effectiveSourceControl.repo,
    effectiveSourceControl.status?.branch,
    graphContextPath,
    repositoryTarget,
    sidebarView,
  ]);

  return {
    sourceControl: effectiveSourceControl,
    multiRepo,
    toggleSourceControl,
    openGitGraphFromContext,
  };
}
