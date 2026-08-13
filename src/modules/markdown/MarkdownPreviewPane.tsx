import { MarkdownCode } from "@/components/ai-elements/markdown-code";
import { cn } from "@/lib/utils";
import { currentWorkspaceEnv } from "@/modules/workspace";
import { invoke } from "@tauri-apps/api/core";
import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
} from "react";
import { Streamdown } from "streamdown";
import { buildRanges, clearPaint, paint, scrollTo } from "./lib/findInRendered";
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
};

/** Same surface the header's search bar drives on an editor pane. */
export type MarkdownPreviewHandle = {
  setQuery: (q: string) => void;
  findNext: () => void;
  findPrevious: () => void;
  clearQuery: () => void;
  focus: () => void;
};

const components = { a: MarkdownLink, code: MarkdownCode };

export const MarkdownPreviewPane = forwardRef<MarkdownPreviewHandle, Props>(
  function MarkdownPreviewPane({ path, visible, onSetView }, ref) {
    const [status, setStatus] = useState<Status>({ kind: "loading" });
    const contentRef = useRef<HTMLDivElement>(null);
    const rangesRef = useRef<Range[]>([]);
    const indexRef = useRef(0);
    const queryRef = useRef("");

    const runQuery = useCallback((q: string) => {
      queryRef.current = q;
      const root = contentRef.current;
      rangesRef.current = root && q ? buildRanges(root, q) : [];
      indexRef.current = 0;
      if (rangesRef.current.length === 0) {
        clearPaint();
        return;
      }
      paint(rangesRef.current, 0);
      scrollTo(rangesRef.current[0]);
    }, []);

    const step = useCallback((delta: number) => {
      const ranges = rangesRef.current;
      if (ranges.length === 0) return;
      indexRef.current =
        (indexRef.current + delta + ranges.length) % ranges.length;
      paint(ranges, indexRef.current);
      scrollTo(ranges[indexRef.current]);
    }, []);

    useImperativeHandle(
      ref,
      () => ({
        setQuery: runQuery,
        findNext: () => step(1),
        findPrevious: () => step(-1),
        clearQuery: () => {
          queryRef.current = "";
          rangesRef.current = [];
          indexRef.current = 0;
          clearPaint();
        },
        focus: () => contentRef.current?.focus(),
      }),
      [runQuery, step],
    );

    // Ranges point at text nodes the render replaces, so a reload (or the poll
    // picking up an external edit) invalidates them. Re-run against the new DOM.
    // biome-ignore lint/correctness/useExhaustiveDependencies: re-runs on new content
    useEffect(() => {
      if (status.kind !== "ready" || !queryRef.current) return;
      runQuery(queryRef.current);
    }, [status, runQuery]);

    useEffect(() => clearPaint, []);

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
        <div className="flex-1 overflow-auto">
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
                components={components}
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
  },
);
