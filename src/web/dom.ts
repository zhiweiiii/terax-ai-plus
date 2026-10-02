export function patchChildren(parent: Node, children: Iterable<Node>): void {
  let current = parent.firstChild;
  for (const next of children) {
    if (current === next) {
      current = current.nextSibling;
      continue;
    }
    let reused = current;
    while (reused && !compatible(reused, next)) reused = reused.nextSibling;
    if (!reused) {
      parent.insertBefore(next, current);
      continue;
    }
    if (reused !== current) parent.insertBefore(reused, current);
    if (reused.nodeType === Node.TEXT_NODE) {
      if (reused.textContent !== next.textContent)
        reused.textContent = next.textContent;
    } else if (reused instanceof Element && next instanceof Element) {
      for (const attribute of Array.from(reused.attributes)) {
        if (attribute.name === "open" && reused instanceof HTMLDetailsElement)
          continue;
        if (!next.hasAttribute(attribute.name))
          reused.removeAttribute(attribute.name);
      }
      for (const attribute of Array.from(next.attributes)) {
        if (reused.getAttribute(attribute.name) !== attribute.value)
          reused.setAttribute(attribute.name, attribute.value);
      }
      if (
        reused instanceof HTMLInputElement &&
        next instanceof HTMLInputElement
      )
        reused.checked = next.checked;
      patchChildren(reused, Array.from(next.childNodes));
    }
    current = reused.nextSibling;
  }
  while (current) {
    const removed = current;
    current = current.nextSibling;
    parent.removeChild(removed);
  }
}

function compatible(a: Node, b: Node): boolean {
  return (
    a.nodeType === b.nodeType &&
    (!(a instanceof Element) ||
      (b instanceof Element &&
        a.tagName === b.tagName &&
        a.classList.item(0) === b.classList.item(0) &&
        a.getAttribute("data-key") === b.getAttribute("data-key")))
  );
}
