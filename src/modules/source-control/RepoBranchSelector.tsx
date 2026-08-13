import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Spinner } from "@/components/ui/spinner";
import { cn } from "@/lib/utils";
import {
  type GitBranchEntry,
  type GitRepoHead,
  native,
} from "@/modules/ai/lib/native";
import {
  ArrowDown01Icon,
  CloudDownloadIcon,
  FolderGitTwoIcon,
  GitBranchIcon,
  Refresh01Icon,
  Tick02Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useCallback, useRef, useState } from "react";
import { toast } from "sonner";

type Props = {
  repos: GitRepoHead[];
  /** Repo whose branch is shown on the trigger. */
  activeRepo: string | null;
  activeBranch: string | null;
  onChangeRepo: (root: string) => void;
  onRescan?: () => void;
  /** Called after a successful checkout so the panel can reload. */
  onCheckedOut?: (repoRoot: string) => void;
  changedCount?: (root: string) => number;
};

function shortName(repoRoot: string): string {
  return repoRoot.split(/[/\\]/).filter(Boolean).pop() ?? repoRoot;
}

/**
 * One control for both axes: pick the repo on the first level, its branch on the
 * second. Branches are only fetched when a repo's submenu opens — listing them
 * for a ten-repo workspace up front would be ten git calls for data nobody asked
 * to see.
 */
