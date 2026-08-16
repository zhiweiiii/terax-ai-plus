import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { CommandLineIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useEffect, useRef, useState } from "react";

const W = 170;
const OFFSET = 32;

export type AgentTarget = {
  leafId: number;
  agent: string;
  cwd: string | null;
};

type Props = {
  x: number;
  y: number;
  /** Running agent terminals; when several exist the user picks the target. */
  targets?: AgentTarget[];
  onSend: (leafId?: number) => void;
  onDismiss: () => void;
};

function shortCwd(cwd: string | null): string | null {
  if (!cwd) return null;
  const segs = cwd.split(/[\\/]/).filter(Boolean);
  return segs.length > 0 ? segs.slice(-2).join("/") : cwd;
}

/**
 * Floating button shown after selecting text in the editor/terminal. Clicking
 * it sends the selection to the command line — to the active agent terminal,
 * or (with several agents open) to the one picked from a small list. Always
 * shown for a non-empty selection, regardless of whether a Claude Code /
 * opencode terminal exists.
 */
export function SelectionAskButton({ x, y, targets, onSend, onDismiss }: Props) {
  const pos = useRef({ top: 0, left: 0 });
  const [open, setOpen] = useState(false);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onDismiss();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onDismiss]);

  pos.current = {
    top: Math.max(8, y - OFFSET),
    left: Math.max(8, Math.min(x - W / 2, window.innerWidth - W - 8)),
  };

  const agents = targets ?? [];
  const multi = agents.length > 1;

  return (
    <div
      data-selection-ask
      style={{ top: pos.current.top, left: pos.current.left, width: W }}
      className="fixed z-50"
    >
      <DropdownMenu open={open} onOpenChange={setOpen}>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            title="把选中内容发送到命令行"
            onClick={(e) => {
              e.stopPropagation();
              if (multi) return; // let the menu open for target picking
              onSend(agents[0]?.leafId);
            }}
            className="flex h-7 w-full items-center justify-between gap-1.5 rounded-md border border-border/60 bg-card/95 px-2 text-xs shadow-lg backdrop-blur-md hover:border-border hover:bg-accent"
          >
            <span className="min-w-0 flex-1 truncate whitespace-nowrap text-left">
              {multi ? "发送到 agent…" : "发送到命令行"}
            </span>
            <HugeiconsIcon
              icon={CommandLineIcon}
              size={12}
              strokeWidth={1.75}
              className="shrink-0 text-primary/80"
            />
          </button>
        </DropdownMenuTrigger>
        {multi && (
          <DropdownMenuContent
            align="start"
            side="top"
            sideOffset={6}
            className="max-h-72 w-56 overflow-y-auto"
            onCloseAutoFocus={(e) => e.preventDefault()}
            onPointerDown={(e) => e.stopPropagation()}
            onPointerUp={(e) => e.stopPropagation()}
          >
            <DropdownMenuLabel className="px-2 py-1 text-[10.5px] text-muted-foreground">
              Send to agent
            </DropdownMenuLabel>
            <DropdownMenuSeparator className="my-0.5 border-t border-border/30" />
            {agents.map((t) => {
              const cwd = shortCwd(t.cwd);
              return (
                <DropdownMenuItem
                  key={t.leafId}
                  onSelect={() => onSend(t.leafId)}
                  className="flex flex-col items-start gap-0.5 px-2.5 py-1.5"
                >
                  <span className="text-xs font-medium">{t.agent}</span>
                  {cwd && (
                    <span className="truncate text-[10px] text-muted-foreground/60">
                      {cwd}
                    </span>
                  )}
                </DropdownMenuItem>
              );
            })}
          </DropdownMenuContent>
        )}
      </DropdownMenu>
    </div>
  );
}
