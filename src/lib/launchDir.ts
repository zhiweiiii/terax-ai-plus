import { invoke } from "@tauri-apps/api/core";

let cached: string | undefined;

export async function initLaunchDir(): Promise<void> {
  const dir =
    (await invoke<string | null>("get_launch_dir").catch(() => null)) ??
    (await invoke<string>("workspace_current_dir").catch(() => null));
  cached = dir ? dir.replace(/\\/g, "/") : undefined;
}

export function getLaunchDir(): string | undefined {
  return cached;
}

/**
 * Drains the files passed via the OS "Open With" action (CLI args on
 * Linux/Windows, macOS open-files event). Drained once so HMR / re-mounts
 * can't replay them. Returns [] when the app wasn't launched with a file.
 */
export async function consumeLaunchFiles(): Promise<string[]> {
  const files = await invoke<string[]>("get_launch_files").catch(() => []);
  return files.map((f) => f.replace(/\\/g, "/"));
}

/**
 * Drains the command passed via `--run`. Already validated in Rust (single
 * line, no control characters), so it is safe to type into a PTY. Drained once
 * so HMR / re-mounts can't re-run it.
 */
export async function consumeLaunchCommand(): Promise<string | null> {
  return await invoke<string | null>("get_launch_command").catch(() => null);
}
