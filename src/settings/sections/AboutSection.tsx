import { Button } from "@/components/ui/button";
import { useUpdater } from "@/modules/updater";
import { isManualUpdate } from "@/modules/updater/useUpdater";
import { GithubIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { getName, getVersion } from "@tauri-apps/api/app";
import { openUrl } from "@tauri-apps/plugin-opener";
import { arch, platform } from "@tauri-apps/plugin-os";
import { useEffect, useState } from "react";
import { SectionHeader } from "@/settings/components/SectionHeader";
import { errorToast } from "@/lib/errorToast";

// This fork. The upstream project keeps its own repo and site; pointing at
// them here would show someone else's releases and issues as if they were
// this build's.
const REPO_URL = "https://github.com/zhiweiiii/awei-work";
const UPSTREAM_URL = "https://github.com/crynta/terax-ai";

const PLATFORM_LABEL: Record<string, string> = {
  macos: "macOS",
  windows: "Windows",
  linux: "Linux",
  ios: "iOS",
  android: "Android",
  freebsd: "FreeBSD",
};

export function AboutSection() {
  const [version, setVersion] = useState("");
  const [name, setName] = useState("awei-work");
  const [build, setBuild] = useState("");
  const { status, check, install } = useUpdater({ autoCheck: false });
  const checking = status.kind === "checking";
  const downloading = status.kind === "downloading";
  const available = status.kind === "available";
  const ready = status.kind === "ready";
  const checkLabel =
    status.kind === "uptodate"
      ? "已是最新版本"
      : status.kind === "error"
        ? "检查失败，请重试"
        : checking
          ? "检查中…"
          : downloading
            ? "下载中…"
            : ready
              ? "重启以完成安装"
              : available
                ? `${isManualUpdate(status.update) ? "下载" : "安装"} v${status.update.version}`
                : "检查更新";
  const onUpdateClick = () => {
    if (available) void install();
    else void check({ manual: true });
  };

  useEffect(() => {
    let alive = true;
    void getVersion()
      .then((value) => {
        if (alive) setVersion(value);
      })
      .catch((error) => {
        if (alive) errorToast("读取版本失败", error);
      });
    void getName()
      .then((value) => {
        if (alive) setName(value);
      })
      .catch((error) => {
        if (alive) errorToast("读取应用名称失败", error);
      });
    try {
      const p = platform();
      const a = arch();
      const platformLabel = PLATFORM_LABEL[p] ?? p;
      setBuild(`${platformLabel} · ${a}`);
    } catch {
      setBuild("");
    }
    return () => {
      alive = false;
    };
  }, []);

  const openLink = (url: string) => {
    void openUrl(url).catch((error) => errorToast("打开链接失败", error));
  };

  return (
    <div className="flex flex-col gap-6">
      <SectionHeader title="关于" description="" />

      <div className="flex items-center gap-4 rounded-xl border border-border/60 bg-card/60 p-5">
        <img src="/logo.png" alt="" className="size-12" draggable={false} />
        <div className="flex min-w-0 flex-col">
          <span className="text-[15px] font-semibold tracking-tight">
            {name}
          </span>
          <span className="text-[11px] text-muted-foreground">
            开源的 AI 原生终端模拟器
          </span>
          <span className="mt-1 font-mono text-[11px] text-muted-foreground">
            v{version || "..."}
          </span>
        </div>
      </div>

      <dl className="grid grid-cols-[110px_1fr] gap-y-2.5 text-[12px]">
        <dt className="text-muted-foreground">构建</dt>
        <dd className="font-mono text-[11.5px]">
          {build ? `${build} · v${version}` : `v${version}`}
        </dd>

        <dt className="text-muted-foreground">Bundle ID</dt>
        <dd className="font-mono text-[11.5px]">app.crynta.terax</dd>

        <dt className="text-muted-foreground">许可证</dt>
        <dd>Apache 2.0</dd>

        <dt className="text-muted-foreground">源代码</dt>
        <dd>
          <button
            type="button"
            onClick={() => openLink(REPO_URL)}
            className="inline-flex items-center gap-1.5 rounded-md text-[12px] underline-offset-2 hover:text-foreground hover:underline"
          >
            <HugeiconsIcon icon={GithubIcon} size={12} strokeWidth={1.75} />
            zhiweiiii/awei-work
          </button>
        </dd>
        <dt className="text-muted-foreground">上游项目</dt>
        <dd>
          <button
            type="button"
            onClick={() => openLink(UPSTREAM_URL)}
            className="inline-flex items-center gap-1.5 rounded-md text-[12px] underline-offset-2 hover:text-foreground hover:underline"
          >
            <HugeiconsIcon icon={GithubIcon} size={12} strokeWidth={1.75} />
            crynta/terax-ai
          </button>
        </dd>
      </dl>

      <div className="flex flex-col gap-1.5">
        <div className="flex gap-2">
          <Button
            size="sm"
            onClick={onUpdateClick}
            disabled={checking || downloading || ready}
          >
            {checkLabel}
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={() => openLink(REPO_URL)}
            className="gap-1.5"
          >
            <HugeiconsIcon icon={GithubIcon} size={12} strokeWidth={1.75} />在
            GitHub 查看
          </Button>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => openLink(`${REPO_URL}/issues/new`)}
          >
            反馈问题
          </Button>
        </div>
        {status.kind === "error" && (
          <p className="font-mono text-[10.5px] break-all text-destructive/80">
            {status.message}
          </p>
        )}
        {downloading && status.contentLength ? (
          <p className="text-[11px] text-muted-foreground">
            {Math.min(
              100,
              Math.round((status.downloaded / status.contentLength) * 100),
            )}
            %
          </p>
        ) : null}
      </div>
    </div>
  );
}
