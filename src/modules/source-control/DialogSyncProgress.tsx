import { Spinner } from "@/components/ui/spinner";
import { cn } from "@/lib/utils";
import type { RepoSyncItem, SyncProgress } from "./useMultiRepoSourceControl";

function phaseText(phase: RepoSyncItem["phase"]): {
  text: string;
  tone: "muted" | "active" | "good" | "warn" | "bad";
} {
  switch (phase.kind) {
    case "pending":
      return { text: "Waiting", tone: "muted" };
    case "fetching":
      return { text: "Fetching…", tone: "active" };
    case "pulling":
      return { text: `Pulling ${phase.commits}…`, tone: "active" };
    case "pulled":
      return {
        text: `Pulled ${phase.commits} ${phase.commits === 1 ? "commit" : "commits"}`,
        tone: "good",
      };
    case "up-to-date":
      return { text: "Up to date", tone: "muted" };
    case "no-upstream":
      return { text: "No upstream", tone: "warn" };
    case "diverged":
      return { text: "Diverged, resolve manually", tone: "warn" };
    case "failed":
      return { text: phase.error, tone: "bad" };
  }
}

const TONE_CLASS = {
  muted: "text-muted-foreground/70",
  active: "text-foreground/80",
  good: "text-emerald-500",
  warn: "text-amber-500",
  bad: "text-destructive",
} as const;

/**
 * Inline per-repo progress for the remote-action dialogs, mirroring the
 * panel's SyncProgressList.
 */
export function DialogSyncProgress({
  progress,
}: {
  progress: SyncProgress;
}) {
  const done = progress.items.filter(
    (i) =>
      i.phase.kind !== "pending" &&
      i.phase.kind !== "fetching" &&
      i.phase.kind !== "pulling",
  ).length;
  return (
    <div className="rounded-lg border border-border/50 bg-muted/20 px-2.5 py-2">
      <div className="mb-1 flex items-center gap-2">
        {progress.running ? <Spinner className="size-3" /> : null}
        <span className="text-[10.5px] font-medium text-foreground/85">
          {progress.running
            ? `Working on ${Math.min(done + 1, progress.items.length)}/${progress.items.length}`
            : `${progress.items.length} ${progress.items.length === 1 ? "repo" : "repos"} finished`}
        </span>
      </div>
      <ul className="flex flex-col gap-0.5">
        {progress.items.map((item) => {
          const { text, tone } = phaseText(item.phase);
          return (
            <li
              key={item.repoRoot}
              className="flex items-center gap-2 text-[10.5px]"
            >
              <span className="min-w-0 flex-1 truncate text-muted-foreground">
                {item.name}
              </span>
              <span
                title={text}
                className={cn("max-w-[55%] truncate", TONE_CLASS[tone])}
              >
                {text}
              </span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
