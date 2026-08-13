import { useCallback, useMemo } from "react";
import { native, type GitFetchResult, type GitRepoHead } from "@/modules/ai/lib/native";
import { useRepoList } from "./useRepoList";
import { type SourceControlSummary, useSourceControl } from "./useSourceControl";
import { toast } from "sonner";

type MultiRepoSourceControl = {
  /** All discovered repos in the workspace. */
  repos: GitRepoHead[];
  /** Currently selected repo root (name). */
  activeRepo: string | null;
  /** Switch to a different repo by its root path. */
  setActiveRepo: (root: string) => void;
  /** The source-control summary for the active repo (single-repo compatible). */
  summary: SourceControlSummary;
  /** Sum of changed files across all repos (aggregate badge number). */
  aggregatedChanges: number;
  /** Fetch all repos. Results are reported via toast. */
  fetchAll: () => Promise<GitFetchResult[]>;
  /** Manually trigger a repo scan. */
  scanRepos: () => Promise<void>;
  /** Whether a scan or batch operation is in progress. */
  isLoading: boolean;
};

/**
 * Orchestrates multi-repo git state for the Source Control panel.
 *
 * Builds on `useRepoList` (discovery) and `useSourceControl` (per-repo
 * operations). When repos.length <= 1 degrades to single-repo behavior.
 */
export function useMultiRepoSourceControl(
  contextPath: string | null,
  scanRoot: string | null,
): MultiRepoSourceControl {
  console.log("[terax] useMultiRepoSourceControl: scanRoot=", scanRoot, "contextPath=", contextPath);
  const {
    repos,
    activeRepo,
    setActiveRepo,
    scan,
    isLoading: scanLoading,
  } = useRepoList(scanRoot);

  // Derive the context-appropriate repo root for the single-repo summary.
  // When multi-repo: first entry whose root contains contextPath, else
  // the user-selected active repo, else the first entry.
  const effectiveRepoRoot = useMemo(() => {
    if (!repos.length) return null;
    if (activeRepo) return activeRepo;
    // Find the repo that contains the current context path.
    if (contextPath) {
      const match = repos.find((r) =>
        contextPath.replace(/\\/g, "/").startsWith(r.repoRoot.replace(/\\/g, "/")),
      );
      if (match) return match.repoRoot;
    }
    // No repo matches the current context — show no-repo state.
    return null;
  }, [repos, activeRepo, contextPath]);

  // When repos exist but none match the context, show "no repo" state.
  const inMultiRepoMode = repos.length > 0;
  const effectiveEnabled = !inMultiRepoMode || effectiveRepoRoot !== null;

  // Single-repo summary driven by the effective repo root.
  const summary = useSourceControl(
    contextPath,
    effectiveEnabled,
    effectiveRepoRoot,
  );

  const aggregatedChanges = useMemo(
    () => summary.status?.changedFiles.length ?? 0,
    [summary.status],
  );

  const fetchAll = useCallback(async (): Promise<GitFetchResult[]> => {
    const roots = repos.map((r) => r.repoRoot);
    if (!roots.length) return [];
    try {
      const results = await native.gitFetchAll(roots);
      const failed = results.filter((r) => !r.ok);
      if (failed.length === 0) {
        toast.success(`Fetched ${results.length} repos`);
      } else if (failed.length < results.length) {
        toast.warning(
          `Fetched ${results.length - failed.length}/${results.length} repos; ${failed.length} failed`,
        );
        // Log first few failures to console.
        for (const f of failed.slice(0, 3)) {
          console.warn(`[terax] git fetch failed for ${f.repoRoot}: ${f.error}`);
        }
      } else {
        toast.error(`Fetch failed for all ${results.length} repos`);
      }
      // Refresh status after batch fetch.
      await summary.refresh({ remote: "never" });
      return results;
    } catch (error) {
      const message = typeof error === "string" ? error : String(error);
      toast.error(`Batch fetch failed: ${message}`);
      return [];
    }
  }, [repos, summary]);

  return {
    repos,
    activeRepo: effectiveRepoRoot,
    setActiveRepo,
    summary,
    aggregatedChanges,
    fetchAll,
    scanRepos: scan,
    isLoading: scanLoading || summary.isLoading,
  };
}
