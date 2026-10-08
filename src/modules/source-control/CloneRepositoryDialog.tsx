import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import { FolderGitTwoIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useEffect, useId, useRef, useState } from "react";
import { useRepositoryOperation } from "@/modules/source-control/useRepositoryOperation";
import { toast } from "sonner";
import type { CloneOptions } from "./useMultiRepoSourceControl";

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  defaultTargetDir: string | null;
  onClone: (
    url: string,
    targetDir: string,
    options?: CloneOptions,
  ) => Promise<void>;
  onCloned: (targetDir: string) => void;
};

export function CloneRepositoryDialog({
  open,
  onOpenChange,
  defaultTargetDir,
  onClone,
  onCloned,
}: Props) {
  const [url, setUrl] = useState("");
  const [targetDir, setTargetDir] = useState("");
  const [shallow, setShallow] = useState(false);
  const [recurseSubmodules, setRecurseSubmodules] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { busy, run, scopeKey } = useRepositoryOperation(
    open,
    defaultTargetDir ?? "",
  );
  const formId = useId();
  const urlInputRef = useRef<HTMLInputElement>(null);

  // biome-ignore lint/correctness/useExhaustiveDependencies: Reset drafts when the repository or workspace changes.
  useEffect(() => {
    if (!open) return;
    setUrl("");
    setTargetDir(defaultTargetDir ?? "");
    setShallow(false);
    setRecurseSubmodules(false);
    setError(null);
    const timer = setTimeout(() => urlInputRef.current?.focus(), 0);
    return () => clearTimeout(timer);
  }, [open, defaultTargetDir, scopeKey]);

  const submit = async () => {
    if (busy) return;
    const trimmedUrl = url.trim();
    const trimmedTarget = targetDir.trim();
    if (!trimmedUrl) {
      setError("Repository URL is required");
      return;
    }
    if (!trimmedTarget) {
      setError("Target directory is required");
      return;
    }
    setError(null);
    await run(
      () => onClone(trimmedUrl, trimmedTarget, { shallow, recurseSubmodules }),
      () => {
        toast.success(`Cloned into ${trimmedTarget}`);
        onCloned(trimmedTarget);
        onOpenChange(false);
      },
      "Could not clone repository",
      (error) => setError(String(error)),
    );
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="sm:max-w-md"
        showCloseButton={!busy}
        onEscapeKeyDown={(event) => {
          if (busy) event.preventDefault();
        }}
        onPointerDownOutside={(event) => {
          if (busy) event.preventDefault();
        }}
      >
        <DialogHeader>
          <DialogTitle className="flex items-center gap-1.75">
            <HugeiconsIcon
              icon={FolderGitTwoIcon}
              size={16}
              strokeWidth={1.75}
            />
            Clone repository
          </DialogTitle>
          <DialogDescription>
            Clone a remote repository into a local directory. After the clone
            finishes the workspace is rescanned for repositories.
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-3">
          <div className="flex flex-col gap-1">
            <label
              htmlFor={`${formId}-url`}
              className="text-[10.5px] font-medium uppercase tracking-[0.12em] text-muted-foreground/85"
            >
              Repository URL
            </label>
            <Input
              id={`${formId}-url`}
              ref={urlInputRef}
              value={url}
              disabled={busy}
              onChange={(e) => {
                setUrl(e.target.value);
                setError(null);
              }}
              onKeyDown={(e) => {
                if (e.nativeEvent.isComposing || e.keyCode === 229) return;
                if (e.key === "Enter") {
                  e.preventDefault();
                  void submit();
                }
              }}
              className="rounded-lg font-mono text-[11.5px]"
              placeholder="https://github.com/user/repo.git"
            />
          </div>
          <div className="flex flex-col gap-1">
            <label
              htmlFor={`${formId}-target`}
              className="text-[10.5px] font-medium uppercase tracking-[0.12em] text-muted-foreground/85"
            >
              Target directory
            </label>
            <Input
              id={`${formId}-target`}
              value={targetDir}
              disabled={busy}
              onChange={(e) => {
                setTargetDir(e.target.value);
                setError(null);
              }}
              onKeyDown={(e) => {
                if (e.nativeEvent.isComposing || e.keyCode === 229) return;
                if (e.key === "Enter") {
                  e.preventDefault();
                  void submit();
                }
              }}
              className="rounded-lg font-mono text-[11.5px]"
              placeholder="~/projects/my-repo"
            />
          </div>
          <div className="flex items-center gap-4 text-[11px] text-muted-foreground">
            <label
              htmlFor={`${formId}-shallow`}
              className="flex cursor-pointer items-center gap-1.5"
            >
              <Checkbox
                id={`${formId}-shallow`}
                aria-label="Shallow clone"
                checked={shallow}
                disabled={busy}
                onCheckedChange={(checked) => setShallow(checked === true)}
                className="size-3.5"
              />
              Shallow (depth 1)
            </label>
            <label
              htmlFor={`${formId}-submodules`}
              className="flex cursor-pointer items-center gap-1.5"
            >
              <Checkbox
                id={`${formId}-submodules`}
                aria-label="Recurse submodules"
                checked={recurseSubmodules}
                disabled={busy}
                onCheckedChange={(checked) =>
                  setRecurseSubmodules(checked === true)
                }
                className="size-3.5"
              />
              Recurse submodules
            </label>
          </div>
          {error ? (
            <div className="text-[11px] leading-snug text-destructive">
              {error}
            </div>
          ) : null}
        </div>

        <DialogFooter>
          <Button
            variant="ghost"
            disabled={busy}
            onClick={() => onOpenChange(false)}
          >
            Cancel
          </Button>
          <Button disabled={busy} onClick={() => void submit()}>
            {busy ? (
              <>
                <Spinner className="size-3" />
                Cloning…
              </>
            ) : (
              "Clone"
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
