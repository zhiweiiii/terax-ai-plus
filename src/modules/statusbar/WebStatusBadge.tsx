import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { native } from "@/lib/native";
import { Key01Icon, RouterIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useEffect, useState } from "react";

type Status = {
  running: boolean;
  connections: number;
  failed_logins: number;
};

const POLL_MS = 2000;

export function WebStatusBadge() {
  const [status, setStatus] = useState<Status | null>(null);

  useEffect(() => {
    let disposed = false;
    let timer: number | undefined;

    const poll = async () => {
      try {
        const s = await native.webStatus();
        if (!disposed) setStatus(s);
      } catch {
        if (!disposed) setStatus(null);
      }
      if (!disposed) timer = window.setTimeout(poll, POLL_MS);
    };

    void poll();
    return () => {
      disposed = true;
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, []);

  const running = status?.running ?? false;
  const count = status?.connections ?? 0;
  const failedLogins = status?.failed_logins ?? 0;

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span className="terax-pill-in ml-1.5 flex h-6 shrink-0 cursor-default items-center gap-1 rounded-full border border-border/50 bg-accent/50 px-2 text-[10.5px] font-medium text-muted-foreground">
          {running ? (
            <span className="size-1.5 rounded-full bg-emerald-500" />
          ) : (
            <span className="size-1.5 rounded-full bg-destructive" />
          )}
          <HugeiconsIcon icon={RouterIcon} size={11} strokeWidth={2} />
          <span>{count}</span>
          {failedLogins > 0 ? (
            <span className="flex items-center gap-0.5 text-amber-500">
              <HugeiconsIcon icon={Key01Icon} size={10} strokeWidth={2} />
              <span>{failedLogins}</span>
            </span>
          ) : null}
        </span>
      </TooltipTrigger>
      <TooltipContent
        side="top"
        className="max-w-64 text-[11px] leading-relaxed"
      >
        {running
          ? `远程服务运行中，当前连接 ${count} 个${
              failedLogins > 0 ? `，密码错误 ${failedLogins} 次` : ""
            }`
          : "远程服务未启动"}
      </TooltipContent>
    </Tooltip>
  );
}