import { cn } from "@/lib/utils";
import { Cancel01Icon, Search01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import {
  forwardRef,
  useImperativeHandle,
  useRef,
  useState,
} from "react";

export type FindMatch = {
  key: string;
  /** 1-based line shown in the dropdown. */
  line: number;
  /** Single-line match preview. */
  text: string;
  /** Secondary hint (path, column, sha, ...). */
  hint?: string;
  /** Optional leading icon. */
  iconUrl?: string | null;
};

export type FindBoxHandle = { focus: () => void };

type Props = {
  placeholder?: string;
  minQuery?: number;
  matches: FindMatch[];
  loading?: boolean;
  /** True when the underlying content is unavailable. */
  disabledReason?: string;
  onSearch: (q: string) => void;
  onJump: (index: number) => void;
  onClose: () => void;
};

/**
 * Single-file find box: a floating input with a results dropdown, keyboard
 * navigation (ArrowUp/Down, Enter to jump, Escape to dismiss). Same look and
 * interaction as the old header search box.
 */
export const FindBox = forwardRef<FindBoxHandle, Props>(function FindBox(
  {
    placeholder = "Find…",
    minQuery = 1,
    matches,
    loading = false,
    disabledReason,
    onSearch,
    onJump,
    onClose,
  },
  ref,
) {
  const [q, setQ] = useState("");
  const [activeIndex, setActiveIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  useImperativeHandle(
    ref,
    () => ({
      focus: () => {
        inputRef.current?.focus();
      },
    }),
    [],
  );

  const searching = q.length >= minQuery && !disabledReason;

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter") {
      e.preventDefault();
      if (searching && matches.length > 0) onJump(activeIndex);
    } else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      if (matches.length === 0) return;
      e.preventDefault();
      const delta = e.key === "ArrowDown" ? 1 : -1;
      setActiveIndex((i) => (i + delta + matches.length) % matches.length);
    } else if (e.key === "Escape") {
      e.preventDefault();
      if (q) {
        setQ("");
        onSearch("");
        inputRef.current?.focus();
      } else {
        onClose();
      }
    }
  };

  let body: React.ReactNode;
  if (disabledReason) {
    body = <ResultRow label={disabledReason} />;
  } else if (q.length < minQuery) {
    body = <ResultRow label={`Type at least ${minQuery} characters`} />;
  } else if (loading && matches.length === 0) {
    body = <ResultRow label="Searching…" />;
  } else if (matches.length === 0) {
    body = <ResultRow label="No matches" />;
  } else {
    body = matches.map((m, i) => (
      <button
        key={m.key}
        type="button"
        onClick={() => onJump(i)}
        onMouseEnter={() => setActiveIndex(i)}
        className={cn(
          "flex min-w-0 cursor-pointer items-center gap-2 px-3 py-1.5 text-left",
          i === activeIndex && "bg-accent",
        )}
      >
        {m.iconUrl ? (
          <img src={m.iconUrl} alt="" className="size-4 shrink-0" />
        ) : (
          <HugeiconsIcon
            icon={Search01Icon}
            size={12}
            strokeWidth={1.75}
            className="shrink-0 text-muted-foreground"
          />
        )}
        <span className="min-w-0 flex-1 truncate text-[11.5px]">
          {m.text}
        </span>
        <span className="ml-auto max-w-48 shrink-0 truncate font-mono text-[10.5px] text-muted-foreground">
          {m.hint ?? `:${m.line}`}
        </span>
      </button>
    ));
  }

  return (
    <div className="absolute top-2 right-2 z-50 w-[min(480px,calc(100%-16px))]">
      <div className="relative">
        <HugeiconsIcon
          icon={Search01Icon}
          size={13}
          strokeWidth={1.75}
          className="pointer-events-none absolute top-1/2 left-2 -translate-y-1/2 text-muted-foreground"
        />
        <input
          ref={inputRef}
          value={q}
          placeholder={placeholder}
          onChange={(e) => {
            setQ(e.target.value);
            setActiveIndex(0);
            onSearch(e.target.value);
          }}
          onKeyDown={onKeyDown}
          className="h-7 w-full rounded-md border border-border/60 bg-muted/80 pr-7 pl-7 text-[12.5px] outline-none placeholder:text-muted-foreground/70 focus:border-ring focus:bg-muted"
        />
        {q ? (
          <button
            type="button"
            onClick={() => {
              setQ("");
              onSearch("");
              inputRef.current?.focus();
            }}
            className="absolute top-1/2 right-1.5 -translate-y-1/2 rounded p-0.5 text-muted-foreground hover:bg-accent hover:text-foreground"
            aria-label="Clear search"
          >
            <HugeiconsIcon icon={Cancel01Icon} size={11} strokeWidth={2} />
          </button>
        ) : null}
      </div>
      {searching ? (
        <div className="absolute top-[calc(100%+4px)] right-0 left-0 overflow-hidden rounded-md border border-border bg-popover shadow-lg">
          <div className="max-h-[360px] overflow-y-auto py-1 text-[12.5px] text-foreground">
            {body}
          </div>
        </div>
      ) : null}
    </div>
  );
});

function ResultRow({ label }: { label: string }) {
  return (
    <div className="flex w-full min-w-0 items-center gap-2 px-3 py-1.5 text-left">
      <span className="min-w-0 flex-1 truncate text-muted-foreground">
        {label}
      </span>
    </div>
  );
}
