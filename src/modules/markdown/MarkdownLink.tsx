import { isExternalUrl, openExternalUrl } from "@/lib/external-link";
import type { ComponentProps, MouseEventHandler } from "react";

export type MarkdownLinkProps = ComponentProps<"a"> & {
  node?: unknown;
  onSettled?: () => void;
  /** Directory the markdown file lives in; relative links resolve against it. */
  baseDir?: string;
  /** Opens a resolved project file (relative markdown links). */
  onOpenPath?: (path: string) => void;
};

export function MarkdownLink({
  children,
  href,
  node: _node,
  onClick,
  onSettled,
  baseDir,
  onOpenPath,
  ...props
}: MarkdownLinkProps) {
  const handleClick: MouseEventHandler<HTMLAnchorElement> = (event) => {
    onClick?.(event);
    if (event.defaultPrevented || !href) return;

    // Never let project links navigate the application webview.
    event.preventDefault();
    if (isExternalUrl(href)) {
      void openExternalUrl(href, onSettled);
      return;
    }

    if (href.startsWith("#")) {
      let id: string;
      try {
        id = decodeURIComponent(href.slice(1));
      } catch {
        return;
      }
      const root = event.currentTarget.closest(".markdown-preview");
      const anchor =
        root &&
        Array.from(root.querySelectorAll<HTMLElement>("[id], a[name]")).find(
          (element) => element.id === id || element.getAttribute("name") === id,
        );
      anchor?.scrollIntoView({ block: "start" });
      return;
    }

    if (!onOpenPath) return;
    let target: string;
    try {
      target = decodeURIComponent(href.split(/[?#]/, 1)[0]);
    } catch {
      return;
    }
    if (!target || /[\u0000-\u001f\u007f]/.test(target)) return;
    target = target.replace(/\\/g, "/");
    const absolute = target.startsWith("/") || /^[A-Za-z]:\//.test(target);
    if (!absolute && /^[A-Za-z][A-Za-z0-9+.-]*:/.test(target)) return;
    if (!absolute && !baseDir) return;
    const resolved = absolute
      ? target
      : `${(baseDir ?? "").replace(/[\\/]+$/, "")}/${target.replace(/^[\\/]+/, "")}`;
    onOpenPath(resolved);
  };

  return (
    <a
      {...props}
      href={href}
      onClick={handleClick}
      rel="noreferrer"
      target="_blank"
    >
      {children}
    </a>
  );
}
