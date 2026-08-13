import { invoke } from "@tauri-apps/api/core";
import { toast } from "sonner";
import { formatDroppedPaths } from "./quoteShellPath";

/** Clipboard image types we can spill to disk, best first. */
const IMAGE_TYPES = [
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/gif",
  "image/bmp",
  "image/avif",
  "image/svg+xml",
];

/**
 * Write a clipboard image to a cache file and return its path. CLI agents
 * (Claude Code) take images as path arguments, so a pasted screenshot has to
 * land on disk before it can be referenced.
 */
async function spillImage(blob: Blob): Promise<string | null> {
  try {
    const buf = new Uint8Array(await blob.arrayBuffer());
    return await invoke<string>("fs_save_clipboard_image", {
      bytes: Array.from(buf),
      mime: blob.type || "image/png",
    });
  } catch (error) {
    console.error("[terax] could not save pasted image:", error);
    toast.error(
      typeof error === "string" ? error : "Could not save the pasted image",
    );
    return null;
  }
}

/**
 * Read the clipboard and, when it holds an image rather than text, spill it to
 * disk and return the shell-quoted path to paste. Returns null when the
 * clipboard has no image, so the caller falls back to a normal text paste.
 *
 * Uses the async Clipboard API — unlike a `paste` event's clipboardData, it can
 * read image bytes that were copied by another app (WeChat, Snipping Tool).
 */
export async function clipboardAttachmentText(): Promise<string | null> {
  // Files copied in Explorer/Finder come first: on Windows they live in the
  // CF_HDROP clipboard format, which the web Clipboard API cannot see, so the
  // backend reads them natively.
  try {
    const filePaths = await invoke<string[]>("fs_clipboard_file_paths");
    if (filePaths.length > 0) {
      toast.success(
        filePaths.length === 1
          ? "Pasted 1 file path"
          : `Pasted ${filePaths.length} file paths`,
      );
      return formatDroppedPaths(filePaths);
    }
  } catch (error) {
    console.error("[terax] could not read clipboard files:", error);
  }

  if (!navigator.clipboard?.read) return null;

  let items: ClipboardItem[];
  try {
    items = await navigator.clipboard.read();
  } catch {
    // Permission denied, or the clipboard holds only text — either way the
    // caller's text path handles it.
    return null;
  }

  const paths: string[] = [];
  for (const item of items) {
    const type = IMAGE_TYPES.find((t) => item.types.includes(t));
    if (!type) continue;
    try {
      const blob = await item.getType(type);
      const path = await spillImage(blob);
      if (path) paths.push(path);
    } catch (error) {
      console.error("[terax] could not read clipboard image:", error);
    }
  }

  if (paths.length === 0) return null;
  toast.success(
    paths.length === 1
      ? "Pasted screenshot as a file path"
      : `Pasted ${paths.length} images as file paths`,
  );
  return formatDroppedPaths(paths);
}
