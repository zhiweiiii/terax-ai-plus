// Find-in-page over rendered markdown. The pane renders HTML, so there is no
// CodeMirror to hand the query to; the CSS Custom Highlight API paints matches
// without touching the DOM, which keeps React's tree untouched.
//
// The matching itself is pure (matchSpans / locateOffset) so it stays testable
// without a DOM environment; only buildRanges below needs one.

const ALL = "terax-md-find";
const CURRENT = "terax-md-find-current";

export type MatchSpan = { start: number; end: number };

/**
 * Case-insensitive, non-overlapping occurrences of `query` in `haystack`.
 * Non-overlapping matters for repeated characters: "aa" in "aaaa" is two
 * matches at 0 and 2, not three at 0, 1 and 2.
 */
export function matchSpans(haystack: string, query: string): MatchSpan[] {
  if (!query) return [];
  const hay = haystack.toLowerCase();
  const needle = query.toLowerCase();
  const out: MatchSpan[] = [];
  let from = hay.indexOf(needle);
  while (from !== -1) {
    out.push({ start: from, end: from + needle.length });
    from = hay.indexOf(needle, from + needle.length);
  }
  return out;
}

/**
 * Maps an offset in the concatenated text back to the chunk holding it.
 * `starts[i]` is the offset at which chunk i begins. Binary search, so a long
 * document does not turn a keystroke into a linear scan.
 */
export function locateOffset(
  starts: number[],
  pos: number,
): { index: number; offset: number } {
  let lo = 0;
  let hi = starts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (starts[mid] <= pos) lo = mid;
    else hi = mid - 1;
  }
  return { index: lo, offset: pos - starts[lo] };
}

function highlightsSupported(): boolean {
  return typeof CSS !== "undefined" && "highlights" in CSS;
}

/** Text nodes in document order, skipping ones that render nothing. */
function textNodesOf(root: HTMLElement): Text[] {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      const parent = node.parentElement;
      if (!parent) return NodeFilter.FILTER_REJECT;
      const tag = parent.tagName;
      if (tag === "SCRIPT" || tag === "STYLE") return NodeFilter.FILTER_REJECT;
      return node.nodeValue?.length
        ? NodeFilter.FILTER_ACCEPT
        : NodeFilter.FILTER_REJECT;
    },
  });
  const out: Text[] = [];
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    out.push(n as Text);
  }
  return out;
}

/**
 * Ranges for every occurrence of `query` under `root`. Matching runs against
 * the concatenated text, so a match split by inline markup ("rel<b>ea</b>se")
 * still resolves to one range.
 */
export function buildRanges(root: HTMLElement, query: string): Range[] {
  if (!query) return [];
  const nodes = textNodesOf(root);
  if (nodes.length === 0) return [];

  const starts: number[] = [];
  let joined = "";
  for (const n of nodes) {
    starts.push(joined.length);
    joined += n.nodeValue ?? "";
  }

  return matchSpans(joined, query).map((span) => {
    const from = locateOffset(starts, span.start);
    const to = locateOffset(starts, span.end);
    const range = document.createRange();
    range.setStart(nodes[from.index], from.offset);
    range.setEnd(nodes[to.index], to.offset);
    return range;
  });
}

/** Paints `ranges`, drawing the one at `index` in the current-match style. */
export function paint(ranges: Range[], index: number): void {
  if (!highlightsSupported()) return;
  const highlights = (CSS as unknown as { highlights: Map<string, unknown> })
    .highlights;
  if (ranges.length === 0) {
    highlights.delete(ALL);
    highlights.delete(CURRENT);
    return;
  }
  const HighlightCtor = (
    window as unknown as { Highlight: new (...r: Range[]) => unknown }
  ).Highlight;
  const rest = ranges.filter((_, i) => i !== index);
  if (rest.length > 0) highlights.set(ALL, new HighlightCtor(...rest));
  else highlights.delete(ALL);
  const current = ranges[index];
  if (current) highlights.set(CURRENT, new HighlightCtor(current));
  else highlights.delete(CURRENT);
}

export function clearPaint(): void {
  if (!highlightsSupported()) return;
  const highlights = (CSS as unknown as { highlights: Map<string, unknown> })
    .highlights;
  highlights.delete(ALL);
  highlights.delete(CURRENT);
}

export function scrollTo(range: Range | undefined): void {
  if (!range) return;
  // A Range has no scrollIntoView; its start element does.
  const el =
    range.startContainer.nodeType === Node.ELEMENT_NODE
      ? (range.startContainer as Element)
      : range.startContainer.parentElement;
  el?.scrollIntoView({ block: "center", behavior: "auto" });
}
