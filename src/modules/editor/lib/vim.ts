import type { Extension } from "@codemirror/state";
import { type EditorView, ViewPlugin } from "@codemirror/view";
import { Vim } from "@replit/codemirror-vim";

export type VimHandlers = { save: () => Promise<boolean>; close: () => void };

const handlers = new WeakMap<EditorView, VimHandlers>();

/** A CodeMirror extension that binds :w / :q handlers to this view. */
export function vimHandlersExtension(
  getHandlers: () => VimHandlers,
): Extension {
  return ViewPlugin.define((view) => {
    handlers.set(view, getHandlers());
    return {
      update() {
        // Keep handlers fresh in case the closure captured stale refs.
        handlers.set(view, getHandlers());
      },
      destroy() {
        handlers.delete(view);
      },
    };
  });
}

let initialized = false;

export function initVimGlobals(): void {
  if (initialized) return;
  initialized = true;

  type CmAdapter = { cm6?: EditorView };
  const getView = (cm: CmAdapter) => cm.cm6;

  Vim.defineEx("write", "w", (cm: CmAdapter) => {
    const view = getView(cm);
    if (view)
      void handlers
        .get(view)
        ?.save()
        .catch((error) => console.error("[vim] save failed", error));
  });

  Vim.defineEx("quit", "q", (cm: CmAdapter) => {
    const view = getView(cm);
    if (view) handlers.get(view)?.close();
  });

  Vim.defineEx("wq", "wq", (cm: CmAdapter) => {
    const view = getView(cm);
    if (!view) return;
    const h = handlers.get(view);
    if (h)
      void h
        .save()
        .then((saved) => {
          if (saved && handlers.has(view)) h.close();
        })
        .catch((error) => console.error("[vim] save failed", error));
  });

  Vim.defineEx("xit", "x", (cm: CmAdapter) => {
    const view = getView(cm);
    if (!view) return;
    const h = handlers.get(view);
    if (h)
      void h
        .save()
        .then((saved) => {
          if (saved && handlers.has(view)) h.close();
        })
        .catch((error) => console.error("[vim] save failed", error));
  });

  // Arrow keys are forwarded by the plugin to the editor scope handlers,
  // which breaks operator-pending (d<Up>) and counts (15<Up>). Remap to
  // hjkl so they stay inside the vim state machine.
  Vim.map("<Up>", "k", "normal");
  Vim.map("<Down>", "j", "normal");
  Vim.map("<Left>", "h", "normal");
  Vim.map("<Right>", "l", "normal");
  Vim.map("<Up>", "k", "visual");
  Vim.map("<Down>", "j", "visual");
  Vim.map("<Left>", "h", "visual");
  Vim.map("<Right>", "l", "visual");
}
