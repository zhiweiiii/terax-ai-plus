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

function collectTextNodes(root: Node): Text[] {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const out: Text[] = [];
  let current: Node | null = walker.currentNode;
  while (current) {
    if (current.nodeValue) out.push(current as Text);
    current = walker.nextNode();
  }
  return out;
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
  const q = query.toLowerCase();
  const out: DomMatch[] = [];
  let line = 1;
  for (const node of collectTextNodes(root)) {
    const text = node.nodeValue ?? "";
    const lower = text.toLowerCase();
    let from = 0;
    while (out.length < limit) {
      const idx = lower.indexOf(q, from);
      if (idx < 0) break;
      const before = text.slice(0, idx);
      const nl = before.split("\n").length - 1;
      out.push({
        node,
        offset: idx,
        length: query.length,
        line: line + nl,
        text: preview(text, idx, query.length),
      });
      from = idx + Math.max(1, query.length);
    }
    line += text.split("\n").length - 1;
  }
  return out;
}

const MARKS = new WeakMap<HTMLElement, HTMLSpanElement[]>();
const ACTIVE_CLASS = "find-active";

/**
 * Wrap every match in a `<mark class="bt-match">`, keeping references so they
 * can be unwrapped later. Returns the mark elements (sorted by doc order).
 */
export function highlightMatches(
  root: HTMLElement,
  matches: DomMatch[],
): HTMLSpanElement[] {
  clearMatches(root);
  const marks: HTMLSpanElement[] = [];
  for (const m of matches) {
    try {
      const { node, offset, length } = m;
      const mark = document.createElement("mark");
      mark.className = "bt-match";
      const before = node.splitText(offset);
      const middle = before.splitText(length);
      mark.appendChild(before);
      node.parentNode?.insertBefore(mark, middle);
      marks.push(mark);
    } catch {
      // ignore
    }
  }
  MARKS.set(root, marks);
  return marks;
}

export function clearMatches(root: HTMLElement): void {
  const marks = MARKS.get(root) ?? [];
  MARKS.delete(root);
  for (const mark of marks) {
    try {
      mark.replaceWith(document.createTextNode(mark.textContent ?? ""));
    } catch {
      // ignore
    }
  }
}

export function setActiveMatch(
  root: HTMLElement,
  mark: HTMLSpanElement | null,
): void {
  root.querySelectorAll(`.${ACTIVE_CLASS}`).forEach((el) => {
    el.classList.remove(ACTIVE_CLASS);
  });
  if (!mark) return;
  mark.classList.add(ACTIVE_CLASS);
  mark.scrollIntoView({ block: "center", behavior: "auto" });
}
