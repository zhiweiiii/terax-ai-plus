import {
  type RefObject,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import { homeDir } from "@tauri-apps/api/path";
import { native } from "@/lib/native";
import type { Tab } from "@/modules/tabs";
import {
  getWslHome,
  LOCAL_WORKSPACE,
  type WorkspaceEnv,
} from "@/modules/workspace";

async function resolveEnvHome(env: WorkspaceEnv): Promise<string> {
  return env.kind === "wsl"
    ? getWslHome(env.distro)
    : (await homeDir()).replace(/\\/g, "/");
}

type Params = {
  tabsRef: RefObject<Tab[]>;
  workspaceEnv: WorkspaceEnv;
  setWorkspaceEnv: (env: WorkspaceEnv) => void;
  resetWorkspace: (home?: string) => void;
  /** Dispose live sessions and clear App-owned pane/handle ref maps. */
  clearWorkspaceState: () => void;
};

/**
 * Owns the resolved home / launch cwd. switchWorkspace runs an interactive
 * local⇄WSL switch (tears down sessions, re-authorizes home, resets tabs);
 * adoptWorkspaceEnv applies a space's env + home on restore, without teardown.
 */
export function useWorkspaceSwitcher({
  tabsRef,
  workspaceEnv,
  setWorkspaceEnv,
  resetWorkspace,
  clearWorkspaceState,
}: Params) {
  const epoch = useRef(0);
  const mounted = useRef(false);
  const envRef = useRef(workspaceEnv);
  envRef.current = workspaceEnv;
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      epoch.current++;
    };
  }, []);

  const [home, setHome] = useState<string | null>(null);
  const [launchCwd, setLaunchCwd] = useState<string | null>(null);
  const [launchCwdResolved, setLaunchCwdResolved] = useState(false);

  useEffect(() => {
    const request = epoch.current;
    homeDir()
      .then(async (p) => {
        const normalized = p.replace(/\\/g, "/");
        if (!mounted.current || epoch.current !== request) return;
        setHome(normalized);
        try {
          await native.workspaceAuthorize(normalized, LOCAL_WORKSPACE);
        } catch {
          // Bootstrap already authorizes home from Rust; ignore.
        }
      })
      .catch(() => {
        if (mounted.current && epoch.current === request) setHome(null);
      });
  }, []);

  useEffect(() => {
    let disposed = false;
    native
      .workspaceCurrentDir()
      .then((cwd) => {
        if (!disposed) setLaunchCwd(cwd);
      })
      .catch(() => {
        if (!disposed) setLaunchCwd(null);
      })
      .finally(() => {
        if (!disposed) setLaunchCwdResolved(true);
      });
    return () => {
      disposed = true;
    };
  }, []);

  const authorizeHome = useCallback(
    async (nextHome: string, env: WorkspaceEnv) => {
      try {
        await native.workspaceAuthorize(nextHome, env);
      } catch {
        // Bootstrap authorization failures surface in the git panel.
      }
    },
    [],
  );

  const switchWorkspace = useCallback(
    async (env: WorkspaceEnv): Promise<boolean> => {
      const request = ++epoch.current;
      const currentEnv = envRef.current;
      if (
        env.kind === currentEnv.kind &&
        (env.kind === "local" ||
          (currentEnv.kind === "wsl" && env.distro === currentEnv.distro))
      ) {
        return false;
      }
      const dirty = tabsRef.current.some((t) => t.kind === "editor" && t.dirty);
      if (dirty) {
        window.alert(
          "Save or close unsaved editor tabs before switching workspace.",
        );
        return false;
      }

      let nextHome: string;
      try {
        nextHome = await resolveEnvHome(env);
      } catch (e) {
        if (mounted.current && epoch.current === request)
          window.alert(String(e));
        return false;
      }

      await authorizeHome(nextHome, env);
      if (!mounted.current || epoch.current !== request) return false;
      if (tabsRef.current.some((tab) => tab.kind === "editor" && tab.dirty)) {
        window.alert(
          "Save or close unsaved editor tabs before switching workspace.",
        );
        return false;
      }
      clearWorkspaceState();
      envRef.current = env.kind === "local" ? LOCAL_WORKSPACE : env;
      setWorkspaceEnv(envRef.current);
      setHome(nextHome);
      setLaunchCwd(nextHome);
      resetWorkspace(nextHome);
      return true;
    },
    [
      setWorkspaceEnv,
      resetWorkspace,
      tabsRef,
      clearWorkspaceState,
      authorizeHome,
    ],
  );

  const adoptWorkspaceEnv = useCallback(
    async (env: WorkspaceEnv): Promise<string | null> => {
      const request = ++epoch.current;
      envRef.current = env.kind === "local" ? LOCAL_WORKSPACE : env;
      setWorkspaceEnv(envRef.current);
      let nextHome: string;
      try {
        nextHome = await resolveEnvHome(env);
      } catch {
        return null;
      }
      await authorizeHome(nextHome, env);
      if (!mounted.current || epoch.current !== request) return null;
      setHome(nextHome);
      setLaunchCwd(nextHome);
      return nextHome;
    },
    [setWorkspaceEnv, authorizeHome],
  );

  return {
    home,
    launchCwd,
    launchCwdResolved,
    switchWorkspace,
    adoptWorkspaceEnv,
  };
}
