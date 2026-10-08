import { currentWorkspaceEnv, type WorkspaceEnv } from "@/modules/workspace";
import { invoke } from "@tauri-apps/api/core";

export function watchAdd(
  paths: string[],
  workspace: WorkspaceEnv = currentWorkspaceEnv(),
): () => void {
  if (paths.length === 0) return () => {};
  const added = invoke<string | null>("fs_watch_add", {
    paths,
    workspace,
  });
  void added.catch(() => {});
  let released = false;
  return () => {
    if (released) return;
    released = true;
    void added
      .then((lease) =>
        lease === null ? undefined : invoke("fs_watch_remove", { lease }),
      )
      .catch(() => {});
  };
}

export function parentDir(path: string): string {
  const i = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  if (i === 2 && /^[A-Za-z]:[\\/]/.test(path)) return path.slice(0, 3);
  if (i <= 0) return path.slice(0, i + 1) || path;
  return path.slice(0, i);
}
