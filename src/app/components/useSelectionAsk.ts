import { useCallback, useEffect, useState } from "react";

type Params = {
  captureActiveSelection: () => string | null;
  onSend: (leafId?: number) => void;
};

/**
 * Tracks text selections inside the terminal / editor and surfaces the
 * "send to command line" button at the pointer. The button is always shown
 * when there is a non-empty selection, regardless of whether a Claude Code
 * or opencode terminal is running. Dismisses on any click outside the button.
 */
export function useSelectionAsk({ captureActiveSelection, onSend }: Params) {
  const [popup, setPopup] = useState<{ x: number; y: number } | null>(null);

  useEffect(() => {
    const isInsideButton = (t: EventTarget | null) => {
      const el = t as HTMLElement | null;
      if (!el) return false;
      return !!el.closest("[data-selection-ask]");
    };

    const onDown = (e: MouseEvent) => {
      if (isInsideButton(e.target)) return;
      setPopup(null);
    };
    const onUp = (e: MouseEvent) => {
      if (isInsideButton(e.target)) return;
      const el = e.target as HTMLElement | null;
      // Terminal grid, CodeMirror editor, or rendered markdown preview.
      const inContentArea = el?.closest?.(
        ".xterm, .cm-editor, .markdown-preview",
      );
      if (!inContentArea) return;
      // Defer one tick so xterm/CodeMirror finalize the selection.
      setTimeout(() => {
        const text = captureActiveSelection();
        if (text && text.trim().length > 0) {
          setPopup({ x: e.clientX, y: e.clientY });
        } else {
          setPopup(null);
        }
      }, 0);
    };

    document.addEventListener("mousedown", onDown);
    document.addEventListener("mouseup", onUp);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("mouseup", onUp);
    };
  }, [captureActiveSelection]);

  const send = useCallback(
    (leafId?: number) => {
      onSend(leafId);
      setPopup(null);
    },
    [onSend],
  );

  return { popup, setPopup, send };
}
