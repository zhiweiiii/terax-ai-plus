import { emit, listen, type UnlistenFn } from "@tauri-apps/api/event";
import { LazyStore } from "@tauri-apps/plugin-store";
import type { Theme } from "./types";
import { validateTheme } from "@/modules/theme/validateTheme";

const STORE_PATH = "terax-custom-themes.json";
const KEY = "themes";
const CHANGED_EVENT = "terax://custom-themes-changed";

const store = new LazyStore(STORE_PATH, { defaults: {}, autoSave: 200 });
let mutationQueue: Promise<void> = Promise.resolve();

function mutate(action: () => Promise<void>): Promise<void> {
  const operation = mutationQueue.then(action);
  mutationQueue = operation.catch(() => {});
  return operation;
}

export async function listCustomThemes(): Promise<Theme[]> {
  const value = await store.get<unknown>(KEY);
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.length > 256)
    throw new Error("Invalid custom themes collection");
  const themes: Theme[] = [];
  const ids = new Set<string>();
  for (const raw of value) {
    const parsed = validateTheme(raw);
    if (!parsed.ok) throw new Error(`Invalid custom theme: ${parsed.error}`);
    if (ids.has(parsed.theme.id)) throw new Error("Duplicate custom theme ID");
    ids.add(parsed.theme.id);
    themes.push(parsed.theme);
  }
  return themes;
}

export function saveCustomTheme(theme: Theme): Promise<void> {
  return mutate(async () => {
    const parsed = validateTheme(theme);
    if (!parsed.ok) throw new Error(parsed.error);
    const current = await listCustomThemes();
    const next = current
      .filter((t) => t.id !== parsed.theme.id)
      .concat(parsed.theme);
    if (next.length > 256) throw new Error("Custom theme limit reached");
    await store.set(KEY, next);
    await store.save();
    await emit(CHANGED_EVENT);
  });
}

export function deleteCustomTheme(id: string): Promise<void> {
  return mutate(async () => {
    const current = await listCustomThemes();
    const next = current.filter((t) => t.id !== id);
    if (next.length === current.length) return;
    await store.set(KEY, next);
    await store.save();
    await emit(CHANGED_EVENT);
  });
}

export async function onCustomThemesChange(
  cb: () => void,
): Promise<UnlistenFn> {
  const unsubLocal = await store.onChange((key) => {
    if (key === KEY) cb();
  });
  let unsubEvent: UnlistenFn;
  try {
    unsubEvent = await listen(CHANGED_EVENT, () => cb());
  } catch (error) {
    unsubLocal();
    throw error;
  }
  return () => {
    unsubLocal();
    unsubEvent();
  };
}
