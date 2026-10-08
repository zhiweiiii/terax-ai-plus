import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";
import {
  ArrowDown01Icon,
  ArrowUp01Icon,
  Cancel01Icon,
  Clock01Icon,
  CommandLineIcon,
  ComputerTerminal02Icon,
  Copy01Icon,
  MoreHorizontalIcon,
  Refresh01Icon,
  Search01Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { homeDir } from "@tauri-apps/api/path";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import type {
  BlockMatch,
  PositionedBlock,
  VisibleBlocks,
} from "./lib/blockDecorations";

let cachedHome: string | null = null;
void homeDir()
  .then((h) => {
    cachedHome = h.replace(/\\/g, "/").replace(/\/+$/, "");
  })
  .catch(() => {});

type Props = {
  subscribe: (cb: () => void) => () => void;
  getVisible: () => VisibleBlocks;
  readOutput: (id: string) => string | null;
  searchBlock: (id: string, query: string) => BlockMatch[];
  revealMatch: (m: BlockMatch) => void;
  clearSearch: () => void;
  promptReady: boolean;
  onRunAgain: (command: string) => void;
  onRestoreFocus: () => void;
};

const EMPTY: VisibleBlocks = { blocks: [], sticky: null };

function fmtDuration(ms: number): string | null {
  if (!Number.isFinite(ms) || ms <= 0) return null;
  if (ms < 1000) return `${ms}ms`;
  if (ms < 10000) return `${(ms / 1000).toFixed(1)}s`;
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) {
    const m = Math.floor(seconds / 60);
    const s = seconds % 60;
    return s ? `${m}m ${s}s` : `${m}m`;
  }
  const minutes = Math.round(ms / 60000);
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return m ? `${h}h ${m}m` : `${h}h`;
}

function fmtTime(ms: number): string {
  const d = new Date(ms);
  const h = String(d.getHours()).padStart(2, "0");
  const m = String(d.getMinutes()).padStart(2, "0");
  return `${h}:${m}`;
}

function relPath(p: string): string {
  if (cachedHome && (p === cachedHome || p.startsWith(`${cachedHome}/`))) {
    return `~${p.slice(cachedHome.length)}`;
  }
  return p;
}

function copy(text: string, message: string) {
  void navigator.clipboard
    .writeText(text)
    .then(() => toast.success(message))
    .catch((error) => toast.error(`Could not copy block: ${String(error)}`));
}

function sameBlock(
  a: PositionedBlock | null,
  b: PositionedBlock | null,
): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  return (
    a.id === b.id &&
    a.command === b.command &&
    a.cwd === b.cwd &&
    a.exitCode === b.exitCode &&
    a.running === b.running &&
    a.ok === b.ok &&
    a.startedAt === b.startedAt &&
    a.finishedAt === b.finishedAt &&
    a.top === b.top &&
    a.bottom === b.bottom &&
    a.headerTop === b.headerTop
  );
}

export function BlockOverlay(props: Props) {
  const { subscribe, getVisible } = props;
  const [vis, setVis] = useState<VisibleBlocks>(EMPTY);
  const [searchId, setSearchId] = useState<string | null>(null);
  const previous = useRef<VisibleBlocks | null>(null);

  useEffect(() => {
    const update = () => {
      const v = getVisible();
      const old = previous.current;
      if (
        old &&
        sameBlock(old.sticky, v.sticky) &&
        old.blocks.length === v.blocks.length &&
        old.blocks.every((block, index) => sameBlock(block, v.blocks[index]))
      )
        return;
      previous.current = v;
      setVis(v);
    };
    update();
    return subscribe(update);
  }, [subscribe, getVisible]);

  useEffect(() => () => props.clearSearch(), [props.clearSearch]);

  const openSearch = (id: string) => {
    props.clearSearch();
    setSearchId(id);
  };

  const closeSearch = () => {
    props.clearSearch();
    setSearchId(null);
    props.onRestoreFocus();
  };

  return (
    <div className="pointer-events-none absolute inset-0 z-10 overflow-hidden">
      {vis.blocks.map((b) => (
        <BlockChrome key={b.id} block={b} all={props} onSearch={openSearch} />
      ))}
      {vis.sticky && (
        <StickyHeader block={vis.sticky} all={props} onSearch={openSearch} />
      )}
      {searchId && (
        <SearchBar
          key={searchId}
          blockId={searchId}
          searchBlock={props.searchBlock}
          revealMatch={props.revealMatch}
          onClose={closeSearch}
        />
      )}
    </div>
  );
}

type ChromeProps = {
  block: PositionedBlock;
  all: Props;
  onSearch: (id: string) => void;
};

// No chrome while the command runs; the bar lands together with the divider
// once the block is finished.
function BlockChrome({ block, all, onSearch }: ChromeProps) {
  if (block.running) return null;
  return (
    <>
      <div
        className={cn("bt-divider", !block.ok && "bt-divider-fail")}
        style={{ top: block.bottom }}
      />
      <div className="bt-bar" style={{ top: block.headerTop }}>
        <Meta block={block} />
        <Toolbar block={block} all={all} onSearch={onSearch} />
      </div>
    </>
  );
}

function Meta({ block }: { block: PositionedBlock }) {
  return (
    <span className="bt-head-meta">
      {block.cwd && <span className="bt-cwd">{relPath(block.cwd)}</span>}
      <span className="bt-clock">
        <HugeiconsIcon icon={Clock01Icon} size={11} strokeWidth={1.75} />
        {fmtTime(block.startedAt)}
      </span>
    </span>
  );
}

