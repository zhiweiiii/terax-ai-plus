import { invoke } from "@tauri-apps/api/core";
import { useLspRuntimeStore } from "@/modules/lsp/lib/runtimeStore";

const pending = new Map<string, Promise<string | null>>();

export function detectBinary(command: string): Promise<string | null> {
  const cached = Object.getOwnPropertyDescriptor(
    useLspRuntimeStore.getState().detected,
    command,
  )?.value as string | null | undefined;
  if (cached !== undefined) return Promise.resolve(cached);
  let p = pending.get(command);
  if (!p) {
    useLspRuntimeStore.getState().setDetectionError(command, null);
    const newest = (): Promise<string | null> => {
      const latest = pending.get(command);
      if (latest && latest !== p) return latest;
      const state = useLspRuntimeStore.getState();
      if (state.detectionErrors[command])
        return Promise.reject(new Error(state.detectionErrors[command]));
      return Promise.resolve(state.detected[command] ?? null);
    };
    p = invoke<string | null>("lsp_detect", { command }).then(
      (path) => {
        if (pending.get(command) !== p) return newest();
        pending.delete(command);
        useLspRuntimeStore.getState().setDetected(command, path);
        return path;
      },
      (error: unknown) => {
        if (pending.get(command) !== p) return newest();
        pending.delete(command);
        useLspRuntimeStore.getState().setDetectionError(command, String(error));
        throw error;
      },
    );
    pending.set(command, p);
  }
  return p;
}

export function redetectBinary(command: string): Promise<string | null> {
  pending.delete(command);
  useLspRuntimeStore.getState().clearDetected(command);
  return detectBinary(command);
}
