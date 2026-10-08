import type { WorkspaceEnv } from "@/modules/workspace";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import { useEffect, useRef } from "react";

/**
 * App-wide event bus. One place emits a change, every panel subscribes — the
 * panels must not each open their own Tauri listen or guess what moved.
 *
 * Two families of signals:
 *  - filesystem: `fs:changed` / `fs:written`, bridged from the Rust fs watch.
 *    Files move under the app all the time (the agent, another editor, git
 *    commands in a terminal), so anything showing file-derived data has to
 *    react to these or it shows stale caches.
 *  - context: `context:changed`, emitted when the command line (project) the
 *    side panels follow switches, carrying the new owner's cwd.
 */

export type FsChangedEvent = {
  paths: string[];
  rescan?: boolean;
  workspace?: WorkspaceEnv;
};
export type FsWrittenEvent = {
  path: string;
  source?: string;
  workspace?: WorkspaceEnv;
};
export type ContextChangedEvent = {
  cwd: string | null;
  terminalId: number | null;
};

export type AppEventMap = {
  "fs:changed": FsChangedEvent;
  "fs:written": FsWrittenEvent;
  "context:changed": ContextChangedEvent;
};

type EventKey = keyof AppEventMap;
type AnyHandler = (payload: unknown) => void;

const registry = new Map<EventKey, Set<AnyHandler>>();

/** Subscribe to an event. Returns an unsubscribe function. */
export function onEvent<K extends EventKey>(
  event: K,
  handler: (payload: AppEventMap[K]) => void,
): () => void {
  let set = registry.get(event);
  if (!set) {
    set = new Set();
    registry.set(event, set);
  }
  const wrapped: AnyHandler = (payload) => handler(payload as AppEventMap[K]);
  set.add(wrapped);
  return () => {
    set.delete(wrapped);
  };
}

export function emitEvent<K extends EventKey>(
  event: K,
  payload: AppEventMap[K],
): void {
  const set = registry.get(event);
  if (!set) return;
  for (const handler of [...set]) {
    try {
      handler(payload);
    } catch (error) {
      console.error(`[terax] ${event} listener failed:`, error);
    }
  }
}

/**
 * Subscribe a component to an event. The handler is kept in a ref, so the
 * subscription is stable across re-renders and always calls the latest
 * handler.
 */
export function useAppEvent<K extends EventKey>(
  event: K,
  handler: (payload: AppEventMap[K]) => void,
): void {
  const ref = useRef(handler);
  ref.current = handler;
  useEffect(() => onEvent(event, (payload) => ref.current(payload)), [event]);
}

/**
 * Bridge the Rust fs watch into the bus once (app lifetime). The fs watcher is
 * process-wide, so components subscribe to `fs:changed` / `fs:written` here
 * instead of each calling Tauri's `listen`. Returns an unsubscribe for the
 * whole bridge.
 */
export function bridgeNativeFileEvents(): () => void {
  let alive = true;
  const unsubs: Array<() => void> = [];
  const window = getCurrentWebviewWindow();
  void window
    .listen<FsChangedEvent>("fs:changed", (e) => {
      if (alive) emitEvent("fs:changed", e.payload);
    })
    .then((un) => {
      if (alive) unsubs.push(un);
      else un();
    })
    .catch((error) =>
      console.error("[terax] filesystem listener failed:", error),
    );
  void window
    .listen<FsWrittenEvent>("fs:file-written", (e) => {
      if (!alive) return;
      emitEvent("fs:written", {
        path: e.payload.path,
        source: e.payload.source,
        workspace: e.payload.workspace,
      });
    })
    .then((un) => {
      if (alive) unsubs.push(un);
      else un();
    })
    .catch((error) =>
      console.error("[terax] file-write listener failed:", error),
    );
  return () => {
    alive = false;
    for (const un of unsubs) un();
  };
}
