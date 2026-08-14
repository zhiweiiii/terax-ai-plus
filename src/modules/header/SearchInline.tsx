import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { KEY_SEP } from "@/lib/platform";
import { cn } from "@/lib/utils";
import { fileIconUrl } from "@/modules/explorer/lib/iconResolver";
import {
  CONTENT_SEARCH_MIN_QUERY,
  useContentSearch,
  type ContentHit,
} from "@/modules/command-palette/hooks/useContentSearch";
import { usePreferencesStore } from "@/modules/settings/preferences";
import { getBindingTokens, SHORTCUTS } from "@/modules/shortcuts/shortcuts";
import { Cancel01Icon, Search01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import {
  forwardRef,
  useCallback,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from "react";

export type SearchInlineHandle = { focus: () => void };

type Props = {
  /** Workspace root to search. Null disables the search. */
  root: string | null;
  onOpenHit: (path: string, line: number) => void;
  /** When true, collapse to an icon-only button until the user opens it. */
  compact?: boolean;
};

export const SearchInline = forwardRef<SearchInlineHandle, Props>(
  function SearchInline({ root, onOpenHit, compact }, ref) {
    const [q, setQ] = useState("");
    // In compact mode the field is hidden behind an icon until activated.
    // In normal mode the field is always present.
    const [openInCompact, setOpenInCompact] = useState(false);
    const [activeIndex, setActiveIndex] = useState(0);
    const inputRef = useRef<HTMLInputElement>(null);
    const pendingFocusRef = useRef(false);
    const setInputRef = useCallback((el: HTMLInputElement | null) => {
      inputRef.current = el;
      if (!el || !pendingFocusRef.current) return;
      pendingFocusRef.current = false;
      el.focus();
    }, []);

    const userShortcuts = usePreferencesStore((s) => s.shortcuts);

    const shortcutText = useMemo(() => {
      const s = SHORTCUTS.find((s) => s.id === "search.focus");
      if (!s) return "";
      const bindings = userShortcuts["search.focus"] || s.defaultBindings;
      if (!bindings || bindings.length === 0) return "";
      const tokens = getBindingTokens(bindings[0]);
      return tokens.join(KEY_SEP);
    }, [userShortcuts]);

    const placeholder = useMemo(() => {
      const base = "Search workspace";
      return shortcutText ? `${base} (${shortcutText})` : base;
    }, [shortcutText]);

    const tooltipTitle = placeholder;

    const expanded = !compact || openInCompact;

    // The dropdown stays live while the field is expanded; the hook itself
    // debounces and self-cancels superseded queries server-side.
    const searching = expanded && q.length >= CONTENT_SEARCH_MIN_QUERY;
    const content = useContentSearch(root, q, searching);

    const focus = useCallback(() => {
      pendingFocusRef.current = true;
      if (compact) setOpenInCompact(true);
      else inputRef.current?.focus();
      if (inputRef.current) pendingFocusRef.current = false;
    }, [compact]);

    useImperativeHandle(ref, () => ({ focus }), [focus]);

    const openHit = useCallback(
      (hit: ContentHit) => {
        onOpenHit(hit.path, hit.line);
        setQ("");
      },
      [onOpenHit],
    );

    const onKeyDown = useCallback(
      (e: React.KeyboardEvent) => {
        const hits = content.results;
        if (e.key === "Enter") {
          e.preventDefault();
          const hit = hits[activeIndex];
          if (hit) openHit(hit);
        } else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
          if (hits.length === 0) return;
          e.preventDefault();
          const delta = e.key === "ArrowDown" ? 1 : -1;
          setActiveIndex((i) => (i + delta + hits.length) % hits.length);
        } else if (e.key === "Escape") {
          e.preventDefault();
          if (q) {
            setQ("");
            inputRef.current?.focus();
          } else {
            if (compact) setOpenInCompact(false);
            inputRef.current?.blur();
          }
        }
      },
      [activeIndex, content.results, openHit, q, compact],
    );

    return (
      <div
        className="relative h-7 shrink-0 transition-[width] duration-200 ease-out"
        style={{ width: expanded ? 224 : 28 }}
      >
        {expanded ? (
          <div className="absolute inset-0 animate-in fade-in-0 duration-150">
            <HugeiconsIcon
              icon={Search01Icon}
              size={13}
              strokeWidth={1.75}
              className="pointer-events-none absolute top-1/2 left-2 -translate-y-1/2 text-muted-foreground"
            />
            <Input
              ref={setInputRef}
              value={q}
              placeholder={placeholder}
              className="h-7 w-full bg-muted/80 pr-7 pl-7 text-[13px]! placeholder:text-muted-foreground/70 focus-visible:ring-0"
              onChange={(e) => {
                setQ(e.target.value);
                setActiveIndex(0);
              }}
              onBlur={() => {
                if (compact && !q) setOpenInCompact(false);
              }}
              onKeyDown={onKeyDown}
            />
            {q && (
              <button
                type="button"
                onClick={() => {
                  setQ("");
                  inputRef.current?.focus();
                }}
                className="absolute top-1/2 right-1.5 -translate-y-1/2 rounded p-0.5 text-muted-foreground hover:bg-accent hover:text-foreground"
                aria-label="Clear search"
              >
                <HugeiconsIcon icon={Cancel01Icon} size={11} strokeWidth={2} />
              </button>
            )}

            {expanded && q && (
              <SearchResults
                root={root}
                q={q}
                content={content}
                activeIndex={activeIndex}
                onSelectIndex={setActiveIndex}
                onOpenHit={openHit}
              />
            )}
          </div>
        ) : (
          <div className="absolute inset-0 flex items-center justify-end animate-in fade-in-0 duration-150">
            <Button
              variant="ghost"
              size="icon"
              className="size-7 shrink-0 rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"
              onClick={focus}
              title={tooltipTitle}
            >
              <HugeiconsIcon icon={Search01Icon} size={15} strokeWidth={1.75} />
            </Button>
          </div>
        )}
      </div>
    );
  },
);

function SearchResults({
  root,
  q,
  content,
  activeIndex,
  onSelectIndex,
  onOpenHit,
}: {
  root: string | null;
  q: string;
  content: ReturnType<typeof useContentSearch>;
  activeIndex: number;
  onSelectIndex: (i: number) => void;
  onOpenHit: (hit: ContentHit) => void;
}) {
  let body: React.ReactNode;
  if (!root) {
    body = <ResultRow disabled label="No workspace root" />;
  } else if (q.length < CONTENT_SEARCH_MIN_QUERY) {
    body = <ResultRow disabled label="Type at least 2 characters" />;
  } else if (content.error) {
    body = (
      <>
        <ResultRow disabled label="Search failed" tone="error" />
        <ResultRow label="Retry" onClick={content.retry} />
      </>
    );
  } else if (content.loading && content.results.length === 0) {
    body = <ResultRow disabled label="Searching..." />;
  } else if (content.results.length === 0) {
    body = <ResultRow disabled label="No matches" />;
  } else {
    body = content.results.map((hit, i) => (
      <button
        key={`${hit.path}:${hit.line}`}
        type="button"
        onClick={() => onOpenHit(hit)}
        onMouseEnter={() => onSelectIndex(i)}
        className={cn(
          "flex min-w-0 cursor-pointer items-center gap-2 px-3 py-1.5 text-left",
          i === activeIndex && "bg-accent",
        )}
      >
        <img
          src={fileIconUrl(basename(hit.rel))}
          alt=""
          className="size-4 shrink-0"
        />
        <span className="min-w-0 flex-1 truncate font-mono text-[11.5px]">
          {hit.text.trim()}
        </span>
        <span className="ml-auto max-w-64 shrink-0 truncate text-[11px] text-muted-foreground">
          {hit.rel}:{hit.line}
        </span>
      </button>
    ));
  }

  return (
    <div className="absolute top-[calc(100%+6px)] right-0 z-50 w-[min(600px,calc(100vw-32px))] overflow-hidden rounded-lg border border-border bg-popover shadow-lg">
      <div className="max-h-[420px] overflow-y-auto py-1 text-[12.5px] text-foreground">
        {body}
      </div>
    </div>
  );
}

function ResultRow({
  label,
  tone = "muted",
  disabled = false,
  onClick,
}: {
  label: string;
  tone?: "muted" | "error";
  disabled?: boolean;
  onClick?: () => void;
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      className={cn(
        "flex w-full min-w-0 cursor-pointer items-center gap-2 px-3 py-1.5 text-left disabled:cursor-default",
        tone === "error" ? "text-destructive" : "text-muted-foreground",
      )}
    >
      <span className="min-w-0 flex-1 truncate">{label}</span>
    </button>
  );
}

function basename(rel: string): string {
  const parts = rel.split(/[\\/]/);
  return parts[parts.length - 1] || rel;
}
