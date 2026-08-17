import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { FindBox, type FindBoxHandle } from "@/components/ui/find-box";
import {
  Popover,
  PopoverAnchor,
  PopoverContent,
} from "@/components/ui/popover";
import { Spinner } from "@/components/ui/spinner";
import { TooltipProvider } from "@/components/ui/tooltip";
import {
  type GitCommitFileChange,
  type GitLogEntry,
  type GitRepoHead,
  native,
} from "@/lib/native";
import { cn } from "@/lib/utils";
import { fileIconUrl } from "@/modules/explorer/lib/iconResolver";
import {
  ArrowDown01Icon,
  ChevronDownIcon,
  Copy01Icon,
  File02Icon,
  FolderGitTwoIcon,
  GitBranchIcon,
  LinkSquare02Icon,
  Tick02Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { openUrl } from "@tauri-apps/plugin-opener";
import {
  forwardRef,
  memo,
  type ReactNode,
  useCallback,
  useDeferredValue,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import { CommitContextMenu } from "./CommitContextMenu";
import { GraphRail, MAX_VISIBLE_LANES, railWidth } from "./GraphRail";
import { HistoryFilterBar, useHistoryFilters } from "./HistoryFilters";
import {
  findMatch,
  matchCommit,
  type SearchOptions,
  serverFilterOptions,
  uniqueAuthors,
} from "./lib/filters";
import {
  applyFirstParent,
  EMPTY_GRAPH_STATE,
  type GraphRow,
  type GraphState,
  layoutGraph,
} from "./lib/graph";
import {
  commitWebUrl,
  hostLabel,
  parseRemoteWebUrl,
  type RemoteWebInfo,
} from "./lib/remoteWebUrl";

const RAIL_RESERVED_PX = railWidth(MAX_VISIBLE_LANES);
// rail | sha | subject(capped) | spacer(absorbs slack) | author(hugs) | date | changes
const GRID_TEMPLATE = `${RAIL_RESERVED_PX + 4}px 60px minmax(0, 560px) minmax(12px, 1fr) minmax(140px, max-content) 96px 116px`;

const PAGE_SIZE = 30;
const ROW_HEIGHT = 32;
const TABLE_HEADER_HEIGHT = 24;
const NEAR_BOTTOM_PX = 240;
const FILES_CACHE_LIMIT = 16;

type CommitFileDiffOpenInput = {
  repoRoot: string;
  sha: string;
  shortSha: string;
  subject: string;
  path: string;
  originalPath: string | null;
};

type Props = {
  repoRoot: string;
  /** Workspace repos; >1 renders the in-pane repo switcher. */
  repos?: GitRepoHead[];
  /** Re-target this pane to another repo (parent updates the tab state). */
  onSwitchRepo?: (repoRoot: string, branch: string | null) => void;
  onOpenCommitFile: (input: CommitFileDiffOpenInput) => void;
};

type LoadStatus = "idle" | "initial" | "more" | "error";

type FilesEntry =
  | { state: "loading" }
  | { state: "loaded"; files: GitCommitFileChange[] }
  | { state: "error"; error: string };

function basename(path: string): string {
  const parts = path.split(/[\\/]/).filter(Boolean);
  return parts.length > 0 ? parts[parts.length - 1] : path;
}

function dirname(path: string): string {
  const normalized = path.replace(/\\/g, "/");
  const index = normalized.lastIndexOf("/");
  if (index <= 0) return "";
  return normalized.slice(0, index);
}

function normalizeError(error: unknown): string {
  if (typeof error === "string") return error;
  if (error && typeof error === "object" && "message" in error) {
    const message = (error as { message?: unknown }).message;
    if (typeof message === "string") return message;
  }
  return "Unknown error";
}

function absoluteTime(secs: number): string {
  if (!secs) return "";
  return new Date(secs * 1000).toLocaleString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function authorInitials(name: string): string {
  const trimmed = (name ?? "").trim();
  if (!trimmed) return "?";
  const parts = trimmed.split(/\s+/);
  if (parts.length === 1) return parts[0].charAt(0).toUpperCase();
  return (parts[0].charAt(0) + parts[parts.length - 1].charAt(0)).toUpperCase();
}

const AUTHOR_TINTS = [
  "#7aa2f7", // soft blue
  "#bb9af7", // soft purple
  "#9ece6a", // soft green
  "#e0af68", // soft amber
  "#f7768e", // soft rose
  "#73daca", // soft teal
  "#ff9e64", // soft orange
  "#b4f9f8", // pale cyan
];

function authorTint(key: string): string {
  let hash = 0;
  for (let i = 0; i < key.length; i++) {
    hash = (hash * 31 + key.charCodeAt(i)) | 0;
  }
  return AUTHOR_TINTS[Math.abs(hash) % AUTHOR_TINTS.length];
}

function compactDate(secs: number): string {
  if (!secs) return "";
  const d = new Date(secs * 1000);
  const now = new Date();
  const sameYear = d.getFullYear() === now.getFullYear();
  const month = d.toLocaleString(undefined, { month: "short" });
  const day = String(d.getDate()).padStart(2, "0");
  if (sameYear) {
    const hh = String(d.getHours()).padStart(2, "0");
    const mm = String(d.getMinutes()).padStart(2, "0");
    return `${month} ${day}  ${hh}:${mm}`;
  }
  return `${month} ${day} ${d.getFullYear()}`;
}

function statusTone(code: string): string {
  switch (code.toUpperCase()) {
    case "A":
      return "text-emerald-600 dark:text-emerald-400";
    case "M":
      return "text-amber-600 dark:text-amber-300";
    case "D":
      return "text-rose-600 dark:text-rose-400";
    case "R":
    case "C":
      return "text-sky-600 dark:text-sky-300";
    default:
      return "text-muted-foreground";
  }
}

function highlight(
  text: string,
  query: string,
  options: SearchOptions,
): ReactNode {
  if (!query) return text;
  const match = findMatch(text, query, options);
  if (!match) return text;
  return (
    <>
      {text.slice(0, match.index)}
      <mark className="rounded-sm bg-primary/25 px-0.5 text-foreground">
        {text.slice(match.index, match.index + match.length)}
      </mark>
      {text.slice(match.index + match.length)}
    </>
  );
}

export type GitHistoryPaneHandle = {
  openSearch: () => void;
};

export const GitHistoryPane = forwardRef<GitHistoryPaneHandle, Props>(
  function GitHistoryPane(
    { repoRoot, repos, onSwitchRepo, onOpenCommitFile },
    ref,
  ) {
    const [commits, setCommits] = useState<GitLogEntry[]>([]);
    const [loadStatus, setLoadStatus] = useState<LoadStatus>("idle");
    const [error, setError] = useState<string | null>(null);
    const [endReached, setEndReached] = useState(false);
    const [searchInput, setSearchInput] = useState("");
    const deferredSearch = useDeferredValue(searchInput.trim());
    // Require at least 2 characters before filtering to avoid noisy single-char
    // matches and pointless full-list scans on every keystroke.
    const activeSearch = deferredSearch.length >= 2 ? deferredSearch : "";
    const {
      filters,
      searchOptions,
      updateFilters,
      updateSearchOptions,
      clearFilters,
      serverActive,
    } = useHistoryFilters();
    const { author, date, branch, noMerges, firstParent } = filters;

    const [openAnchor, setOpenAnchor] = useState<{
      sha: string;
      top: number;
      left: number;
      width: number;
      height: number;
    } | null>(null);
    const [remoteWeb, setRemoteWeb] = useState<RemoteWebInfo | null>(null);
    const filesCacheRef = useRef(new Map<string, FilesEntry>());
    const [filesTick, setFilesTick] = useState(0);
    const bumpFiles = useCallback(() => setFilesTick((n) => n + 1), []);

    const requestIdRef = useRef(0);
    const inflightMoreRef = useRef(false);
    const filesInflightRef = useRef(new Set<string>());
    const scrollRef = useRef<HTMLDivElement>(null);
    const [findOpen, setFindOpen] = useState(false);
    const [findMatches, setFindMatches] = useState<GitLogEntry[]>([]);
    const findBoxRef = useRef<FindBoxHandle>(null);

    const openSearch = useCallback(() => {
      setFindOpen(true);
      requestAnimationFrame(() => findBoxRef.current?.focus());
    }, []);

    useImperativeHandle(ref, () => ({ openSearch }), [openSearch]);

    const runFind = useCallback(
      (q: string) => {
        const query = q.trim();
        if (query.length < 2) {
          setFindMatches([]);
          return;
        }
        setFindMatches(commits.filter((c) => matchCommit(c, query, {})));
      },
      [commits],
    );

    const closeFind = useCallback(() => {
      setFindOpen(false);
      setFindMatches([]);
    }, []);
    const graphCacheRef = useRef<{
      rows: GraphRow[];
      byCommit: Map<string, GraphRow>;
      tail: GraphState;
      firstSha: string | null;
      len: number;
      maxLaneCount: number;
    }>({
      rows: [],
      byCommit: new Map(),
      tail: EMPTY_GRAPH_STATE,
      firstSha: null,
      len: 0,
      maxLaneCount: 1,
    });

    // First-parent view only touches the layout input; the list stays intact.
    const graphInput = useMemo(
      () => (firstParent ? applyFirstParent(commits) : commits),
      [commits, firstParent],
    );

    const { graphByCommit, maxLaneCount } = useMemo(() => {
      const cache = graphCacheRef.current;
      if (graphInput.length === 0) {
        cache.rows = [];
        cache.byCommit = new Map();
        cache.tail = EMPTY_GRAPH_STATE;
        cache.firstSha = null;
        cache.len = 0;
        cache.maxLaneCount = 1;
        return { graphByCommit: cache.byCommit, maxLaneCount: 1 };
      }
      const firstSha = graphInput[0].sha;
      const canAppend =
        cache.firstSha === firstSha && graphInput.length >= cache.len;
      if (!canAppend) {
        const { rows, state } = layoutGraph(graphInput);
        const byCommit = new Map<string, GraphRow>();
        let max = 1;
        for (const row of rows) {
          byCommit.set(row.sha, row);
          if (row.laneCount > max) max = row.laneCount;
        }
        cache.rows = rows;
        cache.byCommit = byCommit;
        cache.tail = state;
        cache.firstSha = firstSha;
        cache.len = graphInput.length;
        cache.maxLaneCount = max;
        return { graphByCommit: byCommit, maxLaneCount: max };
      }
      if (graphInput.length > cache.len) {
        const delta = graphInput.slice(cache.len);
        const { rows: newRows, state } = layoutGraph(delta, cache.tail);
        let max = cache.maxLaneCount;
        for (const row of newRows) {
          cache.byCommit.set(row.sha, row);
          if (row.laneCount > max) max = row.laneCount;
        }
        cache.rows = cache.rows.concat(newRows);
        cache.tail = state;
        cache.len = graphInput.length;
        cache.maxLaneCount = max;
      }
      return {
        graphByCommit: cache.byCommit,
        maxLaneCount: cache.maxLaneCount,
      };
    }, [graphInput]);
    const gridTemplate = GRID_TEMPLATE;

    const filtered = useMemo(() => {
      if (!activeSearch) return commits;
      return commits.filter((c) => matchCommit(c, activeSearch, searchOptions));
    }, [activeSearch, commits, searchOptions]);

    const virtualizer = useVirtualizer({
      count: filtered.length,
      getScrollElement: () => scrollRef.current,
      estimateSize: () => ROW_HEIGHT,
      overscan: 8,
      getItemKey: (index) => filtered[index]?.sha ?? index,
    });

    const jumpFind = useCallback(
      (i: number) => {
        const c = findMatches[i];
        if (!c) return;
        const idx = filtered.findIndex((x) => x.sha === c.sha);
        if (idx >= 0) virtualizer.scrollToIndex(idx, { align: "center" });
      },
      [findMatches, filtered, virtualizer],
    );

    const loadInitial = useCallback(async () => {
      const requestId = ++requestIdRef.current;
      setLoadStatus("initial");
      setError(null);
      setEndReached(false);
      try {
        const options = serverFilterOptions(
          { author, date, branch, noMerges },
          Date.now(),
        );
        const entries = options
          ? await native.gitLogFiltered(repoRoot, {
              ...options,
              maxCount: PAGE_SIZE,
            })
          : await native.gitLog(repoRoot, { limit: PAGE_SIZE });
        if (requestId !== requestIdRef.current) return;
        setCommits(entries);
        setLoadStatus("idle");
        if (entries.length < PAGE_SIZE) setEndReached(true);
      } catch (err) {
        if (requestId !== requestIdRef.current) return;
        setError(normalizeError(err));
        setLoadStatus("error");
      }
    }, [author, branch, date, noMerges, repoRoot]);

    const loadMore = useCallback(async () => {
      if (inflightMoreRef.current || endReached) return;
      if (loadStatus !== "idle") return;
      const last = commits[commits.length - 1];
      if (!last) return;
      inflightMoreRef.current = true;
      setLoadStatus("more");
      const requestId = requestIdRef.current;
      try {
        const options = serverFilterOptions(
          { author, date, branch, noMerges },
          Date.now(),
        );
        const entries = options
          ? await native.gitLogFiltered(repoRoot, {
              ...options,
              maxCount: PAGE_SIZE,
              skip: commits.length,
            })
          : await native.gitLog(repoRoot, {
              limit: PAGE_SIZE,
              beforeSha: last.sha,
            });
        if (requestId !== requestIdRef.current) return;
        setCommits((prev) => {
          const seen = new Set(prev.map((c) => c.sha));
          const merged = [...prev];
          for (const e of entries) if (!seen.has(e.sha)) merged.push(e);
          return merged;
        });
        if (entries.length < PAGE_SIZE) setEndReached(true);
        setLoadStatus("idle");
      } catch (err) {
        if (requestId !== requestIdRef.current) return;
        setError(normalizeError(err));
        setLoadStatus("error");
      } finally {
        inflightMoreRef.current = false;
      }
    }, [
      author,
      branch,
      commits,
      date,
      endReached,
      loadStatus,
      noMerges,
      repoRoot,
    ]);

    useEffect(() => {
      filesInflightRef.current.clear();
      filesCacheRef.current.clear();
      bumpFiles();
      setCommits([]);
      setOpenAnchor(null);
      void loadInitial();
    }, [bumpFiles, loadInitial]);

    useEffect(() => {
      let cancelled = false;
      native
        .gitRemoteUrl(repoRoot)
        .then((url) => {
          if (cancelled) return;
          setRemoteWeb(parseRemoteWebUrl(url));
        })
        .catch(() => {
          if (cancelled) return;
          setRemoteWeb(null);
        });
      return () => {
        cancelled = true;
      };
    }, [repoRoot]);

    const handleScroll = useCallback(() => {
      const el = scrollRef.current;
      if (!el) return;
      setOpenAnchor((prev) => (prev ? null : prev));
      if (activeSearch) return;
      const remaining = el.scrollHeight - el.scrollTop - el.clientHeight;
      if (remaining < NEAR_BOTTOM_PX) {
        void loadMore();
      }
    }, [activeSearch, loadMore]);

    // Auto-fill: if the list doesn't fill the viewport (no scroll possible)
    // after a load, keep pulling pages until it does or the end is reached.
    // Scheduled async so we don't fight ongoing state transitions.
    useEffect(() => {
      if (loadStatus !== "idle") return;
      if (endReached) return;
      if (activeSearch) return;
      if (commits.length === 0) return;
      const el = scrollRef.current;
      if (!el) return;
      const scrollable = el.scrollHeight - el.clientHeight;
      if (scrollable > NEAR_BOTTOM_PX) return;
      const id = window.setTimeout(() => {
        void loadMore();
      }, 0);
      return () => window.clearTimeout(id);
    }, [commits.length, activeSearch, endReached, loadMore, loadStatus]);

    const handleRefresh = useCallback(() => {
      filesInflightRef.current.clear();
      filesCacheRef.current.clear();
      bumpFiles();
      void loadInitial();
    }, [bumpFiles, loadInitial]);

    const fetchFiles = useCallback(
      async (sha: string) => {
        if (filesInflightRef.current.has(sha)) return;
        const cache = filesCacheRef.current;
        const existing = cache.get(sha);
        if (existing && existing.state !== "error") return;
        filesInflightRef.current.add(sha);
        cache.set(sha, { state: "loading" });
        bumpFiles();
        try {
          const files = await native.gitCommitFiles(repoRoot, sha);
          cache.set(sha, { state: "loaded", files });
          while (cache.size > FILES_CACHE_LIMIT) {
            const oldest = cache.keys().next().value;
            if (oldest === undefined || oldest === sha) break;
            cache.delete(oldest);
          }
          bumpFiles();
        } catch (err) {
          cache.set(sha, { state: "error", error: normalizeError(err) });
          bumpFiles();
        } finally {
          filesInflightRef.current.delete(sha);
        }
      },
      [repoRoot],
    );

    const handleRowClick = useCallback(
      (sha: string, event: React.MouseEvent<HTMLElement>) => {
        if (openAnchor?.sha === sha) {
          setOpenAnchor(null);
          return;
        }
        // Anchor at the cursor so the popover opens where the user clicked,
        // but clamp X so it never gets pushed off-screen on the right.
        const POPOVER_WIDTH = 420;
        const PADDING = 16;
        const maxLeft = window.innerWidth - POPOVER_WIDTH - PADDING;
        const left = Math.max(PADDING, Math.min(event.clientX, maxLeft));
        setOpenAnchor({
          sha,
          top: event.clientY,
          left,
          width: 1,
          height: 1,
        });
        void fetchFiles(sha);
      },
      [fetchFiles, openAnchor?.sha],
    );

    const closePopover = useCallback(() => setOpenAnchor(null), []);

    const openFilesEntry = useMemo(() => {
      if (!openAnchor) return null;
      return filesCacheRef.current.get(openAnchor.sha) ?? null;
    }, [openAnchor, filesTick]);

    const handleFileOpen = useCallback(
      (commit: GitLogEntry, file: GitCommitFileChange) => {
        onOpenCommitFile({
          repoRoot,
          sha: commit.sha,
          shortSha: commit.shortSha,
          subject: commit.subject,
          path: file.path,
          originalPath: file.originalPath,
        });
        setOpenAnchor(null);
      },
      [onOpenCommitFile, repoRoot],
    );

    const copyToClipboard = useCallback(async (value: string) => {
      try {
        await navigator.clipboard.writeText(value);
      } catch {
        /* noop */
      }
    }, []);

    return (
      <TooltipProvider delayDuration={500} skipDelayDuration={200}>
        <div className="relative flex h-full min-h-0 flex-col bg-background [contain:layout_style]">
          {repos && repos.length > 1 ? (
            <HistoryRepoSwitcher
              repos={repos}
              repoRoot={repoRoot}
              onSwitch={(root, branch) => onSwitchRepo?.(root, branch)}
            />
          ) : null}
          <HistoryFilterBar
            state={{
              filters,
              searchOptions,
              updateFilters,
              updateSearchOptions,
              clearFilters,
              serverActive,
            }}
            repoRoot={repoRoot}
            multiRepo={!!repos && repos.length > 1}
            authors={uniqueAuthors(commits)}
            hasSearchQuery={activeSearch.length > 0}
            onClearSearch={() => setSearchInput("")}
          />
          {loadStatus === "initial" && commits.length === 0 ? (
            <CenterPlaceholder>
              <Spinner className="size-4" />
              <span className="text-[11.5px] text-muted-foreground">
                Loading commits…
              </span>
            </CenterPlaceholder>
          ) : loadStatus === "error" && commits.length === 0 ? (
            <CenterPlaceholder>
              <div className="text-[13px] font-medium">
                Could not load history
              </div>
              <div className="max-w-md text-[11px] leading-relaxed text-muted-foreground">
                {error ?? "Unknown error"}
              </div>
              <Button size="sm" onClick={handleRefresh}>
                Retry
              </Button>
            </CenterPlaceholder>
          ) : commits.length === 0 ? (
            <CenterPlaceholder>
              <div className="text-[13px] font-medium">No commits yet</div>
              <div className="max-w-md text-[11px] leading-relaxed text-muted-foreground">
                {serverActive || activeSearch
                  ? "No commits match the current filters."
                  : "This branch has no commits."}
              </div>
            </CenterPlaceholder>
          ) : (
            <>
              <div
                className="grid shrink-0 items-center gap-3 border-b border-border/40 bg-card/55 pr-3 text-[9.5px] font-semibold uppercase tracking-[0.14em] text-muted-foreground/70"
                style={{
                  height: TABLE_HEADER_HEIGHT,
                  gridTemplateColumns: gridTemplate,
                }}
              >
                <div />
                <div className="pl-px">SHA</div>
                <div className="min-w-0">Subject</div>
                <div />
                <div className="ml-2">Author</div>
                <div className="text-right">Date</div>
                <div className="text-right">Changes</div>
              </div>
              <div
                ref={scrollRef}
                onScroll={handleScroll}
                className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden [scrollbar-gutter:stable]"
              >
                <div
                  style={{
                    height: virtualizer.getTotalSize(),
                    position: "relative",
                    width: "100%",
                  }}
                >
                  {virtualizer.getVirtualItems().map((virtualRow) => {
                    const commit = filtered[virtualRow.index];
                    if (!commit) return null;
                    return (
                      <div
                        key={virtualRow.key}
                        style={{
                          position: "absolute",
                          top: 0,
                          left: 0,
                          width: "100%",
                          height: virtualRow.size,
                          transform: `translateY(${virtualRow.start}px)`,
                        }}
                      >
                        <CommitContextMenu
                          repoRoot={repoRoot}
                          commit={commit}
                          onRefresh={handleRefresh}
                        >
                          <CommitRow
                            commit={commit}
                            query={activeSearch}
                            searchOptions={searchOptions}
                            active={openAnchor?.sha === commit.sha}
                            isHead={!activeSearch && virtualRow.index === 0}
                            graphRow={graphByCommit.get(commit.sha) ?? null}
                            maxLaneCount={maxLaneCount}
                            gridTemplate={gridTemplate}
                            onClick={handleRowClick}
                          />
                        </CommitContextMenu>
                      </div>
                    );
                  })}
                </div>

                {loadStatus === "more" ? (
                  <div className="flex items-center justify-center gap-2 py-3 text-[11px] text-muted-foreground">
                    <Spinner className="size-3" />
                    Loading more…
                  </div>
                ) : null}
                {endReached && !activeSearch ? (
                  <div className="py-3 text-center text-[10.5px] text-muted-foreground/65">
                    End of history
                  </div>
                ) : null}
                {loadStatus === "error" && commits.length > 0 ? (
                  <div className="flex items-center justify-center gap-2 py-3 text-[11px] text-destructive">
                    {error ?? "Failed to load more"}
                    <Button
                      size="xs"
                      variant="ghost"
                      className="h-6 cursor-pointer text-[11px]"
                      onClick={() => void loadMore()}
                    >
                      Retry
                    </Button>
                  </div>
                ) : null}
              </div>
            </>
          )}

          <Popover
            open={!!openAnchor}
            onOpenChange={(next) => {
              if (!next) closePopover();
            }}
          >
            {typeof document !== "undefined"
              ? createPortal(
                  <PopoverAnchor asChild>
                    <div
                      aria-hidden
                      style={{
                        position: "fixed",
                        top: openAnchor?.top ?? -9999,
                        left: openAnchor?.left ?? -9999,
                        width: openAnchor?.width ?? 0,
                        height: openAnchor?.height ?? 0,
                        pointerEvents: "none",
                      }}
                    />
                  </PopoverAnchor>,
                  document.body,
                )
              : null}
            <PopoverContent
              side="bottom"
              align="start"
              sideOffset={4}
              alignOffset={0}
              collisionPadding={16}
              avoidCollisions
              onOpenAutoFocus={(e) => e.preventDefault()}
              className="flex w-[420px] max-w-[calc(100vw-2rem)] flex-col gap-0 overflow-hidden rounded-xl p-0 shadow-xl"
            >
              {openAnchor
                ? (() => {
                    const commit = commits.find(
                      (c) => c.sha === openAnchor.sha,
                    );
                    if (!commit) return null;
                    return (
                      <CommitDetail
                        key={commit.sha}
                        repoRoot={repoRoot}
                        commit={commit}
                        filesEntry={openFilesEntry}
                        remoteWeb={remoteWeb}
                        onCopySha={copyToClipboard}
                        onOpenFile={handleFileOpen}
                        onRetryFiles={() => void fetchFiles(openAnchor.sha)}
                      />
                    );
                  })()
                : null}
            </PopoverContent>
          </Popover>

          {findOpen ? (
            <FindBox
              ref={findBoxRef}
              placeholder="Find in history"
              matches={findMatches.map((c, i) => ({
                key: c.sha,
                line: i + 1,
                text: c.subject,
                hint: c.shortSha,
              }))}
              onSearch={runFind}
              onJump={jumpFind}
              onClose={closeFind}
            />
          ) : null}
        </div>
      </TooltipProvider>
    );
  },
);

function CenterPlaceholder({ children }: { children: ReactNode }) {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-2 px-6 text-center">
      {children}
    </div>
  );
}

function repoShortName(repoRoot: string): string {
  const parts = repoRoot.split(/[\\/]/).filter(Boolean);
  return parts.length > 0 ? parts[parts.length - 1] : repoRoot;
}

/**
 * Lets a history tab switch which repo it shows without opening a new tab.
 * The branch shown on the trigger comes from the scanned repo head, which the
 * source-control layer keeps fresh.
 */
function HistoryRepoSwitcher({
  repos,
  repoRoot,
  onSwitch,
}: {
  repos: GitRepoHead[];
  repoRoot: string;
  onSwitch: (repoRoot: string, branch: string | null) => void;
}) {
  const current = repos.find((r) => r.repoRoot === repoRoot);
  return (
    <div className="flex h-8 shrink-0 items-center gap-2 border-b border-border/40 px-2.5">
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            title={repoRoot}
            className="inline-flex min-w-0 cursor-pointer items-center gap-1.5 rounded-md bg-foreground/5 px-2 py-1 text-[11.5px] font-medium leading-none text-foreground transition-colors hover:bg-foreground/10"
          >
            <HugeiconsIcon
              icon={FolderGitTwoIcon}
              size={12}
              strokeWidth={1.9}
              className="shrink-0 text-muted-foreground"
            />
            <span className="max-w-28 truncate">
              {repoShortName(current?.repoRoot ?? repoRoot)}
            </span>
            {current?.branch ? (
              <>
                <span className="shrink-0 text-muted-foreground/40">/</span>
                <span className="max-w-24 truncate text-foreground/80">
                  {current.branch}
                </span>
              </>
            ) : null}
            <HugeiconsIcon
              icon={ArrowDown01Icon}
              size={10}
              strokeWidth={2}
              className="shrink-0 opacity-60"
            />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent
          align="start"
          side="bottom"
          sideOffset={4}
          className="max-h-72 w-72 overflow-y-auto rounded-xl border border-border/40 bg-popover/90 p-1 shadow-lg backdrop-blur-md"
        >
          <DropdownMenuLabel className="px-2 py-1.5 text-[11px] text-muted-foreground">
            Repositories ({repos.length})
          </DropdownMenuLabel>
          <DropdownMenuSeparator className="my-0.5 border-t border-border/30" />
          {repos.map((repo) => {
            const isActive = repo.repoRoot === repoRoot;
            return (
              <DropdownMenuItem
                key={repo.repoRoot}
                onSelect={() => onSwitch(repo.repoRoot, repo.branch)}
                className="flex cursor-pointer items-center gap-2 rounded-lg px-2.5 py-1.5"
              >
                <HugeiconsIcon
                  icon={FolderGitTwoIcon}
                  size={13}
                  strokeWidth={1.75}
                  className="shrink-0 text-muted-foreground"
                />
                <div className="min-w-0 flex-1">
                  <div className="truncate text-xs">
                    {repoShortName(repo.repoRoot)}
                  </div>
                  <div className="truncate text-[10px] text-muted-foreground">
                    {repo.branch}
                  </div>
                </div>
                {isActive ? (
                  <HugeiconsIcon
                    icon={Tick02Icon}
                    size={13}
                    strokeWidth={2.25}
                    className="shrink-0 text-primary"
                  />
                ) : null}
              </DropdownMenuItem>
            );
          })}
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}

type CommitRowProps = {
  commit: GitLogEntry;
  query: string;
  searchOptions: SearchOptions;
  active: boolean;
  /** The newest commit of the loaded list, shown as the HEAD of the branch. */
  isHead: boolean;
  graphRow: GraphRow | null;
  maxLaneCount: number;
  gridTemplate: string;
  onClick: (sha: string, event: React.MouseEvent<HTMLElement>) => void;
};

const CommitRow = memo(function CommitRow({
  commit,
  query,
  searchOptions,
  active,
  isHead,
  graphRow,
  maxLaneCount,
  gridTemplate,
  onClick,
}: CommitRowProps) {
  const date = compactDate(commit.timestampSecs);
  const initials = authorInitials(commit.author);
  const totalStat = commit.insertions + commit.deletions;
  return (
    <button
      type="button"
      onClick={(event) => onClick(commit.sha, event)}
      className={cn(
        "group relative grid h-full w-full cursor-pointer items-center gap-3 border-l-2 border-transparent pr-3 text-left transition-colors",
        isHead && "bg-primary/[0.04]",
        active ? "border-l-primary/70 bg-accent/45" : "hover:bg-accent/25",
      )}
      style={{ gridTemplateColumns: gridTemplate }}
    >
      <div className="flex items-center justify-start pl-1">
        {graphRow ? (
          <GraphRail
            row={graphRow}
            rowHeight={ROW_HEIGHT}
            maxLaneCount={maxLaneCount}
            active={active}
          />
        ) : null}
      </div>
      <span className="pl-px font-mono text-[10.5px] tabular-nums text-muted-foreground/80">
        {commit.shortSha}
      </span>
      <span
        className={cn(
          "flex min-w-0 items-center gap-1.5",
          active
            ? "font-semibold text-foreground"
            : "font-medium text-foreground/95",
        )}
      >
        {isHead ? (
          <span className="shrink-0 rounded bg-primary/15 px-1.5 py-0.5 text-[8.5px] font-bold uppercase tracking-wider text-primary">
            HEAD
          </span>
        ) : null}
        <span className="min-w-0 truncate text-[12px] leading-tight">
          {commit.subject ? (
            highlight(commit.subject, query, searchOptions)
          ) : (
            <span className="text-muted-foreground">(no subject)</span>
          )}
        </span>
      </span>
      <span aria-hidden />
      <span
        className="ml-2 inline-flex h-[18px] max-w-full min-w-0 items-center gap-1.5 justify-self-start self-center overflow-hidden rounded-md bg-foreground/6 pl-1 pr-1.5 text-[10.5px] font-medium text-foreground/85"
        title={commit.authorEmail || commit.author}
      >
        <span
          className="inline-flex size-3.5 shrink-0 items-center justify-center rounded-[3px] font-mono text-[8.5px] font-bold uppercase tabular-nums text-background"
          style={{
            backgroundColor: authorTint(commit.authorEmail || commit.author),
          }}
        >
          {initials}
        </span>
        <span className="min-w-0 truncate">
          {commit.author
            ? highlight(commit.author, query, searchOptions)
            : "Unknown"}
        </span>
      </span>
      <span className="text-right font-mono text-[10.5px] tabular-nums text-muted-foreground/75">
        {date}
      </span>
      <span className="flex min-w-0 items-center justify-end gap-1.5 font-mono text-[10px] tabular-nums">
        {commit.filesChanged > 0 ? (
          <span
            className="inline-flex items-center gap-1 text-muted-foreground/75"
            title={`${commit.filesChanged} ${commit.filesChanged === 1 ? "file" : "files"} changed`}
          >
            <HugeiconsIcon
              icon={File02Icon}
              size={10.5}
              strokeWidth={1.7}
              className="opacity-70"
            />
            <span className="font-medium">{commit.filesChanged}</span>
          </span>
        ) : null}
        {commit.filesChanged > 0 && totalStat > 0 ? (
          <span
            aria-hidden
            className="size-[3px] shrink-0 rounded-full bg-muted-foreground/30"
          />
        ) : null}
        {totalStat > 0 ? (
          <span className="inline-flex items-center gap-1">
            {commit.insertions > 0 ? (
              <span className="font-semibold text-emerald-600/85 dark:text-emerald-400/85">
                +{commit.insertions}
              </span>
            ) : null}
            {commit.deletions > 0 ? (
              <span className="font-semibold text-rose-600/85 dark:text-rose-400/85">
                −{commit.deletions}
              </span>
            ) : null}
          </span>
        ) : commit.filesChanged === 0 ? (
          <span className="text-muted-foreground/40">—</span>
        ) : null}
      </span>
    </button>
  );
});

type CommitDetailProps = {
  repoRoot: string;
  commit: GitLogEntry;
  filesEntry: FilesEntry | null;
  remoteWeb: RemoteWebInfo | null;
  onCopySha: (value: string) => Promise<void> | void;
  onOpenFile: (
    commit: GitLogEntry,
    file: GitCommitFileChange,
  ) => Promise<void> | void;
  onRetryFiles: () => void;
};

function CommitDetail({
  repoRoot,
  commit,
  filesEntry,
  remoteWeb,
  onCopySha,
  onOpenFile,
  onRetryFiles,
}: CommitDetailProps) {
  const absolute = absoluteTime(commit.timestampSecs);
  const webUrl = remoteWeb ? commitWebUrl(remoteWeb, commit.sha) : null;
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!copied) return;
    const t = window.setTimeout(() => setCopied(false), 1100);
    return () => window.clearTimeout(t);
  }, [copied]);

  return (
    <div className="flex max-h-[60vh] min-h-0 flex-col">
      <div className="shrink-0 border-b border-border/45 p-3">
        <div className="flex items-start gap-2">
          <span className="mt-px shrink-0 rounded bg-muted/65 px-1.5 py-0.5 font-mono text-[10.5px] leading-none tabular-nums text-muted-foreground">
            {commit.shortSha}
          </span>
          <div className="min-w-0 flex-1 text-[12.5px] font-semibold leading-snug text-foreground">
            {commit.subject || (
              <span className="text-muted-foreground">(no subject)</span>
            )}
          </div>
        </div>
        <div className="mt-2 flex min-w-0 items-center gap-1.5 text-[10.5px] text-muted-foreground">
          <span className="truncate">{commit.author || "Unknown"}</span>
          {commit.authorEmail ? (
            <>
              <span className="text-muted-foreground/45">·</span>
              <span className="truncate text-muted-foreground/85">
                {commit.authorEmail}
              </span>
            </>
          ) : null}
          <span className="text-muted-foreground/45">·</span>
          <span className="shrink-0 tabular-nums">{absolute}</span>
        </div>

        <div className="mt-2.5 flex items-center gap-1">
          <Button
            size="xs"
            variant="ghost"
            className="h-6 cursor-pointer gap-1.5 px-1.5 text-[11px] text-muted-foreground hover:text-foreground"
            onClick={() => {
              void onCopySha(commit.sha);
              setCopied(true);
            }}
          >
            <HugeiconsIcon icon={Copy01Icon} size={11} strokeWidth={1.9} />
            {copied ? "Copied" : "Copy SHA"}
          </Button>
          {webUrl ? (
            <Button
              size="xs"
              variant="ghost"
              className="h-6 cursor-pointer gap-1.5 px-1.5 text-[11px] text-muted-foreground hover:text-foreground"
              onClick={() => void openUrl(webUrl).catch(console.error)}
            >
              <HugeiconsIcon
                icon={LinkSquare02Icon}
                size={11}
                strokeWidth={1.9}
              />
              {hostLabel(remoteWeb!)}
            </Button>
          ) : null}
        </div>
      </div>

      <ContainedBranches repoRoot={repoRoot} sha={commit.sha} />

      <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
        <CommitFiles
          commit={commit}
          filesEntry={filesEntry}
          onOpenFile={onOpenFile}
          onRetry={onRetryFiles}
        />
      </div>
    </div>
  );
}

