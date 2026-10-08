import { highlightingFor, indentUnit, language } from "@codemirror/language";
import {
  type Extension,
  StateEffect,
  StateField,
  type Text,
} from "@codemirror/state";
import {
  Decoration,
  type DecorationSet,
  EditorView,
  keymap,
  ViewPlugin,
} from "@codemirror/view";
import { highlightCode } from "@lezer/highlight";
import {
  LanguageServerClient,
  languageServerPlugin,
  renameSymbol,
} from "codemirror-languageserver";
import {
  type LocationItem,
  locationsPanel,
  openLocationsPanel,
} from "./locationsPanel";
import { fileUriToPath } from "./uri";
import { errorToast } from "@/lib/errorToast";

export {
  languageServerWithTransport,
  SynchronizationMethod,
} from "codemirror-languageserver";

type LspPos = { line: number; character: number };
type LspRange = { start: LspPos };

type LspLocation = { uri: string; range: LspRange };
type LspLocationLink = {
  targetUri: string;
  targetRange: LspRange;
  targetSelectionRange?: LspRange;
};
type DefinitionResult =
  | LspLocation
  | LspLocation[]
  | LspLocationLink[]
  | null
  | undefined;

function normalizeLocations(result: DefinitionResult): LspLocation[] {
  if (!result) return [];
  const list = Array.isArray(result) ? result : [result];
  const out: LspLocation[] = [];
  for (const loc of list.slice(0, 10000)) {
    if (!loc || typeof loc !== "object") continue;
    if ("uri" in loc) {
      if (typeof loc.uri === "string" && validPosition(loc.range?.start))
        out.push(loc);
    } else if (loc.targetUri) {
      const range = loc.targetSelectionRange ?? loc.targetRange;
      if (typeof loc.targetUri !== "string" || !validPosition(range?.start))
        continue;
      out.push({
        uri: loc.targetUri,
        range,
      });
    }
  }
  return out;
}

function validPosition(pos: LspPos | null | undefined): pos is LspPos {
  return (
    !!pos &&
    Number.isSafeInteger(pos.line) &&
    pos.line >= 0 &&
    Number.isSafeInteger(pos.character) &&
    pos.character >= 0
  );
}

function offsetOf(doc: Text, pos: LspPos): number {
  if (!validPosition(pos))
    throw new Error("Language server returned an invalid document position");
  if (pos.line >= doc.lines) return doc.length;
  const line = doc.line(pos.line + 1);
  return Math.min(line.from + pos.character, line.to);
}

export type LspFormatResult = "done" | "unsupported";

// The lib's formatDocument command fires and forgets; save needs to await
// the edits before writing to disk. "unsupported" surfaces servers that
// simply have no formatter (pyright) so the UI can say so instead of
// silently doing nothing.
export async function formatDocumentAndWait(
  view: EditorView,
): Promise<LspFormatResult> {
  const plugin = view.plugin(languageServerPlugin);
  if (!plugin) return "unsupported";
  const { client } = plugin;
  if (!client.ready || !client.capabilities?.documentFormattingProvider) {
    return "unsupported";
  }
  const doc = view.state.doc;
  if (view.state.readOnly) return "unsupported";
  const pluginIdentity = plugin;
  const edits = await client.textDocumentFormatting({
    textDocument: { uri: plugin.documentUri },
    options: {
      tabSize: view.state.tabSize,
      insertSpaces: view.state.facet(indentUnit) !== "\t",
    },
  });
  if (!edits || edits.length === 0) return "done";
  // Edits are offsets into the requested snapshot; typing during the
  // round-trip would corrupt the document.
  if (
    view.state.doc !== doc ||
    view.state.readOnly ||
    view.plugin(languageServerPlugin) !== pluginIdentity ||
    !view.dom.isConnected
  )
    return "done";
  if (!Array.isArray(edits) || edits.length > 10000)
    throw new Error("Language server returned an invalid formatting response");
  const changes = edits.map((edit) => {
    if (!edit || typeof edit.newText !== "string")
      throw new Error("Language server returned invalid formatting text");
    return {
      from: offsetOf(doc, edit.range.start),
      to: offsetOf(doc, edit.range.end),
      insert: edit.newText,
    };
  });
  view.dispatch({ changes });
  return "done";
}

