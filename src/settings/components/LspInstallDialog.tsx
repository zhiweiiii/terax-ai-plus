import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { redetectBinary, type LspPreset } from "@/modules/lsp";
import { setLspActivation } from "@/modules/settings/store";
import {
  Copy01Icon,
  Refresh01Icon,
  Tick02Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { useEffect, useState } from "react";

type Props = {
  server: LspPreset | null;
  onClose: () => void;
};

export function LspInstallDialog({ server, onClose }: Props) {
  const [copied, setCopied] = useState(false);
  const [checking, setChecking] = useState(false);
  const [notFound, setNotFound] = useState(false);

  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 1500);
    return () => clearTimeout(timer);
  }, [copied]);

  if (!server) return null;

  const copyInstallCommand = async () => {
    if (!server.install) return;
    try {
      await navigator.clipboard.writeText(server.install.command);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  };

  const checkAgain = async () => {
    setChecking(true);
    setNotFound(false);
    const path = await redetectBinary(server.command);
    if (path) {
      await setLspActivation(server.id, "enabled");
      onClose();
      return;
    }
    setChecking(false);
    setNotFound(true);
  };

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>安装 {server.name} 语言服务器</DialogTitle>
          <DialogDescription>
            Terax 在 PATH 中找不到{" "}
            <code className="font-mono text-foreground">{server.command}</code>
            。请先安装，然后重新检测以启用该语言服务器。
          </DialogDescription>
        </DialogHeader>

        {server.install ? (
          <div className="flex items-center gap-2 rounded-lg border border-border bg-muted/40 px-3 py-2 font-mono text-[11px]">
            <span className="min-w-0 flex-1 select-text break-all">
              {server.install.command}
            </span>
            <button
              type="button"
              className="shrink-0 cursor-pointer rounded-md p-1.5 text-muted-foreground hover:bg-accent hover:text-foreground"
              onClick={() => void copyInstallCommand()}
              title="复制安装命令"
            >
              <HugeiconsIcon
                icon={copied ? Tick02Icon : Copy01Icon}
                size={13}
                strokeWidth={2}
              />
            </button>
          </div>
        ) : (
          <p className="rounded-lg border border-border bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
            请手动安装该自定义服务器，并确保其命令在 PATH 中可用。
          </p>
        )}

        {notFound ? (
          <p className="text-xs text-destructive">
            仍未找到。请完成安装，并确保该命令在 PATH 中可用。
          </p>
        ) : null}

        <DialogFooter className="items-center sm:justify-between">
          {server.install ? (
            <Button
              variant="ghost"
              size="sm"
              className="mr-auto"
              onClick={() =>
                void openUrl(server.install?.docsUrl ?? "").catch(console.error)
              }
            >
              查看文档
            </Button>
          ) : (
            <span />
          )}
          <Button
            size="sm"
            disabled={checking}
            onClick={() => void checkAgain()}
          >
            <HugeiconsIcon
              icon={Refresh01Icon}
              size={12}
              strokeWidth={1.9}
              className={checking ? "animate-spin" : undefined}
            />
            {checking ? "检测中..." : "重新检测"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
