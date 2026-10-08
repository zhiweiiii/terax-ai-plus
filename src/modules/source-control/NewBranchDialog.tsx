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
import { useEffect, useId, useRef, useState } from "react";
import { useRepositoryOperation } from "@/modules/source-control/useRepositoryOperation";
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
  const { busy, run, scopeKey } = useRepositoryOperation(
    open,
    JSON.stringify([repoRoot, defaultStartPoint]),
  );
  const formId = useId();
  const inputRef = useRef<HTMLInputElement>(null);

  // biome-ignore lint/correctness/useExhaustiveDependencies: Reset drafts when the repository or workspace changes.
  useEffect(() => {
    if (!open) return;
    setName("");
    setBase(defaultStartPoint);
    setCheckout(true);
    const timer = setTimeout(() => inputRef.current?.focus(), 0);
    return () => clearTimeout(timer);
  }, [open, defaultStartPoint, scopeKey]);

  const submit = async () => {
    const trimmed = name.trim();
    if (!trimmed) return;
    await run(
      (workspace) =>
        native.gitCreateBranch(
          repoRoot,
          trimmed,
          {
            checkout,
            startPoint: base.trim() || undefined,
          },
          workspace,
        ),
      () => {
        toast.success(
          checkout
            ? `Created and switched to ${trimmed} in ${repoName}`
            : `Created branch ${trimmed} in ${repoName}`,
        );
        onOpenChange(false);
        onCreated(checkout);
      },
      `Could not create branch in ${repoName}`,
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
              htmlFor={`${formId}-name`}
              className="text-xs text-muted-foreground"
            >
              分支名
            </Label>
            <Input
              id={`${formId}-name`}
              ref={inputRef}
              value={name}
              disabled={busy}
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => {
                if (e.nativeEvent.isComposing || e.keyCode === 229) return;
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
              htmlFor={`${formId}-base`}
              className="text-xs text-muted-foreground"
            >
              基于
            </Label>
            <Input
              id={`${formId}-base`}
              value={base}
              disabled={busy}
              onChange={(e) => setBase(e.target.value)}
              placeholder="HEAD"
            />
          </div>
          <label
            htmlFor={`${formId}-checkout`}
            className="flex cursor-pointer items-center gap-2 text-xs"
          >
            <Checkbox
              id={`${formId}-checkout`}
              checked={checkout}
              disabled={busy}
              onCheckedChange={(value) => setCheckout(value === true)}
            />
            创建后切换到该分支
          </label>
        </div>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={busy}>取消</AlertDialogCancel>
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
