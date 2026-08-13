import {
  type GitFetchResult,
  type GitRepoHead,
  native,
} from "@/modules/ai/lib/native";
import { useCallback, useMemo } from "react";
import { toast } from "sonner";
import { useRepoList } from "./useRepoList";
import {
  canFastForward,
  type SourceControlSummary,
  useSourceControl,
} from "./useSourceControl";

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
  /** Fetch + fast-forward pull, one repo at a time. Reported via toast. */
  syncAll: () => Promise<void>;
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
    // Membership check matters on a workspace switch: activeRepo still holds
    // the previous project's selection until the scan lands, and trusting it
    // pointed the whole panel at a repo the new workspace does not contain.
    if (activeRepo && repos.some((r) => r.repoRoot === activeRepo)) {
      return activeRepo;
    }
    // Find the repo that contains the current context path.
    if (contextPath) {
      const match = repos.find((r) =>
        contextPath
          .replace(/\\/g, "/")
          .startsWith(r.repoRoot.replace(/\\/g, "/")),
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
          console.warn(
            `[terax] git fetch failed for ${f.repoRoot}: ${f.error}`,
          );
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

  // Sync = fetch, then fast-forward pull where the fetch revealed new commits.
  // Repos are walked one at a time on purpose: running them together would put
  // several credential prompts and remote connections in flight at once, and a
  // failure part-way would leave no way to tell how far it got.
  const syncAll = useCallback(async (): Promise<void> => {
    const roots = repos.map((r) => r.repoRoot);
    if (!roots.length) return;
    let fetched = 0;
    let pulled = 0;
    const failed: { root: string; error: string }[] = [];

    for (const root of roots) {
      try {
        await native.gitFetch(root);
        fetched++;
        const status = await native.gitStatus(root);
        if (canFastForward(status)) {
          await native.gitPullFfOnly(root);
          pulled++;
        }
      } catch (error) {
        failed.push({
          root,
          error: typeof error === "string" ? error : String(error),
        });
        console.warn(`[terax] sync failed for ${root}:`, error);
      }
    }

    const name = (root: string) => root.replace(/\\/g, "/").split("/").pop();
    if (failed.length === 0) {
      toast.success(
        pulled > 0
          ? `Synced ${fetched} repos, pulled ${pulled}`
          : `Synced ${fetched} repos, already up to date`,
      );
    } else if (failed.length < roots.length) {
      toast.warning(
        `Synced ${roots.length - failed.length}/${roots.length} repos`,
        { description: failed.map((f) => name(f.root)).join(", ") },
      );
    } else {
      toast.error(`Sync failed for all ${roots.length} repos`, {
        description: failed[0]?.error,
      });
    }
    await summary.refresh({ remote: "never" });
  }, [repos, summary]);

  // The panel drives everything through the summary, so route "sync" here when
  // there is more than one repo instead of threading a second handler down.
  const runRemoteAction = useCallback<SourceControlSummary["runRemoteAction"]>(
    async (mode = "contextual") => {
      if (mode !== "sync" || repos.length <= 1) {
        return summary.runRemoteAction(mode);
      }
      await syncAll();
      return { ok: true, action: "fetch" };
    },
    [repos.length, summary, syncAll],
  );

  const wrappedSummary = useMemo<SourceControlSummary>(
    () => ({ ...summary, runRemoteAction }),
    [summary, runRemoteAction],
  );

  return {
    repos,
    activeRepo: effectiveRepoRoot,
    setActiveRepo,
    summary: wrappedSummary,
    aggregatedChanges,
    fetchAll,
    syncAll,
    scanRepos: scan,
    isLoading: scanLoading || summary.isLoading,
  };
}
