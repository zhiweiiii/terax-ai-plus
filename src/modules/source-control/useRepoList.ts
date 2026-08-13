import { type GitRepoHead, native } from "@/modules/ai/lib/native";
import { useEffect, useRef, useState } from "react";

type UseRepoListResult = {
  repos: GitRepoHead[];
  activeRepo: string | null;
  setActiveRepo: (root: string) => void;
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
      } else if (
        activeRepoRef.current &&
        !heads.some((h) => h.repoRoot === activeRepoRef.current)
      ) {
        // Active repo no longer in the list — pick the first.
        setActiveRepoState(heads[0].repoRoot);
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
    lastPathRef.current = basePath;

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
    }
  };

  return { repos, activeRepo, setActiveRepo, scan, isLoading };
}
