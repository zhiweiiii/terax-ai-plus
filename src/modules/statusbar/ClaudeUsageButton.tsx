import { Button } from "@/components/ui/button";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { errorToast } from "@/lib/errorToast";
import { ChartLineData01Icon, Refresh01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { invoke } from "@tauri-apps/api/core";
import { useEffect, useState } from "react";

type UsageWindow = {
  label: string;
  percent: number | null;
  resets: string | null;
};

type Usage = {
  session: UsageWindow | null;
  weeks: UsageWindow[];
  raw: string;
  fetchedAt: number;
  error: string | null;
};

/** Where a window stops being worth a neutral colour. */
const WARN_AT = 75;
const DANGER_AT = 90;

function toneOf(percent: number | null): string {
  if (percent === null) return "text-muted-foreground";
  if (percent >= DANGER_AT) return "text-destructive";
  if (percent >= WARN_AT) return "text-amber-700 dark:text-amber-400";
  return "text-foreground";
}

function barOf(percent: number): string {
  if (percent >= DANGER_AT) return "bg-destructive";
  if (percent >= WARN_AT) return "bg-amber-500";
  return "bg-emerald-500";
}

function ageLabel(fetchedAt: number): string {
  const seconds = Math.max(0, Math.floor(Date.now() / 1000) - fetchedAt);
  if (seconds < 60) return "刚刚";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} 分钟前`;
  return `${Math.floor(minutes / 60)} 小时前`;
}

/**
 * Claude Code's subscription limits, in the status bar.
 *
 * The figures come from `claude -p "/usage"`, because they exist nowhere on
 * disk: the transcripts record tokens spent, which is not the same quantity as
 * percent of a plan window used. That call costs one request against the very
 * limit it reports, so nothing here polls. The panel loads whatever the backend
 * already had, fetches when opened, and otherwise only on an explicit refresh.
 */
export function ClaudeUsageButton() {
  const [open, setOpen] = useState(false);
  const [usage, setUsage] = useState<Usage | null>(null);
  const [busy, setBusy] = useState(false);

  /* First paint uses the cached answer only. Fetching on mount would spend a
     request every time the app starts, for a number nobody has asked to see. */
  useEffect(() => {
    void invoke<Usage | null>("claude_usage_cached")
      .then((cached) => {
        if (cached) setUsage(cached);
      })
      .catch(() => {
        /* A missing cache is the normal case, not an error worth a toast. */
      });
  }, []);

  const load = async (force: boolean) => {
    setBusy(true);
    try {
      const next = await invoke<Usage>("claude_usage", { force });
      setUsage(next);
    } catch (e) {
      errorToast("读取用量失败", e);
    } finally {
      setBusy(false);
    }
  };

  const onOpenChange = (next: boolean) => {
    setOpen(next);
    // The backend keeps its own floor on how often this really refetches, so
    // opening the panel is free once it has an answer.
    if (next) void load(false);
  };

  const session = usage?.session ?? null;
  const primaryWeek = usage?.weeks[0] ?? null;

  return (
    <Popover open={open} onOpenChange={onOpenChange}>
      <PopoverTrigger asChild>
        <Button
          variant="ghost"
          size="sm"
          className="h-6 shrink-0 gap-1.5 px-1.5 text-[10.5px] font-normal text-muted-foreground hover:text-foreground"
          title="Claude Code 用量"
          aria-label="Claude Code 用量"
        >
          <HugeiconsIcon
            icon={ChartLineData01Icon}
            size={12}
            strokeWidth={1.75}
          />
          {session || primaryWeek ? (
            <span className="flex items-center gap-1 tabular-nums">
              <span className={toneOf(session?.percent ?? null)}>
                5h {session?.percent ?? "-"}%
              </span>
              <span className="text-muted-foreground/50">·</span>
              <span className={toneOf(primaryWeek?.percent ?? null)}>
                周 {primaryWeek?.percent ?? "-"}%
              </span>
            </span>
          ) : (
            <span>用量</span>
          )}
        </Button>
      </PopoverTrigger>
      <PopoverContent
        align="end"
        side="top"
        className="max-h-[70vh] w-80 overflow-y-auto p-3"
      >
        <div className="flex flex-col gap-2.5">
          <div className="flex items-center justify-between gap-2">
            <span className="text-[11px] font-medium">Claude Code 用量</span>
            <button
              type="button"
              disabled={busy}
              onClick={() => void load(true)}
              title="重新查询（会消耗一次请求）"
              className="flex size-6 items-center justify-center rounded text-muted-foreground hover:bg-foreground/10 hover:text-foreground disabled:opacity-50"
            >
              <HugeiconsIcon
                icon={Refresh01Icon}
                size={12}
                strokeWidth={1.75}
                className={busy ? "animate-spin" : undefined}
              />
            </button>
          </div>

          {usage === null ? (
            <p className="text-[10.5px] leading-snug text-muted-foreground">
              {busy ? "正在查询…" : "还没有数据，点右上角查询。"}
            </p>
          ) : null}

          {session ? <WindowRow title="5 小时窗口" window={session} /> : null}
          {usage?.weeks.map((week) => (
            <WindowRow
              key={week.label}
              title={`本周（${week.label}）`}
              window={week}
            />
          ))}

          {usage?.error ? (
            <p className="select-text whitespace-pre-wrap break-words text-[10.5px] leading-snug text-destructive">
              {usage.error}
            </p>
          ) : null}

          {/* Claude Code also reports what drove the usage. It is prose and it
              changes shape, so it is shown as written rather than parsed. */}
          {usage?.raw.trim() ? (
            <details className="border-t border-border/60 pt-2">
              <summary className="cursor-pointer text-[10.5px] text-muted-foreground">
                完整输出
              </summary>
              <pre className="mt-1.5 select-text whitespace-pre-wrap break-words font-mono text-[10px] leading-snug text-muted-foreground">
                {usage.raw.trim()}
              </pre>
            </details>
          ) : null}

          {usage && !usage.error ? (
            <p className="text-[10px] text-muted-foreground">
              更新于 {ageLabel(usage.fetchedAt)}，查询本身也会消耗一次请求
            </p>
          ) : null}
        </div>
      </PopoverContent>
    </Popover>
  );
}

function WindowRow({ title, window }: { title: string; window: UsageWindow }) {
  const percent = window.percent;
  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-baseline justify-between gap-2">
        <span className="text-[11px] text-foreground">{title}</span>
        <span className={`text-[11px] tabular-nums ${toneOf(percent)}`}>
          {percent === null ? "未知" : `${percent}%`}
        </span>
      </div>
      {percent === null ? null : (
        <div className="h-1 w-full overflow-hidden rounded-full bg-foreground/10">
          <div
            className={`h-full rounded-full ${barOf(percent)}`}
            style={{ width: `${Math.min(100, percent)}%` }}
          />
        </div>
      )}
      {window.resets ? (
        <span className="select-text text-[10px] text-muted-foreground">
          {window.resets} 重置
        </span>
      ) : null}
    </div>
  );
}
