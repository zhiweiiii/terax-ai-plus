import {
  type GitRepoInfo,
  type GitStatusSnapshot,
  native,
} from "@/lib/native";
import { useWorkspaceEnvStore, workspaceScopeKey } from "@/modules/workspace";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

const AUTO_FETCH_THROTTLE_MS = 5 * 60_000;
const AUTO_FETCH_LRU_LIMIT = 16;
const FOCUS_REFRESH_MIN_INTERVAL_MS = 1500;
// Skip the context-change refetch when the data is this fresh and the new path
// is still inside the loaded repo (cd-within-repo produces identical status).
const SC_STATUS_TTL_MS = 2000;

export type SourceControlRefreshMode = "auto" | "always" | "never";
export type SourceControlRemoteAction = "fetch" | "pull" | "push";
/**
 * "sync" is fetch followed by a fast-forward pull when the fetch revealed new
 * upstream commits. Plain "pull" can only run once something already told git
 * it was behind, which made pulling a two-click affair.
 */
export type SourceControlRemoteActionMode =
  | "contextual"
  | "sync"
  | SourceControlRemoteAction;

export type SourceControlRemoteActionResult = {
  ok: boolean;
  action: SourceControlRemoteAction | null;
  error?: string;
  blocked?: "diverged" | "missing-upstream" | "no-repo";
};

export type SourceControlSummary = {
  contextPath: string | null;
  repo: GitRepoInfo | null;
  status: GitStatusSnapshot | null;
  changedCount: number;
  upstream: string | null;
  ahead: number;
  behind: number;
  hasRepo: boolean;
  isLoading: boolean;
  localError: string | null;
  busyAction: SourceControlRemoteAction | null;
  lastRemoteError: string | null;
  applyStatus: (
    updater: (status: GitStatusSnapshot) => GitStatusSnapshot,
  ) => void;
  refresh: (options?: { remote?: SourceControlRefreshMode }) => Promise<void>;
  runRemoteAction: (
    mode?: SourceControlRemoteActionMode,
  ) => Promise<SourceControlRemoteActionResult>;
};

export type SourceControlRemoteIndicator = {
  visible: boolean;
  label: string;
  title: string;
  disabled: boolean;
  action: SourceControlRemoteAction | null;
};

type SourceControlSummaryState = {
  contextPath: string | null;
  repo: GitRepoInfo | null;
  status: GitStatusSnapshot | null;
  hasRepo: boolean;
  isLoading: boolean;
  localError: string | null;
  busyAction: SourceControlRemoteAction | null;
  lastRemoteError: string | null;
};

type RefreshableSourceControlState = Pick<
  SourceControlSummaryState,
  | "contextPath"
  | "repo"
  | "status"
  | "hasRepo"
  | "isLoading"
  | "localError"
  | "lastRemoteError"
>;

type InflightRefresh = {
  contextKey: string;
  mode: SourceControlRefreshMode;
  promise: Promise<void>;
};

function sourceControlContextKey(
  workspaceKey: string,
  contextPath: string | null,
): string {
  return `${workspaceKey}\0${contextPath ?? ""}`;
}

function normalizedContextPath(path: string): string {
  const normalized = path.replace(/\\/g, "/");
  if (normalized === "/" || /^[A-Za-z]:\/$/.test(normalized)) {
    return normalized;
  }
  return normalized.replace(/\/+$/, "");
}

