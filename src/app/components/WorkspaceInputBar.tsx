import { Chip } from "@/components/ui/chip";
import { useBlockController } from "@/modules/terminal/lib/blockController";
import { focusLeafInput } from "@/modules/terminal/lib/useTerminalSession";
import {
  CommandLineIcon,
  Folder01Icon,
  GitBranchIcon,
} from "@hugeicons/core-free-icons";
import { lazy, Suspense, useEffect, useRef, useState } from "react";
import { OsIcon } from "./OsIcon";
import { useGitBranch } from "./useGitBranch";
import { useSystemInfo } from "./useSystemInfo";

const ShellInput = lazy(() => import("@/modules/terminal/block/ShellInput"));

export const TOGGLE_BLOCK_INPUT_EVENT = "terax:toggle-block-input";

type Props = {
  isBlockTab: boolean;
  isTerminalTab: boolean;
  activeLeafId: number | null;
  cwd: string | null;
  home: string | null;
};

export function WorkspaceInputBar({
  isBlockTab,
  isTerminalTab,
  activeLeafId,
  cwd,
  home,
}: Props) {
  const { os, shell } = useSystemInfo();

  const controller = useBlockController(isBlockTab ? activeLeafId : null);
  const blockMode = controller?.blockMode ?? "prompt";

  // Re-resolve the branch chip when a command finishes (covers `git checkout`).
  const [promptNonce, setPromptNonce] = useState(0);
  const prevBlockMode = useRef(blockMode);
  useEffect(() => {
    if (prevBlockMode.current !== "prompt" && blockMode === "prompt") {
      setPromptNonce((n) => n + 1);
    }
    prevBlockMode.current = blockMode;
  }, [blockMode]);
  const branch = useGitBranch(isTerminalTab ? cwd : null, promptNonce);

  useEffect(() => {
    if (!isBlockTab) return;
    const onToggle = () => {
      if (activeLeafId != null) focusLeafInput(activeLeafId);
    };
    window.addEventListener(TOGGLE_BLOCK_INPUT_EVENT, onToggle);
    return () => window.removeEventListener(TOGGLE_BLOCK_INPUT_EVENT, onToggle);
  }, [isBlockTab, activeLeafId]);

  const mounted = isBlockTab;
  if (!mounted) return null;

  const terminalChips = isTerminalTab ? (
    <>
      {os && <Chip tone="neutral" iconNode={<OsIcon os={os} />} title={os} />}
      {cwd && (
        <Chip tone="blue" icon={Folder01Icon} title={cwd}>
          {relPath(cwd, home)}
        </Chip>
      )}
      {branch && (
        <Chip tone="violet" icon={GitBranchIcon} title={`Branch: ${branch}`}>
          {branch}
        </Chip>
      )}
      {shell && (
        <Chip tone="emerald" icon={CommandLineIcon}>
          {shell}
        </Chip>
      )}
    </>
  ) : null;

  return (
    <div className="shrink-0 border-t border-border/60 bg-card/40 px-3 py-2">
      <div className="flex flex-col gap-2 rounded-lg px-1 py-1">
        {terminalChips}

        <div className="flex items-end gap-2.5">
          <div className="relative min-w-0 flex-1">
            {controller && activeLeafId != null && (
              <Suspense fallback={null}>
                <ShellInput
                  leafId={activeLeafId}
                  mode={blockMode}
                  focused
                  onSubmit={controller.submitCommand}
                  onInterrupt={controller.interrupt}
                  getCwd={controller.getCwd}
                />
              </Suspense>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function relPath(p: string, home: string | null): string {
  if (!home) return p;
  const h = home.replace(/\/+$/, "");
  if (p === h || p.startsWith(`${h}/`)) return `~${p.slice(h.length)}`;
  return p;
}
