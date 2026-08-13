import { describe, expect, it } from "vitest";
import {
  capEditorTabs,
  type EditorTab,
  MAX_EDITOR_TABS_PER_SPACE,
  type Tab,
  type TerminalTab,
} from "./useTabs";

const terminal: TerminalTab = {
  id: 100,
  kind: "terminal",
  spaceId: "one",
  title: "shell",
  paneTree: { kind: "leaf", id: 101 },
  activeLeafId: 101,
};

function editor(id: number, spaceId = "one", dirty = false): EditorTab {
  return {
    id,
    kind: "editor",
    spaceId,
    title: `f${id}.ts`,
    path: `/repo/f${id}.ts`,
    dirty,
    preview: false,
  };
}

const ids = (tabs: Tab[]) => tabs.map((t) => t.id);

describe("capEditorTabs", () => {
  it("leaves a space alone while it is at or under the cap", () => {
    const tabs: Tab[] = [terminal, ...[1, 2, 3, 4, 5].map((i) => editor(i))];
    expect(capEditorTabs(tabs, "one", [5])).toBe(tabs);
  });

  it("closes the oldest editor tabs first, oldest = earliest in tab order", () => {
    const tabs: Tab[] = [
      terminal,
      ...[1, 2, 3, 4, 5, 6, 7].map((i) => editor(i)),
    ];
    const next = capEditorTabs(tabs, "one", [7]);
    expect(ids(next)).toEqual([100, 3, 4, 5, 6, 7]);
  });

  it("never closes tabs named in keepIds", () => {
    const tabs: Tab[] = [terminal, ...[1, 2, 3, 4, 5, 6].map((i) => editor(i))];
    // 1 is the oldest but is being kept, so 2 goes instead.
    const next = capEditorTabs(tabs, "one", [6, 1]);
    expect(ids(next)).toEqual([100, 1, 3, 4, 5, 6]);
  });

  it("never closes a tab with unsaved edits, even past the cap", () => {
    const tabs: Tab[] = [
      editor(1, "one", true),
      editor(2, "one", true),
      ...[3, 4, 5, 6, 7].map((i) => editor(i)),
    ];
    const next = capEditorTabs(tabs, "one", [7]);
    // Two over: the dirty pair is skipped and the budget falls on 3 and 4.
    expect(ids(next)).toEqual([1, 2, 5, 6, 7]);
  });

  it("keeps every tab when the whole overflow is dirty", () => {
    const tabs: Tab[] = [1, 2, 3, 4, 5, 6].map((i) =>
      editor(i, "one", i !== 6),
    );
    expect(capEditorTabs(tabs, "one", [6])).toBe(tabs);
  });

  it("counts and evicts only within the target space", () => {
    const tabs: Tab[] = [
      ...[1, 2, 3, 4].map((i) => editor(i, "other")),
      ...[5, 6, 7, 8, 9, 10].map((i) => editor(i, "one")),
    ];
    const next = capEditorTabs(tabs, "one", [10]);
    expect(ids(next)).toEqual([1, 2, 3, 4, 6, 7, 8, 9, 10]);
  });

  it("ignores non-editor tabs when counting", () => {
    const tabs: Tab[] = [
      terminal,
      { ...terminal, id: 102 },
      ...[1, 2, 3, 4, 5].map((i) => editor(i)),
    ];
    expect(capEditorTabs(tabs, "one", [5])).toBe(tabs);
  });

  it("caps at the documented size", () => {
    const tabs: Tab[] = Array.from({ length: 12 }, (_, i) => editor(i + 1));
    const next = capEditorTabs(tabs, "one", [12]);
    expect(next).toHaveLength(MAX_EDITOR_TABS_PER_SPACE);
  });
});
