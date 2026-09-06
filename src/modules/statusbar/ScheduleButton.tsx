import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { errorToast } from "@/lib/errorToast";
import { Clock01Icon, Delete02Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";

/** A command queued to run later, as the backend reports it. */
type ScheduledJob = {
  id: number;
  leaf_id: number;
  command: string;
  /** Epoch milliseconds. */
  fire_at: number;
  created_at: number;
};

type Props = {
  /** The terminal a new job runs in. Null when there is no live terminal,
   *  which is when there is nothing to schedule against. */
  leafId: number | null;
};

function untilText(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h > 0) return `${h} 小时 ${m} 分后`;
  if (m > 0) return `${m} 分 ${s} 秒后`;
  return `${s} 秒后`;
}

/**
 * Queue a command to run in this terminal later.
 *
 * The clock is in the backend (`src-tauri/src/modules/schedule.rs`), not here:
 * this window can be closed, and the phone that scheduled the same job can be
 * asleep. All this panel does is ask for a job and list what is waiting — and
 * the list it shows is the same one the phone sees, because there is only one.
 *
 * Jobs are not persisted. A job names a terminal, and no terminal survives a
 * restart, so one restored into a fresh process would be a promise nothing
 * could keep.
 */
export function ScheduleButton({ leafId }: Props) {
  const [open, setOpen] = useState(false);
  const [hours, setHours] = useState("");
  const [minutes, setMinutes] = useState("");
  const [command, setCommand] = useState("");
  const [jobs, setJobs] = useState<ScheduledJob[]>([]);
  // Re-renders the countdowns. Only ticks while the panel is open.
  const [, setTick] = useState(0);

  const refresh = useCallback(() => {
    void invoke<ScheduledJob[]>("schedule_list")
      .then(setJobs)
      .catch(() => setJobs([]));
  }, []);

  // The backend announces every change — a job added from the phone, one that
  // ran, one that was given up on — so the list is never stale behind a poll.
  useEffect(() => {
    const stop = listen<ScheduledJob[]>("terax:schedules", (e) => {
      setJobs(Array.isArray(e.payload) ? e.payload : []);
    });
    return () => {
      void stop.then((off) => off());
    };
  }, []);

  useEffect(() => {
    if (!open) return;
    refresh();
    const handle = window.setInterval(() => setTick((n) => n + 1), 1000);
    return () => window.clearInterval(handle);
  }, [open, refresh]);

  const submit = () => {
    if (leafId === null) return;
    const text = command.trim();
    if (text === "") {
      toast.error("先填写要执行的命令");
      return;
    }
    const delaySeconds =
      (Number(hours) || 0) * 3600 + (Number(minutes) || 0) * 60;
    if (delaySeconds <= 0) {
      toast.error("请填写多久之后执行");
      return;
    }
    void invoke("schedule_add", {
      leafId,
      command: text,
      delaySeconds,
    })
      .then(() => {
        setCommand("");
        setHours("");
        setMinutes("");
        toast.success(`已排队：${untilText(delaySeconds * 1000)}`);
      })
      .catch((e) => errorToast("排队失败", String(e)));
  };

  const cancel = (id: number) => {
    void invoke("schedule_cancel", { id }).catch((e) =>
      errorToast("取消失败", String(e)),
    );
  };

  const now = Date.now();

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          className="relative size-6 text-muted-foreground hover:text-foreground"
          title="定时发送命令"
          aria-label="定时发送命令"
        >
          <HugeiconsIcon icon={Clock01Icon} size={13} strokeWidth={2} />
          {jobs.length > 0 ? (
            <span className="absolute -top-0.5 -right-0.5 size-1.5 rounded-full bg-blue-500" />
          ) : null}
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" side="top" className="w-96 p-3">
        <div className="flex flex-col gap-2.5">
          <div className="flex flex-col gap-1">
            <Label className="text-[11px]">命令</Label>
            <Input
              className="h-8 font-mono text-[12px]"
              value={command}
              onChange={(e) => setCommand(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") submit();
              }}
              placeholder="npm run build"
              spellCheck={false}
            />
          </div>
          <div className="flex items-end gap-2">
            <div className="flex flex-col gap-1">
              <Label className="text-[11px]">小时</Label>
              <Input
                className="h-8 w-16 text-center"
                inputMode="numeric"
                value={hours}
                onChange={(e) => setHours(e.target.value)}
                placeholder="0"
              />
            </div>
            <div className="flex flex-col gap-1">
              <Label className="text-[11px]">分钟</Label>
              <Input
                className="h-8 w-16 text-center"
                inputMode="numeric"
                value={minutes}
                onChange={(e) => setMinutes(e.target.value)}
                placeholder="0"
              />
            </div>
            <Button
              size="sm"
              className="ml-auto h-8"
              disabled={leafId === null}
              onClick={submit}
            >
              安排
            </Button>
          </div>

          {leafId === null ? (
            <p className="text-[11px] text-muted-foreground">
              没有活动的命令行，无法安排。
            </p>
          ) : null}

          <div className="mt-0.5 flex flex-col gap-1 border-t border-border/60 pt-2">
            {jobs.length === 0 ? (
              <p className="text-[11px] text-muted-foreground">
                没有排队的命令。
              </p>
            ) : (
              jobs.map((job) => (
                <div
                  key={job.id}
                  className="flex items-baseline gap-2 rounded-md bg-muted/50 px-2 py-1"
                >
                  <span className="shrink-0 font-mono text-[10.5px] text-blue-500">
                    {untilText(job.fire_at - now)}
                  </span>
                  {/* Wraps rather than truncates: a queued command you cannot
                      read in full is one you cannot decide to cancel. */}
                  <span className="min-w-0 flex-1 break-all font-mono text-[11px]">
                    {job.command}
                  </span>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="size-5 shrink-0 text-muted-foreground hover:text-destructive"
                    title="取消"
                    onClick={() => cancel(job.id)}
                  >
                    <HugeiconsIcon
                      icon={Delete02Icon}
                      size={11}
                      strokeWidth={2}
                    />
                  </Button>
                </div>
              ))
            )}
          </div>
        </div>
      </PopoverContent>
    </Popover>
  );
}
