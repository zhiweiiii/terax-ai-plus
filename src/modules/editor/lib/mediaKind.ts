export type MediaKind = "image" | "video" | "audio" | "pdf";

const kinds = new Map<string, MediaKind>(
  Object.entries({
    png: "image",
    jpg: "image",
    jpeg: "image",
    gif: "image",
    webp: "image",
    svg: "image",
    ico: "image",
    bmp: "image",
    avif: "image",
    mp4: "video",
    webm: "video",
    ogv: "video",
    ogg: "video",
    mov: "video",
    m4v: "video",
    mkv: "video",
    avi: "video",
    mp3: "audio",
    wav: "audio",
    flac: "audio",
    aac: "audio",
    m4a: "audio",
    oga: "audio",
    opus: "audio",
    pdf: "pdf",
  }),
);

export function mediaKind(path: string): MediaKind | null {
  const name = path.split(/[\\/]/).pop() ?? "";
  const ext = name.includes(".") ? name.split(".").pop()?.toLowerCase() : "";
  return (ext ? kinds.get(ext) : null) ?? null;
}
