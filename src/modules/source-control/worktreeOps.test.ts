import { beforeEach, describe, expect, it, vi } from "vitest";

const nativeMock = vi.hoisted(() => ({
  runCommand: vi.fn(),
}));

vi.mock("@/lib/native", () => ({ native: nativeMock }));

import {
  defaultWorktreePath,
  gitWorktreeAdd,
  gitWorktreePrune,
  gitWorktreeRemove,
} from "./worktreeOps";

beforeEach(() => {
  nativeMock.runCommand.mockReset();
});

describe("defaultWorktreePath", () => {
  it("combines the repo name and branch slug", () => {
    expect(defaultWorktreePath("/home/dev/my-repo", "feat")).toBe(
      "/home/dev/my-repo-wt-feat",
    );
  });

  it("handles Windows backslash separators", () => {
    expect(defaultWorktreePath("C:\\dev\\my-repo", "feat")).toBe(
      "C:/dev/my-repo-wt-feat",
    );
  });

  it("handles a trailing separator on the repo root", () => {
    expect(defaultWorktreePath("/home/dev/my-repo/", "feat")).toBe(
      "/home/dev/my-repo-wt-feat",
    );
  });

  it("keeps a nested repo path while using only the last component", () => {
    expect(
      defaultWorktreePath("/home/dev/monorepo/packages/kit", "fix"),
    ).toBe("/home/dev/monorepo/packages/kit-wt-fix");
  });

  it("falls back to the repoRoot when the parent directory is missing", () => {
    expect(defaultWorktreePath("my-repo", "feat")).toBe(
      "my-repo/my-repo-wt-feat",
    );
  });

  it("flattens slashes in the branch name", () => {
    expect(defaultWorktreePath("/r/app", "feature/x")).toBe(
      "/r/app-wt-feature-x",
    );
    expect(defaultWorktreePath("/r/app", "feature/x/y")).toBe(
      "/r/app-wt-feature-x-y",
    );
  });

  it("flattens backslashes in the branch name", () => {
    expect(defaultWorktreePath("/r/app", "feature\\x")).toBe(
      "/r/app-wt-feature-x",
    );
  });

  it("keeps non-separator special characters in the slug", () => {
    expect(defaultWorktreePath("/r/app", "feat(1)_A.B")).toBe(
      "/r/app-wt-feat(1)_A.B",
    );
  });

  it("falls back to 'head' for blank branch names", () => {
    expect(defaultWorktreePath("/r/app", "  ")).toBe("/r/app-wt-head");
    expect(defaultWorktreePath("/r/app", "")).toBe("/r/app-wt-head");
  });
});

describe("gitWorktreeAdd", () => {
  it("assembles the add command with the worktree path", async () => {
    nativeMock.runCommand.mockResolvedValue({
      exit_code: 0,
      stdout: "",
      stderr: "",
    });
    await gitWorktreeAdd("/repo", "/repo-wt");
    expect(nativeMock.runCommand).toHaveBeenCalledWith(
      "git worktree add '/repo-wt'",
      "/repo",
      60,
    );
  });

  it("passes the branch and commit through when provided", async () => {
    nativeMock.runCommand.mockResolvedValue({
      exit_code: 0,
      stdout: "",
      stderr: "",
    });
    await gitWorktreeAdd("/repo", "/repo-wt", {
      branch: "feat",
      commit: "abc123",
    });
    expect(nativeMock.runCommand).toHaveBeenCalledWith(
      "git worktree add -b 'feat' '/repo-wt' 'abc123'",
      "/repo",
      60,
    );
  });

  it("quotes a branch name containing spaces", async () => {
    nativeMock.runCommand.mockResolvedValue({
      exit_code: 0,
      stdout: "",
      stderr: "",
    });
    await gitWorktreeAdd("/repo", "/repo-wt", { branch: "feat x" });
    expect(nativeMock.runCommand).toHaveBeenCalledWith(
      "git worktree add -b 'feat x' '/repo-wt'",
      "/repo",
      60,
    );
  });

  it("throws with the stderr detail when git fails", async () => {
    nativeMock.runCommand.mockResolvedValue({
      exit_code: 128,
      stdout: "",
      stderr: "fatal: invalid path",
    });
    await expect(gitWorktreeAdd("/repo", "/repo-wt")).rejects.toThrow(
      "Could not create worktree: fatal: invalid path",
    );
  });

  it("throws with the fallback message when git fails without detail", async () => {
    nativeMock.runCommand.mockResolvedValue({
      exit_code: 1,
      stdout: "",
      stderr: "",
    });
    await expect(gitWorktreeRemove("/repo", "/repo-wt")).rejects.toThrow(
      "Could not remove worktree",
    );
  });
});

describe("gitWorktreeRemove", () => {
  it("omits --force by default", async () => {
    nativeMock.runCommand.mockResolvedValue({
      exit_code: 0,
      stdout: "",
      stderr: "",
    });
    await gitWorktreeRemove("/repo", "/repo-wt");
    expect(nativeMock.runCommand).toHaveBeenCalledWith(
      "git worktree remove '/repo-wt'",
      "/repo",
      60,
    );
  });

  it("adds --force when requested", async () => {
    nativeMock.runCommand.mockResolvedValue({
      exit_code: 0,
      stdout: "",
      stderr: "",
    });
    await gitWorktreeRemove("/repo", "/repo-wt", true);
    expect(nativeMock.runCommand).toHaveBeenCalledWith(
      "git worktree remove --force '/repo-wt'",
      "/repo",
      60,
    );
  });
});

describe("gitWorktreePrune", () => {
  it("issues the prune command", async () => {
    nativeMock.runCommand.mockResolvedValue({
      exit_code: 0,
      stdout: "",
      stderr: "",
    });
    await gitWorktreePrune("/repo");
    expect(nativeMock.runCommand).toHaveBeenCalledWith(
      "git worktree prune",
      "/repo",
      30,
    );
  });
});
