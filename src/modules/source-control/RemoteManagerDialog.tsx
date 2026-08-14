import { Button } from "@/components/ui/button";
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
import { cn } from "@/lib/utils";
import { native } from "@/lib/native";
import {
  Add01Icon,
  Delete02Icon,
  Edit02Icon,
  Refresh01Icon,
  Tick02Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import type { GitRemoteEntry } from "./useMultiRepoSourceControl";

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  repoRoot: string | null;
  onAdd: (repoRoot: string, name: string, url: string) => Promise<void>;
  onRemove: (repoRoot: string, name: string) => Promise<void>;
  onSetUrl: (repoRoot: string, name: string, url: string) => Promise<void>;
};

type BusyKey = string | null;

export function RemoteManagerDialog({
  open,
  onOpenChange,
  repoRoot,
  onAdd,
  onRemove,
  onSetUrl,
}: Props) {
  const [remotes, setRemotes] = useState<GitRemoteEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [editingUrl, setEditingUrl] = useState<{ name: string; url: string } | null>(
    null,
  );
  const [armedRemove, setArmedRemove] = useState<string | null>(null);
  const [addName, setAddName] = useState("");
  const [addUrl, setAddUrl] = useState("");
  const [busy, setBusy] = useState<BusyKey>(null);

  const load = useCallback(async () => {
    if (!repoRoot) {
      setRemotes([]);
      return;
    }
    setError(null);
    try {
      setRemotes(await native.gitRemoteList(repoRoot));
    } catch (e) {
      setError(typeof e === "string" ? e : String(e));
      setRemotes([]);
    }
  }, [repoRoot]);

  useEffect(() => {
    if (!open) return;
    setEditingUrl(null);
    setArmedRemove(null);
    setAddName("");
    setAddUrl("");
    setBusy(null);
    void load();
  }, [open, load]);

  const run = async (key: string, op: () => Promise<void>) => {
    if (busy) return;
    setBusy(key);
    try {
      await op();
      await load();
    } catch (e) {
      toast.error(typeof e === "string" ? e : String(e));
    } finally {
      setBusy(null);
    }
  };

  const handleAdd = () => {
    const name = addName.trim();
    const url = addUrl.trim();
    if (!name || !url || !repoRoot) return;
    if (/\s/.test(name)) {
      toast.error("Remote names cannot contain whitespace");
      return;
    }
    void run("add", () => onAdd(repoRoot, name, url));
  };

  const handleRemove = (name: string) => {
    if (!repoRoot) return;
    if (armedRemove !== name) {
      setArmedRemove(name);
      return;
    }
    setArmedRemove(null);
    void run(`remove:${name}`, () => onRemove(repoRoot, name));
  };

  const handleSetUrl = (name: string) => {
    if (!repoRoot || !editingUrl) return;
    const url = editingUrl.url.trim();
    if (!url) return;
    void run(`seturl:${name}`, () => onSetUrl(repoRoot, name, url));
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-1.75">
            <HugeiconsIcon
              icon={Edit02Icon}
              size={15}
              strokeWidth={1.9}
            />
            Remotes
          </DialogTitle>
          <DialogDescription>
            Manage the remotes of the selected repository. Fetch and push use
            the branch's tracking remote.
          </DialogDescription>
        </DialogHeader>

        <div className="flex max-h-[45vh] min-h-24 flex-col gap-1 overflow-y-auto">
          {remotes === null ? (
            <div className="flex items-center gap-2 px-1 py-3 text-[11px] text-muted-foreground">
              <Spinner className="size-3" />
              Loading remotes…
            </div>
          ) : error ? (
            <div className="px-1 py-3 text-[11px] leading-snug text-destructive">
              {error}
            </div>
          ) : remotes.length === 0 ? (
            <div className="px-1 py-3 text-[11px] text-muted-foreground">
              No remotes configured.
            </div>
          ) : (
            remotes.map((remote) => {
              const editing = editingUrl?.name === remote.name;
              const removing = armedRemove === remote.name;
              return (
                <div
                  key={remote.name}
                  className="rounded-lg border border-border/50 px-2.5 py-2"
                >
                  <div className="flex min-w-0 items-center gap-2">
                    <span className="min-w-0 flex-1 truncate text-[12px] font-medium">
                      {remote.name}
                    </span>
                    {busy === `seturl:${remote.name}` ? (
                      <Spinner className="size-3" />
                    ) : (
                      <button
                        type="button"
                        title="Change URL"
                        disabled={busy !== null}
                        onClick={() =>
                          setEditingUrl(
                            editing
                              ? null
                              : { name: remote.name, url: remote.url },
                          )
                        }
                        className="cursor-pointer rounded p-1 text-muted-foreground transition-colors hover:bg-foreground/10 hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50"
                      >
                        <HugeiconsIcon
                          icon={Edit02Icon}
                          size={13}
                          strokeWidth={1.9}
                        />
                      </button>
                    )}
                    {busy === `remove:${remote.name}` ? (
                      <Spinner className="size-3" />
                    ) : (
                      <button
                        type="button"
                        title={
                          removing
                            ? "Click again to remove"
                            : "Remove remote"
                        }
                        disabled={busy !== null}
                        onClick={() => handleRemove(remote.name)}
                        className={cn(
                          "cursor-pointer rounded p-1 transition-colors disabled:cursor-not-allowed disabled:opacity-50",
                          removing
                            ? "bg-destructive/15 text-destructive"
                            : "text-muted-foreground hover:bg-foreground/10 hover:text-destructive",
                        )}
                      >
                        <HugeiconsIcon
                          icon={removing ? Tick02Icon : Delete02Icon}
                          size={13}
                          strokeWidth={1.9}
                        />
                      </button>
                    )}
                  </div>
                  <div
                    className="truncate font-mono text-[10px] text-muted-foreground/70"
                    title={remote.url}
                  >
                    {remote.url}
                  </div>
                  {editing ? (
                    <div className="mt-1.5 flex items-center gap-1.5">
                      <Input
                        value={editingUrl?.url ?? ""}
                        onChange={(e) =>
                          setEditingUrl((current) =>
                            current ? { ...current, url: e.target.value } : current,
                          )
                        }
                        onKeyDown={(e) => {
                          if (e.key === "Enter") {
                            e.preventDefault();
                            handleSetUrl(remote.name);
                          }
                          if (e.key === "Escape") setEditingUrl(null);
                        }}
                        className="h-7 rounded-lg px-2 font-mono text-[10.5px]"
                        placeholder="https://github.com/user/repo.git"
                      />
                      <Button
                        size="xs"
                        onClick={() => handleSetUrl(remote.name)}
                        disabled={busy === `seturl:${remote.name}`}
                      >
                        Save
                      </Button>
                      <Button
                        size="xs"
                        variant="ghost"
                        disabled={busy !== null}
                        onClick={() => setEditingUrl(null)}
                      >
                        Cancel
                      </Button>
                    </div>
                  ) : null}
                </div>
              );
            })
          )}
        </div>

        <div className="flex flex-col gap-1.5">
          <div className="text-[10.5px] font-medium uppercase tracking-[0.12em] text-muted-foreground/85">
            Add remote
          </div>
          <div className="flex items-center gap-1.5">
            <Input
              value={addName}
              onChange={(e) => setAddName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  handleAdd();
                }
              }}
              className="h-8 w-28 rounded-lg text-[11px]"
              placeholder="name"
            />
            <Input
              value={addUrl}
              onChange={(e) => setAddUrl(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  handleAdd();
                }
              }}
              className="h-8 min-w-0 flex-1 rounded-lg font-mono text-[11px]"
              placeholder="https://github.com/user/repo.git"
            />
            <Button
              size="xs"
              disabled={busy !== null || !addName.trim() || !addUrl.trim()}
              onClick={handleAdd}
            >
              {busy === "add" ? <Spinner className="size-3" /> : <HugeiconsIcon icon={Add01Icon} size={12} strokeWidth={2} />}
              Add
            </Button>
          </div>
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Close
          </Button>
          <Button
            variant="outline"
            disabled={busy !== null}
            onClick={() => void load()}
          >
            <HugeiconsIcon icon={Refresh01Icon} size={12} strokeWidth={1.9} />
            Refresh
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