export function repositoryContainsContext(
  repoRoot: string | null,
  contextPath: string | null,
): boolean {
  if (!repoRoot || !contextPath) return false;
  let root = normalizedContextPath(repoRoot);
  let context = normalizedContextPath(contextPath);
  const windowsPaths =
    (/^[A-Za-z]:\//.test(root) && /^[A-Za-z]:\//.test(context)) ||
    (root.startsWith("//") && context.startsWith("//"));
  if (windowsPaths) {
    root = root.toLowerCase();
    context = context.toLowerCase();
  }
  const prefix = root.endsWith("/") ? root : `${root}/`;
  return context === root || context.startsWith(prefix);
}

export function beginSourceControlRefresh<
  T extends RefreshableSourceControlState,
>(current: T, contextPath: string, reuseCurrentRepository: boolean): T {
  return {
    ...current,
    contextPath,
    repo: reuseCurrentRepository ? current.repo : null,
    status: reuseCurrentRepository ? current.status : null,
    hasRepo: reuseCurrentRepository ? current.hasRepo : false,
    isLoading: true,
    localError: null,
    lastRemoteError: reuseCurrentRepository ? current.lastRemoteError : null,
  };
}

function normalizeError(error: unknown): string {
  if (typeof error === "string") return error;
  if (error && typeof error === "object" && "message" in error) {
    const message = (error as { message?: unknown }).message;
    if (typeof message === "string") return message;
  }
  return "Unknown source control error";
}

/** True when a fast-forward pull would actually move the branch. */
export function canFastForward(
  status: Pick<GitStatusSnapshot, "upstream" | "ahead" | "behind"> | null,
): boolean {
  if (!status?.upstream) return false;
  return status.behind > 0 && status.ahead === 0;
}

function getContextualAction(
  status: GitStatusSnapshot | null,
): SourceControlRemoteAction | null {
  if (!status?.upstream) return null;
  if (status.ahead > 0 && status.behind > 0) return null;
  if (status.behind > 0) return "pull";
  if (status.ahead > 0) return "push";
  return "fetch";
}

export function getSourceControlRemoteIndicator(
  summary: Pick<
    SourceControlSummary,
    "hasRepo" | "upstream" | "ahead" | "behind" | "busyAction"
  >,
): SourceControlRemoteIndicator {
  if (!summary.hasRepo || !summary.upstream) {
    return {
      visible: false,
      label: "",
      title: "",
      disabled: true,
      action: null,
    };
  }
  if (summary.ahead > 0 && summary.behind > 0) {
    return {
      visible: true,
      label: `↑${summary.ahead} ↓${summary.behind}`,
      title:
        "Branch has diverged from upstream. Use Source Control or the terminal to resolve it.",
      disabled: true,
      action: null,
    };
  }
  if (summary.behind > 0) {
    return {
      visible: true,
      label: `↓${summary.behind}`,
      title: `Pull ${summary.behind} remote ${
        summary.behind === 1 ? "commit" : "commits"
      } with fast-forward only.`,
      disabled: summary.busyAction !== null,
      action: "pull",
    };
  }
  if (summary.ahead > 0) {
    return {
      visible: true,
      label: `↑${summary.ahead}`,
      title: `Push ${summary.ahead} local ${
        summary.ahead === 1 ? "commit" : "commits"
      }.`,
      disabled: summary.busyAction !== null,
      action: "push",
    };
  }
  return {
    visible: true,
    label: "Sync",
    title: "Fetch remote updates.",
    disabled: summary.busyAction !== null,
    action: "fetch",
  };
}

function touchAutoFetch(map: Map<string, number>, key: string): void {
  map.delete(key);
  map.set(key, Date.now());
  while (map.size > AUTO_FETCH_LRU_LIMIT) {
    const oldest = map.keys().next().value;
    if (oldest === undefined) break;
    map.delete(oldest);
  }
}

export function useSourceControl(
  contextPath: string | null,
  enabled?: boolean,
  repoRoot?: string | null,
): SourceControlSummary {
  const _enabled = enabled ?? true;
  const workspaceEnv = useWorkspaceEnvStore((s) => s.env);
  const workspaceKey = workspaceScopeKey(workspaceEnv);
  const [state, setState] = useState<SourceControlSummaryState>({
    contextPath: null,
    repo: null,
    status: null,
    hasRepo: false,
    isLoading: false,
    localError: null,
    busyAction: null,
    lastRemoteError: null,
  });
  const stateRef = useRef(state);
  const requestIdRef = useRef(0);
  const inflightRef = useRef<InflightRefresh | null>(null);
  const autoFetchByRepoRef = useRef(new Map<string, number>());
  const enabledRef = useRef(_enabled);
  const lastRefreshAtRef = useRef(0);
  const resetWorkspaceKeyRef = useRef(workspaceKey);
  const repoRootRef = useRef(repoRoot ?? null);
  const contextKey = sourceControlContextKey(workspaceKey, contextPath);
  const contextKeyRef = useRef(contextKey);
  contextKeyRef.current = contextKey;

  useEffect(() => {
    stateRef.current = state;
  }, [state]);

  useEffect(() => {
    enabledRef.current = _enabled;
  }, [_enabled]);

  useEffect(() => {
    repoRootRef.current = repoRoot ?? null;
  }, [repoRoot]);

  useEffect(() => {
    if (resetWorkspaceKeyRef.current === workspaceKey) return;
    resetWorkspaceKeyRef.current = workspaceKey;
    requestIdRef.current++;
    inflightRef.current = null;
    autoFetchByRepoRef.current.clear();
    setState({
      contextPath: null,
      repo: null,
      status: null,
      hasRepo: false,
      isLoading: false,
      localError: null,
      busyAction: null,
      lastRemoteError: null,
    });
  }, [workspaceKey]);

  const applyStatus = useCallback(
    (updater: (status: GitStatusSnapshot) => GitStatusSnapshot) => {
      setState((current) => {
        if (!current.status) return current;
        const next = updater(current.status);
        if (next === current.status) return current;
        return { ...current, status: next };
      });
    },
    [],
  );

  const doRefresh = useCallback(
    async (remoteMode: SourceControlRefreshMode): Promise<void> => {
      const refreshContextKey = contextKey;
      if (!enabledRef.current || refreshContextKey !== contextKeyRef.current) {
        return;
      }
      const requestId = ++requestIdRef.current;
      const isCurrentRequest = () =>
        requestId === requestIdRef.current &&
        refreshContextKey === contextKeyRef.current;

      if (!contextPath) {
        if (!isCurrentRequest()) return;
        setState({
          contextPath: null,
          repo: null,
          status: null,
          hasRepo: false,
          isLoading: false,
          localError: null,
          busyAction: null,
          lastRemoteError: null,
        });
        return;
      }

      const activeRoot = stateRef.current.repo?.repoRoot ?? null;
      const explicitRoot = repoRootRef.current;
      const reusableRoot =
        explicitRoot ||
        (repositoryContainsContext(activeRoot, contextPath)
          ? activeRoot
          : null);

      setState((current) =>
        beginSourceControlRefresh(current, contextPath, !!reusableRoot),
      );

      try {
        let repo: GitRepoInfo | null;
        let status: GitStatusSnapshot | null;

        // Explicit repo root: skip panel_snapshot and go directly to status.
        if (explicitRoot) {
          try {
            status = await native.gitStatus(explicitRoot);
            if (!isCurrentRequest()) return;
            repo = {
              repoRoot: explicitRoot,
              branch: status.branch,
              upstream: status.upstream,
              isDetached: status.isDetached,
            };
          } catch {
            if (!isCurrentRequest()) return;
            setState((current) => ({
              ...current,
              repo: null,
              status: null,
              hasRepo: false,
              isLoading: false,
              localError: null,
            }));
            return;
          }
        } else if (reusableRoot) {
          try {
            repo = stateRef.current.repo ?? null;
            status = await native.gitStatus(reusableRoot);
            if (!isCurrentRequest()) return;
            if (!repo || repo.repoRoot !== reusableRoot) {
              repo = {
                repoRoot: reusableRoot,
                branch: status.branch,
                upstream: status.upstream,
                isDetached: status.isDetached,
              };
            }
          } catch {
            const snapshot = await native.gitPanelSnapshot(contextPath);
            if (!isCurrentRequest()) return;
            if (!snapshot.repo) {
              setState((current) => ({
                ...current,
                repo: null,
                status: null,
                hasRepo: false,
                isLoading: false,
                localError: null,
              }));
              return;
            }
            repo = snapshot.repo;
            status = snapshot.status ?? null;
          }
        } else {
          const snapshot = await native.gitPanelSnapshot(contextPath);
          if (!isCurrentRequest()) return;
          if (!snapshot.repo) {
            setState((current) => ({
              ...current,
              repo: null,
              status: null,
              hasRepo: false,
              isLoading: false,
              localError: null,
            }));
            return;
          }
          repo = snapshot.repo;
          status = snapshot.status ?? null;
        }

        if (!repo) {
          setState((current) => ({
            ...current,
            repo: null,
            status: null,
            hasRepo: false,
            isLoading: false,
            localError: null,
          }));
          return;
        }

        let nextRemoteError = stateRef.current.lastRemoteError;
        const shouldAutoFetch =
          repo.upstream &&
          remoteMode !== "never" &&
          (remoteMode === "always" ||
            Date.now() - (autoFetchByRepoRef.current.get(repo.repoRoot) ?? 0) >=
              AUTO_FETCH_THROTTLE_MS);

        if (shouldAutoFetch) {
          try {
            await native.gitFetch(repo.repoRoot);
            touchAutoFetch(autoFetchByRepoRef.current, repo.repoRoot);
            nextRemoteError = null;
            if (!isCurrentRequest()) return;
            status = await native.gitStatus(repo.repoRoot);
            if (!isCurrentRequest()) return;
          } catch (error) {
            nextRemoteError = normalizeError(error);
          }
        }

        if (!isCurrentRequest()) return;
        setState((current) => ({
          ...current,
          repo,
          status,
          hasRepo: true,
          isLoading: false,
          localError: null,
          lastRemoteError: nextRemoteError,
        }));
      } catch (error) {
        if (!isCurrentRequest()) return;
        setState((current) => ({
          ...current,
          repo: null,
          hasRepo: false,
          status: null,
          isLoading: false,
          localError: normalizeError(error),
        }));
      } finally {
        if (isCurrentRequest()) {
          lastRefreshAtRef.current = Date.now();
        }
      }
    },
    [contextKey, contextPath],
  );

  const refresh = useCallback(
    async (options?: { remote?: SourceControlRefreshMode }) => {
      const remoteMode = options?.remote ?? "never";
      const inflight = inflightRef.current;
      if (inflight?.contextKey === contextKey) {
        const cur = inflight.mode;
        const upgrade =
          (cur === "never" && remoteMode !== "never") ||
          (cur === "auto" && remoteMode === "always");
        if (!upgrade) return inflight.promise;
      }
      const run = doRefresh(remoteMode).finally(() => {
        if (inflightRef.current?.promise === run) {
          inflightRef.current = null;
        }
      });
      inflightRef.current = { contextKey, mode: remoteMode, promise: run };
      return run;
    },
    [contextKey, doRefresh],
  );

  const runRemoteAction = useCallback(
    async (
      mode: SourceControlRemoteActionMode = "contextual",
    ): Promise<SourceControlRemoteActionResult> => {
      const { repo, status } = stateRef.current;
      if (!repo || !status) {
        return { ok: false, action: null, blocked: "no-repo" };
      }
      if (!status.upstream) {
        return { ok: false, action: null, blocked: "missing-upstream" };
      }

      const action = mode === "contextual" ? getContextualAction(status) : mode;
      if (!action) {
        return { ok: false, action: null, blocked: "diverged" };
      }

      // Sync drives the fetch button, so report it as one for the spinner.
      setState((current) => ({
        ...current,
        busyAction: action === "sync" ? "fetch" : action,
      }));
      const actionContextKey = contextKeyRef.current;
      const isCurrentContext = () => actionContextKey === contextKeyRef.current;

      let performed: SourceControlRemoteAction =
        action === "sync" ? "fetch" : action;
      try {
        if (action === "fetch") {
          await native.gitFetch(repo.repoRoot);
          touchAutoFetch(autoFetchByRepoRef.current, repo.repoRoot);
        } else if (action === "pull") {
          await native.gitFetch(repo.repoRoot);
          touchAutoFetch(autoFetchByRepoRef.current, repo.repoRoot);
          await native.gitPullFfOnly(repo.repoRoot);
        } else if (action === "sync") {
          await native.gitFetch(repo.repoRoot);
          touchAutoFetch(autoFetchByRepoRef.current, repo.repoRoot);
          // Re-read after fetching: the pre-fetch snapshot cannot know whether
          // upstream moved, which is the whole reason pull was gated before.
          const fresh = await native.gitStatus(repo.repoRoot);
          if (canFastForward(fresh)) {
            await native.gitPullFfOnly(repo.repoRoot);
            performed = "pull";
          } else if (fresh.ahead > 0 && fresh.behind > 0) {
            // Leave the merge decision to the user, same as the pull button.
            if (isCurrentContext()) await refresh({ remote: "never" });
            return { ok: false, action: "pull", blocked: "diverged" };
          }
        } else {
          await native.gitPush(repo.repoRoot);
        }
        if (isCurrentContext()) {
          setState((current) => ({ ...current, lastRemoteError: null }));
          await refresh({ remote: "never" });
        }
        return { ok: true, action: performed };
      } catch (error) {
        const message = normalizeError(error);
        if (isCurrentContext()) {
          setState((current) => ({ ...current, lastRemoteError: message }));
          await refresh({ remote: "never" }).catch(() => {});
        }
        return { ok: false, action: performed, error: message };
      } finally {
        setState((current) => ({ ...current, busyAction: null }));
      }
    },
    [refresh],
  );

  useEffect(() => {
    if (!_enabled) {
      requestIdRef.current++;
      setState({
        contextPath: null,
        repo: null,
        status: null,
        hasRepo: false,
        isLoading: false,
        localError: null,
        busyAction: null,
        lastRemoteError: null,
      });
      return;
    }
    setState((current) => ({ ...current, lastRemoteError: null }));
    const run = () => {
      const root = stateRef.current.repo?.repoRoot;
      const sameRepo = repositoryContainsContext(root ?? null, contextPath);
      const fresh = Date.now() - lastRefreshAtRef.current < SC_STATUS_TTL_MS;
      // An explicit repoRoot (the multi-repo selector) is a hard target: when it
      // names a different repo than the one loaded, the freshness short-circuit
      // must not win, or picking a repo would swap the name while the branch and
      // change list kept showing the previous one.
      const explicitRoot = repoRootRef.current;
      const rootMatches =
        !explicitRoot ||
        (!!root &&
          normalizedContextPath(root) === normalizedContextPath(explicitRoot));
      if (fresh && sameRepo && rootMatches && stateRef.current.hasRepo) {
        setState((current) =>
          current.contextPath === contextPath
            ? current
            : { ...current, contextPath },
        );
        return;
      }
      void refresh({ remote: "never" });
    };
    const idle =
      typeof window.requestIdleCallback === "function"
        ? window.requestIdleCallback(run, { timeout: 600 })
        : (window.setTimeout(run, 0) as unknown as number);
    return () => {
      if (typeof window.cancelIdleCallback === "function") {
        try {
          window.cancelIdleCallback(idle as number);
        } catch {
          /* noop */
        }
      } else {
        window.clearTimeout(idle as number);
      }
    };
  }, [refresh, contextPath, _enabled, repoRoot]);

  useEffect(() => {
    if (!_enabled) return;
    let timer = 0;
    // lastRefreshAtRef moves on *every* refresh, including the context-change
    // one that fires when the terminal cd's. Dropping the focus refresh when it
    // lands inside that window meant a refresh that raced the agent's writes
    // could be the last one to run — which is why the change list updated only
    // sometimes. Wait the window out instead of giving up on the refresh.
    const schedule = (delay: number) => {
      timer = window.setTimeout(() => {
        timer = 0;
        const elapsed = Date.now() - lastRefreshAtRef.current;
        if (elapsed < FOCUS_REFRESH_MIN_INTERVAL_MS) {
          schedule(FOCUS_REFRESH_MIN_INTERVAL_MS - elapsed);
          return;
        }
        void refresh({ remote: "never" });
      }, delay);
    };
    const onFocus = () => {
      if (timer) window.clearTimeout(timer);
      schedule(400);
    };
    // The DOM focus event only fires when the *document* regains focus, which
    // an OS-level window switch does not reliably produce inside the webview —
    // so alt-tabbing back from an agent's terminal left the change list stale.
    // onFocusChanged is the window-level signal; both feed the same throttle,
    // so firing twice costs nothing.
    window.addEventListener("focus", onFocus);
    let alive = true;
    let unlistenWindow: (() => void) | undefined;
    getCurrentWindow()
      .onFocusChanged(({ payload: focused }) => {
        if (focused) onFocus();
      })
      .then((un) => {
        if (alive) unlistenWindow = un;
        else un();
      })
      .catch(() => {});
    return () => {
      alive = false;
      unlistenWindow?.();
      window.removeEventListener("focus", onFocus);
      if (timer) window.clearTimeout(timer);
    };
  }, [refresh, enabled]);

  return useMemo<SourceControlSummary>(
    () => ({
      contextPath: state.contextPath,
      repo: state.repo,
      status: state.status,
      changedCount: state.status?.changedFiles.length ?? 0,
      upstream: state.status?.upstream ?? state.repo?.upstream ?? null,
      ahead: state.status?.ahead ?? 0,
      behind: state.status?.behind ?? 0,
      hasRepo: state.hasRepo,
      isLoading: state.isLoading,
      localError: state.localError,
      busyAction: state.busyAction,
      lastRemoteError: state.lastRemoteError,
      applyStatus,
      refresh,
      runRemoteAction,
    }),
    [state, applyStatus, refresh, runRemoteAction],
  );
}
