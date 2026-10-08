import { useCallback, useEffect, useState } from "react";

type Params = {
  captureActiveSelection: () => string | null;
  onSend: (leafId?: number) => void;
};

export function useSelectionAsk({ captureActiveSelection, onSend }: Params) {
  const [popup, setPopup] = useState<{ x: number; y: number } | null>(null);

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const cancelPending = () => {
      if (timer !== undefined) clearTimeout(timer);
      timer = undefined;
    };
    const isInsideButton = (target: EventTarget | null) =>
      target instanceof Element && !!target.closest("[data-selection-ask]");

    setPopup(null);

    const onDown = (e: MouseEvent) => {
      if (isInsideButton(e.target)) return;
      cancelPending();
      setPopup(null);
    };
    const onUp = (e: MouseEvent) => {
      if (isInsideButton(e.target)) return;
      cancelPending();
      if (e.button !== 0 || !(e.target instanceof Element)) return;
      const el = e.target;
      // Terminal grid, CodeMirror editor, or rendered markdown preview.
      const inContentArea = el?.closest?.(
        ".xterm, .cm-editor, .markdown-preview",
      );
      if (!inContentArea) return;
      // Defer one tick so xterm/CodeMirror finalize the selection.
      timer = setTimeout(() => {
        timer = undefined;
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
      cancelPending();
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
