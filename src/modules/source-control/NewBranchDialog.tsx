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
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Spinner } from "@/components/ui/spinner";
import { native } from "@/lib/native";
import { GitBranchPlusIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useEffect, useRef, useState } from "react";
import { errorToast } from "@/lib/errorToast";
import { toast } from "sonner";

/**
 * Create a local branch, optionally switching to it right away. The start
 * point defaults to the currently checked out branch (or HEAD when detached).
 */
export function NewBranchDialog({
  open,
  onOpenChange,
  repoRoot,
  repoName,
  defaultStartPoint,
  onCreated,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  repoRoot: string;
  repoName: string;
  defaultStartPoint: string;
  onCreated: (checkedOut: boolean) => void;
}) {
  const [name, setName] = useState("");
  const [base, setBase] = useState(defaultStartPoint);
  const [checkout, setCheckout] = useState(true);
  const [busy, setBusy] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!open) return;
    setName("");
    setBase(defaultStartPoint);
    setCheckout(true);
    setBusy(false);
    setTimeout(() => inputRef.current?.focus(), 0);
  }, [open, defaultStartPoint]);

  const submit = async () => {
    const trimmed = name.trim();
    if (!trimmed || busy) return;
    setBusy(true);
    try {
      await native.gitCreateBranch(repoRoot, trimmed, {
        checkout,
        startPoint: base.trim() || undefined,
      });
      toast.success(
        checkout
          ? `Created and switched to ${trimmed} in ${repoName}`
          : `Created branch ${trimmed} in ${repoName}`,
      );
      onOpenChange(false);
      onCreated(checkout);
    } catch (e) {
      errorToast(`Could not create branch in ${repoName}`, e);
    } finally {
      setBusy(false);
    }
  };

  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle className="flex gap-1.75">
            <HugeiconsIcon
              icon={GitBranchPlusIcon}
              size={16}
              strokeWidth={1.75}
            />
            新建分支
          </AlertDialogTitle>
          <AlertDialogDescription>
            在 {repoName} 中创建分支。
          </AlertDialogDescription>
        </AlertDialogHeader>
        <div className="grid gap-3">
          <div className="grid gap-1.5">
            <Label
              htmlFor="new-branch-name"
              className="text-xs text-muted-foreground"
            >
              分支名
            </Label>
            <Input
              id="new-branch-name"
              ref={inputRef}
              value={name}
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  void submit();
                }
              }}
              placeholder="feature/name"
            />
          </div>
          <div className="grid gap-1.5">
            <Label
              htmlFor="new-branch-base"
              className="text-xs text-muted-foreground"
            >
              基于
            </Label>
            <Input
              id="new-branch-base"
              value={base}
              onChange={(e) => setBase(e.target.value)}
              placeholder="HEAD"
            />
          </div>
          <label
            htmlFor="new-branch-checkout"
            className="flex cursor-pointer items-center gap-2 text-xs"
          >
            <Checkbox
              id="new-branch-checkout"
              checked={checkout}
              onCheckedChange={(value) => setCheckout(value === true)}
            />
            创建后切换到该分支
          </label>
        </div>
        <AlertDialogFooter>
          <AlertDialogCancel>取消</AlertDialogCancel>
          <Button
            disabled={busy || name.trim().length === 0}
            onClick={() => void submit()}
          >
            {busy ? <Spinner className="size-3" /> : "创建"}
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
