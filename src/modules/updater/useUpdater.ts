import { relaunch } from "@tauri-apps/plugin-process";
import { check, type Update } from "@tauri-apps/plugin-updater";
import { getVersion } from "@tauri-apps/api/app";
import { openUrl } from "@tauri-apps/plugin-opener";
import { emitTo } from "@tauri-apps/api/event";
import { Window } from "@tauri-apps/api/window";
import { useCallback, useEffect, useRef, useState } from "react";

const LAST_CHECK_KEY = "terax-plus:updater:last-check";
const CHECK_INTERVAL_MS = 30 * 60 * 1000;
const RELEASES_URL = "https://github.com/zhiweiiii/awei-work/releases";
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
  if (!match) return null;
  const parts = match.slice(1).map(Number);
  return parts.every(Number.isSafeInteger) ? parts : null;
}

async function checkManualUpdate(): Promise<ManualUpdate | null> {
  const response = await fetch(
    "https://api.github.com/repos/zhiweiiii/awei-work/releases?per_page=20",
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
          (asset.name === `awei-work_${parts.join(".")}_x64-setup.exe` ||
            asset.name === `Terax_${parts.join(".")}_x64-setup.exe`) &&
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
  | { kind: "error"; message: string; interactive: boolean };

interface Options {
  /** Skip the time-based throttle on automatic startup checks. */
  manual?: boolean;
}

interface HookOptions {
  /** When false, the hook does not run an automatic check on mount. */
  autoCheck?: boolean;
  beforeInstall?: () => Promise<void>;
}

export function useUpdater({
  autoCheck = true,
  beforeInstall,
}: HookOptions = {}) {
  const [status, setStatus] = useState<UpdaterStatus>({ kind: "idle" });
  const stateRef = useRef(status);
  stateRef.current = status;
  const guardRef = useRef(beforeInstall);
  guardRef.current = beforeInstall;
  const aliveRef = useRef(false);
  const generation = useRef(0);
  const busyRef = useRef(false);
  const resourceRef = useRef<Update | null>(null);

  const publish = useCallback((next: UpdaterStatus) => {
    stateRef.current = next;
    setStatus(next);
  }, []);

  const release = useCallback(() => {
    const resource = resourceRef.current;
    resourceRef.current = null;
    if (resource) void resource.close().catch(() => {});
  }, []);

  useEffect(() => {
    aliveRef.current = true;
    return () => {
      aliveRef.current = false;
      generation.current++;
      busyRef.current = false;
      release();
    };
  }, [release]);

  const runCheck = useCallback(
    async ({ manual }: Options = {}) => {
      if (!aliveRef.current || busyRef.current) return;
      if (!manual) {
        try {
          const last = Number(localStorage.getItem(LAST_CHECK_KEY) ?? 0);
          const elapsed = Date.now() - last;
          if (
            Number.isFinite(last) &&
            elapsed >= 0 &&
            elapsed < CHECK_INTERVAL_MS
          )
            return;
        } catch {}
      }
      busyRef.current = true;
      const request = ++generation.current;
      const current = () => aliveRef.current && generation.current === request;
      release();
      publish({ kind: "checking" });
      try {
        const update = SIGNED_UPDATES
          ? await check({ timeout: 15_000 }).catch(() => checkManualUpdate())
          : await checkManualUpdate();
        if (!current()) {
          if (update && !isManualUpdate(update))
            await update.close().catch(() => {});
          return;
        }
        try {
          localStorage.setItem(LAST_CHECK_KEY, String(Date.now()));
        } catch {}
        if (update) {
          if (!isManualUpdate(update)) resourceRef.current = update;
          publish({ kind: "available", update });
        } else {
          publish({ kind: "uptodate" });
        }
      } catch (err) {
        if (current())
          publish({
            kind: "error",
            message: String(err),
            interactive: manual === true,
          });
      } finally {
        if (generation.current === request) busyRef.current = false;
      }
    },
    [publish, release],
  );

  const install = useCallback(async () => {
    const status = stateRef.current;
    if (!aliveRef.current || busyRef.current) return;
    if (status.kind !== "available") return;
    const { update } = status;
    busyRef.current = true;
    const request = ++generation.current;
    const current = () => aliveRef.current && generation.current === request;
    let total: number | null = null;
    let downloaded = 0;
    try {
      if (isManualUpdate(update)) {
        await openUrl(update.url);
        return;
      }
      if (!guardRef.current) {
        const mainWindow = await Window.getByLabel("main");
        if (!mainWindow) throw new Error("主窗口不可用，请稍后重试");
        await mainWindow.show();
        await mainWindow.setFocus();
        await emitTo("main", "terax:check-update");
        if (current()) publish({ kind: "idle" });
        return;
      }
      publish({ kind: "downloading", downloaded: 0, contentLength: null });
      await update.download(
        (event) => {
          if (!current()) return;
          if (event.event === "Started") {
            total = event.data.contentLength ?? null;
            publish({
              kind: "downloading",
              downloaded: 0,
              contentLength: total,
            });
          } else if (event.event === "Progress") {
            downloaded += event.data.chunkLength;
            publish({ kind: "downloading", downloaded, contentLength: total });
          }
        },
        { timeout: 120_000 },
      );
      if (!current()) return;
      await guardRef.current();
      if (!current()) return;
      publish({ kind: "ready" });
      await update.install();
      if (!current()) return;
      await relaunch();
    } catch (err) {
      if (current())
        publish({ kind: "error", message: String(err), interactive: true });
    } finally {
      if (generation.current === request) {
        busyRef.current = false;
        if (!isManualUpdate(update)) release();
      }
    }
  }, [publish, release]);

  const dismiss = useCallback(() => {
    if (busyRef.current) return;
    generation.current++;
    release();
    publish({ kind: "idle" });
  }, [publish, release]);

  useEffect(() => {
    if (!autoCheck) return;
    void runCheck();
  }, [autoCheck, runCheck]);

  return { status, check: runCheck, install, dismiss };
}
