import { cn } from "@/lib/utils";
import {
  ComputerTerminal02Icon,
  FolderGitTwoIcon,
  FolderTreeIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import type { SidebarRailTab, SidebarViewId } from "./types";

export const SIDEBAR_RAIL_WIDTH = 48;

type RailItem = {
  id: SidebarRailTab;
  label: string;
  icon: Parameters<typeof HugeiconsIcon>[0]["icon"];
  badge?: number;
};

type Props = {
  activeView: SidebarViewId;
  onSelectView: (view: SidebarViewId) => void;
  onSelectWindow: () => void;
  changedCount: number;
  sidebarOpen: boolean;
};

export function SidebarRail({
  activeView,
  onSelectView,
  onSelectWindow,
  changedCount,
  sidebarOpen,
}: Props) {
  const items: RailItem[] = [
    {
      id: "window",
      label: "窗口",
      icon: ComputerTerminal02Icon,
    },
    {
      id: "explorer",
      label: "文件",
      icon: FolderTreeIcon,
    },
    {
      id: "source-control",
      label: "版本控制",
      icon: FolderGitTwoIcon,
      badge: changedCount,
    },
  ];

  return (
    <div
      style={{ width: SIDEBAR_RAIL_WIDTH }}
      className="flex shrink-0 flex-col items-center gap-1 border-r border-border/50 bg-card/85 py-2 backdrop-blur"
    >
      {items.map((item) => {
        const isWindow = item.id === "window";
        const isActive = isWindow
          ? !sidebarOpen
          : item.id === activeView;
        const showBadge = !!item.badge && item.badge > 0;

        return (
          <button
            key={item.id}
            type="button"
            aria-label={item.label}
            aria-pressed={isActive}
            onClick={() => {
              if (isWindow) onSelectWindow();
              else onSelectView(item.id as SidebarViewId);
            }}
            title={item.label}
            className={cn(
              "group relative flex w-10 cursor-pointer flex-col items-center gap-0.5 rounded-lg py-1.5 outline-none transition-colors duration-[var(--dur-base)]",
              "focus-visible:ring-2 focus-visible:ring-primary/40",
              isActive
                ? "text-foreground"
                : "text-muted-foreground hover:text-foreground",
            )}
          >
            {/* Active indicator — left border bar */}
            <span
              className={cn(
                "absolute left-0 top-1/2 h-5 w-[2px] -translate-y-1/2 rounded-full bg-primary transition-opacity",
                isActive ? "opacity-100" : "opacity-0 group-hover:opacity-30",
              )}
            />
            <HugeiconsIcon
              icon={item.icon}
              size={20}
              strokeWidth={isActive ? 2 : 1.75}
              className="shrink-0 transition-[stroke-width] duration-[var(--dur-base)]"
            />
            <span className="text-[9px] font-medium leading-none">{item.label}</span>
            {showBadge ? (
              <span className="absolute right-0 top-1.5 inline-flex h-3.5 min-w-3.5 items-center justify-center rounded-full bg-primary px-1 text-[8px] font-bold leading-none text-primary-foreground tabular-nums">
                {item.badge! > 99 ? "99+" : item.badge}
              </span>
            ) : null}
          </button>
        );
      })}
    </div>
  );
}
