import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import { native } from "@/lib/native";
import { useEffect, useRef, useState } from "react";
import { useRepositoryOperation } from "@/modules/source-control/useRepositoryOperation";
import { toast } from "sonner";

/** Rename a local branch. The input is pre-filled with the current name. */
export function RenameBranchDialog({
  open,
  onOpenChange,
  repoRoot,
  repoName,
  branchName,
  onRenamed,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  repoRoot: string;
  repoName: string;
  branchName: string;
  onRenamed: () => void;
}) {
  const [name, setName] = useState(branchName);
  const { busy, run, scopeKey } = useRepositoryOperation(
    open,
    JSON.stringify([repoRoot, branchName]),
  );
  const inputRef = useRef<HTMLInputElement>(null);

  // biome-ignore lint/correctness/useExhaustiveDependencies: Reset drafts when the repository or workspace changes.
  useEffect(() => {
    if (!open) return;
    setName(branchName);
    const timer = setTimeout(() => {
      const el = inputRef.current;
      if (!el) return;
      el.focus();
      el.select();
    }, 0);
    return () => clearTimeout(timer);
  }, [open, branchName, scopeKey]);

  const submit = async () => {
    const trimmed = name.trim();
    if (!trimmed || trimmed === branchName) return;
    await run(
      (workspace) =>
        native.gitRenameBranch(repoRoot, branchName, trimmed, workspace),
      () => {
        toast.success(`Renamed ${branchName} to ${trimmed} in ${repoName}`);
        onOpenChange(false);
        onRenamed();
      },
      `Could not rename ${branchName}`,
    );
  };

  return (
    <AlertDialog
      open={open}
      onOpenChange={(next) => {
        if (!busy) onOpenChange(next);
      }}
    >
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>重命名分支</AlertDialogTitle>
          <AlertDialogDescription>
            在 {repoName} 中重命名 {branchName}。
          </AlertDialogDescription>
        </AlertDialogHeader>
        <Input
          ref={inputRef}
          value={name}
          disabled={busy}
          aria-label="新分支名"
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => {
            if (e.nativeEvent.isComposing || e.keyCode === 229) return;
            if (e.key === "Enter") {
              e.preventDefault();
              void submit();
            }
          }}
          placeholder="新分支名"
        />
        <AlertDialogFooter>
          <AlertDialogCancel disabled={busy}>取消</AlertDialogCancel>
          <Button
            disabled={
              busy || name.trim().length === 0 || name.trim() === branchName
            }
            onClick={() => void submit()}
          >
            {busy ? <Spinner className="size-3" /> : "重命名"}
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
