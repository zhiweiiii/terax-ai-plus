import { native } from "@/modules/ai/lib/native";
import type { SidebarViewId } from "@/modules/sidebar";
import type { Tab } from "@/modules/tabs";
import { useCallback, useMemo } from "react";
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
