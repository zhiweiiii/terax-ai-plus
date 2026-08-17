import { MarkdownCode } from "@/components/ai-elements/markdown-code";
import {
  FindBox,
  type FindBoxHandle,
  type FindMatch,
} from "@/components/ui/find-box";
import { cn } from "@/lib/utils";
import { currentWorkspaceEnv } from "@/modules/workspace";
import { invoke } from "@tauri-apps/api/core";
import type { ComponentProps } from "react";
import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from "react";
import { Streamdown } from "streamdown";
import {
  clearMatches,
  type DomMatch,
  findInDom,
  highlightMatches,
  setActiveMatch,
} from "./lib/findInDom";
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

export type MarkdownPreviewPaneHandle = {
  openSearch: () => void;
};

function dirname(path: string): string {
  const sep = path.lastIndexOf("\\");
  const slash = path.lastIndexOf("/");
  const cut = Math.max(sep, slash);
  return cut <= 0 ? "" : path.slice(0, cut);
}

export const MarkdownPreviewPane = forwardRef<MarkdownPreviewPaneHandle, Props>(
  function MarkdownPreviewPane({ path, visible, onSetView, onOpenPath }, ref) {
    const [status, setStatus] = useState<Status>({ kind: "loading" });
    const contentRef = useRef<HTMLDivElement>(null);
    const [findOpen, setFindOpen] = useState(false);
    const [findMatches, setFindMatches] = useState<DomMatch[]>([]);
    const findBoxRef = useRef<FindBoxHandle>(null);
    const marksRef = useRef<HTMLSpanElement[]>([]);
    const baseDir = useMemo(() => dirname(path), [path]);

    const openSearch = useCallback(() => {
      setFindOpen(true);
      requestAnimationFrame(() => findBoxRef.current?.focus());
    }, []);

    useImperativeHandle(ref, () => ({ openSearch }), [openSearch]);

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

    // Drop any find highlights when content re-renders.
    useEffect(() => {
      if (contentRef.current) clearMatches(contentRef.current);
      setFindMatches([]);
    }, [status]);

    const runFind = useCallback((q: string) => {
      const root = contentRef.current;
      if (!root) return;
      const matches = q.trim() ? findInDom(root, q.trim()) : [];
      clearMatches(root);
      marksRef.current =
        matches.length > 0 ? highlightMatches(root, matches) : [];
      setFindMatches(matches);
      if (matches.length > 0) setActiveMatch(root, marksRef.current[0] ?? null);
      else setActiveMatch(root, null);
    }, []);

    const jumpFind = useCallback((i: number) => {
      const root = contentRef.current;
      if (!root) return;
      setActiveMatch(root, marksRef.current[i] ?? null);
    }, []);

    const closeFind = useCallback(() => {
      setFindOpen(false);
      setFindMatches([]);
      if (contentRef.current) {
        clearMatches(contentRef.current);
        marksRef.current = [];
        setActiveMatch(contentRef.current, null);
      }
    }, []);

    const findDropdown: FindMatch[] = findMatches.map((m, i) => ({
      key: `${m.line}:${i}`,
      line: m.line,
      text: m.text,
      hint: `行 ${m.line}`,
    }));

    return (
      <div
        className={cn(
          "relative flex h-full w-full flex-col overflow-hidden rounded-md border border-border/60 bg-background",
          !visible && "pointer-events-none",
        )}
      >
        <MarkdownViewToggle mode="rendered" onChange={onSetView} />
        <div className="markdown-preview relative min-h-0 flex-1 overflow-auto">
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
        {findOpen ? (
          <FindBox
            ref={findBoxRef}
            placeholder="Find in preview"
            matches={findDropdown}
            onSearch={runFind}
            onJump={jumpFind}
            onClose={closeFind}
          />
        ) : null}
      </div>
    );
  },
);
