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
import { type ReactNode, useEffect, useRef, useState } from "react";

type UsageWindow = {
  label: string;
  percent: number | null;
  resets: string | null;
};

type ClaudeUsage = {
  session: UsageWindow | null;
  weeks: UsageWindow[];
  raw: string;
  fetchedAt: number;
  error: string | null;
};

type CodexUsageWindow = {
  usedPercent: number | null;
  resetsAt: number | null;
  windowDurationMins: number | null;
};

type CodexUsage = {
  primary: CodexUsageWindow | null;
  secondary: CodexUsageWindow | null;
  planType: string | null;
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

function codexResetLabel(resetsAt: number | null): string | null {
  if (resetsAt === null || !Number.isFinite(resetsAt)) return null;
  const date = new Date(resetsAt * 1000);
  if (!Number.isFinite(date.getTime())) return null;
  return new Intl.DateTimeFormat("zh-CN", {
    dateStyle: "short",
    timeStyle: "short",
  }).format(date);
}

function codexWindowTitle(window: CodexUsageWindow, fallback: string): string {
  if (window.windowDurationMins === 300) return "5 小时窗口";
  if (window.windowDurationMins === 10080) return "周窗口";
  return fallback;
}

/**
 * Claude Code and Codex subscription limits, in one status-bar panel.
 *
 * The figures come from `claude -p "/usage"`, because they exist nowhere on
 * disk: the transcripts record tokens spent, which is not the same quantity as
 * percent of a plan window used. That call costs one request against the very
 * limit it reports, so nothing here polls. The panel loads whatever the backend
 * already had, fetches when opened, and otherwise only on an explicit refresh.
 */
export function ClaudeUsageButton() {
  const [open, setOpen] = useState(false);
  const [claudeUsage, setClaudeUsage] = useState<ClaudeUsage | null>(null);
  const [codexUsage, setCodexUsage] = useState<CodexUsage | null>(null);
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const revisionRef = useRef(0);
  const mountedRef = useRef(true);

  /* First paint uses the cached answer only. Fetching on mount would spend a
     request every time the app starts, for a number nobody has asked to see. */
  useEffect(() => {
    mountedRef.current = true;
    const revision = revisionRef.current;
    void invoke<ClaudeUsage | null>("claude_usage_cached")
      .then((cached) => {
        if (cached && mountedRef.current && revisionRef.current === revision)
          setClaudeUsage(cached);
      })
      .catch(() => {
        /* A missing cache is the normal case, not an error worth a toast. */
      });
    void invoke<CodexUsage | null>("codex_usage_cached")
      .then((cached) => {
        if (cached && mountedRef.current && revisionRef.current === revision)
          setCodexUsage(cached);
      })
      .catch(() => {
        /* A missing cache is the normal case, not an error worth a toast. */
      });
    return () => {
      mountedRef.current = false;
      revisionRef.current++;
    };
  }, []);

  const load = async (force: boolean) => {
    if (!mountedRef.current || busyRef.current) return;
    busyRef.current = true;
    const revision = ++revisionRef.current;
    setBusy(true);
    try {
      const [claude, codex] = await Promise.allSettled([
        invoke<ClaudeUsage>("claude_usage", { force }),
        invoke<CodexUsage>("codex_usage", { force }),
      ]);
      if (!mountedRef.current || revision !== revisionRef.current) return;
      if (claude.status === "fulfilled") setClaudeUsage(claude.value);
      else errorToast("读取 Claude Code 用量失败", claude.reason);
      if (codex.status === "fulfilled") setCodexUsage(codex.value);
      else errorToast("读取 Codex 用量失败", codex.reason);
    } catch (e) {
      errorToast("读取用量失败", e);
    } finally {
      busyRef.current = false;
      if (mountedRef.current && revision === revisionRef.current)
        setBusy(false);
    }
  };

  const onOpenChange = (next: boolean) => {
    setOpen(next);
    // The backend keeps its own floor on how often this really refetches, so
    // opening the panel is free once it has an answer.
    if (next) void load(false);
  };

  const session = claudeUsage?.session ?? null;
  const primaryWeek = claudeUsage?.weeks[0] ?? null;
  const codexPrimary = codexUsage?.primary ?? null;

  return (
    <Popover open={open} onOpenChange={onOpenChange}>
      <PopoverTrigger asChild>
        <Button
          variant="ghost"
          size="sm"
          className="h-6 shrink-0 gap-1.5 px-1.5 text-[10.5px] font-normal text-muted-foreground hover:text-foreground"
          title="Claude Code 与 Codex 用量"
          aria-label="Claude Code 与 Codex 用量"
        >
          <HugeiconsIcon
            icon={ChartLineData01Icon}
            size={12}
            strokeWidth={1.75}
          />
          {session || primaryWeek || codexPrimary ? (
            <span className="flex items-center gap-1 tabular-nums">
              <span className={toneOf(session?.percent ?? null)}>
                C {session?.percent ?? "-"}%
              </span>
              <span className="text-muted-foreground/50">·</span>
              <span className={toneOf(codexPrimary?.usedPercent ?? null)}>
                O {codexPrimary?.usedPercent ?? "-"}%
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
            <span className="text-[11px] font-medium">用量</span>
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

          {claudeUsage === null && codexUsage === null ? (
            <p className="text-[10.5px] leading-snug text-muted-foreground">
              {busy ? "正在查询…" : "还没有数据，点右上角查询。"}
            </p>
          ) : null}

          <UsageSection title="Claude Code">
            {session ? <WindowRow title="5 小时窗口" window={session} /> : null}
            {claudeUsage?.weeks.map((week) => (
              <WindowRow
                key={week.label}
                title={`本周（${week.label}）`}
                window={week}
              />
            ))}

            {claudeUsage?.error ? (
              <p className="select-text whitespace-pre-wrap break-words text-[10.5px] leading-snug text-destructive">
                {claudeUsage.error}
              </p>
            ) : null}

            {/* Claude Code also reports what drove the usage. It is prose and it
              changes shape, so it is shown as written rather than parsed. */}
            {claudeUsage?.raw.trim() ? (
              <details className="border-t border-border/60 pt-2">
                <summary className="cursor-pointer text-[10.5px] text-muted-foreground">
                  完整输出
                </summary>
                <pre className="mt-1.5 select-text whitespace-pre-wrap break-words font-mono text-[10px] leading-snug text-muted-foreground">
                  {claudeUsage.raw.trim()}
                </pre>
              </details>
            ) : null}

            {claudeUsage && !claudeUsage.error ? (
              <p className="text-[10px] text-muted-foreground">
                更新于 {ageLabel(claudeUsage.fetchedAt)}
                ，查询本身也会消耗一次请求
              </p>
            ) : null}
          </UsageSection>

          <UsageSection title="Codex">
            {codexPrimary ? (
              <CodexWindowRow
                title={codexWindowTitle(codexPrimary, "短期窗口")}
                window={codexPrimary}
              />
            ) : null}
            {codexUsage?.secondary ? (
              <CodexWindowRow
                title={codexWindowTitle(codexUsage.secondary, "长期窗口")}
                window={codexUsage.secondary}
              />
            ) : null}
            {codexUsage?.error ? (
              <p className="select-text whitespace-pre-wrap break-words text-[10.5px] leading-snug text-destructive">
                {codexUsage.error}
              </p>
            ) : null}
            {codexUsage && !codexUsage.error ? (
              <p className="text-[10px] text-muted-foreground">
                {codexUsage.planType ? `${codexUsage.planType} · ` : ""}更新于{" "}
                {ageLabel(codexUsage.fetchedAt)}
              </p>
            ) : null}
          </UsageSection>
        </div>
      </PopoverContent>
    </Popover>
  );
}

function UsageSection({
  title,
  children,
}: {
  title: string;
  children: ReactNode;
}) {
  return (
    <section className="flex flex-col gap-2 border-t border-border/60 pt-2">
      <span className="text-[10.5px] font-medium text-muted-foreground">
        {title}
      </span>
      {children}
    </section>
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
            style={{ width: `${Math.max(0, Math.min(100, percent))}%` }}
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

function CodexWindowRow({
  title,
  window,
}: {
  title: string;
  window: CodexUsageWindow;
}) {
  const percent = window.usedPercent;
  const reset = codexResetLabel(window.resetsAt);
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
            style={{ width: `${Math.max(0, Math.min(100, percent))}%` }}
          />
        </div>
      )}
      {reset ? (
        <span className="text-[10px] text-muted-foreground">{reset} 重置</span>
      ) : null}
    </div>
  );
}
