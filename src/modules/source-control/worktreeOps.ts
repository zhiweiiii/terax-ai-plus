import { quoteShellArg } from "@/lib/shellQuote";
import type { CommandOutput } from "@/lib/native";
import { native } from "@/lib/native";

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
): Promise<void> {
  const args = ["git", "worktree", "add"];
  if (options?.branch) args.push("-b", quoteShellArg(options.branch));
  args.push(quoteShellArg(path));
  if (options?.commit) args.push(quoteShellArg(options.commit));
  assertOk(
    await native.runCommand(args.join(" "), repoRoot, 60),
    "Could not create worktree",
  );
}

export async function gitWorktreeRemove(
  repoRoot: string,
  path: string,
  force = false,
): Promise<void> {
  const args = ["git", "worktree", "remove"];
  if (force) args.push("--force");
  args.push(quoteShellArg(path));
  assertOk(
    await native.runCommand(args.join(" "), repoRoot, 60),
    "Could not remove worktree",
  );
}

export async function gitWorktreePrune(repoRoot: string): Promise<void> {
  assertOk(
    await native.runCommand("git worktree prune", repoRoot, 30),
    "Could not prune worktrees",
  );
}

export function defaultWorktreePath(repoRoot: string, branch: string): string {
  const parts = repoRoot.split(/[\\/]/).filter(Boolean);
  const repoName = parts.pop() ?? "repo";
  const parent = parts.join("/");
  const slug = branch.trim().replace(/[\\/]/g, "-") || "head";
  const dir = `${repoName}-wt-${slug}`;
  return parent ? `${parent}/${dir}` : `${repoRoot}/${dir}`;
}
