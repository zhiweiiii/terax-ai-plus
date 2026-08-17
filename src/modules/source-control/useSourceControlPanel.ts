import {
  type GitChangedFile,
  type GitCommitResult,
  type GitDiscardEntry,
  type GitLogEntry,
  type GitRepoHead,
  type GitRepoInfo,
  type GitStatusSnapshot,
  native,
} from "@/lib/native";
import {
  invalidateDiff,
  invalidateRepoDiffs,
  workingDiffKey,
} from "@/modules/editor/lib/diffCache";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { repoDisplayName, type RepoStatusEntry } from "./useRepoStatuses";
import type { SourceControlSummary } from "./useSourceControl";

type PanelState = "closed" | "loading" | "no-repo" | "ready" | "error";
type DiffMode = "+" | "-";
type SelectionTransition = "none" | "moved-group" | "reset";

const RECONCILE_DEBOUNCE_MS = 180;

export type DiffSelection = {
  path: string;
  mode: DiffMode;
};

export type SourceControlEntry = {
  key: string;
  path: string;
  mode: DiffMode;
  indexStatus: string;
  worktreeStatus: string;
  statusLabel: string;
  statusCode: string;
  originalPath: string | null;
  untracked: boolean;
};

export type CheckState = "checked" | "indeterminate" | "unchecked";

/** One row per changed file (flat list) — merges the staged/unstaged split. */
export type SourceControlFileEntry = {
  key: string;
  /** Which repo the file belongs to; drives staging and diff in multi-repo. */
  repoRoot: string;
  path: string;
  originalPath: string | null;
  statusCode: string;
  statusLabel: string;
  checkState: CheckState;
  staged: boolean;
  unstaged: boolean;
  untracked: boolean;
};

/** One repo's slice of the change list, rendered under a group header. */
export type RepoFileGroup = {
  repoRoot: string;
  name: string;
  files: SourceControlFileEntry[];
};

export type PendingDiscard = {
  scope: "single" | "all";
  count: number;
  label: string;
};

type SourceControlPanelState = {
  panelState: PanelState;
  repo: GitRepoInfo | null;
  status: GitStatusSnapshot | null;
  selected: DiffSelection | null;
  commitMessage: string;
  actionBusy: string | null;
  statusError: string | null;
  actionError: string | null;
  remoteError: string | null;
  actionMessage: string | null;
  stagedEntries: SourceControlEntry[];
  unstagedEntries: SourceControlEntry[];
  fileEntries: SourceControlFileEntry[];
  /** Per-repo grouping for the change list; empty unless multi-repo. */
  repoGroups: RepoFileGroup[];
  headerCheckState: CheckState;
  allClean: boolean;
  canPush: boolean;
  pushHint: string | null;
  selectionTransition: SelectionTransition;
  stagedEmptyText: string;
  unstagedEmptyText: string;
  pendingDiscard: PendingDiscard | null;
  setCommitMessage: (value: string) => void;
  amendEnabled: boolean;
  setAmendEnabled: (value: boolean) => void;
  amendTargetSha: string | null;
  setAmendTargetSha: (value: string | null) => void;
  recentCommits: GitLogEntry[];
  refreshRecentCommits: () => Promise<void>;
  /** Specific-commit amend only makes sense on a single repository. */
  amendSpecificSupported: boolean;
  commitAndPush: () => Promise<void>;
  preCommitWarnings: string[] | null;
  confirmPreCommitWarnings: () => Promise<void>;
  cancelPreCommitWarnings: () => void;
  /** Active repo root when the last commit succeeded, enabling Reword. */
  rewordTarget: string | null;
  rewordOpen: boolean;
  rewordMessage: string;
  setRewordMessage: (value: string) => void;
  openReword: () => void;
  cancelReword: () => void;
  confirmReword: () => Promise<void>;
  refresh: () => Promise<void>;
  selectEntry: (entry: SourceControlEntry) => Promise<void>;
  selectFile: (entry: SourceControlFileEntry) => Promise<void>;
  stageEntry: (entry: SourceControlEntry) => Promise<void>;
  unstageEntry: (entry: SourceControlEntry) => Promise<void>;
  toggleStageFile: (entry: SourceControlFileEntry) => Promise<void>;
  toggleAll: () => Promise<void>;
  requestDiscardEntry: (entry: SourceControlEntry) => void;
  requestDiscardFile: (entry: SourceControlFileEntry) => void;
  requestDiscardAll: () => void;
  confirmPendingDiscard: () => Promise<void>;
  cancelPendingDiscard: () => void;
  stageAllEntries: () => Promise<void>;
  unstageAllEntries: () => Promise<void>;
  commit: () => Promise<void>;
  push: () => Promise<void>;
};

