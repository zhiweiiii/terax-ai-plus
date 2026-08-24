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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Spinner } from "@/components/ui/spinner";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { native } from "@/lib/native";
import { ArrowUp01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useEffect, useState } from "react";
import { errorToast } from "@/lib/errorToast";
import { DialogSyncProgress } from "./DialogSyncProgress";
import { parseUpstreamRemote } from "./remoteHelpers";
import type {
  GitRemoteEntry,
  PushAdvancedOptions,
  PushAllResult,
  PushPlan,
  PushPlanCommitDiff,
  SyncProgress,
} from "./useMultiRepoSourceControl";

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  plan: PushPlan | null;
  onPush: (
    plan: PushPlan,
    options: PushAdvancedOptions,
  ) => Promise<PushAllResult>;
  syncProgress?: SyncProgress | null;
};

function PushCommitDiff({ diff }: { diff: PushPlanCommitDiff }) {
  return (
    <div className="ml-5 mt-1">
      {diff.diffText ? (
        <pre className="max-h-48 overflow-y-auto rounded-md bg-muted/40 p-2 font-mono text-[10px] leading-snug whitespace-pre-wrap break-all text-foreground/85">
          {diff.diffText}
        </pre>
      ) : (
        <div className="text-[10.5px] text-muted-foreground/60">
          Patch unavailable.
        </div>
      )}
      {diff.truncated ? (
        <div className="mt-0.5 text-[10px] text-muted-foreground/60">
          Patch truncated.
        </div>
      ) : null}
    </div>
  );
}

