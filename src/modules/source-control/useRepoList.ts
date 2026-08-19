import { type GitRepoHead, native } from "@/lib/native";
import { useEffect, useRef, useState } from "react";

// Per-project repo selections kept in memory; older projects fall off.
const SELECTION_MEMORY_LIMIT = 16;

type UseRepoListResult = {
  repos: GitRepoHead[];
  activeRepo: string | null;
  setActiveRepo: (root: string) => void;
  /** Drop the explicit selection; the panel then spans every repo. */
  clearActiveRepo: () => void;
  scan: () => Promise<void>;
  isLoading: boolean;
};

/**
 * Discovers git repos under a base directory and tracks the user's
 * currently selected repo within the list.
 *
 * Scans only when `basePath` changes (debounced) or `scan()` is called.
 * If exactly one repo is found it is auto-selected.
 */
export function useRepoList(basePath: string | null): UseRepoListResult {
  const [repos, setRepos] = useState<GitRepoHead[]>([]);
  const [activeRepo, setActiveRepoState] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const lastPathRef = useRef<string | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const activeRepoRef = useRef<string | null>(activeRepo);
  activeRepoRef.current = activeRepo;
  // Scans race whenever workspaces are switched quickly: without a token the
  // slower scan of the workspace you left can land last and repopulate the
  // panel with its repos.
  const scanTokenRef = useRef(0);
  // A deliberate repo pick is per project, so it is remembered against the
  // path it was made in rather than carried across the switch. Bounded: a long
  // session must not accumulate an entry per directory ever visited.
  const selectionByPathRef = useRef(new Map<string, string>());

  const rememberSelection = (path: string, root: string) => {
    const map = selectionByPathRef.current;
    map.delete(path);
    map.set(path, root);
    while (map.size > SELECTION_MEMORY_LIMIT) {
      const oldest = map.keys().next().value;
      if (oldest === undefined) break;
      map.delete(oldest);
    }
  };

  const doScan = async (path: string) => {
    const token = ++scanTokenRef.current;
    setIsLoading(true);
    try {
      const heads = await native.gitScanRepos(path, 1);
      if (token !== scanTokenRef.current) return;
      setRepos(heads);
      if (heads.length === 1) {
        setActiveRepoState(heads[0].repoRoot);
      } else if (heads.length === 0) {
        // Leaving the selection set would keep the old project's repo on
        // screen with no entry in the list backing it.
        setActiveRepoState(null);
      } else {
        const remembered = selectionByPathRef.current.get(path);
        const keep =
          remembered && heads.some((h) => h.repoRoot === remembered)
            ? remembered
            : activeRepoRef.current &&
                heads.some((h) => h.repoRoot === activeRepoRef.current)
              ? activeRepoRef.current
              : heads[0].repoRoot;
        setActiveRepoState(keep);
      }
    } catch (err) {
      if (token !== scanTokenRef.current) return;
      console.warn("[terax] repo scan failed:", err);
      setRepos([]);
      setActiveRepoState(null);
    } finally {
      if (token === scanTokenRef.current) setIsLoading(false);
    }
  };

  useEffect(() => {
    // Clear on null/empty path.
    if (!basePath) {
      scanTokenRef.current++;
      setRepos([]);
      setActiveRepoState(null);
      lastPathRef.current = null;
      return;
    }

    // Same path — skip re-scan.
    if (basePath === lastPathRef.current) return;
    const switched = lastPathRef.current !== null;
    lastPathRef.current = basePath;

    // Drop the previous project's repos before the new scan lands. Holding
    // them meant `effectiveRepoRoot` kept resolving to a repo the new project
    // does not contain, so the panel spent the scan aimed at the old repo and
    // showed its branch. Empty is the honest intermediate state, and the
    // single-repo path resolves the new context on its own meanwhile.
    if (switched) {
      setRepos([]);
      setActiveRepoState(null);
    }

    // Fire scan immediately — 500ms debounce is too slow for initial detection.
    void doScan(basePath);
  }, [basePath]); // eslint-disable-line react-hooks/exhaustive-deps

  const scan = async () => {
    if (!basePath) return;
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    await doScan(basePath);
  };

  const setActiveRepo = (root: string) => {
    if (repos.some((h) => h.repoRoot === root)) {
      setActiveRepoState(root);
      if (basePath) rememberSelection(basePath, root);
    }
  };

  const clearActiveRepo = () => setActiveRepoState(null);

  return { repos, activeRepo, setActiveRepo, clearActiveRepo, scan, isLoading };
}