function normalizeError(error: unknown): string {
  if (typeof error === "string") return error;
  if (error && typeof error === "object" && "message" in error) {
    const message = (error as { message?: unknown }).message;
    if (typeof message === "string") return message;
  }
  return "Unknown source control error";
}

function normalizeStatusCode(status: string): string {
  const code = status.trim().toUpperCase();
  switch (code) {
    case "?":
      return "U";
    case "A":
      return "A";
    case "M":
      return "M";
    case "D":
      return "D";
    case "R":
    case "C":
      return "R";
    case "U":
      return "U";
    default:
      return code || "M";
  }
}

function statusCodeForMode(mode: DiffMode, file: GitChangedFile): string {
  if (mode === "-" && file.untracked) return "U";
  const primary = mode === "+" ? file.indexStatus : file.worktreeStatus;
  const fallback = mode === "+" ? file.worktreeStatus : file.indexStatus;
  return normalizeStatusCode(primary !== " " ? primary : fallback);
}

function makeEntry(
  path: string,
  mode: DiffMode,
  file: GitChangedFile,
): SourceControlEntry {
  return {
    key: `${mode}:${path}`,
    path,
    mode,
    indexStatus: file.indexStatus,
    worktreeStatus: file.worktreeStatus,
    statusLabel: file.statusLabel,
    statusCode: statusCodeForMode(mode, file),
    originalPath: file.originalPath,
    untracked: file.untracked,
  };
}

function sameSelection(
  a: DiffSelection | null,
  b: DiffSelection | null,
): boolean {
  return !!a && !!b && a.path === b.path && a.mode === b.mode;
}

function optimisticStage(
  status: GitStatusSnapshot,
  paths: Set<string>,
): GitStatusSnapshot {
  let changed = false;
  const next = status.changedFiles.map((file) => {
    if (!paths.has(file.path)) return file;
    if (file.staged && !file.unstaged) return file;
    changed = true;
    const wt =
      file.worktreeStatus !== " " ? file.worktreeStatus : file.indexStatus;
    return {
      ...file,
      indexStatus: wt,
      worktreeStatus: " ",
      staged: true,
      unstaged: false,
      untracked: false,
    };
  });
  if (!changed) return status;
  return { ...status, changedFiles: next };
}

function optimisticUnstage(
  status: GitStatusSnapshot,
  paths: Set<string>,
): GitStatusSnapshot {
  let changed = false;
  const next: GitChangedFile[] = [];
  for (const file of status.changedFiles) {
    if (!paths.has(file.path)) {
      next.push(file);
      continue;
    }
    if (!file.staged && file.unstaged) {
      next.push(file);
      continue;
    }
    changed = true;
    const idx =
      file.indexStatus !== " " ? file.indexStatus : file.worktreeStatus;
    if (idx === "R" && file.originalPath) {
      next.push({
        path: file.originalPath,
        originalPath: null,
        indexStatus: " ",
        worktreeStatus: "D",
        staged: false,
        unstaged: true,
        untracked: false,
        statusLabel: "Deleted",
      });
      next.push({
        path: file.path,
        originalPath: null,
        indexStatus: " ",
        worktreeStatus: "?",
        staged: false,
        unstaged: true,
        untracked: true,
        statusLabel: "Untracked",
      });
      continue;
    }
    next.push({
      ...file,
      originalPath: null,
      indexStatus: " ",
      worktreeStatus: idx === "A" ? "?" : idx,
      staged: false,
      unstaged: true,
      untracked: idx === "A",
    });
  }
  if (!changed) return status;
  return { ...status, changedFiles: next };
}

function optimisticDiscard(
  status: GitStatusSnapshot,
  paths: Set<string>,
): GitStatusSnapshot {
  let changed = false;
  const next: GitChangedFile[] = [];
  for (const file of status.changedFiles) {
    if (!paths.has(file.path)) {
      next.push(file);
      continue;
    }
    if (file.staged) {
      changed = true;
      next.push({
        ...file,
        worktreeStatus: " ",
        unstaged: false,
        untracked: false,
      });
    } else {
      changed = true;
    }
  }
  if (!changed) return status;
  return { ...status, changedFiles: next };
}

export type RepoStatusBundle = {
  entries: RepoStatusEntry[];
  applyStatus: (
    repoRoot: string,
    updater: (status: GitStatusSnapshot) => GitStatusSnapshot,
  ) => void;
  refreshRepo: (repoRoot: string) => Promise<void>;
  refreshAll: () => Promise<void>;
};

const NOOP_REPO_STATUSES: RepoStatusBundle = {
  entries: [],
  applyStatus: () => {},
  refreshRepo: async () => {},
  refreshAll: async () => {},
};

