import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";
import type { GitRepoHead } from "@/modules/ai/lib/native";
import {
  ArrowDown01Icon,
  FolderGitTwoIcon,
  Refresh01Icon,
  Tick02Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";

type Props = {
  repos: GitRepoHead[];
  activeRepo: string | null;
  onChangeRepo: (root: string) => void;
  onRefresh?: () => void;
  changedCount?: (root: string) => number;
};

/**
 * A compact dropdown that lets users switch between multiple git repos
 * discovered in the workspace. Only renders when repos.length > 1.
 */
export function RepoSelector({
  repos,
  activeRepo,
  onChangeRepo,
  onRefresh,
  changedCount,
}: Props) {
  // TEMP: always render for debugging
  if (repos.length === 0) {
    return (
      <span className="shrink-0 rounded bg-yellow-500/15 px-2 py-0.5 text-[10px] text-yellow-600">
        No repos found under scan root
      </span>
    );
  }

  const activeName = activeRepo
    ? (repos
        .find((r) => r.repoRoot === activeRepo)
        ?.repoRoot.split(/[/\\]/)
        .pop() ?? activeRepo)
    : null;

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="sm"
          className="h-7 gap-1.5 px-2 text-xs text-muted-foreground hover:text-foreground"
          title="Switch repository"
        >
          <HugeiconsIcon icon={FolderGitTwoIcon} size={14} strokeWidth={1.75} />
          <span className="max-w-32 truncate">{activeName ?? "No repo"}</span>
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
        className="max-h-72 w-72 overflow-y-auto rounded-xl border border-border/40 bg-popover/90 p-1 backdrop-blur-md shadow-lg"
      >
        <DropdownMenuLabel className="flex items-center gap-2 px-2 py-1.5 text-[11px] text-muted-foreground">
          <HugeiconsIcon icon={FolderGitTwoIcon} size={12} strokeWidth={1.75} />
          <span className="flex-1">Repositories ({repos.length})</span>
          {onRefresh && (
            <Button
              variant="ghost"
              size="icon-sm"
              className="size-5 rounded"
              title="Rescan"
              onClick={(e) => {
                e.stopPropagation();
                onRefresh();
              }}
            >
              <HugeiconsIcon icon={Refresh01Icon} size={11} strokeWidth={2} />
            </Button>
          )}
        </DropdownMenuLabel>
        <DropdownMenuSeparator className="my-0.5 border-t border-border/30" />
        {repos.map((repo) => {
          const name = repo.repoRoot.split(/[/\\]/).pop() ?? repo.repoRoot;
          const isActive = repo.repoRoot === activeRepo;
          const count = changedCount?.(repo.repoRoot);
          return (
            <DropdownMenuItem
              key={repo.repoRoot}
              onSelect={() => onChangeRepo(repo.repoRoot)}
              className={cn(
                "flex items-center gap-2 rounded-lg px-2.5 py-1.5 cursor-default",
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
                <div className="truncate text-xs">{name}</div>
                <div className="truncate text-[10px] text-muted-foreground">
                  {repo.branch}
                </div>
              </div>
              {count !== undefined && count > 0 && (
                <span className="ml-auto shrink-0 rounded-full bg-primary/15 px-1.5 py-0.5 text-[10px] font-medium text-primary">
                  {count}
                </span>
              )}
              {isActive && (
                <HugeiconsIcon
                  icon={Tick02Icon}
                  size={12}
                  strokeWidth={2}
                  className="shrink-0 text-primary"
                />
              )}
            </DropdownMenuItem>
          );
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
