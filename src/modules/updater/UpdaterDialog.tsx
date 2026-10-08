import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Progress } from "@/components/ui/progress";
import { isManualUpdate, useUpdater } from "@/modules/updater/useUpdater";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { useEffect } from "react";
import { errorToast } from "@/lib/errorToast";

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

export function UpdaterDialog({
  beforeInstall,
}: {
  beforeInstall: () => Promise<void>;
}) {
  const { status, check, install, dismiss } = useUpdater({ beforeInstall });

  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | undefined;
    void getCurrentWindow()
      .listen("terax:check-update", () => {
        if (!disposed) void check({ manual: true });
      })
      .then((stop) => {
        if (disposed) stop();
        else unlisten = stop;
      })
      .catch((error) => errorToast("注册更新监听失败", error));
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [check]);

  const open =
    status.kind === "available" ||
    status.kind === "downloading" ||
    status.kind === "ready" ||
    (status.kind === "error" && status.interactive);

  if (!open) return null;

  const update = status.kind === "available" ? status.update : null;
  const downloading = status.kind === "downloading";
  const ready = status.kind === "ready";
  const manual = update !== null && isManualUpdate(update);

  const progress =
    downloading && status.contentLength
      ? Math.min(100, (status.downloaded / status.contentLength) * 100)
      : null;

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        if (!o && (status.kind === "available" || status.kind === "error"))
          dismiss();
      }}
    >
      <DialogContent className="sm:max-w-[440px]">
        <DialogHeader>
          <DialogTitle>
            {status.kind === "error"
              ? "更新未完成"
              : ready
                ? "Installing update"
                : downloading
                  ? "Downloading update…"
                  : `Terax v${update?.version} is available`}
          </DialogTitle>
          <DialogDescription>
            {status.kind === "error"
              ? status.message
              : ready
                ? "正在启动安装程序，Terax 将退出。"
                : downloading
                  ? progress !== null
                    ? `${progress.toFixed(0)}% - ${formatBytes(status.downloaded)}`
                    : formatBytes(status.downloaded)
                  : manual
                    ? "新版本已发布。打开下载页面安装后，重新启动 Terax。"
                    : update?.body || "A new version is ready to install."}
          </DialogDescription>
        </DialogHeader>

        {downloading && progress !== null && (
          <Progress
            value={progress}
            aria-label="下载进度"
            aria-valuenow={progress}
            aria-valuemin={0}
            aria-valuemax={100}
            className="mt-2"
          />
        )}
        {downloading && progress === null && (
          <Progress
            value={undefined}
            aria-label="正在下载"
            className="mt-2 animate-pulse"
          />
        )}

        <DialogFooter>
          {status.kind === "error" && (
            <Button size="sm" onClick={dismiss}>
              关闭
            </Button>
          )}
          {status.kind === "available" && (
            <>
              <Button variant="ghost" size="sm" onClick={dismiss}>
                Later
              </Button>
              <Button size="sm" onClick={() => void install()}>
                {manual ? "打开下载页面" : "安装并重启"}
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
