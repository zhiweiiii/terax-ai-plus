import {
  type GitFetchResult,
  type GitLogEntry,
  type GitRepoHead,
  native,
} from "@/modules/ai/lib/native";
import { useCallback, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { useRepoList } from "./useRepoList";
import { repoDisplayName } from "./useRepoStatuses";
import {
  canFastForward,
  type SourceControlSummary,
  useSourceControl,
} from "./useSourceControl";

/** Per-repo phase while a Sync is walking the workspace. */
export type RepoSyncPhase =
  | { kind: "pending" }
  | { kind: "fetching" }
  | { kind: "pulling"; commits: number }
  | { kind: "pulled"; commits: number }
  | { kind: "up-to-date" }
  | { kind: "no-upstream" }
  | { kind: "diverged" }
  | { kind: "failed"; error: string };

export type RepoSyncItem = {
  repoRoot: string;
  name: string;
  phase: RepoSyncPhase;
};

export type SyncProgress = {
  running: boolean;
  items: RepoSyncItem[];
};

/** One repo's share of a pending push, shown in the confirmation dialog. */
export type PushPlanEntry = {
  repoRoot: string;
  name: string;
  branch: string;
  upstream: string;
  ahead: number;
  commits: GitLogEntry[];
};

export type PushPlan = {
  entries: PushPlanEntry[];
  /** Repos left out, with the reason, so the dialog can say why. */
  skipped: { name: string; reason: string }[];
};

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
  /** Fetch + fast-forward pull, one repo at a time. */
  syncAll: () => Promise<void>;
  /** Live per-repo state of the running (or last) sync; null before the first. */
  syncProgress: SyncProgress | null;
  /** Dismiss the progress list. */
  clearSyncProgress: () => void;
  /** Inspect every repo and list what a push would send. Read-only. */
  buildPushPlan: () => Promise<PushPlan>;
  /** Push the planned repos one at a time; progress lands in syncProgress. */
  pushAll: (plan: PushPlan) => Promise<void>;
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
    // Nothing contains the context, which is the normal shape of a workspace
    // that holds several repos without being one itself (tpaas-v4/*). Falling
    // through to "no repo" left panelState !== "ready", and the panel renders
    // its whole change area behind that — so every repo's changes disappeared.
    // Anchor on the first repo instead: the list shows them all regardless, and
    // branch/push get a target.
    return repos[0].repoRoot;
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
  const [syncProgress, setSyncProgress] = useState<SyncProgress | null>(null);
  const autoClearRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clearSyncProgress = useCallback(() => {
    if (autoClearRef.current) {
      clearTimeout(autoClearRef.current);
      autoClearRef.current = null;
    }
    setSyncProgress(null);
  }, []);

  const syncAll = useCallback(async (): Promise<void> => {
    const targets = repos.map((r) => ({
      repoRoot: r.repoRoot,
      name: repoDisplayName(r.repoRoot),
    }));
    if (!targets.length) return;
    if (autoClearRef.current) {
      clearTimeout(autoClearRef.current);
      autoClearRef.current = null;
    }

    const setPhase = (repoRoot: string, phase: RepoSyncPhase) =>
      setSyncProgress((current) =>
        current
          ? {
              ...current,
              items: current.items.map((item) =>
                item.repoRoot === repoRoot ? { ...item, phase } : item,
              ),
            }
          : current,
      );

    setSyncProgress({
      running: true,
      items: targets.map((t) => ({ ...t, phase: { kind: "pending" } })),
    });

    let pulled = 0;
    let failed = 0;
    // One repo at a time: concurrent runs would put several credential prompts
    // and remote connections in flight, and the progress list would stop
    // meaning "this is what it is doing right now".
    for (const target of targets) {
      setPhase(target.repoRoot, { kind: "fetching" });
      try {
        await native.gitFetch(target.repoRoot);
        const status = await native.gitStatus(target.repoRoot);
        if (!status.upstream) {
          setPhase(target.repoRoot, { kind: "no-upstream" });
        } else if (status.ahead > 0 && status.behind > 0) {
          setPhase(target.repoRoot, { kind: "diverged" });
        } else if (canFastForward(status)) {
          const commits = status.behind;
          setPhase(target.repoRoot, { kind: "pulling", commits });
          await native.gitPullFfOnly(target.repoRoot);
          setPhase(target.repoRoot, { kind: "pulled", commits });
          pulled++;
        } else {
          setPhase(target.repoRoot, { kind: "up-to-date" });
        }
      } catch (error) {
        failed++;
        setPhase(target.repoRoot, {
          kind: "failed",
          error: typeof error === "string" ? error : String(error),
        });
      }
    }

    setSyncProgress((current) =>
      current ? { ...current, running: false } : current,
    );
    await summary.refresh({ remote: "never" });
    // A clean run needs no follow-up; anything worth reading stays until the
    // user dismisses it.
    if (failed === 0 && pulled === 0) {
      autoClearRef.current = setTimeout(() => {
        autoClearRef.current = null;
        setSyncProgress(null);
      }, 2500);
    }
  }, [repos, summary]);

  // Read-only survey: what would a push actually send, per repo. Runs before
  // the confirmation dialog so the user approves a concrete list, not a verb.
  const buildPushPlan = useCallback(async (): Promise<PushPlan> => {
    const entries: PushPlanEntry[] = [];
    const skipped: { name: string; reason: string }[] = [];
    for (const repo of repos) {
      const name = repoDisplayName(repo.repoRoot);
      try {
        const status = await native.gitStatus(repo.repoRoot);
        if (!status.upstream) {
          skipped.push({ name, reason: "No upstream" });
          continue;
        }
        if (status.ahead === 0) {
          skipped.push({ name, reason: "Nothing to push" });
          continue;
        }
        if (status.behind > 0) {
          skipped.push({ name, reason: "Diverged — pull first" });
          continue;
        }
        // The branch is strictly ahead, so its newest `ahead` commits are
        // exactly the ones the push would send.
        const commits = await native.gitLog(repo.repoRoot, {
          limit: status.ahead,
        });
        entries.push({
          repoRoot: repo.repoRoot,
          name,
          branch: status.branch,
          upstream: status.upstream,
          ahead: status.ahead,
          commits,
        });
      } catch (error) {
        skipped.push({
          name,
          reason: typeof error === "string" ? error : String(error),
        });
      }
    }
    return { entries, skipped };
  }, [repos]);

  const pushAll = useCallback(
    async (plan: PushPlan): Promise<void> => {
      if (plan.entries.length === 0) return;
      if (autoClearRef.current) {
        clearTimeout(autoClearRef.current);
        autoClearRef.current = null;
      }
      const setPhase = (repoRoot: string, phase: RepoSyncPhase) =>
        setSyncProgress((current) =>
          current
            ? {
                ...current,
                items: current.items.map((item) =>
                  item.repoRoot === repoRoot ? { ...item, phase } : item,
                ),
              }
            : current,
        );

      setSyncProgress({
        running: true,
        items: plan.entries.map((e) => ({
          repoRoot: e.repoRoot,
          name: e.name,
          phase: { kind: "pending" },
        })),
      });

      // Same reasoning as sync: one repo at a time keeps credential prompts
      // serialised and the progress list truthful.
      for (const entry of plan.entries) {
        setPhase(entry.repoRoot, { kind: "pulling", commits: entry.ahead });
        try {
          await native.gitPush(entry.repoRoot);
          setPhase(entry.repoRoot, { kind: "pulled", commits: entry.ahead });
        } catch (error) {
          setPhase(entry.repoRoot, {
            kind: "failed",
            error: typeof error === "string" ? error : String(error),
          });
        }
      }
      setSyncProgress((current) =>
        current ? { ...current, running: false } : current,
      );
      await summary.refresh({ remote: "never" });
    },
    [summary],
  );

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
    syncProgress,
    clearSyncProgress,
    buildPushPlan,
    pushAll,
    scanRepos: scan,
    isLoading: scanLoading || summary.isLoading,
  };
}
