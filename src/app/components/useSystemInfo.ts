import { invoke } from "@tauri-apps/api/core";
import { useEffect, useState } from "react";

const OS_LABEL = "Windows";

let shellPromise: Promise<string | null> | null = null;
function detectShell(): Promise<string | null> {
  if (!shellPromise) {
    shellPromise = invoke<string>("pty_shell_name")
      .then((s) => s || null)
      .catch(() => null);
  }
  return shellPromise;
}

export type SystemInfo = { os: string | null; shell: string | null };

export function useSystemInfo(): SystemInfo {
  const [shell, setShell] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    detectShell().then((s) => {
      if (alive) setShell(s);
    });
    return () => {
      alive = false;
    };
  }, []);
  return { os: OS_LABEL, shell };
}
