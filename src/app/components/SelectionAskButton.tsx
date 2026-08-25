import { CommandLineIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useEffect, useRef } from "react";

const W = 170;
const OFFSET = 32;

type Props = {
  x: number;
  y: number;
  onSend: () => void;
  onDismiss: () => void;
};

/**
 * Floating button shown after selecting text in the editor/terminal. Clicking
 * it sends the selection to the command line — the terminal whose working
 * directory contains the file (see `findClaudeLeaf`), whatever is running
 * there. Always shown for a non-empty selection, regardless of whether a
 * Claude Code / opencode terminal exists.
 */
export function SelectionAskButton({ x, y, onSend, onDismiss }: Props) {
  const pos = useRef({ top: 0, left: 0 });

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

  return (
    <div
      data-selection-ask
      style={{ top: pos.current.top, left: pos.current.left, width: W }}
      className="fixed z-50"
    >
      <button
        type="button"
        title="把选中内容发送到 agent"
        onClick={(e) => {
          e.stopPropagation();
          onSend();
        }}
        className="flex h-7 w-full items-center justify-between gap-1.5 rounded-md border border-border/60 bg-card/95 px-2 text-xs shadow-lg backdrop-blur-md hover:border-border hover:bg-accent"
      >
        <span className="min-w-0 flex-1 truncate whitespace-nowrap text-left">
          发送到 agent
        </span>
        <HugeiconsIcon
          icon={CommandLineIcon}
          size={12}
          strokeWidth={1.75}
          className="shrink-0 text-primary/80"
        />
      </button>
    </div>
  );
}
