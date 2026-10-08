import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { normalizePreviewUrl } from "@/modules/preview/previewUrl";
import { errorToast } from "@/lib/errorToast";
import {
  ArrowReloadHorizontalIcon,
  Globe02Icon,
  LinkSquare02Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { openUrl } from "@tauri-apps/plugin-opener";
import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
} from "react";

type PortPreset = {
  port: number;
  label: string;
  hint: string;
};

// Curated dev-server ports. Ordered by frontend frequency, then backend.
const PORT_PRESETS: readonly PortPreset[] = [
  { port: 5173, label: "Vite", hint: "vite, sveltekit" },
  { port: 5174, label: "Vite (alt)", hint: "second vite instance" },
  { port: 3000, label: "Next.js", hint: "next, express, rails" },
  { port: 3001, label: "Next.js (alt)", hint: "second next instance" },
  { port: 4173, label: "Vite preview", hint: "vite preview" },
  { port: 4200, label: "Angular", hint: "angular cli" },
  { port: 4321, label: "Astro", hint: "astro" },
  { port: 5500, label: "Live Server", hint: "vscode live server" },
  { port: 6006, label: "Storybook", hint: "storybook" },
  { port: 8080, label: "Webpack", hint: "webpack, vue cli" },
  { port: 8081, label: "Metro", hint: "react native metro" },
  { port: 8000, label: "Django / FastAPI", hint: "django, fastapi" },
  { port: 8888, label: "Jupyter", hint: "jupyter notebook" },
  { port: 5000, label: "Flask", hint: "flask" },
  { port: 7860, label: "Gradio", hint: "gradio" },
  { port: 11434, label: "Ollama", hint: "ollama api" },
];

export type PreviewAddressBarHandle = {
  focus: () => void;
};

type Props = {
  url: string;
  onSubmit: (url: string) => void;
  onReload: () => void;
};

