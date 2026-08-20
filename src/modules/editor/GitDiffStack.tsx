import type { GitCommitFileDiffTab, GitDiffTab, Tab } from "@/modules/tabs";
import { useEffect, useRef } from "react";
import type { GitDiffPaneHandle } from "./GitDiffPane";
import { GitDiffPane } from "./GitDiffPane";

export type { GitDiffPaneHandle };

type Props = {
  tabs: Tab[];
  activeId: number;
  registerHandle: (id: number, handle: GitDiffPaneHandle | null) => void;
  onAttachToAgent?: (absolutePath: string) => void;
};

export function GitDiffStack({
  tabs,
  activeId,
  registerHandle,
  onAttachToAgent,
}: Props) {
  const active = tabs.find(
    (t): t is GitDiffTab | GitCommitFileDiffTab =>
      (t.kind === "git-diff" || t.kind === "git-commit-file") &&
      t.id === activeId,
  );
  const registerRef = useRef(registerHandle);
  useEffect(() => {
    registerRef.current = registerHandle;
  }, [registerHandle]);

  const setRef = (h: GitDiffPaneHandle | null) =>
    registerRef.current(active?.id ?? -1, h);

  if (!active) return null;
  if (active.kind === "git-diff") {
    return (
      <div className="h-full w-full">
        <GitDiffPane
          key={active.id}
          ref={setRef}
          active
          source={{
            kind: "working",
            repoRoot: active.repoRoot,
            path: active.path,
            mode: active.mode,
            originalPath: active.originalPath,
          }}
          onAttachToAgent={onAttachToAgent}
        />
      </div>
    );
  }
  return (
    <div className="h-full w-full">
      <GitDiffPane
        key={active.id}
        ref={setRef}
        active
        source={{
          kind: "commit",
          repoRoot: active.repoRoot,
          sha: active.sha,
          path: active.path,
          originalPath: active.originalPath,
        }}
        chipLabel={active.shortSha}
        onAttachToAgent={onAttachToAgent}
      />
    </div>
  );
}
