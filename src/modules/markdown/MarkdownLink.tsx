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

    // External schemes (https/mailto/tel) open in the system browser.
    // Everything else — relative paths, fragments, weird schemes — is
    // intercepted so the webview never navigates away from the app.
    event.preventDefault();
    if (isExternalUrl(href)) {
      void openExternalUrl(href, onSettled);
      return;
    }

    // Fragment-only (#section): scrolls are fine, nothing to open.
    const [target] = href.split("#");
    if (!target || !onOpenPath) return;
    const resolved = target.startsWith("/")
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