function StickyHeader({ block, all, onSearch }: ChromeProps) {
  return (
    <div className="bt-sticky">
      <HugeiconsIcon
        className="bt-sticky-icon"
        icon={CommandLineIcon}
        size={12}
        strokeWidth={1.75}
      />
      <span className="bt-sticky-cmd">{block.command || "command"}</span>
      <Toolbar block={block} all={all} onSearch={onSearch} />
    </div>
  );
}

function Toolbar({ block, all, onSearch }: ChromeProps) {
  const duration = block.running
    ? null
    : fmtDuration(block.finishedAt - block.startedAt);
  const failed = !block.running && !block.ok && block.exitCode !== null;
  return (
    <div className="bt-tools">
      {failed && <span className="bt-exit">exit {block.exitCode}</span>}
      {duration && <span className="bt-dur">{duration}</span>}
      {!block.running && !!block.command && (
        <button
          type="button"
          title="Run again"
          className="bt-btn"
          disabled={!all.promptReady}
          onClick={() => all.onRunAgain(block.command)}
        >
          <HugeiconsIcon icon={Refresh01Icon} size={12.5} strokeWidth={1.75} />
        </button>
      )}
      <BlockMenu block={block} all={all} onSearch={onSearch} />
    </div>
  );
}

function BlockMenu({ block, all, onSearch }: ChromeProps) {
  const output = () => all.readOutput(block.id) ?? "";
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button type="button" title="Block actions" className="bt-btn">
          <HugeiconsIcon
            icon={MoreHorizontalIcon}
            size={14}
            strokeWidth={1.75}
          />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="end"
        className="min-w-44"
        onCloseAutoFocus={(e) => {
          e.preventDefault();
          all.onRestoreFocus();
        }}
      >
        <MenuItem
          icon={Refresh01Icon}
          label="Run again"
          disabled={block.running || !all.promptReady || !block.command}
          onClick={() => all.onRunAgain(block.command)}
        />
        <MenuItem
          icon={Copy01Icon}
          label="Copy command"
          disabled={!block.command}
          onClick={() => copy(block.command, "Command copied")}
        />
        <MenuItem
          icon={ComputerTerminal02Icon}
          label="Copy output"
          onClick={() => {
            const o = output();
            if (o) copy(o, "Output copied");
          }}
        />
        <MenuItem
          icon={Copy01Icon}
          label="Copy command and output"
          onClick={() => {
            const text = `$ ${block.command}\n${output()}`;
            copy(text, "Block copied");
          }}
        />
        <MenuItem
          icon={Search01Icon}
          label="Find in block"
          onClick={() => onSearch(block.id)}
        />
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function MenuItem({
  icon,
  label,
  disabled,
  onClick,
}: {
  icon: typeof Copy01Icon;
  label: string;
  disabled?: boolean;
  onClick: () => void;
}) {
  return (
    <DropdownMenuItem
      disabled={disabled}
      onSelect={onClick}
      className="gap-2 text-xs"
    >
      <HugeiconsIcon icon={icon} size={13} strokeWidth={1.75} />
      {label}
    </DropdownMenuItem>
  );
}

// One fixed search bar pinned to the top of the terminal so it stays put while
// navigating matches (the grid scrolls underneath).
function SearchBar({
  blockId,
  searchBlock,
  revealMatch,
  onClose,
}: {
  blockId: string;
  searchBlock: (id: string, query: string) => BlockMatch[];
  revealMatch: (m: BlockMatch) => void;
  onClose: () => void;
}) {
  const [matches, setMatches] = useState<BlockMatch[]>([]);
  const [idx, setIdx] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const run = (query: string) => {
    const m = searchBlock(blockId, query);
    setMatches(m);
    setIdx(0);
    if (m.length) revealMatch(m[0]);
  };
  const nav = (dir: number) => {
    if (!matches.length) return;
    const next = (idx + dir + matches.length) % matches.length;
    setIdx(next);
    revealMatch(matches[next]);
  };

  return (
    <div className="bt-search pointer-events-auto">
      <HugeiconsIcon icon={Search01Icon} size={12} strokeWidth={1.75} />
      <input
        ref={inputRef}
        aria-label="Find in block"
        className="bt-search-input"
        placeholder="Find in block"
        onChange={(e) => run(e.target.value)}
        onKeyDown={(e) => {
          if (e.nativeEvent.isComposing || e.keyCode === 229) return;
          e.stopPropagation();
          if (e.key === "Enter") {
            e.preventDefault();
            nav(e.shiftKey ? -1 : 1);
          } else if (e.key === "Escape") {
            e.preventDefault();
            onClose();
          }
        }}
      />
      <span className="bt-search-count">
        {matches.length ? `${idx + 1}/${matches.length}` : "0"}
      </span>
      <SearchBtn
        title="Previous"
        icon={ArrowUp01Icon}
        onClick={() => nav(-1)}
      />
      <SearchBtn title="Next" icon={ArrowDown01Icon} onClick={() => nav(1)} />
      <SearchBtn title="Close" icon={Cancel01Icon} onClick={onClose} />
    </div>
  );
}

function SearchBtn({
  title,
  icon,
  onClick,
}: {
  title: string;
  icon: typeof Copy01Icon;
  onClick: () => void;
}) {
  return (
    <button type="button" title={title} onClick={onClick} className="bt-btn">
      <HugeiconsIcon icon={icon} size={13} strokeWidth={1.75} />
    </button>
  );
}
