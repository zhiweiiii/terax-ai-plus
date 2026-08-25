import { quoteShellArg } from "@/lib/shellQuote";

/**
 * How a file is named to a coding agent. Claude Code and opencode both expand
 * `@path` in a submitted prompt into a real attachment, so that is the form to
 * send; a bare path is just text the model has to recognise and then spend a
 * read on.
 *
 * `@` resolves against the agent's working directory, so a file inside `cwd`
 * becomes a relative `@` mention. Anything outside has no `@` form at all and
 * falls back to a quoted absolute path, which the agent can still open.
 */
export function agentFileRef(absolutePath: string, cwd: string | null): string {
  const rel = relativeTo(absolutePath, cwd);
  // A path with whitespace would end the mention at the first space, so it
  // cannot be sent as `@`; the quoted absolute form stays readable instead.
  if (!rel || /\s/.test(rel)) return quoteShellArg(absolutePath);
  return `@${rel}`;
}

function relativeTo(absolutePath: string, cwd: string | null): string | null {
  if (!cwd) return null;
  const norm = (p: string) => p.replace(/\\/g, "/").replace(/\/+$/, "");
  const file = norm(absolutePath);
  const root = norm(cwd);
  // Windows paths are case-insensitive, so compare folded but slice the
  // original: the agent should see the file's real capitalisation.
  const foldedFile = file.toLowerCase();
  const foldedRoot = root.toLowerCase();
  if (foldedFile === foldedRoot) return null;
  if (!foldedFile.startsWith(`${foldedRoot}/`)) return null;
  return file.slice(root.length + 1) || null;
}
