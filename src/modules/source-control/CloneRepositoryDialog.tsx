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
import { useEffect, useRef, useState } from "react";
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
  const [busy, setBusy] = useState(false);
  const urlInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!open) return;
    setUrl("");
    setTargetDir(defaultTargetDir ?? "");
    setShallow(false);
    setRecurseSubmodules(false);
    setError(null);
    setBusy(false);
    setTimeout(() => urlInputRef.current?.focus(), 0);
  }, [open, defaultTargetDir]);

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
    setBusy(true);
    try {
      await onClone(trimmedUrl, trimmedTarget, { shallow, recurseSubmodules });
      toast.success(`Cloned into ${trimmedTarget}`);
      onCloned(trimmedTarget);
      onOpenChange(false);
    } catch (e) {
      setError(typeof e === "string" ? e : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
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
              htmlFor="clone-repo-url"
              className="text-[10.5px] font-medium uppercase tracking-[0.12em] text-muted-foreground/85"
            >
              Repository URL
            </label>
            <Input
              id="clone-repo-url"
              ref={urlInputRef}
              value={url}
              onChange={(e) => {
                setUrl(e.target.value);
                setError(null);
              }}
              onKeyDown={(e) => {
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
              htmlFor="clone-target-dir"
              className="text-[10.5px] font-medium uppercase tracking-[0.12em] text-muted-foreground/85"
            >
              Target directory
            </label>
            <Input
              id="clone-target-dir"
              value={targetDir}
              onChange={(e) => {
                setTargetDir(e.target.value);
                setError(null);
              }}
              onKeyDown={(e) => {
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
              htmlFor="clone-shallow"
              className="flex cursor-pointer items-center gap-1.5"
            >
              <Checkbox
                id="clone-shallow"
                aria-label="Shallow clone"
                checked={shallow}
                disabled={busy}
                onCheckedChange={(checked) => setShallow(checked === true)}
                className="size-3.5"
              />
              Shallow (depth 1)
            </label>
            <label
              htmlFor="clone-submodules"
              className="flex cursor-pointer items-center gap-1.5"
            >
              <Checkbox
                id="clone-submodules"
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
