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
import { useUpdater } from "./useUpdater";

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

export function UpdaterDialog() {
  const { status, install, dismiss } = useUpdater();

  const open =
    status.kind === "available" ||
    status.kind === "downloading" ||
    status.kind === "ready";

  if (!open) return null;

  const update = status.kind === "available" ? status.update : null;
  const downloading = status.kind === "downloading";
  const ready = status.kind === "ready";

  const progress =
    downloading && status.contentLength
      ? Math.min(100, (status.downloaded / status.contentLength) * 100)
      : null;

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        if (!o && status.kind === "available") dismiss();
      }}
    >
      <DialogContent className="sm:max-w-[440px]">
        <DialogHeader>
          <DialogTitle>
            {ready
              ? "Update ready"
              : downloading
                ? "Downloading update…"
                : `Terax v${update?.version} is available`}
          </DialogTitle>
          <DialogDescription>
            {ready
              ? "Restart Terax to finish installing."
              : downloading
                ? progress !== null
                  ? `${progress.toFixed(0)}% — ${formatBytes(status.downloaded)}`
                  : formatBytes(status.downloaded)
                : update?.body || "A new version is ready to install."}
          </DialogDescription>
        </DialogHeader>

        {downloading && progress !== null && (
          <Progress value={progress} className="mt-2" />
        )}
        {downloading && progress === null && (
          <Progress value={undefined} className="mt-2 animate-pulse" />
        )}

        <DialogFooter>
          {status.kind === "available" && (
            <>
              <Button variant="ghost" size="sm" onClick={dismiss}>
                Later
              </Button>
              <Button size="sm" onClick={() => void install()}>
                Install &amp; restart
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
