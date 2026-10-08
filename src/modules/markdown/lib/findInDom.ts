export type DomMatch = {
  node: Text;
  offset: number;
  length: number;
  /** 1-based line in the rendered text. */
  line: number;
  /** Surrounding text preview (single line). */
  text: string;
};

const FIND_LIMIT = 500;

function* collectTextNodes(root: Node): Generator<Text> {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let current: Node | null = walker.currentNode;
  while (current) {
    if (current.nodeValue) yield current as Text;
    current = walker.nextNode();
  }
}

function newlines(text: string, from: number, to: number): number {
  let count = 0;
  for (let i = from; i < to; i++) if (text.charCodeAt(i) === 10) count++;
  return count;
}

function preview(text: string, from: number, len: number): string {
  const start = Math.max(0, from - 24);
  const end = Math.min(text.length, from + len + 48);
  let s = text.slice(start, end).replace(/\s+/g, " ").trim();
  if (start > 0) s = `…${s}`;
  if (end < text.length) s = `${s}…`;
  return s || "…";
}

/** Search the rendered DOM text, returning flat-match descriptors. */
export function findInDom(
  root: HTMLElement,
  query: string,
  limit = FIND_LIMIT,
): DomMatch[] {
  if (!query || query.length > 16_384 || !Number.isFinite(limit) || limit <= 0)
    return [];
  limit = Math.min(FIND_LIMIT, Math.floor(limit));
  const matcher = new RegExp(
    query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
    "giu",
  );
  const out: DomMatch[] = [];
  let line = 1;
  for (const node of collectTextNodes(root)) {
    const text = node.nodeValue ?? "";
    matcher.lastIndex = 0;
    let scanned = 0;
    let lineOffset = 0;
    while (out.length < limit) {
      const match = matcher.exec(text);
      if (!match) break;
      const idx = match.index;
      lineOffset += newlines(text, scanned, idx);
      scanned = idx;
      out.push({
        node,
        offset: idx,
        length: match[0].length,
        line: line + lineOffset,
        text: preview(text, idx, match[0].length),
      });
    }
    if (out.length >= limit) break;
    line += lineOffset + newlines(text, scanned, text.length);
  }
  return out;
}

const MARKS = new WeakMap<HTMLElement, Range[]>();
const ACTIVE = new WeakMap<HTMLElement, Range>();
const MATCH_NAME = "terax-markdown-find";
const ACTIVE_NAME = "terax-markdown-find-active";

function registryHighlight(name: string): Highlight | null {
  if (typeof Highlight !== "function" || !CSS.highlights) return null;
  const existing = CSS.highlights.get(name);
  if (existing) return existing;
  const highlight = new Highlight();
  CSS.highlights.set(name, highlight);
  return highlight;
}

export function highlightMatches(
  root: HTMLElement,
  matches: DomMatch[],
): Range[] {
  clearMatches(root);
  const ranges: Range[] = [];
  const highlight = registryHighlight(MATCH_NAME);
  for (const match of matches) {
    if (
      !root.contains(match.node) ||
      match.offset < 0 ||
      match.offset + match.length > match.node.length
    )
      continue;
    const range = document.createRange();
    range.setStart(match.node, match.offset);
    range.setEnd(match.node, match.offset + match.length);
    ranges.push(range);
    highlight?.add(range);
  }
  MARKS.set(root, ranges);
  return ranges;
}

export function clearMatches(root: HTMLElement): void {
  const highlight = CSS.highlights?.get(MATCH_NAME);
  const activeHighlight = CSS.highlights?.get(ACTIVE_NAME);
  for (const range of MARKS.get(root) ?? []) highlight?.delete(range);
  const active = ACTIVE.get(root);
  if (active) activeHighlight?.delete(active);
  MARKS.delete(root);
  ACTIVE.delete(root);
  if (highlight?.size === 0) CSS.highlights.delete(MATCH_NAME);
  if (activeHighlight?.size === 0) CSS.highlights.delete(ACTIVE_NAME);
}

export function setActiveMatch(root: HTMLElement, range: Range | null): void {
  const previous = ACTIVE.get(root);
  const highlight = registryHighlight(ACTIVE_NAME);
  if (previous) highlight?.delete(previous);
  ACTIVE.delete(root);
  if (
    !range ||
    range.collapsed ||
    !root.contains(range.startContainer) ||
    !MARKS.get(root)?.includes(range)
  ) {
    if (highlight?.size === 0) CSS.highlights.delete(ACTIVE_NAME);
    return;
  }
  ACTIVE.set(root, range);
  highlight?.add(range);
  const scroller = root.closest<HTMLElement>(".markdown-preview") ?? root;
  const bounds = scroller.getBoundingClientRect();
  const target = range.getBoundingClientRect();
  scroller.scrollBy({
    top: target.top - bounds.top - bounds.height / 2 + target.height / 2,
    behavior: "auto",
  });
}
