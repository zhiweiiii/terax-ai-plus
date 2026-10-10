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
import { ProjectList } from "@/modules/spaces/ProjectList";
import type { TerminalTab } from "@/modules/tabs/lib/useTabs";
import {
  Add01Icon,
  ArrowDown01Icon,
  Delete02Icon,
  DashboardSquare01Icon,
  PencilEdit02Icon,
  Tick02Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useCallback, useMemo, useRef, useState } from "react";
import type { SpaceMeta } from "./lib/store";

type Props = {
  spaces: SpaceMeta[];
  projects: TerminalTab[];
  activeProjectId: number | null;
  runningProjectIds: ReadonlySet<number>;
  onSelectProject: (tab: TerminalTab) => void;
  onRenameProject: (id: number, name: string) => void;
  onCloseProject: (id: number) => void;
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
  projects,
  activeProjectId,
  runningProjectIds,
  onSelectProject,
  onRenameProject,
  onCloseProject,
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
  const [projectSpaceId, setProjectSpaceId] = useState<string | null>(null);
  const editing = useRef(false);
  const selectedProject = useRef(false);
  const focusInput = useCallback((input: HTMLInputElement | null) => {
    input?.focus();
  }, []);

  const active = spaces.find((s) => s.id === activeId);
  const label = active?.name ?? "Group";
  const projectSpace = spaces.find((space) => space.id === projectSpaceId);
  const projectsBySpace = useMemo(() => {
    const grouped = new Map<string, TerminalTab[]>();
    for (const project of projects) {
      const list = grouped.get(project.spaceId);
      if (list) list.push(project);
      else grouped.set(project.spaceId, [project]);
    }
    return grouped;
  }, [projects]);

  const startCreate = () => {
    editing.current = true;
    setDraft(`Group ${spaces.length + 1}`);
    setCreating(true);
    setRenamingId(null);
  };

  const startRename = (space: SpaceMeta) => {
    editing.current = true;
    setDraft(space.name);
    setRenamingId(space.id);
    setCreating(false);
  };

  const commit = () => {
    if (!editing.current) return;
    editing.current = false;
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
    editing.current = false;
    setCreating(false);
    setRenamingId(null);
    setDraft("");
  };

  return (
    <DropdownMenu
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (next) selectedProject.current = false;
        if (!next) setProjectSpaceId(null);
      }}
    >
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="sm"
          className="h-7 shrink-0 gap-1 rounded-md px-1.5 text-[11px] text-muted-foreground hover:bg-accent hover:text-foreground"
          title="分组与项目"
          aria-label="分组与项目"
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
        onCloseAutoFocus={(event) => {
          if (selectedProject.current) event.preventDefault();
        }}
      >
        {projectSpace ? (
          <>
            <DropdownMenuItem
              onSelect={(event) => {
                event.preventDefault();
                setProjectSpaceId(null);
              }}
              className="text-xs text-muted-foreground"
            >
              返回分组
            </DropdownMenuItem>
            <DropdownMenuLabel className="truncate text-xs">
              {projectSpace.name} / 项目
            </DropdownMenuLabel>
            <DropdownMenuItem
              onSelect={() => {
                selectedProject.current = true;
                onSwitch(projectSpace.id);
                setOpen(false);
                setProjectSpaceId(null);
              }}
              className="text-xs"
            >
              进入此分组
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <ProjectList
              projects={projectsBySpace.get(projectSpace.id) ?? []}
              activeId={activeProjectId}
              runningIds={runningProjectIds}
              onSelect={(project) => {
                selectedProject.current = true;
                onSelectProject(project);
                setOpen(false);
                setProjectSpaceId(null);
              }}
              onRename={onRenameProject}
              onClose={onCloseProject}
            />
          </>
        ) : (
          <>
            <DropdownMenuLabel className="px-2 py-1.5 text-[10.5px] text-muted-foreground">
              分组 ({spaces.length})
            </DropdownMenuLabel>
            <DropdownMenuSeparator className="my-0.5 border-t border-border/30" />

            {spaces.map((space) => {
              const isActive = space.id === activeId;
              if (renamingId === space.id) {
                return (
                  <div key={space.id} className="px-1.5 py-1">
                    <input
                      ref={focusInput}
                      aria-label="Group name"
                      value={draft}
                      onChange={(e) => setDraft(e.target.value)}
                      onKeyDown={(e) => {
                        e.stopPropagation();
                        if (
                          e.nativeEvent.isComposing ||
                          e.nativeEvent.keyCode === 229
                        )
                          return;
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
                    setProjectSpaceId(space.id);
                  }}
                  className={cn(
                    "group/item flex items-center gap-2 rounded-lg px-2 py-1.5 text-xs cursor-default",
                    isActive && "bg-accent text-accent-foreground",
                  )}
                >
                  <span className="min-w-0 flex-1 truncate">{space.name}</span>
                  <span className="shrink-0 text-[10px] text-muted-foreground">
                    {projectsBySpace.get(space.id)?.length ?? 0} 项目
                  </span>
                  {isActive && (
                    <HugeiconsIcon
                      icon={Tick02Icon}
                      size={12}
                      strokeWidth={2}
                      className="shrink-0 text-primary"
                    />
                  )}
                  <button
                    type="button"
                    title="Rename"
                    aria-label={`Rename ${space.name}`}
                    onKeyDown={(e) => e.stopPropagation()}
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
                  </button>
                  {spaces.length > 1 && (
                    <button
                      type="button"
                      title="Delete group"
                      aria-label={`Delete ${space.name}`}
                      onKeyDown={(e) => e.stopPropagation()}
                      onClick={(e) => {
                        e.stopPropagation();
                        onDelete(space.id);
                      }}
                      className="shrink-0 rounded p-0.5 opacity-0 hover:bg-destructive/15 hover:text-destructive group-hover/item:opacity-60"
                    >
                      <HugeiconsIcon
                        icon={Delete02Icon}
                        size={11}
                        strokeWidth={1.9}
                      />
                    </button>
                  )}
                </DropdownMenuItem>
              );
            })}

            <DropdownMenuSeparator className="my-0.5 border-t border-border/30" />

            {creating ? (
              <div className="px-1.5 py-1">
                <input
                  ref={focusInput}
                  aria-label="New group name"
                  value={draft}
                  onChange={(e) => setDraft(e.target.value)}
                  onKeyDown={(e) => {
                    e.stopPropagation();
                    if (
                      e.nativeEvent.isComposing ||
                      e.nativeEvent.keyCode === 229
                    )
                      return;
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
                <span>新建分组</span>
              </DropdownMenuItem>
            )}
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
