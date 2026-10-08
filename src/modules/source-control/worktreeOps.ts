import { quoteShellArg } from "@/lib/shellQuote";
import type { CommandOutput } from "@/lib/native";
import { native } from "@/lib/native";
import { currentWorkspaceEnv, type WorkspaceEnv } from "@/modules/workspace";

export type WorktreeAddOptions = {
  /** New branch to create and check out in the worktree (-b). */
  branch?: string;
  /** Branch or commit to base the worktree on; defaults to HEAD. */
  commit?: string;
};

function assertOk(out: CommandOutput, fallback: string): void {
  if (out.exit_code === 0) return;
  const detail = (out.stderr || out.stdout).trim();
  throw new Error(detail ? `${fallback}: ${detail}` : fallback);
}

export async function gitWorktreeAdd(
  repoRoot: string,
  path: string,
  options?: WorktreeAddOptions,
  workspace: WorkspaceEnv = currentWorkspaceEnv(),
): Promise<void> {
  const args = ["git", "worktree", "add"];
  const quote = (value: string) =>
    quoteShellArg(value, workspace.kind === "local");
  if (options?.branch) args.push("-b", quote(options.branch));
  args.push("--", quote(path));
  if (options?.commit) args.push(quote(options.commit));
  assertOk(
    await native.runCommand(args.join(" "), repoRoot, 60, workspace),
    "Could not create worktree",
  );
}

export async function gitWorktreeRemove(
  repoRoot: string,
  path: string,
  force = false,
  workspace: WorkspaceEnv = currentWorkspaceEnv(),
): Promise<void> {
  const args = ["git", "worktree", "remove"];
  if (force) args.push("--force");
  args.push("--", quoteShellArg(path, workspace.kind === "local"));
  assertOk(
    await native.runCommand(args.join(" "), repoRoot, 60, workspace),
    "Could not remove worktree",
  );
}

export function defaultWorktreePath(repoRoot: string, branch: string): string {
  const root = repoRoot.replace(/\\/g, "/").replace(/\/+$/, "");
  const separator = root.lastIndexOf("/");
  const repoName = root.slice(separator + 1) || "repo";
  const parent = separator >= 0 ? root.slice(0, separator + 1) : "";
  const slug = branch.trim().replace(/[\\/]/g, "-") || "head";
  const dir = `${repoName}-wt-${slug}`;
  return parent ? `${parent}${dir}` : `${root}/${dir}`;
}
