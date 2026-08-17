import type { GitRepoHead } from "@/lib/native";
import type { GitHistoryTab, Tab } from "@/modules/tabs";
import { useEffect, useRef } from "react";
import { GitHistoryPane, type GitHistoryPaneHandle } from "./GitHistoryPane";

type CommitFileDiffOpenInput = {
  repoRoot: string;
  sha: string;
  shortSha: string;
  subject: string;
  path: string;
  originalPath: string | null;
};

type Props = {
  tabs: Tab[];
  activeId: number;
  registerHandle: (id: number, handle: GitHistoryPaneHandle | null) => void;
  /** Workspace repos; >1 enables switching the active history tab in place. */
  repos?: GitRepoHead[];
  /** Re-target the active git-history tab to another repo. */
  onSwitchRepo?: (
    tabId: number,
    repoRoot: string,
    branch: string | null,
  ) => void;
  onOpenCommitFile: (input: CommitFileDiffOpenInput) => void;
};

export function GitHistoryStack({
  tabs,
  activeId,
  registerHandle,
  repos,
  onSwitchRepo,
  onOpenCommitFile,
}: Props) {
  const active = tabs.find(
    (t): t is GitHistoryTab => t.kind === "git-history" && t.id === activeId,
  );
  const registerRef = useRef(registerHandle);
  useEffect(() => {
    registerRef.current = registerHandle;
  }, [registerHandle]);

  const setRef = (h: GitHistoryPaneHandle | null) =>
    registerRef.current(active?.id ?? -1, h);

  if (!active) return null;
  return (
    <GitHistoryPane
      key={active.id}
      ref={setRef}
      repoRoot={active.repoRoot}
      repos={repos}
      onSwitchRepo={
        onSwitchRepo
          ? (repoRoot, branch) => onSwitchRepo(active.id, repoRoot, branch)
          : undefined
      }
      onOpenCommitFile={onOpenCommitFile}
    />
  );
}
