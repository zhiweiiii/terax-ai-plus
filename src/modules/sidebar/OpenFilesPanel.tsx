import { cn } from "@/lib/utils";
import type { Tab } from "@/modules/tabs";
import { labelFor } from "@/modules/tabs/lib/tabLabel";
import { DEFAULT_SPACE_ID } from "@/modules/tabs/lib/useTabs";
import { fileIconUrl } from "@/modules/explorer/lib/iconResolver";
import { useSpaces } from "@/modules/spaces";
import {
  Cancel01Icon,
  ComputerTerminal02Icon,
  GitCompareIcon,
  Globe02Icon,
  PencilEdit02Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";

type Props = {
  tabs: Tab[];
  activeId: number;
  onSelectTab: (id: number) => void;
  onCloseTab: (id: number) => void;
};

export function OpenFilesPanel({ tabs, activeId, onSelectTab, onCloseTab }: Props) {
  const spaces = useSpaces((s) => s.spaces);
  const fileTabs = tabs.filter(
    (t) =>
      t.kind === "editor" ||
      t.kind === "markdown" ||
      t.kind === "preview" ||
      t.kind === "git-diff" ||
      t.kind === "ai-diff",
  );

  if (fileTabs.length === 0) {
    return (
      <div className="flex h-full items-center justify-center px-4 text-center text-[11px] text-muted-foreground">
        No open files
      </div>
    );
  }

  // Group tabs by spaceId
  const groups = new Map<string, Tab[]>();
  for (const tab of fileTabs) {
    const key = tab.spaceId ?? DEFAULT_SPACE_ID;
    const bucket = groups.get(key);
    if (bucket) bucket.push(tab);
    else groups.set(key, [tab]);
  }

  const renderTab = (tab: Tab) => {
    const isActive = tab.id === activeId;
    const name = labelFor(tab);
    const iconUrl =
      tab.kind === "editor" || tab.kind === "markdown"
        ? fileIconUrl(name)
        : null;

    return (
      <button
        key={tab.id}
        type="button"
        onClick={() => onSelectTab(tab.id)}
        className={cn(
          "group flex h-7 shrink-0 items-center gap-2 px-3 text-left text-[12px] transition-colors",
          isActive
            ? "bg-accent text-foreground"
            : "text-muted-foreground hover:bg-foreground/[0.04] hover:text-foreground",
        )}
      >
        {iconUrl ? (
          <img src={iconUrl} alt="" className="size-3.5 shrink-0" />
        ) : tab.kind === "preview" ? (
          <HugeiconsIcon icon={Globe02Icon} size={14} strokeWidth={1.75} className="shrink-0" />
        ) : tab.kind === "git-diff" || tab.kind === "ai-diff" ? (
          <HugeiconsIcon icon={GitCompareIcon} size={14} strokeWidth={1.75} className="shrink-0" />
        ) : tab.kind === "editor" ? (
          <HugeiconsIcon icon={PencilEdit02Icon} size={14} strokeWidth={1.75} className="shrink-0" />
        ) : (
          <HugeiconsIcon icon={ComputerTerminal02Icon} size={14} strokeWidth={1.75} className="shrink-0" />
        )}
        <span className="min-w-0 flex-1 truncate">{name}</span>
        <span
          role="button"
          aria-label="Close file"
          onClick={(e) => {
            e.stopPropagation();
            onCloseTab(tab.id);
          }}
          className="rounded p-0.5 opacity-0 transition-opacity hover:bg-accent group-hover:opacity-60"
        >
          <HugeiconsIcon icon={Cancel01Icon} size={11} strokeWidth={2} />
        </span>
      </button>
    );
  };

  const totalHeader = (
    <div className="flex h-7 shrink-0 items-center gap-2 border-b border-border/50 px-3">
      <span className="text-[10.5px] font-semibold uppercase tracking-[0.16em] text-muted-foreground/85">
        Open Files
      </span>
      <span className="text-[10px] tabular-nums text-muted-foreground/60">
        {fileTabs.length}
      </span>
    </div>
  );

  // If only one group, show without group headers
  if (groups.size <= 1) {
    return (
      <div className="flex h-full flex-col overflow-y-auto">
        {totalHeader}
        {fileTabs.map(renderTab)}
      </div>
    );
  }

  // Multiple groups: show group headers
  const groupOrder = [...groups.keys()];
  return (
    <div className="flex h-full flex-col overflow-y-auto">
      {totalHeader}
      {groupOrder.map((spaceId) => {
        const groupTabs = groups.get(spaceId)!;
        const space = spaces.find((s) => s.id === spaceId);
        const groupLabel = space?.name ?? (spaceId === DEFAULT_SPACE_ID ? "Default" : spaceId);
        return (
          <div key={spaceId}>
            <div className="flex h-6 items-center gap-2 border-b border-border/30 px-3">
              <span className="text-[10px] font-semibold text-muted-foreground/70">
                {groupLabel}
              </span>
              <span className="text-[9px] tabular-nums text-muted-foreground/50">
                {groupTabs.length}
              </span>
            </div>
            {groupTabs.map(renderTab)}
          </div>
        );
      })}
    </div>
  );
}
