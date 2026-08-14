import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import { useEffect, useRef } from "react";

/** Local branch name suggested for a remote branch like `origin/feature/x`. */
export function defaultLocalNameForRemote(remoteBranch: string): string {
  const parts = remoteBranch.split("/").filter(Boolean);
  return parts.length > 1 ? parts.slice(1).join("/") : remoteBranch;
}

/**
 * Name field shown while checking out a remote branch as a new local branch.
 * Pre-filled with the remote-derived name; Enter confirms, Escape cancels.
 * With hasLocal the same-named local branch already exists, so confirming
 * with the unchanged default switches to it instead of creating a copy.
 */
export function RemoteCheckoutRow({
  remote,
  value,
  onChange,
  busy,
  onConfirm,
  onCancel,
  hasLocal = false,
}: {
  remote: string;
  value: string;
  onChange: (value: string) => void;
  busy: boolean;
  onConfirm: () => void;
  onCancel: () => void;
  hasLocal?: boolean;
}) {
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, []);

  return (
    <div className="px-1 pb-1">
      <div className="rounded-lg border border-border/50 bg-background/60 p-1.5">
        <div className="px-1 pb-1 text-[10px] text-muted-foreground">
          {hasLocal ? (
            <>
              本地同名分支{" "}
              <code className="text-foreground/75">
                {defaultLocalNameForRemote(remote)}
              </code>{" "}
              已存在，确认将直接切换到它；改名将创建新分支
            </>
          ) : (
            <>
              将 <code className="text-foreground/75">{remote}</code>{" "}
              检出为本地分支
            </>
          )}
        </div>
        <div className="flex items-center gap-1">
          <Input
            ref={inputRef}
            value={value}
            onChange={(event) => onChange(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") onConfirm();
              else if (event.key === "Escape") onCancel();
            }}
            className="h-7 text-xs"
            placeholder="本地分支名"
          />
          <Button
            size="xs"
            className="h-7 shrink-0 cursor-pointer"
            disabled={busy || value.trim().length === 0}
            onClick={onConfirm}
          >
            {busy ? <Spinner className="size-3" /> : "检出"}
          </Button>
          <Button
            size="xs"
            variant="ghost"
            className="h-7 shrink-0 cursor-pointer"
            onClick={onCancel}
          >
            取消
          </Button>
        </div>
      </div>
    </div>
  );
}
