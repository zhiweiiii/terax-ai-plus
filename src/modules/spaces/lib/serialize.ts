import {
  isLeaf,
  type PaneNode,
  type SplitDir,
} from "@/modules/terminal/lib/panes";
import type {
  EditorTab,
  MarkdownTab,
  PreviewTab,
  Tab,
  TerminalTab,
} from "@/modules/tabs/lib/useTabs";

export type SerializedNode =
  | { kind: "leaf"; cwd?: string; active?: boolean }
  | { kind: "split"; dir: SplitDir; children: SerializedNode[] };

export type SerializedTab =
  | {
      kind: "terminal";
      tree: SerializedNode;
      blocks?: boolean;
      customTitle?: string;
    }
  | { kind: "editor"; path: string; ownerTab?: number }
  | { kind: "preview"; url: string }
  | { kind: "markdown"; path: string; ownerTab?: number };

function basename(path: string): string {
  const parts = path.split(/[\\/]/).filter(Boolean);
  return parts.length ? parts[parts.length - 1] : path;
}

function titleFromUrl(url: string): string {
  try {
    return new URL(url).host || url;
  } catch {
    return url || "preview";
  }
}

function serializeNode(node: PaneNode, activeLeafId: number): SerializedNode {
  if (isLeaf(node)) {
    return {
      kind: "leaf",
      ...(node.cwd !== undefined && { cwd: node.cwd }),
      ...(node.id === activeLeafId && { active: true }),
    };
  }
  return {
    kind: "split",
    dir: node.dir,
    children: node.children.map((c) => serializeNode(c, activeLeafId)),
  };
}

export function isSerializableTab(tab: Tab): boolean {
  switch (tab.kind) {
    case "terminal":
      return !tab.private;
    case "editor":
    case "preview":
    case "markdown":
      return true;
    default:
      return false;
  }
}

function serializeTab(tab: Tab): SerializedTab | null {
  if (!isSerializableTab(tab)) return null;
  switch (tab.kind) {
    case "terminal":
      return {
        kind: "terminal",
        tree: serializeNode(tab.paneTree, tab.activeLeafId),
        ...(tab.blocks && { blocks: true }),
        ...(tab.customTitle !== undefined && { customTitle: tab.customTitle }),
      };
    case "editor":
      return {
        kind: "editor",
        path: tab.path,
        ...(tab.ownerTabId !== undefined && { ownerTabId: tab.ownerTabId }),
      };
    case "preview":
      return { kind: "preview", url: tab.url };
    case "markdown":
      return {
        kind: "markdown",
        path: tab.path,
        ...(tab.ownerTabId !== undefined && { ownerTabId: tab.ownerTabId }),
      };
    default:
      return null;
  }
}

export function serializeTabs(tabs: Tab[]): SerializedTab[] {
  // Serialize in one pass, remembering each entry's source tab and the
  // serialized slot of every terminal tab, so file tabs can reference their
  // owner by position (runtime ids are reallocated on restore).
  const out: SerializedTab[] = [];
  const slots: { tab: Tab; ownerTabId?: number }[] = [];
  const terminalSlot = new Map<number, number>();
  for (const tab of tabs) {
    const s = serializeTab(tab);
    if (!s) continue;
    if (tab.kind === "terminal") terminalSlot.set(tab.id, out.length);
    slots.push({ tab });
    out.push(s);
  }
  return out.map((s, i) => {
    const ownerTabId = slots[i]?.tab.ownerTabId;
    if (
      (s.kind === "editor" || s.kind === "markdown") &&
      ownerTabId !== undefined
    ) {
      const owner = terminalSlot.get(ownerTabId);
      if (owner !== undefined) {
        return { ...s, ownerTab: owner } as typeof s;
      }
    }
    return s;
  });
}

type HydratedTree = {
  tree: PaneNode;
  activeLeafId: number;
  firstLeafCwd?: string;
};

function hydrateNode(
  node: SerializedNode,
  allocId: () => number,
  acc: { activeLeafId: number | null },
): PaneNode {
  if (node.kind === "leaf") {
    const id = allocId();
    if (node.active && acc.activeLeafId === null) acc.activeLeafId = id;
    return {
      kind: "leaf",
      id,
      ...(node.cwd !== undefined && { cwd: node.cwd }),
    };
  }
  const children = node.children.map((c) => hydrateNode(c, allocId, acc));
  if (children.length === 0) return { kind: "leaf", id: allocId() };
  if (children.length === 1) return children[0];
  return { kind: "split", id: allocId(), dir: node.dir, children };
}