export function RepoBranchSelector({
  repos,
  activeRepo,
  activeBranch,
  onChangeRepo,
  onRescan,
  onCheckedOut,
  changedCount,
}: Props) {
  const [branches, setBranches] = useState<Record<string, GitBranchEntry[]>>(
    {},
  );
  const [loading, setLoading] = useState<string | null>(null);
  const [checkingOut, setCheckingOut] = useState<string | null>(null);
  const inFlight = useRef<Set<string>>(new Set());

  const loadBranches = useCallback(async (repoRoot: string) => {
    if (inFlight.current.has(repoRoot)) return;
    inFlight.current.add(repoRoot);
    setLoading(repoRoot);
    try {
      const result = await native.gitListBranches(repoRoot);
      setBranches((current) => ({ ...current, [repoRoot]: result.branches }));
    } catch (e) {
      toast.error(`Could not list branches for ${shortName(repoRoot)}`, {
        description: String(e),
      });
    } finally {
      inFlight.current.delete(repoRoot);
      setLoading((current) => (current === repoRoot ? null : current));
    }
  }, []);

  const checkout = useCallback(
    async (repoRoot: string, branch: GitBranchEntry) => {
      if (checkingOut) return;
      setCheckingOut(`${repoRoot}:${branch.name}`);
      try {
        await native.gitCheckoutBranch(repoRoot, branch.name);
        // A remote ref becomes a local tracking branch, so the cached list for
        // this repo is stale either way.
        setBranches((current) => {
          const next = { ...current };
          delete next[repoRoot];
          return next;
        });
        onChangeRepo(repoRoot);
        onCheckedOut?.(repoRoot);
        toast.success(
          branch.kind === "remote"
            ? `Checked out ${branch.name} in ${shortName(repoRoot)}`
            : `Switched to ${branch.name} in ${shortName(repoRoot)}`,
        );
      } catch (e) {
        toast.error(`Checkout failed in ${shortName(repoRoot)}`, {
          description: String(e),
        });
      } finally {
        setCheckingOut(null);
      }
    },
    [checkingOut, onChangeRepo, onCheckedOut],
  );

  if (repos.length === 0) return null;

  const activeName = activeRepo ? shortName(activeRepo) : null;

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="sm"
          className="h-7 min-w-0 gap-1.5 px-2 text-xs text-muted-foreground hover:text-foreground"
          title="Switch repository or branch"
        >
          <HugeiconsIcon icon={FolderGitTwoIcon} size={14} strokeWidth={1.75} />
          <span className="max-w-28 truncate">{activeName ?? "No repo"}</span>
          {activeBranch ? (
            <>
              <span className="shrink-0 text-muted-foreground/40">/</span>
              <span className="max-w-24 truncate text-foreground/80">
                {activeBranch}
              </span>
            </>
          ) : null}
          <HugeiconsIcon
            icon={ArrowDown01Icon}
            size={10}
            strokeWidth={2}
            className="shrink-0 opacity-60"
          />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="start"
        side="bottom"
        sideOffset={4}
        className="max-h-80 w-72 overflow-y-auto rounded-xl border border-border/40 bg-popover/90 p-1 shadow-lg backdrop-blur-md"
      >
        <DropdownMenuLabel className="flex items-center gap-2 px-2 py-1.5 text-[11px] text-muted-foreground">
          <HugeiconsIcon icon={FolderGitTwoIcon} size={12} strokeWidth={1.75} />
          <span className="flex-1">Repositories ({repos.length})</span>
          {onRescan && (
            <Button
              variant="ghost"
              size="icon-sm"
              className="size-5 rounded"
              title="Rescan"
              onClick={(e) => {
                e.stopPropagation();
                onRescan();
              }}
            >
              <HugeiconsIcon icon={Refresh01Icon} size={11} strokeWidth={2} />
            </Button>
          )}
        </DropdownMenuLabel>
        <DropdownMenuSeparator className="my-0.5 border-t border-border/30" />
        {repos.map((repo) => {
          const isActive = repo.repoRoot === activeRepo;
          const count = changedCount?.(repo.repoRoot);
          const list = branches[repo.repoRoot];
          const locals = (list ?? []).filter((b) => b.kind !== "remote");
          const remotes = (list ?? []).filter((b) => b.kind === "remote");
          return (
            <DropdownMenuSub key={repo.repoRoot}>
              <DropdownMenuSubTrigger
                onPointerEnter={() => {
                  if (!branches[repo.repoRoot])
                    void loadBranches(repo.repoRoot);
                }}
                className={cn(
                  "flex cursor-default items-center gap-2 rounded-lg px-2.5 py-1.5",
                  isActive && "bg-accent text-accent-foreground",
                )}
              >
                <HugeiconsIcon
                  icon={FolderGitTwoIcon}
                  size={13}
                  strokeWidth={1.75}
                  className="shrink-0 text-muted-foreground"
                />
                <div className="min-w-0 flex-1">
                  <div className="truncate text-xs">
                    {shortName(repo.repoRoot)}
                  </div>
                  <div className="truncate text-[10px] text-muted-foreground">
                    {repo.branch}
                  </div>
                </div>
                {count !== undefined && count > 0 && (
                  <span className="shrink-0 rounded-full bg-primary/15 px-1.5 py-0.5 text-[10px] font-medium text-primary">
                    {count}
                  </span>
                )}
                {isActive && (
                  <HugeiconsIcon
                    icon={Tick02Icon}
                    size={13}
                    strokeWidth={2.25}
                    className="shrink-0 text-primary"
                  />
                )}
              </DropdownMenuSubTrigger>
              <DropdownMenuSubContent className="max-h-80 w-64 overflow-y-auto rounded-xl border border-border/40 bg-popover/90 p-1 shadow-lg backdrop-blur-md">
                {!list && loading === repo.repoRoot ? (
                  <div className="flex items-center gap-2 px-2.5 py-2 text-[11px] text-muted-foreground">
                    <Spinner className="size-3" />
                    Loading branches…
                  </div>
                ) : null}
                {list && locals.length === 0 && remotes.length === 0 ? (
                  <div className="px-2.5 py-2 text-[11px] text-muted-foreground">
                    No branches
                  </div>
                ) : null}
                {locals.length > 0 ? (
                  <DropdownMenuLabel className="px-2 py-1 text-[10px] uppercase tracking-wide text-muted-foreground/70">
                    Local
                  </DropdownMenuLabel>
                ) : null}
                {locals.map((branch) => (
                  <BranchItem
                    key={`l:${branch.name}`}
                    branch={branch}
                    busy={checkingOut === `${repo.repoRoot}:${branch.name}`}
                    onSelect={() => void checkout(repo.repoRoot, branch)}
                  />
                ))}
                {remotes.length > 0 ? (
                  <>
                    <DropdownMenuSeparator className="my-0.5 border-t border-border/30" />
                    <DropdownMenuLabel className="px-2 py-1 text-[10px] uppercase tracking-wide text-muted-foreground/70">
                      Remote — checkout creates a tracking branch
                    </DropdownMenuLabel>
                  </>
                ) : null}
                {remotes.map((branch) => (
                  <BranchItem
                    key={`r:${branch.name}`}
                    branch={branch}
                    busy={checkingOut === `${repo.repoRoot}:${branch.name}`}
                    onSelect={() => void checkout(repo.repoRoot, branch)}
                  />
                ))}
              </DropdownMenuSubContent>
            </DropdownMenuSub>
          );
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function BranchItem({
  branch,
  busy,
  onSelect,
}: {
  branch: GitBranchEntry;
  busy: boolean;
  onSelect: () => void;
}) {
  const remote = branch.kind === "remote";
  return (
    <DropdownMenuItem
      onSelect={(e) => {
        // Keep the menu open long enough for the spinner to be visible.
        e.preventDefault();
        onSelect();
      }}
      className="flex cursor-default items-center gap-2 rounded-lg px-2.5 py-1.5"
    >
      {busy ? (
        <Spinner className="size-3 shrink-0" />
      ) : (
        <HugeiconsIcon
          icon={remote ? CloudDownloadIcon : GitBranchIcon}
          size={12}
          strokeWidth={1.75}
          className={cn(
            "shrink-0",
            remote ? "text-sky-500/80" : "text-muted-foreground",
          )}
        />
      )}
      <span className="min-w-0 flex-1 truncate text-xs">{branch.name}</span>
      {branch.isHead ? (
        <HugeiconsIcon
          icon={Tick02Icon}
          size={12}
          strokeWidth={2.25}
          className="shrink-0 text-primary"
        />
      ) : null}
      {branch.kind === "worktree" ? (
        <span className="shrink-0 text-[9px] text-muted-foreground/70">
          worktree
        </span>
      ) : null}
    </DropdownMenuItem>
  );
}
