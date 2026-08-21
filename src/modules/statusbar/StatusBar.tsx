import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { Button } from "@/components/ui/button";
import { LspStatusPill } from "@/modules/lsp";
import type { WorkspaceEnv } from "@/modules/workspace";
import { IncognitoIcon, Settings01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { CwdBreadcrumb } from "./CwdBreadcrumb";
import { DiagnosticsBadge } from "./DiagnosticsBadge";
import { AgentEnvButton } from "./AgentEnvButton";
import { WebStatusBadge } from "./WebStatusBadge";
import { WorkspaceEnvSelector } from "./WorkspaceEnvSelector";

type Props = {
  cwd: string | null;
  filePath?: string | null;
  home: string | null;
  onCd: (path: string) => void;
  onWorkspaceChange: (env: WorkspaceEnv) => void;
  onOpenSettings: () => void;
  privateActive: boolean;
  /** Runs a command in the terminal the status bar is describing. Undefined
   *  when there is none, which disables the parameter panel's actions. */
  onRunInTerminal?: (command: string) => boolean;
};

export function StatusBar({
  cwd,
  filePath,
  home,
  onCd,
  onWorkspaceChange,
  onOpenSettings,
  privateActive,
  onRunInTerminal,
}: Props) {
  return (
    <footer className="flex h-8 shrink-0 items-center justify-between gap-3 border-t border-border/60 bg-card/60 pl-3 pr-4 text-[11px]">
      <div className="flex min-w-0 flex-1 items-center gap-2">
        <WorkspaceEnvSelector onSelect={onWorkspaceChange} />
        <CwdBreadcrumb cwd={cwd} filePath={filePath} home={home} onCd={onCd} />
        <LspStatusPill filePath={filePath ?? null} />
        <DiagnosticsBadge filePath={filePath ?? null} />
        {privateActive ? (
          <Tooltip>
            <TooltipTrigger asChild>
              <span className="flex shrink-0 cursor-default items-center gap-1 rounded-full bg-amber-500/15 px-2 py-0.5 text-[10.5px] font-medium text-amber-700 dark:text-amber-400">
                <HugeiconsIcon icon={IncognitoIcon} size={11} strokeWidth={2} />
                <span>Private</span>
              </span>
            </TooltipTrigger>
            <TooltipContent
              side="top"
              className="max-w-64 text-[11px] leading-relaxed"
            >
              Private terminal session. Use it for secrets or SSH.
            </TooltipContent>
          </Tooltip>
        ) : null}
      </div>
      <div className="flex shrink-0 items-center gap-1.5">
        <AgentEnvButton onApply={onRunInTerminal} />
        <WebStatusBadge />
        <Button
          variant="ghost"
          size="icon"
          className="size-6 shrink-0 rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"
          onClick={onOpenSettings}
          title="Settings"
        >
          <HugeiconsIcon icon={Settings01Icon} size={13} strokeWidth={1.75} />
        </Button>
      </div>
    </footer>
  );
}
