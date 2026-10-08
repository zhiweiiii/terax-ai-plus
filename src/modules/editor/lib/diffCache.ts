import { type GitDiffContentResult, native } from "@/lib/native";
import {
  currentWorkspaceEnv,
  type WorkspaceEnv,
  workspaceScopeKey,
} from "@/modules/workspace";

const DIFF_CACHE_LIMIT = 6;
const DIFF_CACHE_BYTES = 8 * 1024 * 1024;
const inflight = new Map<string, Promise<GitDiffContentResult>>();
const cache = new Map<string, GitDiffContentResult>();
let cachedBytes = 0;

function cost(value: GitDiffContentResult): number {
  return (
    2 *
    (value.originalContent.length +
      value.modifiedContent.length +
      value.fallbackPatch.length)
  );
}

function deleteCached(key: string): void {
  const value = cache.get(key);
  if (value) cachedBytes -= cost(value);
  cache.delete(key);
}

function touch(key: string, value: GitDiffContentResult): void {
  deleteCached(key);
  const bytes = cost(value);
  if (bytes > DIFF_CACHE_BYTES) return;
  cache.set(key, value);
  cachedBytes += bytes;
  while (cache.size > DIFF_CACHE_LIMIT || cachedBytes > DIFF_CACHE_BYTES) {
    const oldest = cache.keys().next().value;
    if (oldest === undefined) break;
    deleteCached(oldest);
  }
}

export function getCachedDiff(key: string): GitDiffContentResult | undefined {
  const hit = cache.get(key);
  if (hit) {
    cache.delete(key);
    cache.set(key, hit);
  }
  return hit;
}

export function invalidateDiff(key: string): void {
  const fields: unknown[] = JSON.parse(key);
  const identity = JSON.stringify(fields.slice(0, -1));
  for (const existing of new Set([...cache.keys(), ...inflight.keys()])) {
    const parts: unknown[] = JSON.parse(existing);
    if (JSON.stringify(parts.slice(0, -1)) === identity) {
      deleteCached(existing);
      inflight.delete(existing);
    }
  }
}

export function invalidateRepoDiffs(
  repoRoot: string,
  workspace: WorkspaceEnv = currentWorkspaceEnv(),
): void {
  const scope = workspaceScopeKey(workspace);
  for (const key of new Set([...cache.keys(), ...inflight.keys()])) {
    const parts: unknown[] = JSON.parse(key);
    if (parts[0] === scope && parts[1] === repoRoot) {
      deleteCached(key);
      inflight.delete(key);
    }
  }
}

export function workingDiffKey(
  repoRoot: string,
  path: string,
  mode: "-" | "+",
  originalPath: string | null = null,
  workspace: WorkspaceEnv = currentWorkspaceEnv(),
): string {
  return JSON.stringify([
    workspaceScopeKey(workspace),
    repoRoot,
    "w",
    mode,
    path,
    originalPath,
  ]);
}

export function commitDiffKey(
  repoRoot: string,
  sha: string,
  path: string,
  originalPath: string | null = null,
  workspace: WorkspaceEnv = currentWorkspaceEnv(),
): string {
  return JSON.stringify([
    workspaceScopeKey(workspace),
    repoRoot,
    "c",
    sha,
    path,
    originalPath,
  ]);
}

function fetchDiff(
  key: string,
  load: () => Promise<GitDiffContentResult>,
): Promise<GitDiffContentResult> {
  const hit = getCachedDiff(key);
  if (hit) return Promise.resolve(hit);
  const existing = inflight.get(key);
  if (existing) return existing;
  const pending = Promise.resolve()
    .then(load)
    .then((value) => {
      if (inflight.get(key) === pending) touch(key, value);
      return value;
    })
    .finally(() => {
      if (inflight.get(key) === pending) inflight.delete(key);
    });
  inflight.set(key, pending);
  return pending;
}

export function fetchWorkingDiff(
  repoRoot: string,
  path: string,
  mode: "-" | "+",
  originalPath: string | null,
  workspace: WorkspaceEnv = currentWorkspaceEnv(),
): Promise<GitDiffContentResult> {
  const env = { ...workspace };
  return fetchDiff(
    workingDiffKey(repoRoot, path, mode, originalPath, env),
    () =>
      native.gitDiffContent(repoRoot, path, mode === "+", originalPath, env),
  );
}

export function fetchCommitDiff(
  repoRoot: string,
  sha: string,
  path: string,
  originalPath: string | null,
  workspace: WorkspaceEnv = currentWorkspaceEnv(),
): Promise<GitDiffContentResult> {
  const env = { ...workspace };
  return fetchDiff(commitDiffKey(repoRoot, sha, path, originalPath, env), () =>
    native.gitCommitFileDiff(repoRoot, sha, path, originalPath, env),
  );
}
