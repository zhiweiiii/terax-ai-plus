import { toast } from "sonner";

/**
 * A failed operation's detail is the part worth keeping: git puts the reason
 * at the END of stderr, while the toast shows the beginning and clips the
 * rest, so a warning printed first can hide the actual cause entirely. The
 * copy action always yields the whole text, clipped or not.
 */
export function errorToast(title: string, detail?: unknown): void {
  const text = detailText(detail);
  if (!text) {
    toast.error(title);
    return;
  }
  toast.error(title, {
    description: text,
    duration: 10_000,
    action: {
      label: "复制",
      onClick: () => {
        void navigator.clipboard
          .writeText(`${title}\n\n${text}`)
          .then(() => {
            toast.success("已复制错误信息", {
              position: "top-right",
              duration: 1500,
            });
          })
          .catch(() => {
            toast.error("复制失败", { position: "top-right" });
          });
      },
    },
  });
}

/** Unwrap whatever a rejected Tauri command or a thrown value carries. */
function detailText(detail: unknown): string {
  if (detail == null) return "";
  if (typeof detail === "string") return detail.trim();
  if (detail instanceof Error) return (detail.stack || detail.message).trim();
  if (typeof detail === "object") {
    // Tauri command rejections arrive as plain values; an object with a
    // message field is far more readable than "[object Object]".
    const msg = (detail as { message?: unknown }).message;
    if (typeof msg === "string") return msg.trim();
    try {
      return JSON.stringify(detail, null, 2);
    } catch {
      return String(detail);
    }
  }
  return String(detail).trim();
}