function ContainedBranches({
  repoRoot,
  sha,
}: {
  repoRoot: string;
  sha: string;
}) {
  const [expanded, setExpanded] = useState(false);
  const [status, setStatus] = useState<"idle" | "loading" | "loaded" | "error">(
    "idle",
  );
  const [branches, setBranches] = useState<string[]>([]);

  const load = useCallback(async () => {
    setStatus("loading");
    try {
      const list = await native.gitBranchesContaining(repoRoot, sha);
      setBranches(list);
      setStatus("loaded");
    } catch {
      setStatus("error");
    }
  }, [repoRoot, sha]);

  const toggle = useCallback(() => {
    setExpanded((current) => {
      const next = !current;
      if (next && status === "idle") void load();
      return next;
    });
  }, [load, status]);

  return (
    <div className="shrink-0 border-b border-border/45 px-3 py-1.5">
      <button
        type="button"
        onClick={toggle}
        className="flex cursor-pointer items-center gap-1.5 text-[10.5px] font-medium text-muted-foreground hover:text-foreground"
      >
        <HugeiconsIcon
          icon={ChevronDownIcon}
          size={12}
          strokeWidth={2}
          className={cn(
            "shrink-0 transition-transform",
            expanded && "rotate-180",
          )}
        />
        Included branches
        {status === "loaded" && branches.length > 0 ? (
          <span className="rounded-sm bg-muted/55 px-1 py-px text-[9.5px] tabular-nums text-muted-foreground/85">
            {branches.length}
          </span>
        ) : null}
      </button>
      {expanded ? (
        status === "loading" ? (
          <div className="mt-1.5 flex items-center gap-2 text-[11px] text-muted-foreground">
            <Spinner className="size-3" />
            Loading branches…
          </div>
        ) : status === "error" ? (
          <div className="mt-1.5 flex items-center justify-between gap-2 text-[11px] text-destructive">
            <span>Could not load branches</span>
            <Button
              size="xs"
              variant="ghost"
              className="h-5 cursor-pointer text-[10.5px]"
              onClick={() => void load()}
            >
              Retry
            </Button>
          </div>
        ) : branches.length === 0 ? (
          <div className="mt-1.5 text-[11px] text-muted-foreground">
            No branches contain this commit.
          </div>
        ) : (
          <div className="mt-1.5 flex max-h-28 flex-wrap gap-1 overflow-y-auto pb-0.5">
            {branches.map((name) => (
              <span
                key={name}
                className="inline-flex max-w-full items-center gap-1 rounded-md bg-foreground/6 px-1.5 py-0.5 font-mono text-[9.5px] leading-none text-foreground/80"
                title={name}
              >
                <HugeiconsIcon
                  icon={GitBranchIcon}
                  size={9}
                  strokeWidth={2}
                  className="shrink-0 text-muted-foreground"
                />
                <span className="truncate">{name}</span>
              </span>
            ))}
          </div>
        )
      ) : null}
    </div>
  );
}

