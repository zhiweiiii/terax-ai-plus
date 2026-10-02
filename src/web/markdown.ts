import { fromMarkdown } from "mdast-util-from-markdown";
import { gfmFromMarkdown } from "mdast-util-gfm";
import { gfm } from "micromark-extension-gfm";
import { copyButton } from "@/web/clipboard";
import { patchChildren } from "@/web/dom";

type MarkdownNode = ReturnType<typeof fromMarkdown>["children"][number];
type Definition = Extract<MarkdownNode, { type: "definition" }>;

export function renderMarkdown(parent: HTMLElement, source: string): void {
  if (source.length > 256 * 1024) {
    parent.dataset.plain = "true";
    parent.textContent = source;
    return;
  }
  try {
    delete parent.dataset.plain;
    renderParsed(parent, source);
  } catch {
    parent.dataset.plain = "true";
    parent.textContent = source;
  }
}

function renderParsed(parent: HTMLElement, source: string): void {
  const tree = fromMarkdown(source, {
    extensions: [gfm()],
    mdastExtensions: [gfmFromMarkdown()],
  });
  const definitions = new Map<string, Definition>();
  const pending: MarkdownNode[] = [...tree.children].reverse();
  while (pending.length > 0) {
    const node = pending.pop();
    if (!node) continue;
    if (node.type === "definition" && !definitions.has(node.identifier))
      definitions.set(node.identifier, node);
    if ("children" in node) {
      for (let index = node.children.length - 1; index >= 0; index--)
        pending.push(node.children[index]);
    }
  }
  const fragment = document.createDocumentFragment();
  for (const node of tree.children) fragment.appendChild(renderNode(node));
  patchChildren(parent, Array.from(fragment.childNodes));

  function renderNode(node: MarkdownNode, depth = 0): Node {
    if (depth >= 64)
      return document.createTextNode(
        source.slice(
          node.position?.start.offset ?? 0,
          node.position?.end.offset ?? source.length,
        ),
      );
    const appendChildren = (
      container: HTMLElement,
      children: MarkdownNode[],
    ) => {
      for (const child of children)
        container.appendChild(renderNode(child, depth + 1));
    };
    if (node.type === "text" || node.type === "html")
      return document.createTextNode(node.value);
    if (node.type === "code") return codeBlock(node.value, node.lang ?? "");
    if (node.type === "definition") return document.createDocumentFragment();
    if (node.type === "footnoteDefinition") {
      const note = document.createElement("div");
      note.className = "md-footnote";
      const label = document.createElement("span");
      label.textContent = `[${node.label ?? node.identifier}] `;
      note.appendChild(label);
      appendChildren(note, node.children);
      return note;
    }
    if (node.type === "link" || node.type === "linkReference") {
      const definition =
        node.type === "linkReference" ? definitions.get(node.identifier) : node;
      const href = safeHref(definition?.url ?? "");
      const link = document.createElement(href ? "a" : "span");
      if (href && link instanceof HTMLAnchorElement) {
        link.href = href;
        link.target = "_blank";
        link.rel = "noopener noreferrer";
        if (definition?.title) link.title = definition.title;
      }
      appendChildren(link, node.children);
      return link;
    }
    if (node.type === "image" || node.type === "imageReference") {
      const definition =
        node.type === "imageReference"
          ? definitions.get(node.identifier)
          : node;
      const href = safeHref(definition?.url ?? "");
      const link = document.createElement(href ? "a" : "span");
      link.textContent = node.alt || "图片";
      if (href && link instanceof HTMLAnchorElement) {
        link.href = href;
        link.target = "_blank";
        link.rel = "noopener noreferrer";
      }
      return link;
    }
    if (node.type === "table") {
      const wrap = document.createElement("div");
      wrap.className = "md-table-wrap";
      const table = document.createElement("table");
      const head = document.createElement("thead");
      const body = document.createElement("tbody");
      for (const [index, row] of node.children.entries()) {
        const tr = document.createElement("tr");
        for (const [column, cell] of row.children.entries()) {
          const td = document.createElement(index === 0 ? "th" : "td");
          const align = node.align?.[column];
          if (align) td.style.textAlign = align;
          appendChildren(td, cell.children);
          tr.appendChild(td);
        }
        (index === 0 ? head : body).appendChild(tr);
      }
      table.append(head, body);
      wrap.appendChild(table);
      return wrap;
    }
    if (node.type === "footnoteReference")
      return document.createTextNode(`[${node.label ?? node.identifier}]`);

    const tags: Partial<Record<MarkdownNode["type"], string>> = {
      paragraph: "p",
      strong: "strong",
      emphasis: "em",
      delete: "del",
      inlineCode: "code",
      blockquote: "blockquote",
      break: "br",
      thematicBreak: "hr",
      listItem: "li",
    };
    const tag =
      node.type === "heading"
        ? `h${node.depth}`
        : node.type === "list"
          ? node.ordered
            ? "ol"
            : "ul"
          : (tags[node.type] ?? "span");
    const element = document.createElement(tag);
    if (node.type === "paragraph") element.className = "md-p";
    if (node.type === "heading") element.className = `md-h md-h${node.depth}`;
    if (node.type === "inlineCode") {
      element.className = "md-inline-code";
      element.textContent = node.value;
    }
    if (node.type === "list") {
      element.className = "md-list";
      if (element instanceof HTMLOListElement && node.start != null)
        element.start = node.start;
    }
    if (node.type === "listItem" && node.checked != null) {
      element.className = "md-task";
      const check = document.createElement("input");
      check.type = "checkbox";
      check.checked = node.checked;
      check.disabled = true;
      element.appendChild(check);
    }
    if ("children" in node) appendChildren(element, node.children);
    return element;
  }
}

function safeHref(value: string): string | null {
  try {
    const url = new URL(value);
    return ["http:", "https:", "mailto:"].includes(url.protocol)
      ? url.href
      : null;
  } catch {
    return null;
  }
}

function codeBlock(code: string, lang: string): HTMLElement {
  const wrap = document.createElement("div");
  wrap.className = "md-code";
  const head = document.createElement("div");
  head.className = "md-code-head";
  const label = document.createElement("span");
  label.textContent = lang || "代码";
  const pre = document.createElement("pre");
  pre.textContent = code;
  head.append(
    label,
    copyButton(() => pre.textContent ?? ""),
  );
  wrap.append(head, pre);
  return wrap;
}
