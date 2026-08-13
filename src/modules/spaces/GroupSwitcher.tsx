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
import {
  Add01Icon,
  ArrowDown01Icon,
  Delete02Icon,
  DashboardSquare01Icon,
  PencilEdit02Icon,
  Tick02Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useState } from "react";
import type { SpaceMeta } from "./lib/store";

type Props = {
  spaces: SpaceMeta[];
  activeId: string | null;
  onSwitch: (id: string) => void;
  onCreate: (name: string) => void;
  onRename: (id: string, name: string) => void;
  onDelete: (id: string) => void;
};

/**
 * Compact group (space) switcher for the header. Each group owns its own set
 * of tabs / working directories; switching swaps the whole tab strip.
 */
export function GroupSwitcher({
  spaces,
  activeId,
  onSwitch,
  onCreate,
  onRename,
  onDelete,
}: Props) {
  const [open, setOpen] = useState(false);
  const [creating, setCreating] = useState(false);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [draft, setDraft] = useState("");

  const active = spaces.find((s) => s.id === activeId);
  const label = active?.name ?? "Group";

  const startCreate = () => {
    setDraft(`Group ${spaces.length + 1}`);
    setCreating(true);
    setRenamingId(null);
  };

  const startRename = (space: SpaceMeta) => {
    setDraft(space.name);
    setRenamingId(space.id);
    setCreating(false);
  };

  const commit = () => {
    const name = draft.trim();
    if (name) {
      if (creating) onCreate(name);
      else if (renamingId) onRename(renamingId, name);
    }
    setCreating(false);
    setRenamingId(null);
    setDraft("");
  };

  const cancel = () => {
    setCreating(false);
    setRenamingId(null);
    setDraft("");
  };

  return (
    <DropdownMenu open={open} onOpenChange={setOpen}>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="sm"
          className="h-7 shrink-0 gap-1 rounded-md px-1.5 text-[11px] text-muted-foreground hover:bg-accent hover:text-foreground"
          title="Switch group"
        >
          <HugeiconsIcon
            icon={DashboardSquare01Icon}
            size={13}
            strokeWidth={1.75}
          />
          <span className="max-w-24 truncate">{label}</span>
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
        className="max-h-80 w-64 overflow-y-auto rounded-xl border border-border/40 bg-popover/90 p-1 backdrop-blur-md shadow-lg"
      >
        <DropdownMenuLabel className="px-2 py-1.5 text-[10.5px] text-muted-foreground">
          Groups ({spaces.length})
        </DropdownMenuLabel>
        <DropdownMenuSeparator className="my-0.5 border-t border-border/30" />

        {spaces.map((space) => {
          const isActive = space.id === activeId;
          if (renamingId === space.id) {
            return (
              <div key={space.id} className="px-1.5 py-1">
                <input
                  autoFocus
                  value={draft}
                  onChange={(e) => setDraft(e.target.value)}
                  onKeyDown={(e) => {
                    e.stopPropagation();
                    if (e.key === "Enter") commit();
                    else if (e.key === "Escape") cancel();
                  }}
                  onBlur={commit}
                  className="w-full rounded border border-border bg-background px-1.5 py-1 text-xs outline-none focus:ring-1 focus:ring-ring"
                />
              </div>
            );
          }
          return (
            <DropdownMenuItem
              key={space.id}
              onSelect={(e) => {
                e.preventDefault();
                onSwitch(space.id);
                setOpen(false);
              }}
              className={cn(
                "group/item flex items-center gap-2 rounded-lg px-2 py-1.5 text-xs cursor-default",
                isActive && "bg-accent text-accent-foreground",
              )}
            >
              <span className="min-w-0 flex-1 truncate">{space.name}</span>
              {isActive && (
                <HugeiconsIcon
                  icon={Tick02Icon}
                  size={12}
                  strokeWidth={2}
                  className="shrink-0 text-primary"
                />
              )}
              <span
                role="button"
                title="Rename"
                onClick={(e) => {
                  e.stopPropagation();
                  startRename(space);
                }}
                className="shrink-0 rounded p-0.5 opacity-0 hover:bg-foreground/10 group-hover/item:opacity-60"
              >
                <HugeiconsIcon
                  icon={PencilEdit02Icon}
                  size={11}
                  strokeWidth={1.9}
                />
              </span>
              {spaces.length > 1 && (
                <span
                  role="button"
                  title="Delete group"
                  onClick={(e) => {
                    e.stopPropagation();
                    onDelete(space.id);
                  }}
                  className="shrink-0 rounded p-0.5 opacity-0 hover:bg-destructive/15 hover:text-destructive group-hover/item:opacity-60"
                >
                  <HugeiconsIcon icon={Delete02Icon} size={11} strokeWidth={1.9} />
                </span>
              )}
            </DropdownMenuItem>
          );
        })}

        <DropdownMenuSeparator className="my-0.5 border-t border-border/30" />

        {creating ? (
          <div className="px-1.5 py-1">
            <input
              autoFocus
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                e.stopPropagation();
                if (e.key === "Enter") commit();
                else if (e.key === "Escape") cancel();
              }}
              onBlur={commit}
              placeholder="Group name"
              className="w-full rounded border border-border bg-background px-1.5 py-1 text-xs outline-none focus:ring-1 focus:ring-ring"
            />
          </div>
        ) : (
          <DropdownMenuItem
            onSelect={(e) => {
              e.preventDefault();
              startCreate();
            }}
            className="flex items-center gap-2 rounded-lg px-2 py-1.5 text-xs text-muted-foreground cursor-default hover:text-foreground"
          >
            <HugeiconsIcon icon={Add01Icon} size={12} strokeWidth={2} />
            <span>New group</span>
          </DropdownMenuItem>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
