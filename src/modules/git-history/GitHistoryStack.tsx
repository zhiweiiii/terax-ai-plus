import type { GitRepoHead } from "@/lib/native";
import type { GitHistoryTab, Tab } from "@/modules/tabs";
import { GitHistoryPane } from "./GitHistoryPane";

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
  repos,
  onSwitchRepo,
  onOpenCommitFile,
}: Props) {
  const active = tabs.find(
    (t): t is GitHistoryTab => t.kind === "git-history" && t.id === activeId,
  );
  if (!active) return null;
  return (
    <GitHistoryPane
      key={active.id}
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
