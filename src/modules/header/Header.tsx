import { Button } from "@/components/ui/button";
import { WindowControls } from "@/components/WindowControls";
import { USE_CUSTOM_WINDOW_CONTROLS } from "@/lib/platform";
import type { Tab } from "@/modules/tabs";
import { TabBar } from "@/modules/tabs";
import {
  CommandIcon,
  Settings01Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import type { ReactNode, RefObject } from "react";
import {
  SearchInline,
  type SearchInlineHandle,
} from "./SearchInline";

type Props = {
  tabs: Tab[];
  activeId: number;
  /** Active file tab's owning terminal, so the command line stays highlighted. */
  activeOwnerTabId?: number | null;
  onSelect: (id: number) => void;
  onNew: () => void;
  onNewBlock: () => void;
  onNewPrivate: () => void;
  onNewPreview: () => void;
  onNewEditor: () => void;
  onNewGitGraph: () => void;
  onClose: (id: number) => void;
  onPin: (id: number) => void;
  onRename: (id: number, title: string) => void;
  onReorder: (fromId: number, toGapIndex: number) => void;
  onOverrideLanguage?: (id: number, lang: string | null) => void;
  onOpenCommandPalette: () => void;
  onOpenSettings: () => void;
  searchRoot: string | null;
  onSearchOpenHit: (path: string, line: number) => void;
  searchRef: RefObject<SearchInlineHandle | null>;
  headerTabs?: ReactNode;
  /** Group (space) switcher rendered before the tab strip. */
  groupSwitcher?: ReactNode;
  onLaunchClaude?: () => void;
  onLaunchClaudeC?: () => void;
};

export function Header({
  tabs,
  activeId,
  activeOwnerTabId,
  onSelect,
  onNew,
  onNewBlock,
  onNewPrivate,
  onNewPreview,
  onNewEditor,
  onNewGitGraph,
  onClose,
  onPin,
  onRename,
  onReorder,
  onOverrideLanguage,
  onOpenCommandPalette,
  onOpenSettings,
  searchRoot,
  onSearchOpenHit,
  searchRef,
  headerTabs,
  groupSwitcher,
  onLaunchClaude,
  onLaunchClaudeC,
}: Props) {

  const settingsButton = (
    <Button
      variant="ghost"
      size="icon"
      className="size-7 shrink-0 rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"
      onClick={onOpenSettings}
      title="Settings"
    >
      <HugeiconsIcon icon={Settings01Icon} size={15} strokeWidth={1.75} />
    </Button>
  );

  return (
    <div
      data-tauri-drag-region
      className="flex h-10 shrink-0 items-center gap-2 border-b border-border/60 bg-card select-none pr-0 pl-2"
    >
      <div className="flex shrink-0 items-center gap-0.5">
        {headerTabs}
        <Button
          size="icon-sm"
          variant="ghost"
          onClick={onOpenCommandPalette}
          title="Command palette"
          className="shrink-0 gap-1.5 rounded-md px-1.5 text-muted-foreground hover:bg-accent hover:text-foreground"
        >
          <HugeiconsIcon icon={CommandIcon} size={14} strokeWidth={1.75} />
        </Button>

        {onLaunchClaude && (
          <Button
            variant="ghost"
            size="icon-sm"
            className="h-6 shrink-0 rounded px-1 text-[10px] font-medium text-muted-foreground hover:bg-accent hover:text-foreground"
            onClick={onLaunchClaude}
            title="Launch Claude Code"
          >
            C
          </Button>
        )}
        {onLaunchClaudeC && (
          <Button
            variant="ghost"
            size="icon-sm"
            className="h-6 shrink-0 rounded px-1 text-[10px] font-medium text-muted-foreground hover:bg-accent hover:text-foreground"
            onClick={onLaunchClaudeC}
            title="Launch Claude Code -c"
          >
            C-C
          </Button>
        )}
      </div>

      <span className="mx-1 h-full w-px shrink-0 bg-border/70" />

      <div
        className="flex min-w-0 flex-1 items-center gap-2"
        data-tauri-drag-region
      >
        {groupSwitcher}
        <TabBar
          tabs={tabs}
          activeId={activeId}
          activeOwnerTabId={activeOwnerTabId}
          onSelect={onSelect}
          onNew={onNew}
          onNewBlock={onNewBlock}
          onNewPrivate={onNewPrivate}
          onNewPreview={onNewPreview}
          onNewEditor={onNewEditor}
          onNewGitGraph={onNewGitGraph}
          onClose={onClose}
          onPin={onPin}
          onRename={onRename}
          onReorder={onReorder}
          onOverrideLanguage={onOverrideLanguage}
        />
        <div data-tauri-drag-region className="h-full min-w-2 flex-1" />
      </div>

      <SearchInline
        ref={searchRef}
        root={searchRoot}
        onOpenHit={onSearchOpenHit}
        compact={false}
      />

      {settingsButton}

      {USE_CUSTOM_WINDOW_CONTROLS && (
        <>
          <span className="ml-1 h-5 w-px shrink-0 bg-border/60" />
          <WindowControls />
        </>
      )}
    </div>
  );
}
