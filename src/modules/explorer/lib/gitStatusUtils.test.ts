import { describe, expect, it } from "vitest";
import type { GitChangedFile, GitStatusSnapshot } from "@/lib/native";
import {
  buildGitStatusMap,
  containingRepoRoot,
  lookupGitStatus,
  repoRelativePath,
  statusCodeForFile,
} from "./gitStatusUtils";

function file(overrides: Partial<GitChangedFile>): GitChangedFile {
  return {
    path: "a.ts",
    originalPath: null,
    indexStatus: " ",
    worktreeStatus: " ",
    staged: false,
    unstaged: false,
    untracked: false,
    statusLabel: "",
    ...overrides,
  };
}

function snapshot(changedFiles: GitChangedFile[]): GitStatusSnapshot {
  return {
    repoRoot: "/repo",
    branch: "main",
    upstream: null,
    ahead: 0,
    behind: 0,
    isDetached: false,
    truncated: false,
    changedFiles,
  };
}

describe("statusCodeForFile", () => {
  it("maps untracked", () => {
    expect(statusCodeForFile(file({ untracked: true }))).toBe("U");
    expect(statusCodeForFile(file({ worktreeStatus: "U" }))).toBe("U");
  });

  it("prefers worktree status when unstaged, index when staged", () => {
    expect(
      statusCodeForFile(file({ unstaged: true, worktreeStatus: "M" })),
    ).toBe("M");
    expect(statusCodeForFile(file({ staged: true, indexStatus: "A" }))).toBe(
      "A",
    );
  });

  it("normalizes rename/copy to R", () => {
    expect(statusCodeForFile(file({ staged: true, indexStatus: "R" }))).toBe(
      "R",
    );
    expect(statusCodeForFile(file({ staged: true, indexStatus: "C" }))).toBe(
      "R",
    );
  });
});

describe("buildGitStatusMap", () => {
  it("keys by normalized repo-relative path", () => {
    const map = buildGitStatusMap(
      snapshot([
        file({ path: "src/a.ts", unstaged: true, worktreeStatus: "M" }),
        file({ path: "b.ts", untracked: true }),
      ]),
    );
    expect(map.get("src/a.ts")).toBe("M");
    expect(map.get("b.ts")).toBe("U");
  });
});

describe("repoRelativePath", () => {
  it("returns relative path for files under the root", () => {
    expect(repoRelativePath("/repo/src/a.ts", ["/repo"])).toBe("src/a.ts");
  });

  it("returns empty string for the root itself", () => {
    expect(repoRelativePath("/repo", ["/repo"])).toBe("");
  });

  it("returns null when outside every root", () => {
    expect(repoRelativePath("/other/a.ts", ["/repo"])).toBeNull();
  });

  it("normalizes backslashes and trailing slashes", () => {
    expect(repoRelativePath("C:\\repo\\src\\a.ts", ["C:/repo/"])).toBe(
      "src/a.ts",
    );
  });

  it("matches through a symlinked alias root", () => {
    expect(
      repoRelativePath("/tmp/proj/a.ts", ["/private/tmp/proj", "/tmp/proj"]),
    ).toBe("a.ts");
  });
});

describe("lookupGitStatus", () => {
  const map = buildGitStatusMap(
    snapshot([file({ path: "src/a.ts", unstaged: true, worktreeStatus: "M" })]),
  );

  it("resolves an absolute path against the repo root", () => {
    expect(lookupGitStatus(map, "/repo", "/repo/src/a.ts")).toBe("M");
  });

  it("returns null for unchanged and out-of-repo paths", () => {
    expect(lookupGitStatus(map, "/repo", "/repo/src/b.ts")).toBeNull();
    expect(lookupGitStatus(map, "/repo", "/elsewhere/a.ts")).toBeNull();
  });
});

describe("containingRepoRoot", () => {
  it("picks the deepest repo containing the path", () => {
    expect(
      containingRepoRoot(["/ws", "/ws/repo-b", "/ws/repo-a"], "/ws/repo-a/x.ts"),
    ).toBe("/ws/repo-a");
  });

  it("returns null when no repo covers the path", () => {
    expect(containingRepoRoot(["/ws/repo-a"], "/other/x.ts")).toBeNull();
  });

  it("treats the repo root itself as contained", () => {
    expect(containingRepoRoot(["/ws/repo-a"], "/ws/repo-a")).toBe(
      "/ws/repo-a",
    );
  });

  it("never matches a repo that is merely a path prefix", () => {
    expect(
      containingRepoRoot(["/ws/repo"], "/ws/repo-other/x.ts"),
    ).toBeNull();
  });

  it("normalizes backslashes on the queried path", () => {
    expect(
      containingRepoRoot(["C:/ws/repo-a"], "C:\\ws\\repo-a\\x.ts"),
    ).toBe("C:/ws/repo-a");
  });
});
