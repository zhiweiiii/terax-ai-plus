import {
  FindBox,
  type FindBoxHandle,
  type FindMatch,
} from "@/components/FindBox";
import { cn } from "@/lib/utils";
import { useDocument } from "@/modules/editor/lib/useDocument";
import { parentDir } from "@/modules/explorer/lib/watch";
import { ProjectMarkdownCode } from "@/modules/markdown/ProjectMarkdownCode";
import type { WorkspaceEnv } from "@/modules/workspace";
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
import { previewRehypePlugins } from "./lib/previewPlugins";
import { MarkdownLink } from "./MarkdownLink";
import { MarkdownViewToggle } from "./MarkdownViewToggle";
import "@/modules/markdown/markdown-find.css";

type Props = {
  path: string;
  workspace: WorkspaceEnv;
  visible: boolean;
  onSetView: (mode: "rendered" | "raw") => void;
  /** Opens a project file from a relative markdown link. */
  onOpenPath: (path: string) => void;
};

export type MarkdownPreviewPaneHandle = {
  openSearch: () => void;
  reload: () => boolean;
  revalidate: () => void;
};

export const MarkdownPreviewPane = forwardRef<MarkdownPreviewPaneHandle, Props>(
  function MarkdownPreviewPane(
    { path, workspace, visible, onSetView, onOpenPath },
    ref,
  ) {
    const {
      doc: status,
      reload,
      revalidate,
    } = useDocument({ path, workspace });
    const contentRef = useRef<HTMLDivElement>(null);
    const [findOpen, setFindOpen] = useState(false);
    const [findMatches, setFindMatches] = useState<DomMatch[]>([]);
    const findBoxRef = useRef<FindBoxHandle>(null);
    const marksRef = useRef<Range[]>([]);
    const queryRef = useRef("");
    const baseDir = useMemo(() => parentDir(path), [path]);

    const openSearch = useCallback(() => {
      setFindOpen(true);
      requestAnimationFrame(() => findBoxRef.current?.focus());
    }, []);

    useImperativeHandle(
      ref,
      () => ({ openSearch, reload, revalidate: () => void revalidate() }),
      [openSearch, reload, revalidate],
    );

    // Components close over baseDir/onOpenPath so relative markdown links can
    // resolve to project files; Streamdown passes only intrinsic element props.
    const componentsWithPaths = useMemo(
      () => ({
        a: (props: ComponentProps<typeof MarkdownLink>) => (
          <MarkdownLink {...props} baseDir={baseDir} onOpenPath={onOpenPath} />
        ),
        code: ProjectMarkdownCode,
      }),
      [baseDir, onOpenPath],
    );

    const runFind = useCallback((q: string) => {
      queryRef.current = q;
      const root = contentRef.current;
      if (!root) return;
      clearMatches(root);
      const matches = q.trim() ? findInDom(root, q.trim()) : [];
      marksRef.current =
        matches.length > 0 ? highlightMatches(root, matches) : [];
      setFindMatches(matches);
      if (matches.length > 0) setActiveMatch(root, marksRef.current[0] ?? null);
      else setActiveMatch(root, null);
    }, []);

    useEffect(() => {
      const root = contentRef.current;
      if (root) clearMatches(root);
      marksRef.current = [];
      if (status.status === "ready") runFind(queryRef.current);
      else setFindMatches([]);
      return () => {
        if (root) clearMatches(root);
      };
    }, [status, runFind]);

    useEffect(() => {
      const root = contentRef.current;
      if (!findOpen || !root) return;
      let frame: number | null = null;
      let disposed = false;
      const observer = new MutationObserver(() => {
        if (!queryRef.current.trim() || frame !== null) return;
        frame = requestAnimationFrame(() => {
          frame = null;
          if (!disposed) runFind(queryRef.current);
        });
      });
      observer.observe(root, {
        childList: true,
        characterData: true,
        subtree: true,
      });
      return () => {
        disposed = true;
        observer.disconnect();
        if (frame !== null) cancelAnimationFrame(frame);
      };
    }, [findOpen, runFind]);

    const jumpFind = useCallback((i: number) => {
      const root = contentRef.current;
      if (!root) return;
      setActiveMatch(root, marksRef.current[i] ?? null);
    }, []);

    const closeFind = useCallback(() => {
      setFindOpen(false);
      queryRef.current = "";
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
            {status.status === "loading" && (
              <p className="text-[12px] text-muted-foreground">Loading…</p>
            )}
            {status.status === "error" && (
              <p className="text-[12px] text-destructive">
                Failed to read file: {status.message}
              </p>
            )}
            {status.status === "binary" && (
              <p className="text-[12px] text-muted-foreground">
                Binary file cannot render as markdown.
              </p>
            )}
            {status.status === "toolarge" && (
              <p className="text-[12px] text-muted-foreground">
                File is {status.size} bytes; limit {status.limit}.
              </p>
            )}
            {status.status === "ready" && (
              <Streamdown
                className="select-text [&>*:first-child]:mt-0 [&>*:last-child]:mb-0"
                components={componentsWithPaths}
                rehypePlugins={previewRehypePlugins}
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
