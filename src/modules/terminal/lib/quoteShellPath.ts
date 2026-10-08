import { quoteForShell, type ShellKind } from "@/lib/shellQuote";

// Quote only when needed, so a clean path stays verbatim for bracketed paste
// (Claude resolves an image path to "[Image #N]"); spaced/special paths quote.
const SAFE_PATH = /^[A-Za-z0-9_@%+=:,./\\-]+$/;

export function quoteShellPath(
  p: string,
  shell: ShellKind,
  agent = false,
): string {
  if (/[\u0000-\u001f\u007f]/.test(p))
    throw new Error("Paths containing control characters cannot be pasted");
  if (agent) return SAFE_PATH.test(p) ? p : JSON.stringify(p);
  return quoteForShell(p, shell);
}

export function formatDroppedPaths(
  paths: string[],
  shell: ShellKind,
  agent = false,
): string {
  return `${paths.map((path) => quoteShellPath(path, shell, agent)).join(" ")} `;
}
