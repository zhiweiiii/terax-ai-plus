import { native, type GitStatusSnapshot } from "@/lib/native";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  bubbleUpDirectoryStatuses,
  buildGitStatusMap,
  containingRepoRoot,
  lookupGitStatus,
  normalizePath,
  type GitStatusCode,
} from "./gitStatusUtils";

function rootsOverlap(a: string, b: string): boolean {
  return a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`);
}

// Decorations ride the always-resident SC snapshots: no fetch, no watcher. When
// no status covers the explorer root, nothing is shown rather than triggering
// git work of our own. Accepts one snapshot per repo so a multi-repo workspace
// decorates every file by whichever repo contains it.
export function useGitStatus(
  workspaceRoot: string | null,
  statuses: GitStatusSnapshot[] | null | undefined,
  enabled: boolean,
) {
  const [canonicalRoot, setCanonicalRoot] = useState<string | null>(null);
  const reqRef = useRef(0);

  useEffect(() => {
    if (!enabled || !workspaceRoot) {
      setCanonicalRoot(null);
      return;
    }
    const req = ++reqRef.current;
    void native
      .canonicalize(workspaceRoot)
      .then((c) => {
        if (req === reqRef.current) setCanonicalRoot(c);
      })
      .catch(() => {
        if (req === reqRef.current) setCanonicalRoot(null);
      });
  }, [enabled, workspaceRoot]);

  const aliases = useMemo(() => {
    const out: string[] = [];
    const seen = new Set<string>();
    for (const r of [workspaceRoot, canonicalRoot]) {
      if (!r) continue;
      const n = normalizePath(r);
      if (seen.has(n)) continue;
      seen.add(n);
      out.push(r);
    }
    return out;
  }, [workspaceRoot, canonicalRoot]);

  // Keep the snapshots whose repo overlaps the explorer root in either nesting
  // direction; lookups still return null for paths outside their repo.
  const repos = useMemo(() => {
    if (!enabled || !statuses || statuses.length === 0) return [];
    const out: { root: string; map: Map<string, GitStatusCode> }[] = [];
    for (const status of statuses) {
      if (!status?.repoRoot) continue;
      const root = normalizePath(status.repoRoot);
      const covered = aliases.some((a) => rootsOverlap(normalizePath(a), root));
      if (!covered) continue;
      const map = buildGitStatusMap(status);
      bubbleUpDirectoryStatuses(map);
      out.push({ root, map });
    }
    return out;
  }, [enabled, statuses, aliases]);

  const lookup = useCallback(
    (path: string): GitStatusCode | null => {
      if (repos.length === 0) return null;
      const abs = normalizePath(path);
      // Deepest containing repo wins: its snapshot is the one the path belongs
      // to when several repos sit under one workspace.
      const root = containingRepoRoot(
        repos.map((r) => r.root),
        abs,
      );
      const repo = root ? repos.find((r) => r.root === root) : null;
      return repo ? lookupGitStatus(repo.map, repo.root, path, aliases) : null;
    },
    [repos, aliases],
  );

  return { lookup };
}
