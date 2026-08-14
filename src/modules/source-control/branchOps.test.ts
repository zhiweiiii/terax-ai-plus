import { beforeEach, describe, expect, it, vi } from "vitest";

const invokeMock = vi.hoisted(() => vi.fn());
const workspaceMock = vi.hoisted(() => vi.fn());

vi.mock("@tauri-apps/api/core", () => ({ invoke: invokeMock }));
vi.mock("@/modules/workspace", () => ({
  currentWorkspaceEnv: workspaceMock,
}));

import {
  gitCompareBranches,
  gitCreateBranch,
  gitDeleteBranch,
  gitDiffWithRef,
  gitMerge,
  gitRebase,
  gitRenameBranch,
} from "./branchOps";

beforeEach(() => {
  invokeMock.mockReset();
  workspaceMock.mockReset();
  workspaceMock.mockReturnValue({ kind: "local" });
});

describe("gitCreateBranch", () => {
  it("invokes git_create_branch with defaults", async () => {
    invokeMock.mockResolvedValue(undefined);
    await gitCreateBranch("/repo", "feat");
    expect(invokeMock).toHaveBeenCalledWith("git_create_branch", {
      repoRoot: "/repo",
      name: "feat",
      checkout: false,
      startPoint: null,
      workspace: { kind: "local" },
    });
  });

  it("passes checkout and startPoint through when provided", async () => {
    invokeMock.mockResolvedValue(undefined);
    await gitCreateBranch("/repo", "feat", {
      checkout: true,
      startPoint: "main",
    });
    expect(invokeMock).toHaveBeenCalledWith("git_create_branch", {
      repoRoot: "/repo",
      name: "feat",
      checkout: true,
      startPoint: "main",
      workspace: { kind: "local" },
    });
  });
});

describe("gitRenameBranch", () => {
  it("invokes git_rename_branch with both names", async () => {
    invokeMock.mockResolvedValue(undefined);
    await gitRenameBranch("/repo", "old", "new");
    expect(invokeMock).toHaveBeenCalledWith("git_rename_branch", {
      repoRoot: "/repo",
      oldName: "old",
      newName: "new",
      workspace: { kind: "local" },
    });
  });
});

describe("gitDeleteBranch", () => {
  it("defaults to a local delete", async () => {
    invokeMock.mockResolvedValue(undefined);
    await gitDeleteBranch("/repo", "old");
    expect(invokeMock).toHaveBeenCalledWith("git_delete_branch", {
      repoRoot: "/repo",
      name: "old",
      remote: false,
      workspace: { kind: "local" },
    });
  });

  it("marks remote deletes", async () => {
    invokeMock.mockResolvedValue(undefined);
    await gitDeleteBranch("/repo", "old", { remote: true });
    expect(invokeMock).toHaveBeenCalledWith("git_delete_branch", {
      repoRoot: "/repo",
      name: "old",
      remote: true,
      workspace: { kind: "local" },
    });
  });
});

describe("gitMerge", () => {
  it("invokes git_merge with all options defaulted off", async () => {
    invokeMock.mockResolvedValue({
      merged: false,
      upToDate: false,
      conflicts: false,
      message: "",
    });
    await gitMerge("/repo", "main");
    expect(invokeMock).toHaveBeenCalledWith("git_merge", {
      repoRoot: "/repo",
      branch: "main",
      ffOnly: false,
      noFF: false,
      squash: false,
      message: null,
      noCommit: false,
      workspace: { kind: "local" },
    });
  });

  it("passes merge options through", async () => {
    invokeMock.mockResolvedValue({
      merged: true,
      upToDate: false,
      conflicts: false,
      message: "",
    });
    await gitMerge("/repo", "main", {
      ffOnly: true,
      message: "merge it",
      noCommit: true,
    });
    expect(invokeMock).toHaveBeenCalledWith("git_merge", {
      repoRoot: "/repo",
      branch: "main",
      ffOnly: true,
      noFF: false,
      squash: false,
      message: "merge it",
      noCommit: true,
      workspace: { kind: "local" },
    });
  });
});

describe("gitRebase", () => {
  it("invokes git_rebase with the branch", async () => {
    invokeMock.mockResolvedValue({ ok: true, conflict: false, message: "" });
    await gitRebase("/repo", "main");
    expect(invokeMock).toHaveBeenCalledWith("git_rebase", {
      repoRoot: "/repo",
      branch: "main",
      workspace: { kind: "local" },
    });
  });
});

describe("gitDiffWithRef", () => {
  it("passes null path when omitted", async () => {
    invokeMock.mockResolvedValue({ patches: [], truncated: false });
    await gitDiffWithRef("/repo", "main");
    expect(invokeMock).toHaveBeenCalledWith("git_diff_with_ref", {
      repoRoot: "/repo",
      reference: "main",
      path: null,
      workspace: { kind: "local" },
    });
  });

  it("passes the path when provided", async () => {
    invokeMock.mockResolvedValue({ patches: [], truncated: false });
    await gitDiffWithRef("/repo", "main", "src/a.ts");
    expect(invokeMock).toHaveBeenCalledWith("git_diff_with_ref", {
      repoRoot: "/repo",
      reference: "main",
      path: "src/a.ts",
      workspace: { kind: "local" },
    });
  });
});

describe("gitCompareBranches", () => {
  it("invokes git_compare_branches with left and right", async () => {
    invokeMock.mockResolvedValue({ leftOnly: [], rightOnly: [] });
    await gitCompareBranches("/repo", "left", "right");
    expect(invokeMock).toHaveBeenCalledWith("git_compare_branches", {
      repoRoot: "/repo",
      left: "left",
      right: "right",
      workspace: { kind: "local" },
    });
  });
});

describe("workspace env", () => {
  it("forwards the current WSL workspace environment", async () => {
    workspaceMock.mockReturnValue({ kind: "wsl", distro: "Ubuntu" });
    invokeMock.mockResolvedValue(undefined);
    await gitCreateBranch("/repo", "feat");
    expect(invokeMock).toHaveBeenCalledWith("git_create_branch", {
      repoRoot: "/repo",
      name: "feat",
      checkout: false,
      startPoint: null,
      workspace: { kind: "wsl", distro: "Ubuntu" },
    });
  });
});
