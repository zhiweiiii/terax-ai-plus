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

/**
 * Show the file in the OS file manager, with it selected.
 *
 * The path is normalised to native separators first. Everything upstream deals
 * in forward slashes - the file tree joins them that way, and git hands its
 * paths back the same - but on Windows this ends at
 * `explorer.exe /select,<path>`, which does nothing at all when given
 * `D:/project/foo`. The failure was silent on top of that: the error was
 * swallowed into the console, so the menu item simply did nothing.
 */
export async function revealInFinder(path: string): Promise<void> {
  const native = isWindows() ? path.replace(/[/\\]+/g, "\\") : path;
  try {
    await revealItemInDir(native);
  } catch (e) {
    console.error("revealItemInDir failed:", e);
    const message = typeof e === "string" ? e : String(e);
    toast.error(`Could not reveal in the file manager: ${message}`);
  }
}

function isWindows(): boolean {
  return navigator.userAgent.includes("Windows");
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
