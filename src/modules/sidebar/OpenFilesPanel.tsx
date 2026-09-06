import { cn } from "@/lib/utils";
import type { Tab } from "@/modules/tabs";
import { labelFor } from "@/modules/tabs/lib/tabLabel";
import { fileIconUrl } from "@/modules/explorer/lib/iconResolver";
import {
  Cancel01Icon,
  ComputerTerminal02Icon,
  GitCompareIcon,
  Globe02Icon,
  HistoryIcon,
  PencilEdit02Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";

type Props = {
  tabs: Tab[];
  activeId: number;
  /** The terminal tab whose files are shown; null shows unattached files. */
  currentOwnerTabId: number | null;
  onSelectTab: (id: number) => void;
  onCloseTab: (id: number) => void;
};

export function OpenFilesPanel({
  tabs,
  activeId,
  currentOwnerTabId,
  onSelectTab,
  onCloseTab,
}: Props) {
  // Every tab here belongs to the command line it was opened from, git tabs
  // included. They used to bypass the filter as "repo-level", which meant a
  // diff opened in one project stayed on screen in another: a list that is
  // supposed to say what you have open in THIS project cannot show tabs from
  // somewhere else.
  //
  // Ownership is required, not preferred: an unowned tab does not appear while
  // a command line is scoping the list. Nothing is stranded by that, because
  // tabs restored without an owner are adopted by their space's first terminal
  // on boot (`adoptOrphanTabs`).
  const listed = (t: Tab) =>
    t.kind === "editor" ||
    t.kind === "markdown" ||
    t.kind === "preview" ||
    t.kind === "git-diff" ||
    t.kind === "git-history" ||
    t.kind === "git-commit-file";
  const fileTabs = tabs.filter(
    (t) =>
      listed(t) &&
      (currentOwnerTabId !== null
        ? t.ownerTabId === currentOwnerTabId
        : t.ownerTabId === undefined),
  );

  if (fileTabs.length === 0) {
    return (
      <div className="flex h-full items-center justify-center px-4 text-center text-[11px] text-muted-foreground">
        No open files
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col overflow-y-auto">
      <div className="flex h-7 shrink-0 items-center gap-2 border-b border-border/50 px-3">
        <HugeiconsIcon
          icon={ComputerTerminal02Icon}
          size={11}
          strokeWidth={1.75}
          className="shrink-0 text-muted-foreground/60"
        />
        <span className="min-w-0 flex-1 truncate text-[10.5px] font-semibold uppercase tracking-[0.16em] text-muted-foreground/85">
          Open Files
        </span>
        <span className="text-[10px] tabular-nums text-muted-foreground/60">
          {fileTabs.length}
        </span>
      </div>
      {fileTabs.map((tab) => {
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
              "group flex h-7 w-full shrink-0 items-center gap-2 px-3 text-left text-[12px] transition-colors",
              isActive
                ? "bg-accent text-foreground"
                : "text-muted-foreground hover:bg-foreground/[0.04] hover:text-foreground",
            )}
          >
            {iconUrl ? (
              <img src={iconUrl} alt="" className="size-3.5 shrink-0" />
            ) : tab.kind === "preview" ? (
              <HugeiconsIcon icon={Globe02Icon} size={14} strokeWidth={1.75} className="shrink-0" />
            ) : tab.kind === "git-diff" || tab.kind === "git-commit-file" ? (
              <HugeiconsIcon icon={GitCompareIcon} size={14} strokeWidth={1.75} className="shrink-0" />
            ) : tab.kind === "git-history" ? (
              <HugeiconsIcon icon={HistoryIcon} size={14} strokeWidth={1.75} className="shrink-0" />
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
      })}
    </div>
  );
}
