import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Spinner } from "@/components/ui/spinner";
import { type GitDiffResult, native } from "@/lib/native";
import { FileDiffIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useCallback, useEffect, useState } from "react";
import { errorToast } from "@/lib/errorToast";

/** Working-tree diff of the current branch, read-only in a scrollable panel. */
export function WorkingTreeDiffDialog({
  open,
  onOpenChange,
  repoRoot,
  repoName,
  refName,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  repoRoot: string;
  repoName: string;
  refName: string;
}) {
  const [diff, setDiff] = useState<GitDiffResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(true);

  const load = useCallback(async () => {
    setBusy(true);
    setError(null);
    setDiff(null);
    try {
      setDiff(await native.gitDiffWithRef(repoRoot, refName));
    } catch (e) {
      setError(String(e));
      errorToast(`Could not diff ${refName} against the working tree`, e);
    } finally {
      setBusy(false);
    }
  }, [repoRoot, refName]);

  useEffect(() => {
    if (open) void load();
  }, [open, load]);

  // Drop stale results while closed so the next open starts clean.
  useEffect(() => {
    if (open) return;
    setDiff(null);
    setError(null);
    setBusy(true);
  }, [open]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle className="flex gap-1.75">
            <HugeiconsIcon icon={FileDiffIcon} size={16} strokeWidth={1.75} />
            与工作区比较
          </DialogTitle>
          <DialogDescription>
            {refName} 与工作区（在 {repoName} 中）。
          </DialogDescription>
        </DialogHeader>
        {busy ? (
          <div className="flex items-center justify-center gap-2 py-10 text-[11px] text-muted-foreground">
            <Spinner className="size-3" />
            加载差异中…
          </div>
        ) : error ? (
          <div className="grid gap-2 py-6 text-center">
            <div className="px-4 text-xs text-destructive">{error}</div>
            <div className="flex justify-center">
              <Button variant="ghost" size="sm" onClick={() => void load()}>
                重试
              </Button>
            </div>
          </div>
        ) : diff?.diffText ? (
          <pre className="max-h-96 overflow-y-auto rounded-lg bg-muted/40 p-3 font-mono text-[11px] leading-snug whitespace-pre-wrap break-all text-foreground/85">
            {diff.diffText}
          </pre>
        ) : (
          <div className="py-6 text-center text-[11px] text-muted-foreground">
            无差异。
          </div>
        )}
        {diff?.truncated ? (
          <div className="text-[10px] text-muted-foreground/60">
            差异已截断。
          </div>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}
