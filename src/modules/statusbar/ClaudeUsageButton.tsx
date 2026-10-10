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
import {
  type ReactNode,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";

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
const REFRESH_INTERVAL = 5 * 60 * 1000;

let pendingUsage: ReturnType<typeof requestUsage> | null = null;

function requestUsage(force: boolean) {
  return Promise.allSettled([
    Promise.resolve().then(() =>
      invoke<ClaudeUsage>("claude_usage", { force }),
    ),
    Promise.resolve().then(() => invoke<CodexUsage>("codex_usage", { force })),
  ]);
}

function readUsage(force: boolean) {
  if (pendingUsage) return pendingUsage;
  const request = requestUsage(force).finally(() => {
    if (pendingUsage === request) pendingUsage = null;
  });
  pendingUsage = request;
  return request;
}

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

function compactResetLabel(resetsAt: number | null): string | null {
  if (resetsAt === null || !Number.isFinite(resetsAt)) return null;
  const date = new Date(resetsAt * 1000);
  if (!Number.isFinite(date.getTime())) return null;
  return new Intl.DateTimeFormat("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).format(date);
}

function preserveOnError<T extends { error: string | null }>(
  previous: T | null,
  next: T,
): T {
  return next.error && previous ? { ...previous, error: next.error } : next;
}

function compactTextResetLabel(value: string | null): string | null {
  if (!value) return null;
  const match = value.match(
    /^([a-z]{3})\s+(\d{1,2}),?\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)(?:\s+\(([^()]+)\))?$/i,
  );
  if (!match) return value;
  const [, month, day, hour, minute = "00", period, zone] = match;
  const monthIndex = [
    "jan",
    "feb",
    "mar",
    "apr",
    "may",
    "jun",
    "jul",
    "aug",
    "sep",
    "oct",
    "nov",
    "dec",
  ].indexOf(month.toLowerCase());
  if (
    monthIndex < 0 ||
    Number(day) < 1 ||
    Number(day) > 31 ||
    Number(hour) < 1 ||
    Number(hour) > 12 ||
    Number(minute) > 59 ||
    (zone && zone !== Intl.DateTimeFormat().resolvedOptions().timeZone)
  )
    return value;
  const hour24 = (Number(hour) % 12) + (period.toLowerCase() === "pm" ? 12 : 0);
  return `${String(monthIndex + 1).padStart(2, "0")}/${day.padStart(2, "0")} ${String(hour24).padStart(2, "0")}:${minute}`;
}

export function ClaudeUsageButton() {
  const [open, setOpen] = useState(false);
  const [claudeUsage, setClaudeUsage] = useState<ClaudeUsage | null>(null);
  const [codexUsage, setCodexUsage] = useState<CodexUsage | null>(null);
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const revisionRef = useRef(0);
  const mountedRef = useRef(true);

  const load = useCallback(async (force: boolean, notify = false) => {
    if (!mountedRef.current || busyRef.current) return;
    busyRef.current = true;
    const revision = ++revisionRef.current;
    setBusy(true);
    try {
      const [claude, codex] = await readUsage(force);
      if (!mountedRef.current || revision !== revisionRef.current) return;
      const fetchedAt = Math.floor(Date.now() / 1000);
      const claudeResult: ClaudeUsage =
        claude.status === "fulfilled"
          ? claude.value
          : {
              session: null,
              weeks: [],
              raw: "",
              fetchedAt,
              error: String(claude.reason),
            };
      const codexResult: CodexUsage =
        codex.status === "fulfilled"
          ? codex.value
          : {
              primary: null,
              secondary: null,
              planType: null,
              fetchedAt,
              error: String(codex.reason),
            };
      setClaudeUsage((previous) => preserveOnError(previous, claudeResult));
      setCodexUsage((previous) => preserveOnError(previous, codexResult));
      if (notify && claudeResult.error)
        errorToast("读取 Claude Code 用量失败", claudeResult.error);
      if (notify && codexResult.error)
        errorToast("读取 Codex 用量失败", codexResult.error);
    } finally {
      if (mountedRef.current && revision === revisionRef.current) {
        busyRef.current = false;
        setBusy(false);
      }
    }
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    const revision = revisionRef.current;
    void Promise.allSettled([
      Promise.resolve().then(() =>
        invoke<ClaudeUsage | null>("claude_usage_cached"),
      ),
      Promise.resolve().then(() =>
        invoke<CodexUsage | null>("codex_usage_cached"),
      ),
    ]).then(([claude, codex]) => {
      if (!mountedRef.current || revisionRef.current !== revision) return;
      if (claude.status === "fulfilled" && claude.value)
        setClaudeUsage(claude.value);
      if (codex.status === "fulfilled" && codex.value)
        setCodexUsage(codex.value);
      void load(false);
    });
    const timer = window.setInterval(() => {
      void load(true);
    }, REFRESH_INTERVAL);
    return () => {
      window.clearInterval(timer);
      mountedRef.current = false;
      revisionRef.current++;
      busyRef.current = false;
    };
  }, [load]);

  const onOpenChange = (next: boolean) => {
    setOpen(next);
    if (next) void load(false);
  };

  const session = claudeUsage?.session ?? null;
  const primaryWeek =
    claudeUsage?.weeks.find((week) => week.label === "all models") ??
    claudeUsage?.weeks[0] ??
    null;
  const codexPrimary = codexUsage?.primary ?? null;
  const codexFiveHour = [codexUsage?.primary, codexUsage?.secondary].find(
    (window) => window?.windowDurationMins === 300,
  );
  const codexWeek = [codexUsage?.primary, codexUsage?.secondary].find(
    (window) => window?.windowDurationMins === 10080,
  );
  const summaryTitle = [
    "每 5 分钟自动更新；括号内为额度重置时间",
    claudeUsage?.error ? `Claude Code 更新失败：${claudeUsage.error}` : null,
    codexUsage?.error ? `Codex 更新失败：${codexUsage.error}` : null,
  ]
    .filter(Boolean)
    .join("\n");

  return (
    <Popover open={open} onOpenChange={onOpenChange}>
      <PopoverTrigger asChild>
        <Button
          variant="ghost"
          size="sm"
          className="h-7 min-w-0 max-w-full gap-1.5 px-1.5 text-[10px] font-normal text-muted-foreground hover:text-foreground"
          title={summaryTitle}
          aria-label="Claude Code 与 Codex 用量"
        >
          <HugeiconsIcon
            icon={ChartLineData01Icon}
            size={12}
            strokeWidth={1.75}
          />
          <span className="flex min-w-0 flex-col items-start gap-0.5 leading-[11px] tabular-nums">
            <UsageSummary
              agent="Claude"
              shortPercent={session?.percent ?? null}
              shortReset={session?.resets ?? null}
              weekPercent={primaryWeek?.percent ?? null}
              weekReset={primaryWeek?.resets ?? null}
              error={Boolean(claudeUsage?.error)}
            />
            <UsageSummary
              agent="Codex"
              shortPercent={codexFiveHour?.usedPercent ?? null}
              shortReset={compactResetLabel(codexFiveHour?.resetsAt ?? null)}
              weekPercent={codexWeek?.usedPercent ?? null}
              weekReset={compactResetLabel(codexWeek?.resetsAt ?? null)}
              error={Boolean(codexUsage?.error)}
            />
          </span>
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
              onClick={() => void load(true, true)}
              title="立即刷新用量"
              aria-label="立即刷新用量"
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
              {busy ? "正在查询…" : "等待自动查询，也可以点右上角刷新。"}
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
              </p>
            ) : null}
          </UsageSection>
          <p className="text-[10px] text-muted-foreground">
            每 5 分钟自动更新，括号内为额度重置时间。
          </p>

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

function UsageSummary({
  agent,
  shortPercent,
  shortReset,
  weekPercent,
  weekReset,
  error,
}: {
  agent: string;
  shortPercent: number | null;
  shortReset: string | null;
  weekPercent: number | null;
  weekReset: string | null;
  error: boolean;
}) {
  const percentLabel = (percent: number | null) =>
    percent === null ? "--" : `${percent}%`;
  const title = `${agent}${error ? " 更新失败" : ""} 5h ${percentLabel(shortPercent)}（${shortReset || "--"}）- 周 ${percentLabel(weekPercent)}（${weekReset || "--"}）`;
  return (
    <span className="block max-w-full truncate" title={title}>
      <span>
        {agent}
        {error ? " 更新失败" : ""}{" "}
      </span>
      <span className={toneOf(shortPercent)}>
        5h {shortPercent === null ? "--" : `${shortPercent}%`}
      </span>
      <span>（{compactTextResetLabel(shortReset) || "--"}）- </span>
      <span className={toneOf(weekPercent)}>
        周 {weekPercent === null ? "--" : `${weekPercent}%`}
      </span>
      <span>（{compactTextResetLabel(weekReset) || "--"}）</span>
    </span>
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
