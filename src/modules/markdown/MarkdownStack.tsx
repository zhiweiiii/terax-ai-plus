import { cn } from "@/lib/utils";
import type { MarkdownTab, Tab } from "@/modules/tabs";
import { useEffect, useRef } from "react";
import {
  MarkdownPreviewPane,
  type MarkdownPreviewPaneHandle,
} from "./MarkdownPreviewPane";

type Props = {
  tabs: Tab[];
  activeId: number;
  registerHandle: (
    id: number,
    handle: MarkdownPreviewPaneHandle | null,
  ) => void;
  onSetMarkdownView: (id: number, mode: "rendered" | "raw") => void;
  /** Opens a project file from a relative markdown link. */
  onOpenPath: (path: string) => void;
};

export function MarkdownStack({
  tabs,
  activeId,
  registerHandle,
  onSetMarkdownView,
  onOpenPath,
}: Props) {
  const markdowns = tabs.filter(
    (t): t is MarkdownTab => t.kind === "markdown" && !t.cold,
  );

  const registerRef = useRef(registerHandle);
  useEffect(() => {
    registerRef.current = registerHandle;
  }, [registerHandle]);

  const refCallbacks = useRef(
    new Map<number, (h: MarkdownPreviewPaneHandle | null) => void>(),
  );

  const getRefCallback = (id: number) => {
    let cb = refCallbacks.current.get(id);
    if (!cb) {
      cb = (h: MarkdownPreviewPaneHandle | null) => registerRef.current(id, h);
      refCallbacks.current.set(id, cb);
    }
    return cb;
  };

  // Drop callback entries for closed tabs to avoid unbounded growth.
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
              onOpenPath={onOpenPath}
            />
          </div>
        );
      })}
    </div>
  );
}
