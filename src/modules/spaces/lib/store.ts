import { LazyStore } from "@tauri-apps/plugin-store";
import type { WorkspaceEnv } from "@/modules/workspace";
import {
  isSerializedTabs,
  type SerializedTab,
} from "@/modules/spaces/lib/serialize";
import { SPACE_COLORS } from "@/modules/spaces/lib/spaceColor";

export type SpaceMeta = {
  id: string;
  name: string;
  root: string | null;
  env: WorkspaceEnv;
  /** Opt-in accent, index into SPACE_COLORS. Undefined = theme primary. */
  color?: number;
  createdAt: number;
  updatedAt: number;
};

export type SpaceState = {
  tabs: SerializedTab[];
  activeTabIndex: number;
};

const STORE_PATH = "terax-spaces.json";
const KEY_SPACES = "spaces";
const KEY_ACTIVE = "activeId";
const STATE_PREFIX = "state:";
const stateKey = (id: string) => `${STATE_PREFIX}${id}`;

const store = new LazyStore(STORE_PATH, { defaults: {}, autoSave: 500 });
let writeQueue: Promise<void> = Promise.resolve();
let dirty = false;

function write(action: () => Promise<void>, mutates = true): Promise<void> {
  const operation = writeQueue.then(async () => {
    await action();
    if (mutates) dirty = true;
  });
  writeQueue = operation.catch(() => {});
  return operation;
}

export function flushStore(): Promise<void> {
  return write(async () => {
    if (!dirty) return;
    await store.save();
    dirty = false;
  }, false);
}

export type LoadedSpaces = {
  spaces: SpaceMeta[];
  activeId: string | null;
  states: Map<string, SpaceState>;
};

export async function loadAll(): Promise<LoadedSpaces> {
  const entries = await store.entries();
  let spaces: SpaceMeta[] = [];
  let activeId: string | null = null;
  const states = new Map<string, SpaceState>();
  for (const [k, v] of entries) {
    if (k === KEY_SPACES) {
      if (
        !Array.isArray(v) ||
        v.length > 1000 ||
        !v.every(isSpaceMeta) ||
        new Set(v.map((space) => space.id)).size !== v.length
      ) {
        throw new Error(
          "Invalid saved workspace list. Original data has been retained.",
        );
      }
      spaces = v;
    } else if (k === KEY_ACTIVE) {
      if (v !== null && typeof v !== "string")
        throw new Error("Invalid saved active workspace.");
      activeId = v;
    } else if (k.startsWith(STATE_PREFIX)) {
      if (!v || typeof v !== "object")
        throw new Error("Invalid saved workspace state.");
      const state = v as SpaceState;
      if (
        !isSerializedTabs(state.tabs) ||
        !Number.isSafeInteger(state.activeTabIndex) ||
        state.activeTabIndex < 0
      )
        throw new Error(
          "Invalid saved workspace tabs. Original data has been retained.",
        );
      states.set(k.slice(STATE_PREFIX.length), state);
    }
  }
  return { spaces, activeId, states };
}

function isSpaceMeta(value: unknown): value is SpaceMeta {
  if (!value || typeof value !== "object") return false;
  const space = value as SpaceMeta;
  return (
    typeof space.id === "string" &&
    space.id.length > 0 &&
    typeof space.name === "string" &&
    (space.root === null || typeof space.root === "string") &&
    !!space.env &&
    (space.env.kind === "local" ||
      (space.env.kind === "wsl" &&
        typeof space.env.distro === "string" &&
        space.env.distro.length > 0)) &&
    Number.isFinite(space.createdAt) &&
    Number.isFinite(space.updatedAt) &&
    (space.color === undefined ||
      (Number.isInteger(space.color) &&
        space.color >= 0 &&
        space.color < SPACE_COLORS.length))
  );
}

export async function saveSpacesList(spaces: SpaceMeta[]): Promise<void> {
  await write(() => store.set(KEY_SPACES, spaces));
}

export async function saveActiveId(id: string | null): Promise<void> {
  await write(() => store.set(KEY_ACTIVE, id));
}

export async function saveState(id: string, state: SpaceState): Promise<void> {
  await write(() => store.set(stateKey(id), state));
}

export async function deleteSpaceData(id: string): Promise<void> {
  await write(async () => {
    await store.delete(stateKey(id));
  });
}

export function newSpaceId(): string {
  return `sp-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}
