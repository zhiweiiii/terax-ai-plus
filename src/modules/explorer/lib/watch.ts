import { invoke } from "@tauri-apps/api/core";
import { currentWorkspaceEnv } from "@/modules/workspace";

export function watchAdd(paths: string[]): void {
  if (paths.length === 0) return;
  void invoke("fs_watch_add", {
    paths,
    workspace: currentWorkspaceEnv(),
  }).catch(() => {});
}

export function watchRemove(paths: string[]): void {
  if (paths.length === 0) return;
  void invoke("fs_watch_remove", {
    paths,
    workspace: currentWorkspaceEnv(),
  }).catch(() => {});
}

export function parentDir(path: string): string {
  const i = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  if (i <= 0) return path.slice(0, i + 1) || path;
  return path.slice(0, i);
}
