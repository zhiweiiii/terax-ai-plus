import { openPath, revealItemInDir } from "@tauri-apps/plugin-opener";
import { toast } from "sonner";

export async function copyToClipboard(text: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    // Best-effort; ignore in environments without clipboard permission.
  }
}

export function relativePath(rootPath: string, path: string): string {
  if (path === rootPath) return ".";
  if (path.startsWith(`${rootPath}/`)) return path.slice(rootPath.length + 1);
  return path;
}

export async function revealInFinder(path: string): Promise<void> {
  try {
    await revealItemInDir(path);
  } catch (e) {
    console.error("revealItemInDir failed:", e);
  }
}

/**
 * Hand the path to the OS so it opens in whatever app is registered for that
 * file type — the same thing a double-click in Explorer/Finder does. A .ps1
 * runs through its PowerShell association, a .png opens in the image viewer.
 */
export async function openWithSystemApp(path: string): Promise<void> {
  try {
    await openPath(path);
  } catch (e) {
    console.error("openPath failed:", e);
    const message = typeof e === "string" ? e : String(e);
    toast.error(`Could not open with the system app: ${message}`);
  }
}