function CommitFiles({
  commit,
  filesEntry,
  onOpenFile,
  onRetry,
}: {
  commit: GitLogEntry;
  filesEntry: FilesEntry | null;
  onOpenFile: (
    commit: GitLogEntry,
    file: GitCommitFileChange,
  ) => Promise<void> | void;
  onRetry: () => void;
}) {
  if (!filesEntry || filesEntry.state === "loading") {
    return (
      <div className="flex items-center gap-2 px-3 py-3 text-[11px] text-muted-foreground">
        <Spinner className="size-3" />
        Loading files…
      </div>
    );
  }
  if (filesEntry.state === "error") {
    return (
      <div className="flex items-center justify-between gap-2 px-3 py-3 text-[11px] text-destructive">
        <span className="truncate">{filesEntry.error}</span>
        <Button
          size="xs"
          variant="ghost"
          className="h-6 cursor-pointer text-[11px]"
          onClick={onRetry}
        >
          Retry
        </Button>
      </div>
    );
  }
  if (filesEntry.files.length === 0) {
    return (
      <div className="px-3 py-3 text-[11px] text-muted-foreground">
        No file changes.
      </div>
    );
  }
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex shrink-0 items-center justify-between px-3 pb-1 pt-2 text-[10px] font-semibold uppercase tracking-[0.16em] text-muted-foreground/85">
        <span>Files</span>
        <span className="rounded-sm bg-muted/55 px-1 py-px text-[9.5px] tabular-nums text-muted-foreground/85 normal-case tracking-normal">
          {filesEntry.files.length}
        </span>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden [scrollbar-gutter:stable]">
        <ul className="space-y-px px-1.5 pb-2">
          {filesEntry.files.map((file) => (
            <li key={file.path}>
              <FileRow
                file={file}
                onOpen={() => void onOpenFile(commit, file)}
              />
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}

const FileRow = memo(function FileRow({
  file,
  onOpen,
}: {
  file: GitCommitFileChange;
  onOpen: () => void;
}) {
  const fileName = basename(file.path);
  const dir = dirname(file.path);
  const iconUrl = fileIconUrl(fileName);
  return (
    <button
      type="button"
      onClick={onOpen}
      className="group flex h-7 w-full cursor-pointer items-center gap-2 rounded-md px-1.5 text-left transition-colors hover:bg-accent/40"
    >
      {iconUrl ? (
        <img src={iconUrl} alt="" className="size-3.5 shrink-0" />
      ) : (
        <span className="size-3.5 shrink-0" />
      )}
      <div className="flex min-w-0 flex-1 items-baseline gap-1.5 leading-none">
        <span className="truncate text-[11.5px] font-medium leading-tight">
          {fileName}
        </span>
        {dir ? (
          <span className="min-w-0 flex-1 truncate text-[10px] leading-tight text-muted-foreground/80">
            {dir}
          </span>
        ) : null}
      </div>
      <div className="flex shrink-0 items-center gap-1 text-[10px] tabular-nums">
        {file.isBinary ? (
          <span className="text-muted-foreground/70">binary</span>
        ) : (
          <>
            {file.added > 0 ? (
              <span className="text-emerald-600 dark:text-emerald-400">
                +{file.added}
              </span>
            ) : null}
            {file.removed > 0 ? (
              <span className="text-rose-600 dark:text-rose-400">
                −{file.removed}
              </span>
            ) : null}
          </>
        )}
      </div>
      <span
        className={cn(
          "inline-flex w-4 shrink-0 justify-center text-[9.5px] font-bold leading-none tabular-nums",
          statusTone(file.status),
        )}
        title={file.statusLabel}
      >
        {file.status.toUpperCase()}
      </span>
    </button>
  );
});