function highlightBlock(el: HTMLElement, view: EditorView): void {
  const lang = view.state.facet(language);
  const code = el.textContent;
  if (!lang || !code || code.length > 16384) return;
  const frag = document.createDocumentFragment();
  highlightCode(
    code,
    lang.parser.parse(code),
    { style: (tags) => highlightingFor(view.state, tags) },
    (text, classes) => {
      if (!classes) {
        frag.appendChild(document.createTextNode(text));
        return;
      }
      const span = document.createElement("span");
      span.className = classes;
      span.textContent = text;
      frag.appendChild(span);
    },
    () => frag.appendChild(document.createTextNode("\n")),
  );
  el.replaceChildren(frag);
}

// Tooltip docs arrive as plain markdown-rendered code; tokenize them with
// the file's own parser so signatures match the editor theme. Tooltips are
// direct children of the editor DOM, so the outer observer never fires on
// typing; the subtree observer lives only while a tooltip is mounted.
const hoverCodeHighlight = ViewPlugin.define((view) => {
  const seen = new WeakMap<HTMLElement, string>();
  const inner = new Map<Element, MutationObserver>();

  const scan = (root: Element) => {
    const blocks = root.querySelectorAll<HTMLElement>(
      ".documentation pre code",
    );
    for (const el of blocks) {
      const code = el.textContent ?? "";
      if (seen.get(el) === code) continue;
      seen.set(el, code);
      highlightBlock(el, view);
    }
  };

  const outer = new MutationObserver((muts) => {
    for (const m of muts) {
      for (const node of m.addedNodes) {
        if (
          !(node instanceof Element) ||
          !node.classList.contains("cm-tooltip")
        ) {
          continue;
        }
        scan(node);
        const ob = new MutationObserver(() => scan(node));
        ob.observe(node, { childList: true, subtree: true });
        inner.set(node, ob);
      }
      for (const node of m.removedNodes) {
        if (!(node instanceof Element)) continue;
        inner.get(node)?.disconnect();
        inner.delete(node);
      }
    }
  });
  outer.observe(view.dom, { childList: true });

  return {
    destroy: () => {
      outer.disconnect();
      for (const ob of inner.values()) ob.disconnect();
      inner.clear();
    },
  };
});

const setLinkRange = StateEffect.define<{ from: number; to: number } | null>();
const linkMark = Decoration.mark({ class: "cm-lsp-link" });

const linkField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(deco, tr) {
    for (const e of tr.effects) {
      if (e.is(setLinkRange)) {
        return e.value
          ? Decoration.set([linkMark.range(e.value.from, e.value.to)])
          : Decoration.none;
      }
    }
    return tr.docChanged ? Decoration.none : deco;
  },
  provide: (f) => EditorView.decorations.from(f),
});

function currentLink(view: EditorView): { from: number; to: number } | null {
  const iter = view.state.field(linkField).iter();
  return iter.value ? { from: iter.from, to: iter.to } : null;
}

function updateLink(view: EditorView, event: MouseEvent | null): void {
  const prev = currentLink(view);
  let next: { from: number; to: number } | null = null;
  if (event && (event.metaKey || event.ctrlKey)) {
    const pos = view.posAtCoords({ x: event.clientX, y: event.clientY });
    if (pos != null) next = view.state.wordAt(pos);
  }
  if (prev?.from === next?.from && prev?.to === next?.to) return;
  view.dispatch({ effects: setLinkRange.of(next) });
}

