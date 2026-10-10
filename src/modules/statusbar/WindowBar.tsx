import { cn } from "@/lib/utils";
import { fileIconUrl } from "@/modules/explorer/lib/iconResolver";
import { labelFor } from "@/modules/tabs/lib/tabLabel";
import type { Tab, TerminalTab } from "@/modules/tabs/lib/useTabs";
import {
  overflowWindowIds,
  scopedWindowTabs,
} from "@/modules/statusbar/lib/windowTabs";
import {
  Cancel01Icon,
  ComputerTerminal02Icon,
  Globe02Icon,
  GitCompareIcon,
  HistoryIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useEffect, useMemo, useRef, useState } from "react";

type Props = {
  tabs: Tab[];
  spaceId: string;
  project: TerminalTab | null;
  activeId: number;
  onSelect: (id: number) => void;
  onClose: (id: number) => void;
  onOverflow: (spaceId: string, ownerId: number | null, ids: number[]) => void;
};

const WINDOW_WIDTH = 128;
const GAP = 4;

export function WindowBar({
  tabs,
  spaceId,
  project,
  activeId,
  onSelect,
  onClose,
  onOverflow,
}: Props) {
  const containerRef = useRef<HTMLElement>(null);
  const projectRef = useRef<HTMLButtonElement>(null);
  const visibleWindowRef = useRef<HTMLButtonElement>(null);
  const [capacity, setCapacity] = useState<number | null>(null);
  const ownerId = project?.id ?? null;
  const windows = useMemo(
    () => scopedWindowTabs(tabs, spaceId, ownerId),
    [tabs, spaceId, ownerId],
  );
  const overflow = useMemo(
    () =>
      capacity === null ? [] : overflowWindowIds(windows, capacity, activeId),
    [windows, capacity, activeId],
  );
  const visibleWindowId = windows.some((tab) => tab.id === activeId)
    ? activeId
    : windows[windows.length - 1]?.id;

  useEffect(() => {
    const element = containerRef.current;
    if (!element) return;
    const measure = () => {
      if (element.clientWidth <= 0) return;
      const available =
        element.clientWidth - (projectRef.current?.offsetWidth ?? 0) - GAP;
      setCapacity(
        Math.max(1, Math.floor((available + GAP) / (WINDOW_WIDTH + GAP))),
      );
    };
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    measure();
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (overflow.length) onOverflow(spaceId, ownerId, overflow);
  }, [overflow, spaceId, ownerId, onOverflow]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: Selection, eviction and resize change the scroll target's layout.
  useEffect(() => {
    visibleWindowRef.current?.scrollIntoView({
      block: "nearest",
      inline: "nearest",
    });
  }, [visibleWindowId, windows.length, capacity]);

  return (
    <nav
      ref={containerRef}
      className="flex w-full min-w-0 items-center gap-1"
      aria-label="项目窗口栏"
    >
      <button
        ref={projectRef}
        type="button"
        disabled={!project}
        onClick={() => project && onSelect(project.id)}
        aria-current={activeId === project?.id ? "page" : undefined}
        title={
          project
            ? `返回项目 ${labelFor(project)}\n${project.cwd ?? ""}`
            : "当前项目"
        }
        className={cn(
          "flex h-7 w-28 shrink-0 items-center gap-1 rounded-md px-1.5 text-[11px] outline-none hover:bg-accent focus-visible:ring-1 focus-visible:ring-ring disabled:opacity-50",
          activeId === project?.id
            ? "bg-accent text-foreground"
            : "text-muted-foreground",
        )}
      >
        <HugeiconsIcon icon={ComputerTerminal02Icon} size={12} />
        <span className="truncate">
          {project ? labelFor(project) : "当前项目"}
        </span>
      </button>
      <div className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto [scrollbar-width:thin]">
        {windows.map((tab) => (
          <div
            key={tab.id}
            className={cn(
              "group flex h-7 w-32 shrink-0 items-center rounded-md px-1 text-[11px]",
              activeId === tab.id
                ? "bg-accent text-foreground"
                : "text-muted-foreground hover:bg-accent/60",
            )}
          >
            <button
              ref={tab.id === visibleWindowId ? visibleWindowRef : undefined}
              type="button"
              onClick={() => onSelect(tab.id)}
              aria-current={activeId === tab.id ? "page" : undefined}
              title={"path" in tab ? tab.path : labelFor(tab)}
              className="flex h-full min-w-0 flex-1 items-center gap-1 outline-none focus-visible:ring-1 focus-visible:ring-ring"
            >
              {tab.kind === "editor" || tab.kind === "markdown" ? (
                <img
                  src={fileIconUrl(labelFor(tab))}
                  alt=""
                  className="size-3 shrink-0"
                />
              ) : (
                <HugeiconsIcon
                  icon={
                    tab.kind === "preview"
                      ? Globe02Icon
                      : tab.kind === "git-history"
                        ? HistoryIcon
                        : GitCompareIcon
                  }
                  size={12}
                />
              )}
              <span className="truncate">{labelFor(tab)}</span>
              {tab.kind === "editor" && tab.dirty ? (
                <span
                  role="img"
                  aria-label="未保存"
                  className="size-1 shrink-0 rounded-full bg-foreground"
                />
              ) : null}
            </button>
            <button
              type="button"
              aria-label={`关闭窗口 ${labelFor(tab)}`}
              onClick={() => onClose(tab.id)}
              className="shrink-0 rounded p-0.5 text-muted-foreground hover:bg-foreground/10 focus-visible:ring-1 focus-visible:ring-ring"
            >
              <HugeiconsIcon icon={Cancel01Icon} size={10} />
            </button>
          </div>
        ))}
      </div>
    </nav>
  );
}
