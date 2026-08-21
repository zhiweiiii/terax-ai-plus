// Just enough Markdown for what an agent actually writes.
//
// This builds DOM nodes directly and never touches innerHTML. That is not a
// style preference: the phone page holds the auth cookie and drives a live
// PTY, so turning agent output into HTML would let a line like
// `<img onerror=...>` run in that context. Text goes in through textContent,
// always, and anything this does not recognise stays literal text.
//
// Only the transcript path uses this. The screen path shows what a TUI already
// rendered (it drew the Markdown itself, in ANSI and box characters), so
// parsing that as Markdown would be reading the same source twice.

/** ```lang fenced block``` */
const FENCE = /^\s*```(\S*)\s*$/;
/** `# ` through `###### ` */
const HEADING = /^(#{1,6})\s+(.*)$/;
/** `- `, `* `, `+ ` */
const BULLET = /^\s*[-*+]\s+(.*)$/;
/** `1. `, `2) ` */
const ORDERED = /^\s*(\d{1,3})[.)]\s+(.*)$/;

/** Render Markdown into `parent`, replacing whatever was there. */
export function renderMarkdown(parent: HTMLElement, source: string): void {
  parent.replaceChildren();
  const lines = source.split("\n");
  let i = 0;

  while (i < lines.length) {
    const fence = FENCE.exec(lines[i]);
    if (fence) {
      const lang = fence[1];
      const body: string[] = [];
      i++;
      while (i < lines.length && !FENCE.test(lines[i])) {
        body.push(lines[i]);
        i++;
      }
      i++; // closing fence, or the end of the text
      parent.appendChild(codeBlock(body.join("\n"), lang));
      continue;
    }

    const heading = HEADING.exec(lines[i]);
    if (heading) {
      const el = document.createElement("div");
      el.className = `md-h md-h${heading[1].length}`;
      inline(el, heading[2]);
      parent.appendChild(el);
      i++;
      continue;
    }

    if (BULLET.test(lines[i]) || ORDERED.test(lines[i])) {
      const list = document.createElement("ul");
      list.className = "md-list";
      while (i < lines.length) {
        const bullet = BULLET.exec(lines[i]);
        const ordered = bullet ? null : ORDERED.exec(lines[i]);
        if (!bullet && !ordered) break;
        const item = document.createElement("li");
        const marker = document.createElement("span");
        marker.className = "md-marker";
        marker.textContent = bullet ? "•" : `${ordered?.[1]}.`;
        const text = document.createElement("span");
        inline(text, bullet ? bullet[1] : (ordered?.[2] ?? ""));
        item.append(marker, text);
        list.appendChild(item);
        i++;
      }
      parent.appendChild(list);
      continue;
    }

    // A run of ordinary lines is one paragraph. Blank lines separate them and
    // are not rendered as empty boxes.
    const para: string[] = [];
    while (
      i < lines.length &&
      lines[i].trim() !== "" &&
      !FENCE.test(lines[i]) &&
      !HEADING.test(lines[i]) &&
      !BULLET.test(lines[i]) &&
      !ORDERED.test(lines[i])
    ) {
      para.push(lines[i]);
      i++;
    }
    if (para.length > 0) {
      const el = document.createElement("p");
      el.className = "md-p";
      inline(el, para.join("\n"));
      parent.appendChild(el);
      continue;
    }
    i++; // blank line
  }
}

function codeBlock(code: string, lang: string): HTMLElement {
  // The block scrolls inside itself. A phone is narrow and code does not wrap
  // usefully, but the page must never scroll sideways as a whole.
  const wrap = document.createElement("div");
  wrap.className = "md-code";
  if (lang) {
    const label = document.createElement("span");
    label.className = "md-code-lang";
    label.textContent = lang;
    wrap.appendChild(label);
  }
  const pre = document.createElement("pre");
  pre.textContent = code;
  wrap.appendChild(pre);
  return wrap;
}

/** `code` and **bold**, the only inline markup worth the trouble. */
const INLINE = /(`[^`]+`|\*\*[^*]+\*\*)/;

function inline(parent: HTMLElement, text: string): void {
  for (const piece of text.split(INLINE)) {
    if (piece === "") continue;
    if (piece.length > 2 && piece.startsWith("`") && piece.endsWith("`")) {
      const el = document.createElement("code");
      el.className = "md-inline-code";
      el.textContent = piece.slice(1, -1);
      parent.appendChild(el);
      continue;
    }
    if (piece.length > 4 && piece.startsWith("**") && piece.endsWith("**")) {
      const el = document.createElement("strong");
      el.textContent = piece.slice(2, -2);
      parent.appendChild(el);
      continue;
    }
    parent.appendChild(document.createTextNode(piece));
  }
}