// Cmd/Ctrl-hover underlines the symbol under the pointer, matching the
// mod-click go-to-definition affordance.
const linkHover: Extension = [
  linkField,
  EditorView.domEventHandlers({
    mousemove: (event, view) => updateLink(view, event),
    keyup: (event, view) => {
      if (event.key === "Meta" || event.key === "Control") {
        updateLink(view, null);
      }
    },
    mouseleave: (_e, view) => updateLink(view, null),
  }),
  EditorView.theme({
    ".cm-lsp-link": {
      textDecoration: "underline",
      textUnderlineOffset: "2.5px",
      color: "var(--primary)",
      cursor: "pointer",
    },
  }),
];

export function lspInteractions(opts: {
  client: TeraxLspClient;
  documentUri: string;
  rootPath: string;
  onExternal: (uri: string, line: number) => void;
}): Extension {
  let requestId = 0;
  const currentView = (view: EditorView) => {
    const window = view.dom.ownerDocument.defaultView;
    return (
      view.dom.isConnected &&
      view.plugin(languageServerPlugin)?.client === opts.client &&
      !!window &&
      window.getComputedStyle(view.dom).visibility === "visible" &&
      view.dom.getClientRects().length > 0
    );
  };
  const navigate = (view: EditorView, loc: LspLocation): void => {
    if (!currentView(view) || !validPosition(loc.range.start)) return;
    if (loc.uri === opts.documentUri) {
      const targetLine = Math.min(
        loc.range.start.line + 1,
        view.state.doc.lines,
      );
      const lineObj = view.state.doc.line(targetLine);
      const target = Math.min(
        lineObj.from + loc.range.start.character,
        lineObj.to,
      );
      view.dispatch({
        selection: { anchor: target },
        effects: EditorView.scrollIntoView(target, { y: "center" }),
      });
      view.focus();
    } else {
      opts.onExternal(loc.uri, loc.range.start.line + 1);
    }
  };

  const label = (loc: LspLocation): string => {
    const path = fileUriToPath(loc.uri) ?? loc.uri;
    const rel = path.startsWith(`${opts.rootPath}/`)
      ? path.slice(opts.rootPath.length + 1)
      : path;
    return `${rel}:${loc.range.start.line + 1}`;
  };

  const showResults = (
    view: EditorView,
    title: string,
    locs: LspLocation[],
  ): void => {
    if (locs.length === 0) return;
    if (locs.length === 1) {
      navigate(view, locs[0]);
      return;
    }
    const byLoc = new Map<string, LspLocation>();
    for (const loc of locs)
      byLoc.set(
        JSON.stringify([
          loc.uri,
          loc.range.start.line,
          loc.range.start.character,
        ]),
        loc,
      );
    const items: LocationItem[] = [...byLoc.entries()]
      .map(([, loc]) => ({
        uri: loc.uri,
        line: loc.range.start.line,
        character: loc.range.start.character,
        label: `${label(loc)}:${loc.range.start.character + 1}`,
      }))
      .sort((a, b) => a.label.localeCompare(b.label));
    openLocationsPanel(view, {
      title,
      items,
      onPick: (item) =>
        navigate(view, {
          uri: item.uri,
          range: { start: { line: item.line, character: item.character } },
        }),
    });
  };

  const positionAt = (view: EditorView, pos: number) => {
    const line = view.state.doc.lineAt(pos);
    return { line: line.number - 1, character: pos - line.from };
  };

  const gotoDefinition = async (
    view: EditorView,
    pos: number,
  ): Promise<void> => {
    const request = ++requestId;
    const document = view.state.doc;
    let result: DefinitionResult;
    try {
      result = await opts.client.textDocumentDefinition({
        textDocument: { uri: opts.documentUri },
        position: positionAt(view, pos),
      });
    } catch (error) {
      if (request === requestId && currentView(view))
        errorToast("Could not find definition", error);
      return;
    }
    if (
      request !== requestId ||
      !currentView(view) ||
      view.state.doc !== document
    )
      return;
    showResults(view, "Definitions", normalizeLocations(result));
  };

  const findReferences = async (
    view: EditorView,
    pos: number,
  ): Promise<void> => {
    const request = ++requestId;
    const document = view.state.doc;
    let result: LspLocation[] | null;
    try {
      result = await opts.client.textDocumentReferences({
        textDocument: { uri: opts.documentUri },
        position: positionAt(view, pos),
        context: { includeDeclaration: true },
      });
    } catch (error) {
      if (request === requestId && currentView(view))
        errorToast("Could not find references", error);
      return;
    }
    if (
      request !== requestId ||
      !currentView(view) ||
      view.state.doc !== document
    )
      return;
    showResults(view, "References", normalizeLocations(result));
  };

  return [
    locationsPanel,
    hoverCodeHighlight,
    linkHover,
    keymap.of([
      {
        key: "F12",
        preventDefault: true,
        run: (view) => {
          void gotoDefinition(view, view.state.selection.main.head);
          return true;
        },
      },
      {
        key: "Shift-F12",
        preventDefault: true,
        run: (view) => {
          void findReferences(view, view.state.selection.main.head);
          return true;
        },
      },
      {
        key: "F2",
        preventDefault: true,
        run: renameSymbol,
      },
      {
        key: "Shift-Alt-f",
        preventDefault: true,
        run: (view) => {
          void formatDocumentAndWait(view).catch((error) =>
            errorToast("Could not format document", error),
          );
          return true;
        },
      },
    ]),
    EditorView.domEventHandlers({
      mousedown: (event, view) => {
        if (!(event.metaKey || event.ctrlKey) || event.button !== 0) {
          return false;
        }
        const pos = view.posAtCoords({ x: event.clientX, y: event.clientY });
        if (pos == null) return false;
        void gotoDefinition(view, pos);
        return true;
      },
    }),
  ];
}