export function useSourceControlPanel(
  isOpen: boolean,
  summary: SourceControlSummary,
  onOpenDiff:
    | ((input: {
        path: string;
        repoRoot: string;
        mode: DiffMode;
        originalPath: string | null;
        title?: string;
      }) => void)
    | null,
  repos: GitRepoHead[] = [],
  repoStatuses: RepoStatusBundle = NOOP_REPO_STATUSES,
): SourceControlPanelState {
  const [panelState, setPanelState] = useState<PanelState>("closed");
  const [repo, setRepo] = useState<GitRepoInfo | null>(null);
  const [status, setStatus] = useState<GitStatusSnapshot | null>(null);
  const [selected, setSelected] = useState<DiffSelection | null>(null);
  const [commitMessage, setCommitMessage] = useState("");
  const [localActionBusy, setLocalActionBusy] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [actionMessage, setActionMessage] = useState<string | null>(null);
  const [selectionTransition, setSelectionTransition] =
    useState<SelectionTransition>("none");
  const [pendingDiscard, setPendingDiscard] = useState<
    | {
        scope: "single";
        repoRoot: string;
        entry: SourceControlEntry;
      }
    | { scope: "all"; repoRoot: string; entries: SourceControlEntry[] }
    | null
  >(null);
  const [amendEnabled, setAmendEnabled] = useState(false);
  const [amendTargetSha, setAmendTargetSha] = useState<string | null>(null);
  const [recentCommits, setRecentCommits] = useState<GitLogEntry[]>([]);
  const [preCommitWarnings, setPreCommitWarnings] = useState<string[] | null>(
    null,
  );
  const [pendingCommitAndPush, setPendingCommitAndPush] = useState(false);
  const [rewordTarget, setRewordTarget] = useState<string | null>(null);
  const [rewordOpen, setRewordOpen] = useState(false);
  const [rewordMessage, setRewordMessage] = useState("");
  const selectedRef = useRef<DiffSelection | null>(null);
  const reconcileTimerRef = useRef(0);
  const recentCommitsRequestRef = useRef(0);
  const repoRootRef = useRef<string | null>(null);
  const branchRef = useRef<string | null>(null);

  useEffect(() => {
    selectedRef.current = selected;
  }, [selected]);

  const stagedEntries = useMemo(
    () =>
      (status?.changedFiles ?? [])
        .filter((file) => file.staged)
        .map((file) => makeEntry(file.path, "+", file)),
    [status],
  );

  const unstagedEntries = useMemo(
    () =>
      (status?.changedFiles ?? [])
        .filter((file) => file.unstaged)
        .map((file) => makeEntry(file.path, "-", file)),
    [status],
  );

  // Every repo in the workspace, so the change list is not limited to whichever
  // one the selector happens to point at. Statuses are owned by the multi-repo
  // layer (useMultiRepoSourceControl) so the badge, the list and the explorer
  // decorations all read the same numbers.
  const multiRepo = repos.length > 1;
  const {
    entries: repoStatusEntries,
    applyStatus: applyOtherStatus,
    refreshRepo: refreshOtherRepo,
    refreshAll: refreshOtherRepos,
  } = repoStatuses;

  const activeRepoRoot = repo?.repoRoot ?? null;

  function entriesForStatus(
    repoRoot: string,
    snapshot: GitStatusSnapshot,
  ): SourceControlFileEntry[] {
    const seen = new Set<string>();
    const out: SourceControlFileEntry[] = [];
    for (const file of snapshot.changedFiles) {
      if (seen.has(file.path)) continue;
      seen.add(file.path);
      const checkState: CheckState =
        file.staged && file.unstaged
          ? "indeterminate"
          : file.staged
            ? "checked"
            : "unchecked";
      const statusCode = file.unstaged
        ? statusCodeForMode("-", file)
        : statusCodeForMode("+", file);
      out.push({
        // Paths repeat across repos, so the row key has to carry the repo too.
        key: `${repoRoot}\u0000${file.path}`,
        repoRoot,
        path: file.path,
        originalPath: file.originalPath,
        statusCode,
        statusLabel: file.statusLabel,
        checkState,
        staged: file.staged,
        unstaged: file.unstaged,
        untracked: file.untracked,
      });
    }
    return out;
  }

  const repoGroups = useMemo<RepoFileGroup[]>(() => {
    if (!multiRepo) return [];
    return repoStatusEntries.map((entry) => ({
      repoRoot: entry.repoRoot,
      name: entry.name,
      files: entriesForStatus(entry.repoRoot, entry.status),
    }));
  }, [multiRepo, repoStatusEntries]);

  const fileEntries = useMemo<SourceControlFileEntry[]>(() => {
    if (multiRepo) return repoGroups.flatMap((g) => g.files);
    if (!status || !activeRepoRoot) return [];
    return entriesForStatus(activeRepoRoot, status);
  }, [multiRepo, repoGroups, status, activeRepoRoot]);

  const headerCheckState = useMemo<CheckState>(() => {
    if (fileEntries.length === 0) return "unchecked";
    const allChecked = fileEntries.every((e) => e.checkState === "checked");
    if (allChecked) return "checked";
    const anyStaged = fileEntries.some((e) => e.staged);
    return anyStaged ? "indeterminate" : "unchecked";
  }, [fileEntries]);

  // Must read the aggregate, not the active repo: with the panel anchored on
  // repos[0], a clean first repo made this true and the whole list collapsed
  // into the "nothing to commit" hint while other repos had changes waiting.
  const allClean = fileEntries.length === 0;
  const canPush = !!status?.upstream && status.behind === 0;
  const pushHint = useMemo(() => {
    if (!status) return null;
    if (!status.upstream) {
      return "Configure or publish this branch in the terminal to enable push in this iteration.";
    }
    if (status.behind > 0) {
      return "Pull remote changes before pushing local commits.";
    }
    if (status.ahead === 0) {
      return `No local commits to push to ${status.upstream}.`;
    }
    return `Pushes to ${status.upstream}.`;
  }, [status]);
  const stagedEmptyText = "No staged changes";
  const unstagedEmptyText = "No unstaged changes";

  const cancelReconcile = useCallback(() => {
    if (reconcileTimerRef.current) {
      window.clearTimeout(reconcileTimerRef.current);
      reconcileTimerRef.current = 0;
    }
  }, []);

  const scheduleReconcile = useCallback(() => {
    cancelReconcile();
    reconcileTimerRef.current = window.setTimeout(() => {
      reconcileTimerRef.current = 0;
      void summary.refresh({ remote: "never" });
    }, RECONCILE_DEBOUNCE_MS);
  }, [cancelReconcile, summary]);

  useEffect(() => () => cancelReconcile(), [cancelReconcile]);

  const openSelection = useCallback(
    (
      sel: DiffSelection,
      repoRoot: string,
      file: GitChangedFile | undefined,
    ) => {
      onOpenDiff?.({
        path: sel.path,
        repoRoot,
        mode: sel.mode,
        originalPath: file?.originalPath ?? null,
      });
    },
    [onOpenDiff],
  );

  const refresh = useCallback(async () => {
    if (!isOpen) {
      setPanelState("closed");
      setSelectionTransition("none");
      return;
    }
    if (summary.repo) invalidateRepoDiffs(summary.repo.repoRoot);
    await summary.refresh({ remote: "never" });
  }, [isOpen, summary]);

  useEffect(() => {
    if (!isOpen) {
      setPanelState("closed");
      setSelectionTransition("none");
      return;
    }
    if (summary.isLoading && !summary.hasRepo && !summary.status) {
      setPanelState("loading");
      return;
    }
    if (!summary.hasRepo) {
      setRepo(null);
      setStatus(null);
      setSelected(null);
      setPanelState("no-repo");
      setSelectionTransition("none");
      if (repoRootRef.current !== null) {
        repoRootRef.current = null;
        branchRef.current = null;
        setAmendTargetSha(null);
        setRewordTarget(null);
      }
      return;
    }
    if (summary.localError && !summary.status) {
      setRepo(summary.repo);
      setStatus(null);
      setSelected(null);
      setPanelState("error");
      setSelectionTransition("none");
      return;
    }
    if (!summary.repo || !summary.status) {
      if (summary.isLoading) {
        setPanelState("loading");
      }
      return;
    }

    setRepo(summary.repo);
    setStatus(summary.status);
    setPanelState("ready");

    if (repoRootRef.current !== summary.repo.repoRoot) {
      repoRootRef.current = summary.repo.repoRoot;
      setAmendTargetSha(null);
      setRewordTarget(null);
    }
    if (branchRef.current !== summary.status.branch) {
      branchRef.current = summary.status.branch;
      setAmendTargetSha(null);
      setRewordTarget(null);
    }

    const current = selectedRef.current;
    const exists =
      !!current &&
      summary.status.changedFiles.some((file) => {
        if (file.path !== current.path) return false;
        return current.mode === "+" ? file.staged : file.unstaged;
      });

    if (!exists && current) {
      const samePathOtherMode = summary.status.changedFiles.find(
        (file) =>
          file.path === current.path &&
          (current.mode === "+" ? file.unstaged : file.staged),
      );
      if (samePathOtherMode) {
        const moved: DiffSelection = {
          path: samePathOtherMode.path,
          mode: current.mode === "+" ? "-" : "+",
        };
        setSelected(moved);
        setSelectionTransition("moved-group");
      } else {
        setSelected(null);
        setSelectionTransition("reset");
      }
    } else {
      setSelectionTransition("none");
    }
  }, [
    isOpen,
    summary.hasRepo,
    summary.isLoading,
    summary.localError,
    summary.repo,
    summary.status,
  ]);

  const selectEntry = useCallback(
    async (entry: SourceControlEntry) => {
      if (!repo) return;
      const nextSelection: DiffSelection = {
        path: entry.path,
        mode: entry.mode,
      };
      if (sameSelection(selected, nextSelection)) {
        setActionError(null);
        setActionMessage(null);
        setSelectionTransition("none");
        return;
      }
      setSelected(nextSelection);
      setActionError(null);
      setActionMessage(null);
      setSelectionTransition("none");
      const file = status?.changedFiles.find((c) => c.path === entry.path);
      openSelection(nextSelection, repo.repoRoot, file);
    },
    [openSelection, repo, selected, status],
  );

  const runMutation = useCallback(
    async (
      busyKey: string,
      optimistic: ((status: GitStatusSnapshot) => GitStatusSnapshot) | null,
      ipc: () => Promise<void>,
      affected: string[],
      // Defaults to the active repo so every single-repo caller is unchanged.
      targetRepoRoot?: string,
    ) => {
      const root = targetRepoRoot ?? repo?.repoRoot;
      if (!root || summary.busyAction) return;
      const isActive = root === repo?.repoRoot;
      setLocalActionBusy(busyKey);
      setActionMessage(null);
      setActionError(null);
      if (optimistic) {
        if (isActive) summary.applyStatus(optimistic);
        else applyOtherStatus(root, optimistic);
      }
      for (const path of affected) {
        invalidateDiff(workingDiffKey(root, path, "+"));
        invalidateDiff(workingDiffKey(root, path, "-"));
      }
      try {
        await ipc();
        // Only the active repo has the debounced reconcile behind it; a
        // secondary repo has to be re-read directly or its optimistic state
        // would be the last word.
        if (isActive) scheduleReconcile();
        else await refreshOtherRepo(root);
      } catch (error) {
        setActionError(normalizeError(error));
        if (isActive) {
          cancelReconcile();
          await summary.refresh({ remote: "never" }).catch(() => {});
        } else {
          await refreshOtherRepo(root);
        }
      } finally {
        setLocalActionBusy(null);
      }
    },
    [
      applyOtherStatus,
      cancelReconcile,
      refreshOtherRepo,
      repo,
      scheduleReconcile,
      summary,
    ],
  );

  const stageEntry = useCallback(
    async (entry: SourceControlEntry) => {
      if (!repo) return;
      const paths = new Set([entry.path]);
      await runMutation(
        `stage:${entry.path}`,
        (s) => optimisticStage(s, paths),
        () => native.gitStage(repo.repoRoot, [entry.path]),
        [entry.path],
      );
    },
    [repo, runMutation],
  );

  const unstageEntry = useCallback(
    async (entry: SourceControlEntry) => {
      if (!repo) return;
      const paths = new Set([entry.path]);
      await runMutation(
        `unstage:${entry.path}`,
        (s) => optimisticUnstage(s, paths),
        () => native.gitUnstage(repo.repoRoot, [entry.path]),
        [entry.path],
      );
    },
    [repo, runMutation],
  );

  const requestDiscardEntry = useCallback(
    (entry: SourceControlEntry) => {
      if (!repo || summary.busyAction) return;
      setPendingDiscard({ scope: "single", repoRoot: repo.repoRoot, entry });
    },
    [repo, summary.busyAction],
  );

  const requestDiscardAll = useCallback(() => {
    if (!repo || summary.busyAction || unstagedEntries.length === 0) return;
    setPendingDiscard({
      scope: "all",
      repoRoot: repo.repoRoot,
      entries: unstagedEntries,
    });
  }, [repo, summary.busyAction, unstagedEntries]);

  const cancelPendingDiscard = useCallback(() => {
    setPendingDiscard(null);
  }, []);

  const confirmPendingDiscard = useCallback(async () => {
    if (!repo || !pendingDiscard) return;
    const list =
      pendingDiscard.scope === "single"
        ? [pendingDiscard.entry]
        : pendingDiscard.entries;
    const discardRepoRoot = pendingDiscard.repoRoot;
    setPendingDiscard(null);
    const entries: GitDiscardEntry[] = list.map((entry) => ({
      path: entry.path,
      untracked: entry.untracked,
    }));
    const paths = new Set(list.map((entry) => entry.path));
    await runMutation(
      pendingDiscard.scope === "single"
        ? `discard:${list[0].path}`
        : "discard:all",
      (s) => optimisticDiscard(s, paths),
      () => native.gitDiscard(discardRepoRoot, entries),
      [...paths],
      discardRepoRoot,
    );
  }, [pendingDiscard, repo, runMutation]);

  // Select-all spans every repo in multi-repo mode, one repo per call so each
  // gets its own optimistic update and reconcile.
  const stageAllEntries = useCallback(async () => {
    if (multiRepo) {
      for (const group of repoGroups) {
        const paths = new Set(
          group.files.filter((f) => f.unstaged).map((f) => f.path),
        );
        if (paths.size === 0) continue;
        await runMutation(
          `stage:all:${group.repoRoot}`,
          (s) => optimisticStage(s, paths),
          () => native.gitStage(group.repoRoot, [...paths]),
          [...paths],
          group.repoRoot,
        );
      }
      return;
    }
    if (!repo || unstagedEntries.length === 0) return;
    const paths = new Set(unstagedEntries.map((entry) => entry.path));
    await runMutation(
      "stage:all",
      (s) => optimisticStage(s, paths),
      () => native.gitStage(repo.repoRoot, [...paths]),
      [...paths],
    );
  }, [multiRepo, repo, repoGroups, runMutation, unstagedEntries]);

  const unstageAllEntries = useCallback(async () => {
    if (multiRepo) {
      for (const group of repoGroups) {
        const paths = new Set(
          group.files.filter((f) => f.staged).map((f) => f.path),
        );
        if (paths.size === 0) continue;
        await runMutation(
          `unstage:all:${group.repoRoot}`,
          (s) => optimisticUnstage(s, paths),
          () => native.gitUnstage(group.repoRoot, [...paths]),
          [...paths],
          group.repoRoot,
        );
      }
      return;
    }
    if (!repo || stagedEntries.length === 0) return;
    const paths = new Set(stagedEntries.map((entry) => entry.path));
    await runMutation(
      "unstage:all",
      (s) => optimisticUnstage(s, paths),
      () => native.gitUnstage(repo.repoRoot, [...paths]),
      [...paths],
    );
  }, [multiRepo, repo, repoGroups, runMutation, stagedEntries]);

  const selectFile = useCallback(
    async (entry: SourceControlFileEntry) => {
      const root = entry.repoRoot || repo?.repoRoot;
      if (!root) return;
      const mode: DiffMode = entry.unstaged ? "-" : "+";
      const nextSelection: DiffSelection = { path: entry.path, mode };
      if (sameSelection(selected, nextSelection)) {
        setActionError(null);
        setActionMessage(null);
        setSelectionTransition("none");
        return;
      }
      setSelected(nextSelection);
      setActionError(null);
      setActionMessage(null);
      setSelectionTransition("none");
      const source =
        root === repo?.repoRoot
          ? status
          : (repoStatusEntries.find((e) => e.repoRoot === root)?.status ??
            null);
      const file = source?.changedFiles.find((c) => c.path === entry.path);
      openSelection(nextSelection, root, file);
    },
    [openSelection, repo, repoStatusEntries, selected, status],
  );

  const toggleStageFile = useCallback(
    async (entry: SourceControlFileEntry) => {
      const root = entry.repoRoot || repo?.repoRoot;
      if (!root) return;
      const paths = new Set([entry.path]);
      if (entry.checkState === "checked") {
        await runMutation(
          `unstage:${entry.key}`,
          (s) => optimisticUnstage(s, paths),
          () => native.gitUnstage(root, [entry.path]),
          [entry.path],
          root,
        );
      } else {
        await runMutation(
          `stage:${entry.key}`,
          (s) => optimisticStage(s, paths),
          () => native.gitStage(root, [entry.path]),
          [entry.path],
          root,
        );
      }
    },
    [repo, runMutation],
  );

  const toggleAll = useCallback(async () => {
    if (headerCheckState === "checked") await unstageAllEntries();
    else await stageAllEntries();
  }, [headerCheckState, stageAllEntries, unstageAllEntries]);

  const requestDiscardFile = useCallback(
    (entry: SourceControlFileEntry) => {
      if (!repo || summary.busyAction) return;
      setPendingDiscard({
        scope: "single",
        repoRoot: entry.repoRoot || repo.repoRoot,
        entry: {
          key: `-:${entry.path}`,
          path: entry.path,
          mode: "-",
          indexStatus: " ",
          worktreeStatus: entry.statusCode,
          statusLabel: entry.statusLabel,
          statusCode: entry.statusCode,
          originalPath: entry.originalPath,
          untracked: entry.untracked,
        },
      });
    },
    [repo, summary.busyAction],
  );

  const runCommit = useCallback(
    async (andPush: boolean, skipChecks: boolean) => {
      if (summary.busyAction) return;
      // Busy state goes up BEFORE the async pre-commit checks so the Commit
      // button flips to "Committing…" on the very click, not after the check
      // IPC round-trip (which can take a while with hooks installed).
      const busyKey = andPush ? "commit-and-push" : "commit";
      setLocalActionBusy(busyKey);
      setActionMessage(null);
      setActionError(null);

      const targetSha = amendEnabled ? (amendTargetSha ?? "") : "";
      const specificAmend = targetSha !== "";
      // Repos with nothing staged are skipped rather than erroring: "commit
      // everything I checked" should not fail because some group is untouched.
      const targets = specificAmend
        ? repo
          ? [{ repoRoot: repo.repoRoot, name: repoDisplayName(repo.repoRoot) }]
          : []
        : multiRepo
          ? repoGroups
              .filter((g) => g.files.some((f) => f.staged))
              .map((g) => ({ repoRoot: g.repoRoot, name: g.name }))
          : repo
            ? [
                {
                  repoRoot: repo.repoRoot,
                  name: repoDisplayName(repo.repoRoot),
                },
              ]
            : [];
      if (targets.length === 0) {
        setLocalActionBusy(null);
        return;
      }

      if (!skipChecks) {
        try {
          const checks = await Promise.all(
            targets.map((target) => native.gitPreCommitChecks(target.repoRoot)),
          );
          const warnings = [
            ...new Set(
              checks.flatMap((check, index) =>
                multiRepo
                  ? check.warnings.map(
                      (warning) => `${targets[index].name}: ${warning}`,
                    )
                  : check.warnings,
              ),
            ),
          ];
          if (warnings.length > 0) {
            // The confirmation dialog re-invokes runCommit with skipChecks;
            // until then nothing is running, so release the busy state.
            setLocalActionBusy(null);
            setPendingCommitAndPush(andPush);
            setPreCommitWarnings(warnings);
            return;
          }
        } catch {
          // Pre-commit check tooling missing: the commit proceeds unchanged.
        }
      }

      setRewordTarget(null);
      const done: string[] = [];
      const failed: { name: string; error: string }[] = [];
      try {
        // Amend reuses the previous message when the box is empty, mirroring
        // `git commit --amend --no-edit`.
        let effectiveMessage = commitMessage.trim();
        if (!effectiveMessage && amendEnabled) {
          if (specificAmend) {
            effectiveMessage =
              recentCommits.find((c) => c.sha === targetSha)?.subject ?? "";
          } else {
            const log = await native.gitLog(targets[0].repoRoot, { limit: 1 });
            effectiveMessage = log[0]?.subject ?? "";
          }
        }
        // Sequential: a shared commit message still means N independent commits,
        // and stopping mid-way has to leave a legible record of how far it got.
        for (const target of targets) {
          try {
            const result: GitCommitResult = specificAmend
              ? await native.gitAmendSpecificCommit(
                  target.repoRoot,
                  targetSha,
                  effectiveMessage,
                )
              : await native.gitCommitAdvanced(
                  target.repoRoot,
                  effectiveMessage,
                  {
                    amend: amendEnabled,
                  },
                );
            invalidateRepoDiffs(target.repoRoot);
            done.push(`${target.name} ${result.commitSha.slice(0, 7)}`);
          } catch (error) {
            failed.push({ name: target.name, error: normalizeError(error) });
          }
        }
        let pushError: string | null = null;
        if (andPush && failed.length === 0) {
          const pushResult = await summary.runRemoteAction("push");
          if (!pushResult.ok && pushResult.error) pushError = pushResult.error;
        }
        if (failed.length === 0) {
          setCommitMessage("");
          if (!multiRepo && targets.length === 1) {
            setRewordTarget(targets[0].repoRoot);
          }
        }
        if (done.length > 0) {
          const base =
            targets.length === 1
              ? `Committed ${done[0]}`
              : `Committed ${done.length}/${targets.length} repos: ${done.join(", ")}`;
          const message = amendEnabled
            ? specificAmend
              ? `${base} (merged into ${targetSha.slice(0, 7)})`
              : `${base} (merged into recent commit)`
            : base;
          setActionMessage(
            andPush && !pushError
              ? `${message} and pushed${
                  summary.status?.upstream
                    ? ` to ${summary.status.upstream}`
                    : ""
                }`
              : message,
          );
        }
        if (failed.length > 0) {
          setActionError(failed.map((f) => `${f.name}: ${f.error}`).join("; "));
        }
        if (pushError) setActionError(pushError);
        await summary.refresh({ remote: "never" });
        if (multiRepo) await refreshOtherRepos();
      } finally {
        setLocalActionBusy(null);
      }
    },
    [
      amendEnabled,
      amendTargetSha,
      commitMessage,
      multiRepo,
      recentCommits,
      refreshOtherRepos,
      repo,
      repoGroups,
      summary,
    ],
  );

  const commit = useCallback(async () => {
    await runCommit(false, false);
  }, [runCommit]);

  const commitAndPush = useCallback(async () => {
    await runCommit(true, false);
  }, [runCommit]);

  const confirmPreCommitWarnings = useCallback(async () => {
    setPreCommitWarnings(null);
    await runCommit(pendingCommitAndPush, true);
  }, [pendingCommitAndPush, runCommit]);

  const cancelPreCommitWarnings = useCallback(() => {
    setPreCommitWarnings(null);
    setPendingCommitAndPush(false);
  }, []);

  const openReword = useCallback(() => {
    if (!rewordTarget || summary.busyAction) return;
    setRewordMessage("");
    setActionError(null);
    setRewordOpen(true);
  }, [rewordTarget, summary.busyAction]);

  const cancelReword = useCallback(() => {
    setRewordOpen(false);
    setRewordMessage("");
  }, []);

  const confirmReword = useCallback(async () => {
    if (!rewordTarget || summary.busyAction) return;
    const message = rewordMessage.trim();
    if (!message) return;
    setLocalActionBusy("reword");
    setActionError(null);
    try {
      await native.gitCommitReword(rewordTarget, message);
      invalidateRepoDiffs(rewordTarget);
      setRewordOpen(false);
      setRewordMessage("");
      setActionMessage("Reworded the commit message");
      await summary.refresh({ remote: "never" });
      if (multiRepo) await refreshOtherRepos();
    } catch (error) {
      setActionError(normalizeError(error));
    } finally {
      setLocalActionBusy(null);
    }
  }, [multiRepo, refreshOtherRepos, rewordMessage, rewordTarget, summary]);

  const push = useCallback(async () => {
    if (!repo) return;
    setActionMessage(null);
    setActionError(null);
    const result = await summary.runRemoteAction("push");
    if (result.ok) {
      setActionMessage(
        status?.upstream ? `Pushed to ${status.upstream}` : "Push completed",
      );
      return;
    }
    if (result.error) {
      setActionError(result.error);
    }
  }, [repo, status?.upstream, summary]);

  const refreshRecentCommits = useCallback(async () => {
    if (!repo) {
      setRecentCommits([]);
      return;
    }
    const id = ++recentCommitsRequestRef.current;
    try {
      const log = await native.gitLog(repo.repoRoot, { limit: 30 });
      if (id !== recentCommitsRequestRef.current) return;
      setRecentCommits(log);
    } catch {
      if (id === recentCommitsRequestRef.current) setRecentCommits([]);
    }
  }, [repo]);

  useEffect(() => {
    if (amendEnabled) void refreshRecentCommits();
  }, [amendEnabled, refreshRecentCommits]);

  const pendingDiscardView = useMemo<PendingDiscard | null>(() => {
    if (!pendingDiscard) return null;
    if (pendingDiscard.scope === "single") {
      return {
        scope: "single",
        count: 1,
        label: pendingDiscard.entry.path,
      };
    }
    return {
      scope: "all",
      count: pendingDiscard.entries.length,
      label: `${pendingDiscard.entries.length} unstaged ${
        pendingDiscard.entries.length === 1 ? "file" : "files"
      }`,
    };
  }, [pendingDiscard]);

  return {
    panelState,
    repo,
    status,
    selected,
    commitMessage,
    actionBusy: localActionBusy ?? summary.busyAction,
    statusError: summary.localError,
    actionError,
    remoteError: summary.lastRemoteError,
    actionMessage,
    stagedEntries,
    unstagedEntries,
    fileEntries,
    repoGroups,
    headerCheckState,
    allClean,
    canPush,
    pushHint,
    selectionTransition,
    stagedEmptyText,
    unstagedEmptyText,
    pendingDiscard: pendingDiscardView,
    setCommitMessage,
    amendEnabled,
    setAmendEnabled,
    amendTargetSha,
    setAmendTargetSha,
    recentCommits,
    refreshRecentCommits,
    amendSpecificSupported: !multiRepo,
    commitAndPush,
    preCommitWarnings,
    confirmPreCommitWarnings,
    cancelPreCommitWarnings,
    rewordTarget,
    rewordOpen,
    rewordMessage,
    setRewordMessage,
    openReword,
    cancelReword,
    confirmReword,
    refresh,
    selectEntry,
    selectFile,
    stageEntry,
    unstageEntry,
    toggleStageFile,
    toggleAll,
    requestDiscardEntry,
    requestDiscardFile,
    requestDiscardAll,
    confirmPendingDiscard,
    cancelPendingDiscard,
    stageAllEntries,
    unstageAllEntries,
    commit,
    push,
  };
}
