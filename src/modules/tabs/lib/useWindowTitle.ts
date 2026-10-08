import { useEffect } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { findLeafCwd } from "@/modules/terminal/lib/panes";
import type { Tab } from "./useTabs";

const APP_NAME = "Terax";

function basename(path: string): string {
  const parts = path.split(/[\\/]/).filter(Boolean);
  return parts.length ? parts[parts.length - 1] : "/";
}

/** Label of the focused tab, using the active terminal pane's folder. */
function tabLabel(tab: Tab | undefined): string {
  if (!tab) return "";
  if (tab.kind === "terminal") {
    const cwd = findLeafCwd(tab.paneTree, tab.activeLeafId) ?? tab.cwd;
    return cwd ? basename(cwd) : tab.title;
  }
  return tab.title;
}

export function useWindowTitle(
  activeTab: Tab | undefined,
  explorerRoot: string | null,
): void {
  const project = explorerRoot ? basename(explorerRoot) : "";
  const label = tabLabel(activeTab);

  useEffect(() => {
    let title: string;
    if (project && label && label !== project) title = `${project} - ${label}`;
    else title = project || label || APP_NAME;

    document.title = title;
    void getCurrentWindow()
      .setTitle(title)
      .catch((error) =>
        console.warn("[terax] window title update failed:", error),
      );
  }, [project, label]);
}
