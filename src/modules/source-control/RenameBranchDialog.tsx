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
import { errorToast } from "@/lib/errorToast";
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
  const [busy, setBusy] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!open) return;
    setName(branchName);
    setBusy(false);
    setTimeout(() => {
      const el = inputRef.current;
      if (!el) return;
      el.focus();
      el.select();
    }, 0);
  }, [open, branchName]);

  const submit = async () => {
    const trimmed = name.trim();
    if (!trimmed || trimmed === branchName || busy) return;
    setBusy(true);
    try {
      await native.gitRenameBranch(repoRoot, branchName, trimmed);
      toast.success(`Renamed ${branchName} to ${trimmed} in ${repoName}`);
      onOpenChange(false);
      onRenamed();
    } catch (e) {
      errorToast(`Could not rename ${branchName}`, e);
    } finally {
      setBusy(false);
    }
  };

  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
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
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              void submit();
            }
          }}
          placeholder="新分支名"
        />
        <AlertDialogFooter>
          <AlertDialogCancel>取消</AlertDialogCancel>
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
