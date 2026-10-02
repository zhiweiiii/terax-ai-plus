import { relaunch } from "@tauri-apps/plugin-process";
import { check, type Update } from "@tauri-apps/plugin-updater";
import { getVersion } from "@tauri-apps/api/app";
import { openUrl } from "@tauri-apps/plugin-opener";
import { useCallback, useEffect, useState } from "react";

const LAST_CHECK_KEY = "terax-plus:updater:last-check";
const CHECK_INTERVAL_MS = 30 * 60 * 1000;
const RELEASES_URL = "https://github.com/zhiweiiii/terax-ai-plus/releases";
const SIGNED_UPDATES = import.meta.env.VITE_TERAX_SIGNED_UPDATES === "true";

type ManualUpdate = {
  manual: true;
  version: string;
  body: string;
  url: string;
};

export function isManualUpdate(
  update: Update | ManualUpdate,
): update is ManualUpdate {
  return "manual" in update;
}

function versionParts(value: string): number[] | null {
  const match = /^(?:build-)?v?(\d+)\.(\d+)\.(\d+)$/.exec(value);
  return match ? match.slice(1).map(Number) : null;
}

async function checkManualUpdate(): Promise<ManualUpdate | null> {
  const response = await fetch(
    "https://api.github.com/repos/zhiweiiii/terax-ai-plus/releases?per_page=20",
    {
      signal: AbortSignal.timeout(15_000),
      headers: { Accept: "application/vnd.github+json" },
    },
  );
  if (!response.ok) throw new Error(`更新服务返回 ${response.status}`);
  const releases: unknown = await response.json();
  if (!Array.isArray(releases)) throw new Error("更新服务返回了无效数据");
  const current = versionParts(await getVersion());
  if (!current) throw new Error("无法读取当前版本号");
  const candidates = releases.flatMap((release) => {
    if (!release || typeof release !== "object") return [];
    const { tag_name: tag, draft, prerelease, body, assets } = release;
    if (
      draft ||
      prerelease ||
      typeof tag !== "string" ||
      !Array.isArray(assets)
    )
      return [];
    const parts = versionParts(tag);
    if (
      !parts ||
      !assets.some(
        (asset) =>
          typeof asset?.name === "string" &&
          asset.name === `Terax_${parts.join(".")}_x64-setup.exe` &&
          asset.state === "uploaded",
      )
    )
      return [];
    return [{ parts, tag, body: typeof body === "string" ? body : "" }];
  });
  candidates.sort(
    (a, b) =>
      b.parts[0] - a.parts[0] ||
      b.parts[1] - a.parts[1] ||
      b.parts[2] - a.parts[2],
  );
  const latest = candidates[0];
  if (!latest) throw new Error("暂时没有可用的 Windows 安装包");
  const newer =
    latest.parts[0] > current[0] ||
    (latest.parts[0] === current[0] &&
      (latest.parts[1] > current[1] ||
        (latest.parts[1] === current[1] && latest.parts[2] > current[2])));
  return newer
    ? {
        manual: true,
        version: latest.parts.join("."),
        body: latest.body,
        url: `${RELEASES_URL}/tag/${encodeURIComponent(latest.tag)}`,
      }
    : null;
}

export type UpdaterStatus =
  | { kind: "idle" }
  | { kind: "checking" }
  | { kind: "uptodate" }
  | { kind: "available"; update: Update | ManualUpdate }
  | { kind: "downloading"; downloaded: number; contentLength: number | null }
  | { kind: "ready" }
  | { kind: "error"; message: string };

interface Options {
  /** Skip the time-based throttle on automatic startup checks. */
  manual?: boolean;
}

interface HookOptions {
  /** When false, the hook does not run an automatic check on mount. */
  autoCheck?: boolean;
}

export function useUpdater({ autoCheck = true }: HookOptions = {}) {
  const [status, setStatus] = useState<UpdaterStatus>({ kind: "idle" });

  const runCheck = useCallback(async ({ manual }: Options = {}) => {
    if (!manual) {
      const last = Number(localStorage.getItem(LAST_CHECK_KEY) ?? 0);
      if (Date.now() - last < CHECK_INTERVAL_MS) return;
    }
    setStatus({ kind: "checking" });
    try {
      const update = SIGNED_UPDATES
        ? await check().catch(() => checkManualUpdate())
        : await checkManualUpdate();
      localStorage.setItem(LAST_CHECK_KEY, String(Date.now()));
      if (update) {
        setStatus({ kind: "available", update });
      } else {
        setStatus({ kind: "uptodate" });
      }
    } catch (err) {
      setStatus({ kind: "error", message: String(err) });
    }
  }, []);

  const install = useCallback(async () => {
    if (status.kind !== "available") return;
    const { update } = status;
    if (isManualUpdate(update)) {
      try {
        await openUrl(update.url);
      } catch (err) {
        setStatus({ kind: "error", message: String(err) });
      }
      return;
    }
    let total: number | null = null;
    let downloaded = 0;
    setStatus({ kind: "downloading", downloaded: 0, contentLength: null });
    try {
      await update.downloadAndInstall((event) => {
        if (event.event === "Started") {
          total = event.data.contentLength ?? null;
          setStatus({
            kind: "downloading",
            downloaded: 0,
            contentLength: total,
          });
        } else if (event.event === "Progress") {
          downloaded += event.data.chunkLength;
          setStatus({ kind: "downloading", downloaded, contentLength: total });
        } else if (event.event === "Finished") {
          setStatus({ kind: "ready" });
        }
      });
      await relaunch();
    } catch (err) {
      setStatus({ kind: "error", message: String(err) });
    }
  }, [status]);

  const dismiss = useCallback(() => {
    setStatus({ kind: "idle" });
  }, []);

  useEffect(() => {
    if (!autoCheck) return;
    void runCheck();
  }, [autoCheck, runCheck]);

  return { status, check: runCheck, install, dismiss };
}
