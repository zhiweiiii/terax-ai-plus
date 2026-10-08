import { listen } from "@tauri-apps/api/event";
import { useEffect, useRef } from "react";
import { errorToast } from "@/lib/errorToast";
import { consumeLaunchFiles } from "@/lib/launchDir";

export function useLaunchFiles(
  ready: boolean,
  onOpen: (paths: string[]) => void,
) {
  const latest = useRef({ ready, onOpen });
  latest.current = { ready, onOpen };
  const pending = useRef(new Set<string>());
  const mounted = useRef(false);

  useEffect(() => {
    mounted.current = true;
    let disposed = false;
    let unlisten: (() => void) | undefined;
    void listen<string[]>("terax:open-file", (event) => {
      if (disposed) return;
      const paths = event.payload.map((path) => path.replace(/\\/g, "/"));
      if (latest.current.ready) latest.current.onOpen(paths);
      else for (const path of paths) pending.current.add(path);
    })
      .then((off) => {
        if (disposed) off();
        else unlisten = off;
      })
      .catch((error) => errorToast("监听打开文件失败", error));
    return () => {
      mounted.current = false;
      disposed = true;
      unlisten?.();
    };
  }, []);

  useEffect(() => {
    if (!ready) return;
    const paths = [...pending.current];
    pending.current.clear();
    if (paths.length) latest.current.onOpen(paths);
    void consumeLaunchFiles()
      .then((files) => {
        if (mounted.current && latest.current.ready && files.length) {
          latest.current.onOpen(files);
        }
      })
      .catch((error) => errorToast("打开启动文件失败", error));
  }, [ready]);
}
