import { cn } from "@/lib/utils";
import { useEffect, useMemo, useRef } from "react";
import { labelFor } from "./lib/tabLabel";
import type { TabSwitcherState } from "./lib/useTabSwitcher";
import type { Tab } from "./lib/useTabs";
import { TabIcon } from "./TabBar";

function subtitleFor(tab: Tab): string | null {
  if (tab.kind === "terminal")
    return tab.cwd
      ? tab.cwd.split(/[\\/]/).filter(Boolean).slice(-2).join("/") || tab.cwd
      : null;
  if (tab.kind === "editor" || tab.kind === "markdown")
    return tab.path.split(/[\\/]/).filter(Boolean).slice(-2, -1)[0] ?? null;
  return null;
}

export function TabSwitcherHud({
  tabs,
  state,
}: {
  tabs: Tab[];
  state: TabSwitcherState;
}) {
  const byId = useMemo(() => new Map(tabs.map((t) => [t.id, t])), [tabs]);
  const rows = state.order
    .map((id) => byId.get(id))
    .filter((t): t is Tab => t !== undefined);
  const selectedId = state.order[state.index];
  const selectedTab = selectedId === undefined ? undefined : byId.get(selectedId);
  const listRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    listRef.current
      ?.querySelector<HTMLElement>(`[data-tab-id="${selectedId}"]`)
      ?.scrollIntoView({ block: "nearest" });
  }, [selectedId]);

  return (
    <div
      role="status"
      aria-live="polite"
      className="pointer-events-none fixed inset-0 z-[100] flex items-center justify-center"
    >
      <span className="sr-only">
        {selectedTab ? labelFor(selectedTab) : ""}
      </span>
      <div
        ref={listRef}
        aria-hidden
        className="flex max-h-[60vh] w-72 max-w-[calc(100vw-2rem)] flex-col gap-0.5 overflow-y-auto rounded-2xl border border-border bg-popover/95 p-1.5 shadow-2xl ring-1 ring-foreground/5 backdrop-blur-md"
      >
        {rows.map((t) => {
          const subtitle = subtitleFor(t);
          return (
            <div
              key={t.id}
              data-tab-id={t.id}
              className={cn(
                "flex items-center gap-2 rounded-xl px-2.5 py-1.5 text-xs",
                t.id === selectedId
                  ? "bg-accent text-foreground"
                  : "text-muted-foreground",
              )}
            >
              <TabIcon tab={t} />
              <span className="min-w-0 flex-1 truncate">{labelFor(t)}</span>
              {subtitle && (
                <span className="max-w-24 shrink-0 truncate text-[10px] text-muted-foreground/55">
                  {subtitle}
                </span>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