export function PushDialog({
  open,
  onOpenChange,
  plan,
  onPush,
  syncProgress,
}: Props) {
  const [options, setOptions] = useState({ force: false });
  const [remotes, setRemotes] = useState<Record<string, GitRemoteEntry[]>>({});
  const [remoteChoice, setRemoteChoice] = useState<Record<string, string>>({});
  // Commit patches currently unfolded, keyed by repo:sha.
  const [expandedDiffs, setExpandedDiffs] = useState<Set<string>>(new Set());
  const [running, setRunning] = useState(false);
  const [rejected, setRejected] = useState<PushAllResult["rejected"]>([]);

  useEffect(() => {
    if (!open || !plan) return;
    setOptions({ force: false });
    setRunning(false);
    setRejected([]);
    setExpandedDiffs(
      new Set(
        plan.entries.flatMap((e) =>
          e.diffs[0] ? [`${e.repoRoot}:${e.diffs[0].sha}`] : [],
        ),
      ),
    );
    const defaults: Record<string, string> = {};
    for (const entry of plan.entries) {
      defaults[entry.repoRoot] =
        entry.remote ??
        parseUpstreamRemote(entry.upstream) ??
        "origin";
    }
    setRemoteChoice(defaults);
    setRemotes({});
    for (const root of plan.entries.map((e) => e.repoRoot)) {
      native
        .gitRemoteList(root)
        .then((list) => {
          setRemotes((current) => ({ ...current, [root]: list }));
          setRemoteChoice((current) => {
            const chosen = current[root];
            if (chosen && list.some((r) => r.name === chosen)) {
              return current;
            }
            const upstream = defaults[root];
            const fallback = list.some((r) => r.name === upstream)
              ? upstream
              : (list[0]?.name ?? chosen ?? "");
            return { ...current, [root]: fallback };
          });
        })
        .catch(() => {
          setRemotes((current) => ({ ...current, [root]: [] }));
        });
    }
  }, [open, plan]);

  const count = plan?.entries.length ?? 0;
  const anyForceNeeded =
    plan?.entries.some((e) => (e.behind ?? 0) > 0) ?? false;
  const canPush = count > 0 && !running;

  const confirmPush = async () => {
    if (!plan || running) return;
    setRunning(true);
    setRejected([]);
    try {
      const confirmed: PushPlan = {
        ...plan,
        entries: plan.entries.map((entry) => ({
          ...entry,
          remote: remoteChoice[entry.repoRoot] || undefined,
        })),
      };
      const result = await onPush(confirmed, {
        ...options,
        noVerify: false,
        tags: "none",
      });
      setRejected(result.rejected);
      if (result.rejected.length === 0) {
        onOpenChange(false);
      }
    } catch (error) {
      errorToast("Push 失败", error);
    } finally {
      setRunning(false);
    }
  };

  const retryWithForce = async (repoRoot: string) => {
    if (!plan || running) return;
    setRunning(true);
    try {
      const entry = plan.entries.find((e) => e.repoRoot === repoRoot);
      if (!entry) return;
      const result = await onPush(
        {
          ...plan,
          entries: [
            { ...entry, remote: remoteChoice[repoRoot] || undefined },
          ],
        },
        { ...options, force: true, noVerify: false, tags: "none" },
      );
      setRejected(result.rejected);
      if (result.rejected.length === 0) {
        onOpenChange(false);
      }
    } catch (error) {
      errorToast("Push 失败", error);
    } finally {
      setRunning(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl" showCloseButton={!running}>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-1.75">
            <HugeiconsIcon icon={ArrowUp01Icon} size={15} strokeWidth={1.9} />
            {count > 0
              ? `Push to ${count} ${count === 1 ? "repository" : "repositories"}?`
              : "Nothing to push"}
          </DialogTitle>
          <DialogDescription>
            {count > 0
              ? "Repositories are pushed one at a time, in this order. Expand a commit to see its patch."
              : "No repository has local commits ready for its upstream."}
          </DialogDescription>
        </DialogHeader>

        {count > 0 ? (
          <div className="flex flex-wrap items-center gap-x-4 gap-y-2 rounded-lg border border-border/50 bg-muted/20 px-2.5 py-2">
            <Tooltip>
              <TooltipTrigger asChild>
                <label
                  htmlFor="push-force"
                  className={cn(
                    "flex cursor-pointer items-center gap-1.5 text-[10.5px]",
                    anyForceNeeded
                      ? "text-muted-foreground"
                      : "cursor-not-allowed text-muted-foreground/50",
                  )}
                >
                  <Checkbox
                    id="push-force"
                    aria-label="Force push with --force-with-lease"
                    checked={options.force}
                    disabled={running || !anyForceNeeded}
                    onCheckedChange={(checked) =>
                      setOptions((current) => ({
                        ...current,
                        force: checked === true,
                      }))
                    }
                    className="size-3.5"
                  />
                  Force push (--force-with-lease)
                </label>
              </TooltipTrigger>
              {!anyForceNeeded ? (
                <TooltipContent
                  side="bottom"
                  className="max-w-56 border border-border/70 bg-zinc-950 text-[10.5px] text-zinc-100"
                >
                  Repositories are strictly ahead of their remotes; force push
                  has nothing to force. If a push is rejected, the progress
                  list offers Force push.
                </TooltipContent>
              ) : null}
            </Tooltip>
          </div>
        ) : null}

        <div className="max-h-[45vh] overflow-y-auto">
          {plan?.entries.map((entry) => {
            const upstreamRemote = parseUpstreamRemote(entry.upstream);
            const repoRemotes = remotes[entry.repoRoot];
            const choice = remoteChoice[entry.repoRoot] ?? "";
            const mismatch =
              !!choice &&
              !!upstreamRemote &&
              choice !== upstreamRemote;
            return (
              <div
                key={entry.repoRoot}
                className="mb-2 rounded-lg border border-border/50 px-2.5 py-2"
              >
                <div className="flex items-baseline gap-2">
                  <span className="truncate text-[12px] font-medium">
                    {entry.name}
                  </span>
                  <span className="truncate text-[10.5px] text-muted-foreground">
                    {entry.branch} → {entry.upstream}
                  </span>
                  <span className="ml-auto shrink-0 rounded-full bg-primary/15 px-1.5 py-0.5 text-[10px] font-medium text-primary">
                    ↑{entry.ahead}
                  </span>
                </div>
                <div className="mt-1 flex items-center gap-1.5">
                  <span className="text-[10px] text-muted-foreground/70">
                    Push to
                  </span>
                  {repoRemotes && repoRemotes.length > 0 ? (
                    <Select
                      value={choice}
                      onValueChange={(name) =>
                        setRemoteChoice((current) => ({
                          ...current,
                          [entry.repoRoot]: name,
                        }))
                      }
                    >
                      <SelectTrigger size="sm" className="h-6 px-1.5 text-[10.5px]">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {repoRemotes.map((remote) => (
                          <SelectItem
                            key={remote.name}
                            value={remote.name}
                            className="text-[11px]"
                          >
                            {remote.name}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  ) : (
                    <span className="text-[10.5px] text-muted-foreground/60">
                      {choice || "…"}
                    </span>
                  )}
                  {mismatch ? (
                    <span className="ml-1 text-[10px] text-amber-500/90">
                      Only the tracking remote ({upstreamRemote}) can receive
                      this push; "{choice}" will fail.
                    </span>
                  ) : null}
                </div>
                <ul className="mt-1 flex flex-col gap-0.5">
                  {entry.commits.map((c) => {
                    const diff = entry.diffs.find((d) => d.sha === c.sha);
                    const diffKey = `${entry.repoRoot}:${c.sha}`;
                    const expanded = expandedDiffs.has(diffKey);
                    return (
                      <li key={c.sha} className="text-[10.5px]">
                        <div className="flex items-baseline gap-2">
                          <button
                            type="button"
                            disabled={!diff}
                            onClick={() => {
                              if (!diff) return;
                              setExpandedDiffs((current) => {
                                const next = new Set(current);
                                if (next.has(diffKey)) next.delete(diffKey);
                                else next.add(diffKey);
                                return next;
                              });
                            }}
                            className={cn(
                              "inline-flex shrink-0 cursor-pointer items-center gap-1.5 rounded text-left disabled:cursor-default disabled:opacity-40",
                              "transition-colors hover:bg-foreground/5",
                            )}
                            title={diff ? "Show patch" : "No patch available"}
                          >
                            <HugeiconsIcon
                              icon={ArrowUp01Icon}
                              size={9}
                              strokeWidth={2}
                              className={cn(
                                "shrink-0 text-muted-foreground transition-transform",
                                expanded && "rotate-180",
                              )}
                            />
                            <code className="text-muted-foreground/70">
                              {c.shortSha}
                            </code>
                          </button>
                          <span className="min-w-0 flex-1 truncate">
                            {c.subject}
                          </span>
                        </div>
                        {expanded && diff ? <PushCommitDiff diff={diff} /> : null}
                      </li>
                    );
                  })}
                </ul>
                {entry.moreCommits > 0 ? (
                  <div className="mt-1 text-[10px] text-muted-foreground/60">
                    +{entry.moreCommits} more{" "}
                    {entry.moreCommits === 1 ? "commit" : "commits"} pushed
                    (patch not shown)
                  </div>
                ) : null}
              </div>
            );
          })}
          {plan && plan.skipped.length > 0 ? (
            <div className="mt-1 rounded-lg bg-muted/40 px-2.5 py-2">
              <div className="mb-1 text-[10.5px] font-medium text-muted-foreground">
                Skipped
              </div>
              <ul className="flex flex-col gap-0.5">
                {plan.skipped.map((sk) => (
                  <li
                    key={sk.name}
                    className="flex items-baseline gap-2 text-[10.5px] text-muted-foreground"
                  >
                    <span className="min-w-0 flex-1 truncate">{sk.name}</span>
                    <span className="shrink-0">{sk.reason}</span>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
        </div>

        {syncProgress && syncProgress.items.length > 0 ? (
          <DialogSyncProgress
            progress={syncProgress}
            renderFailed={(item) =>
              !running &&
              rejected.some((r) => r.repoRoot === item.repoRoot) ? (
                <button
                  type="button"
                  onClick={() => void retryWithForce(item.repoRoot)}
                  className="ml-1 shrink-0 cursor-pointer rounded border border-amber-500/40 bg-amber-500/10 px-1.5 py-0.5 text-[10px] font-medium text-amber-500 transition-colors hover:bg-amber-500/20"
                >
                  Force push?
                </button>
              ) : null
            }
          />
        ) : null}

        <DialogFooter>
          <Button
            variant="ghost"
            disabled={running}
            onClick={() => onOpenChange(false)}
          >
            Cancel
          </Button>
          <Button disabled={!canPush} onClick={() => void confirmPush()}>
            {running ? (
              <>
                <Spinner className="size-3" />
                Pushing…
              </>
            ) : (
              `Push ${count}`
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
