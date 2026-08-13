import { cn } from "@/lib/utils";
import type { MarkdownTab, Tab } from "@/modules/tabs";
import { useEffect, useRef } from "react";
import {
  type MarkdownPreviewHandle,
  MarkdownPreviewPane,
} from "./MarkdownPreviewPane";

type Props = {
  tabs: Tab[];
  activeId: number;
  onSetMarkdownView: (id: number, mode: "rendered" | "raw") => void;
  registerHandle?: (id: number, handle: MarkdownPreviewHandle | null) => void;
};

export function MarkdownStack({
  tabs,
  activeId,
  onSetMarkdownView,
  registerHandle,
}: Props) {
  const markdowns = tabs.filter(
    (t): t is MarkdownTab => t.kind === "markdown" && !t.cold,
  );

  // Same reasoning as EditorStack: an inline arrow in `ref` changes identity
  // every render, which makes React detach and reattach the handle each time.
  const registerRef = useRef(registerHandle);
  registerRef.current = registerHandle;
  const refCallbacks = useRef(
    new Map<number, (h: MarkdownPreviewHandle | null) => void>(),
  );
  const getRefCallback = (id: number) => {
    let cb = refCallbacks.current.get(id);
    if (!cb) {
      cb = (h: MarkdownPreviewHandle | null) => registerRef.current?.(id, h);
      refCallbacks.current.set(id, cb);
    }
    return cb;
  };

  useEffect(() => {
    const live = new Set(markdowns.map((t) => t.id));
    for (const id of refCallbacks.current.keys()) {
      if (!live.has(id)) refCallbacks.current.delete(id);
    }
  }, [markdowns]);

  if (markdowns.length === 0) return null;
  return (
    <div className="relative h-full w-full">
      {markdowns.map((t) => {
        const visible = t.id === activeId;
        return (
          <div
            key={t.id}
            className={cn(
              "absolute inset-0",
              !visible && "invisible pointer-events-none",
            )}
            aria-hidden={!visible}
          >
            <MarkdownPreviewPane
              ref={getRefCallback(t.id)}
              path={t.path}
              visible={visible}
              onSetView={(mode) => onSetMarkdownView(t.id, mode)}
            />
          </div>
        );
      })}
    </div>
  );
}
