import { type GitBranchEntry, native } from "@/lib/native";
import { useRepositoryOperation } from "@/modules/source-control/useRepositoryOperation";
import { toast } from "sonner";
import { BranchConfirmDialog } from "./BranchConfirmDialog";

/**
 * Confirm deleting a local or remote branch. The current branch never offers
 * the delete affordance, so it cannot land here.
 */
export function DeleteBranchDialog({
  open,
  onOpenChange,
  repoRoot,
  repoName,
  branch,
  onDeleted,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  repoRoot: string;
  repoName: string;
  branch: GitBranchEntry | null;
  onDeleted: () => void;
}) {
  const { busy, run } = useRepositoryOperation(
    open,
    JSON.stringify([repoRoot, branch?.name, branch?.kind]),
  );
  const remote = branch?.kind === "remote";

  const submit = async () => {
    if (!branch || !repoRoot || branch.isHead) return;
    await run(
      (workspace) =>
        native.gitDeleteBranch(repoRoot, branch.name, { remote }, workspace),
      () => {
        toast.success(
          remote
            ? `Deleted remote branch ${branch.name}`
            : `Deleted branch ${branch.name} in ${repoName}`,
        );
        onOpenChange(false);
        onDeleted();
      },
      `Could not delete ${branch.name}`,
    );
  };

  return (
    <BranchConfirmDialog
      open={open}
      onOpenChange={onOpenChange}
      destructive
      busy={busy}
      title={remote ? "删除远程分支" : "删除分支"}
      description={
        branch ? (
          <>
            删除{" "}
            <code className="rounded bg-muted/60 px-1 font-mono text-[11px]">
              {branch.name}
            </code>
            {remote ? "（远程）" : `（在 ${repoName} 中）`}？此操作无法撤销。
          </>
        ) : null
      }
      confirmLabel="删除"
      onConfirm={() => void submit()}
    />
  );
}
