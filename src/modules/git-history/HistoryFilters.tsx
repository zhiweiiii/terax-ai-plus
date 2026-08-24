import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Spinner } from "@/components/ui/spinner";
import { Switch } from "@/components/ui/switch";
import { cn } from "@/lib/utils";
import { type GitBranchEntry, native } from "@/lib/native";
import {
  ArrowDown01Icon,
  Calendar03Icon,
  CaseSensitiveIcon,
  Delete02Icon,
  GitBranchIcon,
  RegexIcon,
  Tick02Icon,
  UserIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useCallback, useRef, useState } from "react";
import { errorToast } from "@/lib/errorToast";
import {
  DATE_PRESETS,
  EMPTY_HISTORY_FILTERS,
  hasServerFilters,
  type DatePreset,
  type HistoryFilters,
  type SearchOptions,
} from "./lib/filters";

export type HistoryFilterState = {
  filters: HistoryFilters;
  searchOptions: SearchOptions;
  updateFilters: (patch: Partial<HistoryFilters>) => void;
  updateSearchOptions: (patch: Partial<SearchOptions>) => void;
  clearFilters: () => void;
  serverActive: boolean;
};

export function useHistoryFilters(): HistoryFilterState {
  const [filters, setFilters] = useState<HistoryFilters>(EMPTY_HISTORY_FILTERS);
  const [searchOptions, setSearchOptions] = useState<SearchOptions>({});
  const updateFilters = useCallback((patch: Partial<HistoryFilters>) => {
    setFilters((current) => ({ ...current, ...patch }));
  }, []);
  const updateSearchOptions = useCallback(
    (patch: Partial<SearchOptions>) => {
      setSearchOptions((current) => ({ ...current, ...patch }));
    },
    [],
  );
  const clearFilters = useCallback(() => setFilters(EMPTY_HISTORY_FILTERS), []);
  return {
    filters,
    searchOptions,
    updateFilters,
    updateSearchOptions,
    clearFilters,
    serverActive: hasServerFilters(filters),
  };
}

type Props = {
  state: HistoryFilterState;
  repoRoot: string;
  /** True when the workspace scans multiple repos; the branch list is per-repo. */
  multiRepo: boolean;
  /** Authors present in the currently loaded commits. */
  authors: string[];
  hasSearchQuery: boolean;
  onClearSearch: () => void;
};

export function HistoryFilterBar({
  state,
  repoRoot,
  multiRepo,
  authors,
  hasSearchQuery,
  onClearSearch,
}: Props) {
  const {
    filters,
    searchOptions,
    updateFilters,
    updateSearchOptions,
    clearFilters,
    serverActive,
  } = state;
  const hasActiveOptions = !!searchOptions.regex || !!searchOptions.caseSensitive;
  const showClear = serverActive || hasActiveOptions || hasSearchQuery;

  return (
    <div className="flex min-h-7 shrink-0 flex-wrap items-center gap-1 border-b border-border/40 bg-card/40 px-2 py-1">
      <ToggleButton
        title="Regular expression search"
        active={!!searchOptions.regex}
        icon={RegexIcon}
        onClick={() => updateSearchOptions({ regex: !searchOptions.regex })}
      />
      <ToggleButton
        title="Case sensitive search"
        active={!!searchOptions.caseSensitive}
        icon={CaseSensitiveIcon}
        onClick={() =>
          updateSearchOptions({ caseSensitive: !searchOptions.caseSensitive })
        }
      />
      <FilterSeparator />
      <AuthorFilter
        authors={authors}
        value={filters.author}
        onSelect={(author) => updateFilters({ author })}
      />
      <DateFilter
        value={filters.date}
        onSelect={(date) => updateFilters({ date })}
      />
      <BranchFilter
        repoRoot={repoRoot}
        multiRepo={multiRepo}
        value={filters.branch}
        onSelect={(branch) => updateFilters({ branch })}
      />
      <FilterSeparator />
      <label
        htmlFor="history-filter-no-merges"
        className="flex cursor-pointer items-center gap-1.5 text-[10.5px] text-muted-foreground"
        title="Hide merge commits"
      >
        <Switch
          id="history-filter-no-merges"
          size="sm"
          checked={filters.noMerges}
          onCheckedChange={(checked) => updateFilters({ noMerges: checked })}
        />
        No merges
      </label>
      <label
        htmlFor="history-filter-first-parent"
        className="flex cursor-pointer items-center gap-1.5 text-[10.5px] text-muted-foreground"
        title="Show only the first parent of each merge commit"
      >
        <Switch
          id="history-filter-first-parent"
          size="sm"
          checked={filters.firstParent}
          onCheckedChange={(checked) => updateFilters({ firstParent: checked })}
        />
        First parent
      </label>
      {showClear ? (
        <Button
          size="xs"
          variant="ghost"
          className="ml-auto h-6 cursor-pointer gap-1 px-1.5 text-[10.5px] text-muted-foreground hover:text-foreground"
          onClick={() => {
            clearFilters();
            updateSearchOptions({ regex: false, caseSensitive: false });
            onClearSearch();
          }}
        >
          <HugeiconsIcon icon={Delete02Icon} size={11} strokeWidth={1.9} />
          Clear filters
        </Button>
      ) : null}
    </div>
  );
}

