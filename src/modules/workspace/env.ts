import { invoke } from "@tauri-apps/api/core";
import { create } from "zustand";
import { toast } from "sonner";
import { setLastWslDistro } from "@/modules/settings/store";

export type WorkspaceEnv = { kind: "local" } | { kind: "wsl"; distro: string };

export type WslDistro = {
  name: string;
  default: boolean;
  running: boolean;
};

type State = {
  env: WorkspaceEnv;
  distros: WslDistro[];
  loading: boolean;
  error: string | null;
  setEnv: (env: WorkspaceEnv) => void;
  refreshDistros: () => Promise<WslDistro[]>;
};

export const LOCAL_WORKSPACE: WorkspaceEnv = { kind: "local" };
let distroRefresh: Promise<WslDistro[]> | null = null;

export const useWorkspaceEnvStore = create<State>((set) => ({
  env: LOCAL_WORKSPACE,
  distros: [],
  loading: false,
  error: null,
  setEnv: (env) => {
    set({ env });
    if (env.kind === "wsl")
      void setLastWslDistro(env.distro).catch((error) =>
        toast.error(`Could not save WSL preference: ${String(error)}`),
      );
  },
  refreshDistros: async () => {
    if (distroRefresh) return distroRefresh;
    set({ loading: true, error: null });
    const operation = (async () => {
      try {
        const distros = await invoke<WslDistro[]>("wsl_list_distros");
        set({ distros, loading: false });
        return distros;
      } catch (e) {
        set({ distros: [], loading: false, error: String(e) });
        return [];
      }
    })();
    distroRefresh = operation;
    try {
      return await operation;
    } finally {
      if (distroRefresh === operation) distroRefresh = null;
    }
  },
}));

export function currentWorkspaceEnv(): WorkspaceEnv {
  return useWorkspaceEnvStore.getState().env;
}

export function workspaceScopeKey(env: WorkspaceEnv): string {
  return env.kind === "wsl" ? `wsl:${env.distro}` : "local";
}

export function parseWorkspaceScopeKey(key: string): WorkspaceEnv {
  return key.startsWith("wsl:")
    ? { kind: "wsl", distro: key.slice("wsl:".length) }
    : LOCAL_WORKSPACE;
}

export function currentWorkspaceScopeKey(): string {
  return workspaceScopeKey(currentWorkspaceEnv());
}

export async function getWslHome(distro: string): Promise<string> {
  return invoke<string>("wsl_home", { distro });
}
