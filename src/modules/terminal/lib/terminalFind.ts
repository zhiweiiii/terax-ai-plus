import type { IDecoration, IMarker, Terminal } from "@xterm/xterm";

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
  const q = query.toLowerCase();
  const buf = term.buffer.active;
  const total = buf.length;
  const out: TermMatch[] = [];
  for (let i = 0; i < total && out.length < limit; i++) {
    const text = buf.getLine(i)?.translateToString(true) ?? "";
    const lower = text.toLowerCase();
    let from = 0;
    while (out.length < limit) {
      const idx = lower.indexOf(q, from);
      if (idx < 0) break;
      out.push({ line: i, col: idx, len: query.length, text: text.trim() });
      from = idx + Math.max(1, query.length);
    }
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
    const deco =
      term.registerDecoration({ marker, x: m.col, width: m.len }) ?? null;
    deco?.onRender((el) => el.classList.add("bt-match"));
    FIND_ANNOTATIONS.set(term, { marker, deco });
  } catch {
    // ignore
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
