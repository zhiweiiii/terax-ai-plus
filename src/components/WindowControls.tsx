import { USE_CUSTOM_WINDOW_CONTROLS } from "@/lib/platform";
import { cn } from "@/lib/utils";
import { errorToast } from "@/lib/errorToast";
import {
  Cancel01Icon,
  Copy01Icon,
  MinusSignIcon,
  SquareIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { useEffect, useState } from "react";

type Props = {
  /** Render only the close button (used by the settings window). */
  closeOnly?: boolean;
};

export function WindowControls({ closeOnly = false }: Props) {
  const [maximized, setMaximized] = useState(false);

  useEffect(() => {
    if (!USE_CUSTOM_WINDOW_CONTROLS || closeOnly) return;
    const w = getCurrentWindow();
    let alive = true;
    let request = 0;
    let unlisten: (() => void) | undefined;
    const refresh = () => {
      if (!alive) return;
      const current = ++request;
      void w
        .isMaximized()
        .then((value) => {
          if (alive && current === request) setMaximized(value);
        })
        .catch((error) =>
          console.error("[terax] window state query failed:", error),
        );
    };
    refresh();
    void w
      .onResized(refresh)
      .then((un) => {
        if (!alive) un();
        else unlisten = un;
      })
      .catch((error) =>
        console.error("[terax] window resize listener failed:", error),
      );
    return () => {
      alive = false;
      request++;
      unlisten?.();
    };
  }, [closeOnly]);

  if (!USE_CUSTOM_WINDOW_CONTROLS) return null;

  const w = getCurrentWindow();

  return (
    <div className="flex h-full shrink-0 items-center gap-0.5 pr-1">
      {!closeOnly && (
        <>
          <CtlButton
            ariaLabel="Minimize"
            onClick={() =>
              void w
                .minimize()
                .catch((error) =>
                  errorToast("Could not minimize window", error),
                )
            }
          >
            <HugeiconsIcon icon={MinusSignIcon} size={12} strokeWidth={2} />
          </CtlButton>
          <CtlButton
            ariaLabel={maximized ? "Restore" : "Maximize"}
            onClick={() =>
              void w
                .toggleMaximize()
                .catch((error) => errorToast("Could not resize window", error))
            }
          >
            <HugeiconsIcon
              icon={maximized ? Copy01Icon : SquareIcon}
              size={12}
              strokeWidth={2}
            />
          </CtlButton>
        </>
      )}
      <CtlButton
        ariaLabel="Close"
        onClick={() =>
          void w
            .close()
            .catch((error) => errorToast("Could not close window", error))
        }
        danger
      >
        <HugeiconsIcon icon={Cancel01Icon} size={14} strokeWidth={2} />
      </CtlButton>
    </div>
  );
}

function CtlButton({
  ariaLabel,
  onClick,
  children,
  danger,
}: {
  ariaLabel: string;
  onClick: () => void;
  children: React.ReactNode;
  danger?: boolean;
}) {
  return (
    <button
      type="button"
      aria-label={ariaLabel}
      title={ariaLabel}
      onClick={onClick}
      className={cn(
        "grid size-7 place-items-center rounded-md text-muted-foreground transition-colors",
        danger
          ? "hover:bg-destructive/15 hover:text-destructive"
          : "hover:bg-accent hover:text-foreground",
      )}
    >
      {children}
    </button>
  );
}
