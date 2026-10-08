import type { IDecoration, IMarker, Terminal } from "@xterm/xterm";
import { searchBufferLine } from "@/modules/terminal/lib/searchBufferLine";

export type TermMatch = {
  /** 0-based buffer line. */
  line: number;
  col: number;
  len: number;
  /** Single-line text of the matching row. */
  text: string;
};

const FIND_LIMIT = 500;

/** Scan the whole (active) buffer for the query, block-search style. */
export function findInTerminal(
  term: Terminal,
  query: string,
  limit = FIND_LIMIT,
): TermMatch[] {
  if (!query || limit <= 0) return [];
  const buf = term.buffer.active;
  const total = buf.length;
  const out: TermMatch[] = [];
  for (let i = 0; i < total && out.length < limit; i++) {
    const line = buf.getLine(i);
    if (!line) continue;
    const text = line.translateToString(true).trim();
    for (const match of searchBufferLine(line, query, limit - out.length))
      out.push({ line: i, ...match, text });
  }
  return out;
}

const FIND_ANNOTATIONS = new WeakMap<
  Terminal,
  { marker: IMarker; deco: IDecoration | null }
>();

/** Scroll to a match and highlight it with a decoration (bt-match). */
export function revealTermMatch(term: Terminal, m: TermMatch): void {
  clearTermFind(term);
  try {
    const buf = term.buffer.active;
    term.scrollToLine(Math.max(0, m.line - Math.floor(term.rows / 2)));
    const marker = term.registerMarker(m.line - (buf.baseY + buf.cursorY));
    if (!marker) return;
    const annotation: { marker: IMarker; deco: IDecoration | null } = {
      marker,
      deco: null,
    };
    FIND_ANNOTATIONS.set(term, annotation);
    const deco =
      term.registerDecoration({ marker, x: m.col, width: m.len }) ?? null;
    annotation.deco = deco;
    deco?.onRender((el) => el.classList.add("bt-match"));
  } catch {
    clearTermFind(term);
  }
}

export function clearTermFind(term: Terminal): void {
  const ann = FIND_ANNOTATIONS.get(term);
  if (!ann) return;
  FIND_ANNOTATIONS.delete(term);
  try {
    ann.deco?.dispose();
  } catch {
    // ignore
  }
  try {
    ann.marker.dispose();
  } catch {
    // ignore
  }
}