function FilterSeparator() {
  return <span aria-hidden className="h-3.5 w-px bg-border/50" />;
}

function ToggleButton({
  title,
  active,
  icon,
  onClick,
}: {
  title: string;
  active: boolean;
  icon: typeof RegexIcon;
  onClick: () => void;
}) {
  return (
    <Button
      size="icon-xs"
      variant="ghost"
      title={title}
      onClick={onClick}
      className={cn("cursor-pointer", active && "bg-accent text-foreground")}
    >
      <HugeiconsIcon icon={icon} size={12} strokeWidth={1.9} />
    </Button>
  );
}

function AuthorFilter({
  authors,
  value,
  onSelect,
}: {
  authors: string[];
  value: string | null;
  onSelect: (author: string | null) => void;
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          size="xs"
          variant="ghost"
          title="Filter by author"
          className="h-6 max-w-32 cursor-pointer gap-1 px-1.5 text-[10.5px] text-muted-foreground hover:text-foreground"
        >
          <HugeiconsIcon
            icon={UserIcon}
            size={11}
            strokeWidth={1.9}
            className="shrink-0"
          />
          <span className="truncate">{value ?? "All authors"}</span>
          <HugeiconsIcon
            icon={ArrowDown01Icon}
            size={9}
            strokeWidth={2}
            className="shrink-0 opacity-60"
          />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="start"
        side="bottom"
        sideOffset={4}
        className="max-h-72 w-56 overflow-y-auto rounded-xl border border-border/40 bg-popover/90 p-1 shadow-lg backdrop-blur-md"
      >
        <DropdownMenuItem
          onSelect={() => onSelect(null)}
          className="flex cursor-pointer items-center gap-2 rounded-lg px-2.5 py-1.5"
        >
          <HugeiconsIcon
            icon={UserIcon}
            size={12}
            strokeWidth={1.75}
            className="shrink-0 text-muted-foreground"
          />
          All authors
        </DropdownMenuItem>
        {authors.length > 0 ? (
          <DropdownMenuSeparator className="my-0.5 border-t border-border/30" />
        ) : null}
        {authors.map((author) => (
          <DropdownMenuItem
            key={author}
            onSelect={() => onSelect(author)}
            className="flex cursor-pointer items-center gap-2 rounded-lg px-2.5 py-1.5"
          >
            <span className="min-w-0 flex-1 truncate text-xs">{author}</span>
            {value === author ? (
              <HugeiconsIcon
                icon={Tick02Icon}
                size={12}
                strokeWidth={2.25}
                className="shrink-0 text-primary"
              />
            ) : null}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function DateFilter({
  value,
  onSelect,
}: {
  value: DatePreset;
  onSelect: (date: DatePreset) => void;
}) {
  const label = DATE_PRESETS.find((preset) => preset.id === value)?.label ?? "";
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          size="xs"
          variant="ghost"
          title="Filter by date"
          className="h-6 max-w-36 cursor-pointer gap-1 px-1.5 text-[10.5px] text-muted-foreground hover:text-foreground"
        >
          <HugeiconsIcon
            icon={Calendar03Icon}
            size={11}
            strokeWidth={1.9}
            className="shrink-0"
          />
          <span className="truncate">{label}</span>
          <HugeiconsIcon
            icon={ArrowDown01Icon}
            size={9}
            strokeWidth={2}
            className="shrink-0 opacity-60"
          />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="start"
        side="bottom"
        sideOffset={4}
        className="w-44 rounded-xl border border-border/40 bg-popover/90 p-1 shadow-lg backdrop-blur-md"
      >
        {DATE_PRESETS.map((preset) => (
          <DropdownMenuItem
            key={preset.id}
            onSelect={() => onSelect(preset.id)}
            className="flex cursor-pointer items-center gap-2 rounded-lg px-2.5 py-1.5"
          >
            <span className="min-w-0 flex-1 truncate text-xs">
              {preset.label}
            </span>
            {value === preset.id ? (
              <HugeiconsIcon
                icon={Tick02Icon}
                size={12}
                strokeWidth={2.25}
                className="shrink-0 text-primary"
              />
            ) : null}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function BranchFilter({
  repoRoot,
  multiRepo,
  value,
  onSelect,
}: {
  repoRoot: string;
  multiRepo: boolean;
  value: string | null;
  onSelect: (branch: string | null) => void;
}) {
  const [branches, setBranches] = useState<GitBranchEntry[] | null>(null);
  const [loading, setLoading] = useState(false);
  const loadedForRef = useRef<string | null>(null);

  // The pane may be retargeted to another repo without unmounting this
  // component; cache per repo so the list reloads for the new one.
  const load = useCallback(async () => {
    if (loadedForRef.current === repoRoot) return;
    loadedForRef.current = repoRoot;
    setBranches(null);
    setLoading(true);
    try {
      const result = await native.gitListBranches(repoRoot);
      setBranches(result.branches.filter((branch) => branch.kind !== "remote"));
    } catch (e) {
      loadedForRef.current = null;
      errorToast("Could not list branches", e);
    } finally {
      setLoading(false);
    }
  }, [repoRoot]);

  return (
    <DropdownMenu
      onOpenChange={(open) => {
        if (open) void load();
      }}
    >
      <DropdownMenuTrigger asChild>
        <Button
          size="xs"
          variant="ghost"
          title={
            multiRepo
              ? "Branch filter applies to the current repo only"
              : "Filter by branch"
          }
          className="h-6 max-w-36 cursor-pointer gap-1 px-1.5 text-[10.5px] text-muted-foreground hover:text-foreground"
        >
          <HugeiconsIcon
            icon={GitBranchIcon}
            size={11}
            strokeWidth={1.9}
            className="shrink-0"
          />
          <span className="truncate">{value ?? "All branches"}</span>
          <HugeiconsIcon
            icon={ArrowDown01Icon}
            size={9}
            strokeWidth={2}
            className="shrink-0 opacity-60"
          />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="start"
        side="bottom"
        sideOffset={4}
        className="max-h-72 w-56 overflow-y-auto rounded-xl border border-border/40 bg-popover/90 p-1 shadow-lg backdrop-blur-md"
      >
        <DropdownMenuItem
          onSelect={() => onSelect(null)}
          className="flex cursor-pointer items-center gap-2 rounded-lg px-2.5 py-1.5"
        >
          <HugeiconsIcon
            icon={GitBranchIcon}
            size={12}
            strokeWidth={1.75}
            className="shrink-0 text-muted-foreground"
          />
          All branches
        </DropdownMenuItem>
        <DropdownMenuSeparator className="my-0.5 border-t border-border/30" />
        {loading && !branches ? (
          <div className="flex items-center gap-2 px-2.5 py-2 text-[11px] text-muted-foreground">
            <Spinner className="size-3" />
            Loading branches…
          </div>
        ) : null}
        {branches && branches.length === 0 ? (
          <div className="px-2.5 py-2 text-[11px] text-muted-foreground">
            No branches
          </div>
        ) : null}
        {branches?.map((branch) => (
          <DropdownMenuItem
            key={branch.name}
            onSelect={() => onSelect(branch.name)}
            className="flex cursor-pointer items-center gap-2 rounded-lg px-2.5 py-1.5"
          >
            <span className="min-w-0 flex-1 truncate font-mono text-[11px]">
              {branch.name}
            </span>
            {branch.isHead ? (
              <span className="shrink-0 rounded bg-muted/55 px-1 py-px text-[8.5px] font-medium uppercase tracking-wider text-muted-foreground">
                current
              </span>
            ) : null}
            {value === branch.name ? (
              <HugeiconsIcon
                icon={Tick02Icon}
                size={12}
                strokeWidth={2.25}
                className="shrink-0 text-primary"
              />
            ) : null}
          </DropdownMenuItem>
        ))}
        {multiRepo ? (
          <>
            <DropdownMenuSeparator className="my-0.5 border-t border-border/30" />
            <div className="px-2.5 py-1.5 text-[10px] leading-snug text-muted-foreground/75">
              Branch list is per-repo. Cross-repo filtering is not supported —
              each repo is queried separately.
            </div>
          </>
        ) : null}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