export const PreviewAddressBar = forwardRef<PreviewAddressBarHandle, Props>(
  function PreviewAddressBar({ url, onSubmit, onReload }, ref) {
    const [draft, setDraft] = useState(url);
    const inputRef = useRef<HTMLInputElement>(null);
    const probeRef = useRef<AbortController | null>(null);
    const requestRef = useRef(0);
    const invalidateProbe = useCallback(() => {
      requestRef.current++;
      probeRef.current?.abort();
      probeRef.current = null;
    }, []);
    const currentUrl = useRef(url);
    if (currentUrl.current !== url) {
      currentUrl.current = url;
      requestRef.current++;
    }

    // Keep draft in sync when the parent updates the URL externally
    // (AI tool, detected localhost chip, etc.).
    useEffect(() => {
      setDraft(url);
      invalidateProbe();
      setCheckingPort(null);
      return invalidateProbe;
    }, [url, invalidateProbe]);

    useImperativeHandle(
      ref,
      () => ({
        focus: () => {
          const el = inputRef.current;
          if (!el) return;
          el.focus();
          el.select();
        },
      }),
      [],
    );

    const [notice, setNotice] = useState<string | null>(null);
    const [checkingPort, setCheckingPort] = useState<number | null>(null);

    const submit = () => {
      invalidateProbe();
      setCheckingPort(null);
      const next = normalizePreviewUrl(draft);
      if (!next) {
        probeRef.current = null;
        setNotice(
          "Enter a valid external HTTP or HTTPS URL, or pick a port preset.",
        );
        return;
      }
      setNotice(null);
      if (next !== normalizePreviewUrl(url)) onSubmit(next);
      else onReload();
    };

    const tryPort = async (port: number) => {
      invalidateProbe();
      const request = requestRef.current;
      const controller = new AbortController();
      probeRef.current = controller;
      setNotice(null);
      setCheckingPort(port);
      const next = normalizePreviewUrl(`http://localhost:${port}`);
      if (!next) {
        probeRef.current = null;
        setCheckingPort(null);
        setNotice("Application pages cannot be previewed.");
        return;
      }
      const ok = await probeUrl(next, controller);
      if (request !== requestRef.current) return;
      probeRef.current = null;
      setCheckingPort(null);
      if (!ok) {
        setNotice(`No server listening on :${port}.`);
        return;
      }
      setDraft(next);
      if (next === normalizePreviewUrl(url)) onReload();
      else onSubmit(next);
    };

    return (
      <div className="shrink-0 border-b border-border/60">
        <div className="flex h-9 items-center gap-1 bg-card/40 px-1.5">
          <Button
            type="button"
            variant="ghost"
            size="icon"
            onClick={() => {
              invalidateProbe();
              setCheckingPort(null);
              onReload();
            }}
            title="Reload"
            className="size-7 shrink-0 rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"
          >
            <HugeiconsIcon
              icon={ArrowReloadHorizontalIcon}
              size={14}
              strokeWidth={1.75}
            />
          </Button>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                title="Common dev-server ports"
                className="h-7 shrink-0 gap-1 rounded-md px-1.5 text-[11px] text-muted-foreground hover:bg-accent hover:text-foreground"
              >
                <HugeiconsIcon
                  icon={Globe02Icon}
                  size={13}
                  strokeWidth={1.75}
                />
                <span className="hidden sm:inline">Ports</span>
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent
              align="start"
              className="max-h-80 min-w-56 overflow-y-auto"
            >
              {PORT_PRESETS.map((p) => (
                <DropdownMenuItem
                  key={p.port}
                  onSelect={(e) => {
                    e.preventDefault();
                    void tryPort(p.port).catch((error) =>
                      errorToast("探测预览端口失败", error),
                    );
                  }}
                >
                  <span className="flex-1">{p.label}</span>
                  <span className="text-xs text-muted-foreground">
                    {checkingPort === p.port ? "checking…" : `:${p.port}`}
                  </span>
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
          <div className="flex min-w-0 flex-1 items-center">
            <Input
              ref={inputRef}
              value={draft}
              placeholder="http://localhost:3000"
              spellCheck={false}
              autoComplete="off"
              className="h-7 w-full bg-muted/60 px-2 text-xs placeholder:text-muted-foreground/70 focus-visible:ring-0"
              onChange={(e) => {
                invalidateProbe();
                setCheckingPort(null);
                setDraft(e.target.value);
              }}
              onKeyDown={(e) => {
                if (e.nativeEvent.isComposing || e.nativeEvent.keyCode === 229)
                  return;
                if (e.key === "Enter") {
                  e.preventDefault();
                  submit();
                } else if (e.key === "Escape") {
                  e.preventDefault();
                  invalidateProbe();
                  setCheckingPort(null);
                  setDraft(url);
                  inputRef.current?.blur();
                }
              }}
            />
          </div>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            onClick={() => {
              const next = normalizePreviewUrl(url);
              if (next)
                void openUrl(next).catch((error) =>
                  errorToast("打开浏览器失败", error),
                );
            }}
            title="Open in system browser"
            className="size-7 shrink-0 rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"
            disabled={!normalizePreviewUrl(url)}
          >
            <HugeiconsIcon
              icon={LinkSquare02Icon}
              size={14}
              strokeWidth={1.75}
            />
          </Button>
        </div>
        {notice ? (
          <div className="flex items-center gap-1.5 bg-amber-500/8 px-3 py-1 text-[11px] text-amber-600 dark:text-amber-400">
            <span className="truncate">{notice}</span>
            <button
              type="button"
              onClick={() => setNotice(null)}
              className="ml-auto rounded px-1 text-[10px] opacity-80 hover:bg-accent hover:opacity-100"
            >
              Dismiss
            </button>
          </div>
        ) : null}
      </div>
    );
  },
);

async function probeUrl(
  url: string,
  controller: AbortController,
): Promise<boolean> {
  const timeout = setTimeout(() => controller.abort(), 900);
  try {
    await fetch(url, {
      method: "GET",
      mode: "no-cors",
      cache: "no-store",
      signal: controller.signal,
    });
    return true;
  } catch {
    return false;
  } finally {
    clearTimeout(timeout);
  }
}
