import { errorToast } from "@/lib/errorToast";
import type { MediaKind } from "@/modules/editor/lib/mediaKind";
import { workspaceScopeKey, type WorkspaceEnv } from "@/modules/workspace";
import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import { openPath } from "@tauri-apps/plugin-opener";
import { useEffect, useRef, useState } from "react";

type Props = {
  path: string;
  workspace: WorkspaceEnv;
  kind: MediaKind;
  visible: boolean;
};
type Source = {
  identity: string;
  url?: string;
  nativePath?: string;
  error?: string;
};

export function MediaPane({ path, workspace, kind, visible }: Props) {
  const scope = workspaceScopeKey(workspace);
  const identity = `${scope}\0${path}`;
  const [source, setSource] = useState<Source | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const [opening, setOpening] = useState(false);
  const media = useRef<HTMLMediaElement | null>(null);
  useEffect(() => {
    let current = true;
    void invoke<string>("fs_canonicalize", { path, workspace })
      .then((nativePath) => {
        if (current)
          setSource({ identity, nativePath, url: convertFileSrc(nativePath) });
      })
      .catch((error) => {
        if (current) setSource({ identity, error: String(error) });
      });
    return () => {
      current = false;
    };
  }, [path, workspace, identity]);
  useEffect(() => {
    if (!visible) media.current?.pause();
  }, [visible]);
  const current = source?.identity === identity ? source : null;
  const error =
    current?.error ??
    (failed === current?.url
      ? "无法显示此文件，格式可能不受支持或文件已损坏。"
      : null);
  const title = path.split(/[\\/]/).pop() ?? path;
  const fail = () => {
    if (current?.url) setFailed(current.url);
  };
  return (
    <div className="flex h-full min-h-0 flex-col bg-background">
      <div className="flex shrink-0 items-center justify-between gap-3 border-b border-border px-3 py-2 text-xs">
        <span className="truncate" title={path}>
          {title}
        </span>
        <button
          type="button"
          className="shrink-0 text-muted-foreground hover:text-foreground disabled:opacity-50"
          disabled={!current?.nativePath || opening}
          onClick={() => {
            if (!current?.nativePath || opening) return;
            setOpening(true);
            void openPath(current.nativePath.replace(/\//g, "\\"))
              .catch((cause) => errorToast("系统打开失败", cause))
              .finally(() => setOpening(false));
          }}
        >
          在系统中打开
        </button>
      </div>
      <div className="flex min-h-0 flex-1 items-center justify-center overflow-auto p-4">
        {!current ? (
          <span className="text-xs text-muted-foreground">加载中...</span>
        ) : error ? (
          <div
            role="alert"
            className="px-4 text-center text-xs text-destructive"
          >
            {error}
          </div>
        ) : kind === "image" ? (
          <img
            key={current.url}
            src={current.url}
            alt={title}
            onError={fail}
            decoding="async"
            className="max-h-full max-w-full object-contain"
          />
        ) : kind === "video" ? (
          // biome-ignore lint/a11y/useMediaCaption: Arbitrary local files have no accompanying caption track.
          <video
            key={current.url}
            ref={(element) => {
              media.current = element;
            }}
            src={current.url}
            controls
            preload="metadata"
            onError={fail}
            className="max-h-full max-w-full"
          />
        ) : kind === "audio" ? (
          // biome-ignore lint/a11y/useMediaCaption: Arbitrary local files have no accompanying caption track.
          <audio
            key={current.url}
            ref={(element) => {
              media.current = element;
            }}
            src={current.url}
            controls
            preload="metadata"
            onError={fail}
            className="w-full max-w-md"
          />
        ) : (
          <iframe
            key={current.url}
            src={current.url}
            title={title}
            className="h-full w-full border-0"
          />
        )}
      </div>
    </div>
  );
}