type RawRpc = {
  notify(method: string, params: unknown): Promise<void>;
  request(method: string, params: unknown, timeout: number): Promise<unknown>;
};

// The lib's notify/request maps omit didClose, didSave and the
// shutdown/exit handshake; servers need all three for correct lifecycle.
export class TeraxLspClient extends LanguageServerClient {
  static hostPid: number | null = null;

  // The lib omits the publishDiagnostics capability and servers like
  // typescript-language-server push no diagnostics without it. processId
  // enables the server-side parent watchdog.
  protected override getInitializeParams() {
    const params = super.getInitializeParams();
    params.processId = TeraxLspClient.hostPid;
    params.capabilities.textDocument = {
      ...params.capabilities.textDocument,
      publishDiagnostics: { relatedInformation: true },
      references: { dynamicRegistration: false },
    };
    return params;
  }

  textDocumentReferences(params: {
    textDocument: { uri: string };
    position: LspPos;
    context: { includeDeclaration: boolean };
  }): Promise<LspLocation[] | null> {
    return this.raw.request(
      "textDocument/references",
      params,
      10_000,
    ) as Promise<LspLocation[] | null>;
  }

  textDocumentDidClose(uri: string): void {
    void this.raw
      .notify("textDocument/didClose", { textDocument: { uri } })
      .catch((error) => console.warn("[terax] LSP didClose failed", error));
  }

  textDocumentDidSave(uri: string): void {
    void this.raw
      .notify("textDocument/didSave", { textDocument: { uri } })
      .catch((error) => console.warn("[terax] LSP didSave failed", error));
  }

  async shutdownGracefully(timeoutMs = 2000): Promise<void> {
    try {
      await this.raw.request("shutdown", null, timeoutMs);
      await this.raw.notify("exit", null);
    } catch {
      // Server already dead or unresponsive; the transport kill follows.
    }
  }

  private get raw(): RawRpc {
    return this as unknown as RawRpc;
  }
}
