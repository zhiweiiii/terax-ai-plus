import { CommandLineIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useEffect } from "react";

const W = 170;
const OFFSET = 32;

type Props = {
  x: number;
  y: number;
  onSend: () => void;
  onDismiss: () => void;
};

export function SelectionAskButton({ x, y, onSend, onDismiss }: Props) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onDismiss();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onDismiss]);

  const pos = {
    top: Math.max(8, Math.min(y - OFFSET, window.innerHeight - 36)),
    left: Math.max(8, Math.min(x - W / 2, window.innerWidth - W - 8)),
  };

  return (
    <div
      data-selection-ask
      style={{ top: pos.top, left: pos.left, width: W }}
      className="fixed z-50"
    >
      <button
        type="button"
        title="把选中内容发送到 agent"
        onMouseDown={(e) => e.preventDefault()}
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
