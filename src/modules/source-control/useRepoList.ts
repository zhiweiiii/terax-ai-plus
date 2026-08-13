import { useEffect, useRef, useState } from "react";
import { native, type GitRepoHead } from "@/modules/ai/lib/native";

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
  console.log("[terax] useRepoList called, basePath=", basePath);
  const [repos, setRepos] = useState<GitRepoHead[]>([]);
  const [activeRepo, setActiveRepoState] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const lastPathRef = useRef<string | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const doScan = async (path: string) => {
    setIsLoading(true);
    try {
      const heads = await native.gitScanRepos(path, 1);
      console.log(
        `[terax] repo scan: ${heads.length} repo(s) under ${path}`,
        heads.map((h) => `${h.repoRoot} [${h.branch}]`),
      );
      setRepos(heads);
      if (heads.length === 1) {
        setActiveRepoState(heads[0].repoRoot);
      } else if (
        heads.length > 1 &&
        activeRepo &&
        !heads.some((h) => h.repoRoot === activeRepo)
      ) {
        // Active repo no longer in the list — pick the first.
        setActiveRepoState(heads[0].repoRoot);
      }
    } catch (err) {
      console.warn("[terax] repo scan failed:", err);
      setRepos([]);
      setActiveRepoState(null);
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    // Clear on null/empty path.
    if (!basePath) {
      setRepos([]);
      setActiveRepoState(null);
      lastPathRef.current = null;
      return;
    }

    // Same path — skip re-scan.
    if (basePath === lastPathRef.current) return;
    lastPathRef.current = basePath;

    // Fire scan immediately — 500ms debounce is too slow for initial detection.
    console.log("[terax] useRepoList: scheduling scan for", basePath);
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
