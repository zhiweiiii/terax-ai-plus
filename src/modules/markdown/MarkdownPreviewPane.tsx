import { MarkdownCode } from "@/components/ai-elements/markdown-code";
import { cn } from "@/lib/utils";
import { currentWorkspaceEnv } from "@/modules/workspace";
import { invoke } from "@tauri-apps/api/core";
import type { ComponentProps } from "react";
import { useEffect, useMemo, useRef, useState } from "react";
import { Streamdown } from "streamdown";
import { MarkdownLink } from "./MarkdownLink";
import { MarkdownViewToggle } from "./MarkdownViewToggle";

type ReadResult =
  | { kind: "text"; content: string; size: number }
  | { kind: "binary"; size: number }
  | { kind: "toolarge"; size: number; limit: number };

type Status =
  | { kind: "loading" }
  | { kind: "ready"; content: string }
  | { kind: "binary" }
  | { kind: "toolarge"; size: number; limit: number }
  | { kind: "error"; message: string };

type Props = {
  path: string;
  visible: boolean;
  onSetView: (mode: "rendered" | "raw") => void;
  /** Opens a project file from a relative markdown link. */
  onOpenPath: (path: string) => void;
};

function dirname(path: string): string {
  const sep = path.lastIndexOf("\\");
  const slash = path.lastIndexOf("/");
  const cut = Math.max(sep, slash);
  return cut <= 0 ? "" : path.slice(0, cut);
}

export function MarkdownPreviewPane({
  path,
  visible,
  onSetView,
  onOpenPath,
}: Props) {
  const [status, setStatus] = useState<Status>({ kind: "loading" });
  const contentRef = useRef<HTMLDivElement>(null);
  const baseDir = useMemo(() => dirname(path), [path]);

  // Components close over baseDir/onOpenPath so relative markdown links can
  // resolve to project files; Streamdown passes only intrinsic element props.
  const componentsWithPaths = useMemo(
    () => ({
      a: (props: ComponentProps<typeof MarkdownLink>) => (
        <MarkdownLink {...props} baseDir={baseDir} onOpenPath={onOpenPath} />
      ),
      code: MarkdownCode,
    }),
    [baseDir, onOpenPath],
  );

  useEffect(() => {
    let cancelled = false;
    setStatus({ kind: "loading" });
    invoke<ReadResult>("fs_read_file", {
      path,
      workspace: currentWorkspaceEnv(),
    })
      .then((res) => {
        if (cancelled) return;
        if (res.kind === "text") {
          setStatus({ kind: "ready", content: res.content });
        } else if (res.kind === "binary") {
          setStatus({ kind: "binary" });
        } else {
          setStatus({ kind: "toolarge", size: res.size, limit: res.limit });
        }
      })
      .catch((e) => {
        if (!cancelled) setStatus({ kind: "error", message: String(e) });
      });
    return () => {
      cancelled = true;
    };
  }, [path]);

  return (
    <div
      className={cn(
        "relative flex h-full w-full flex-col overflow-hidden rounded-md border border-border/60 bg-background",
        !visible && "pointer-events-none",
      )}
    >
      <MarkdownViewToggle mode="rendered" onChange={onSetView} />
      <div className="markdown-preview flex-1 overflow-auto">
        <div className="px-8 py-6" ref={contentRef}>
          {status.kind === "loading" && (
            <p className="text-[12px] text-muted-foreground">Loading…</p>
          )}
          {status.kind === "error" && (
            <p className="text-[12px] text-destructive">
              Failed to read file: {status.message}
            </p>
          )}
          {status.kind === "binary" && (
            <p className="text-[12px] text-muted-foreground">
              Binary file — cannot render as markdown.
            </p>
          )}
          {status.kind === "toolarge" && (
            <p className="text-[12px] text-muted-foreground">
              File is {status.size} bytes; limit {status.limit}.
            </p>
          )}
          {status.kind === "ready" && (
            <Streamdown
              className="select-text [&>*:first-child]:mt-0 [&>*:last-child]:mb-0"
              components={componentsWithPaths}
              mode="static"
              parseIncompleteMarkdown={false}
            >
              {status.content}
            </Streamdown>
          )}
        </div>
      </div>
    </div>
  );
}