function hydrateTree(
  tree: SerializedNode,
  allocId: () => number,
): HydratedTree {
  const acc: { activeLeafId: number | null } = { activeLeafId: null };
  const paneTree = hydrateNode(tree, allocId, acc);
  const leaves = collectLeaves(paneTree);
  const activeLeafId = acc.activeLeafId ?? leaves[0]?.id ?? allocId();
  const firstLeafCwd =
    leaves.find((l) => l.id === activeLeafId)?.cwd ?? leaves[0]?.cwd;
  return { tree: paneTree, activeLeafId, firstLeafCwd };
}

function collectLeaves(node: PaneNode): Array<{ id: number; cwd?: string }> {
  if (isLeaf(node)) return [{ id: node.id, cwd: node.cwd }];
  return node.children.flatMap(collectLeaves);
}

function hydrateTab(
  s: SerializedTab,
  spaceId: string,
  allocId: () => number,
): Tab | null {
  switch (s.kind) {
    case "terminal": {
      const { tree, activeLeafId, firstLeafCwd } = hydrateTree(s.tree, allocId);
      const title =
        s.customTitle ??
        (firstLeafCwd ? basename(firstLeafCwd) : s.blocks ? "blocks" : "shell");
      return {
        id: allocId(),
        kind: "terminal",
        spaceId,
        cold: true,
        title,
        cwd: firstLeafCwd,
        paneTree: tree,
        activeLeafId,
        ...(s.blocks && { blocks: true }),
        ...(s.customTitle !== undefined && { customTitle: s.customTitle }),
      } satisfies TerminalTab;
    }
    case "editor":
      return {
        id: allocId(),
        kind: "editor",
        spaceId,
        cold: true,
        title: basename(s.path),
        path: s.path,
        dirty: false,
        preview: false,
      } satisfies EditorTab;
    case "preview":
      return {
        id: allocId(),
        kind: "preview",
        spaceId,
        cold: true,
        title: titleFromUrl(s.url),
        url: s.url,
      } satisfies PreviewTab;
    case "markdown":
      return {
        id: allocId(),
        kind: "markdown",
        spaceId,
        cold: true,
        title: basename(s.path),
        path: s.path,
      } satisfies MarkdownTab;
    default:
      return null;
  }
}

export function freshTerminalTab(
  spaceId: string,
  cwd: string | null,
  allocId: () => number,
): TerminalTab {
  const leafId = allocId();
  return {
    id: allocId(),
    kind: "terminal",
    spaceId,
    cold: true,
    title: cwd ? basename(cwd) : "shell",
    cwd: cwd ?? undefined,
    paneTree: { kind: "leaf", id: leafId, ...(cwd && { cwd }) },
    activeLeafId: leafId,
  };
}

export function hydrateTabs(
  serialized: SerializedTab[],
  spaceId: string,
  allocId: () => number,
): Tab[] {
  if (!Array.isArray(serialized)) return [];

  // First pass: hydrate every tab but remember, per serialized slot, the new
  // id of terminal tabs and the serialized owner slot of file tabs.
  const hydrated: (Tab | null)[] = [];
  const terminalIdBySlot = new Map<number, number>();
  const ownerSlotByIndex = new Map<number, number>();
  for (let i = 0; i < serialized.length; i++) {
    const s = serialized[i];
    try {
      const tab = hydrateTab(s, spaceId, allocId);
      if (!tab) {
        hydrated.push(null);
        continue;
      }
      if (tab.kind === "terminal") terminalIdBySlot.set(i, tab.id);
      if ((s.kind === "editor" || s.kind === "markdown") && s.ownerTab !== undefined) {
        ownerSlotByIndex.set(i, s.ownerTab);
      }
      hydrated.push(tab);
    } catch {
      hydrated.push(null);
    }
  }

  // Second pass: attach the owner's new terminal id to each file tab.
  const out: Tab[] = [];
  for (let i = 0; i < hydrated.length; i++) {
    const tab = hydrated[i];
    if (!tab) continue;
    const ownerSlot = ownerSlotByIndex.get(i);
    if (ownerSlot !== undefined && (tab.kind === "editor" || tab.kind === "markdown")) {
      const ownerId = terminalIdBySlot.get(ownerSlot);
      out.push({ ...tab, ownerTabId: ownerId });
    } else {
      out.push(tab);
    }
  }
  return out;
}
