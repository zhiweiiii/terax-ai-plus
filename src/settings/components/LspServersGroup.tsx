import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import {
  allServers,
  detectBinary,
  type LspPreset,
  redetectBinary,
  useLspRuntimeStore,
} from "@/modules/lsp";
import { usePreferencesStore } from "@/modules/settings/preferences";
import {
  type LspCustomServer,
  loadPreferences,
  setLspActivation,
  setLspCustomServers,
} from "@/modules/settings/store";
import { Delete02Icon, Refresh01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useEffect, useId, useRef, useState } from "react";
import { errorToast } from "@/lib/errorToast";
import { LspInstallDialog } from "./LspInstallDialog";
import { resolveLspSwitchState } from "./lspSwitchState";
import { SettingRow } from "./SettingRow";

let customMutation = Promise.resolve();
function queueCustomMutation(work: () => Promise<void>): Promise<void> {
  const operation = customMutation.then(work);
  customMutation = operation.catch(() => {});
  return operation;
}

export function LspServersGroup() {
  const activation = usePreferencesStore((s) => s.lspActivation);
  const customServers = usePreferencesStore((s) => s.lspCustomServers);
  const [installTarget, setInstallTarget] = useState<LspPreset | null>(null);
  const servers = allServers(customServers);

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center justify-between">
        <Label>语言服务器</Label>
        <AddCustomServerDialog />
      </div>
      {servers.map((server) => (
        <ServerRow
          key={server.id}
          server={server}
          enabled={activation[server.id] === "enabled"}
          custom={customServers.some((c) => c.id === server.id)}
          onInstall={() => setInstallTarget(server)}
        />
      ))}
      <LspInstallDialog
        key={installTarget?.id ?? "closed"}
        server={installTarget}
        onClose={() => setInstallTarget(null)}
      />
    </div>
  );
}

function ServerRow({
  server,
  enabled,
  custom,
  onInstall,
}: {
  server: LspPreset;
  enabled: boolean;
  custom: boolean;
  onInstall: () => void;
}) {
  const detected = useLspRuntimeStore((s) => s.detected[server.command]);
  const detectionError = useLspRuntimeStore(
    (s) => s.detectionErrors[server.command],
  );
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);
  const run = async (work: () => Promise<unknown>) => {
    if (busyRef.current || !mountedRef.current) return;
    busyRef.current = true;
    setBusy(true);
    try {
      await work();
    } catch (error) {
      errorToast("Could not update language server", error);
    } finally {
      busyRef.current = false;
      if (mountedRef.current) setBusy(false);
    }
  };

  useEffect(() => {
    void detectBinary(server.command).catch((error) =>
      errorToast("Could not detect language server", error),
    );
  }, [server.command]);

  const langs = Object.keys(server.languages).join(", ");
  const status = detectionError
    ? `检测失败：${detectionError}`
    : detected === undefined
      ? "检测中..."
      : detected
        ? detected
        : "PATH 中未找到";
  const switchState = resolveLspSwitchState(enabled, detected);

  return (
    <SettingRow
      title={
        <span className="flex items-center gap-1.5">
          {server.name}
          {detected ? (
            <span className="size-1.5 rounded-full bg-emerald-500" />
          ) : null}
        </span>
      }
      description={`${server.command} (${langs}) - ${status}`}
    >
      <div className="flex items-center gap-1.5">
        <button
          type="button"
          className="cursor-pointer rounded p-1 text-muted-foreground hover:bg-accent hover:text-foreground"
          disabled={busy}
          onClick={() => void run(() => redetectBinary(server.command))}
          title="重新检测"
        >
          <HugeiconsIcon icon={Refresh01Icon} size={12} strokeWidth={1.75} />
        </button>
        {custom ? (
          <button
            type="button"
            className="cursor-pointer rounded p-1 text-muted-foreground hover:bg-accent hover:text-destructive"
            disabled={busy}
            onClick={() =>
              void run(() =>
                queueCustomMutation(async () => {
                  await setLspActivation(server.id, null);
                  await setLspCustomServers(
                    (await loadPreferences()).lspCustomServers.filter(
                      (item) => item.id !== server.id,
                    ),
                  );
                }),
              )
            }
            title="移除服务器"
          >
            <HugeiconsIcon icon={Delete02Icon} size={12} strokeWidth={1.75} />
          </button>
        ) : null}
        <Switch
          checked={switchState.checked}
          disabled={switchState.checking || busy}
          aria-label={`${switchState.checked ? "停用" : "启用"} ${server.name} 语言服务器`}
          onCheckedChange={(checked) => {
            if (!checked) {
              void run(() => setLspActivation(server.id, "dismissed"));
              return;
            }
            if (switchState.enableAction === "enable") {
              void run(() => setLspActivation(server.id, "enabled"));
            } else if (switchState.enableAction === "install") {
              onInstall();
            }
          }}
        />
      </div>
    </SettingRow>
  );
}

function AddCustomServerDialog() {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [command, setCommand] = useState("");
  const [args, setArgs] = useState("");
  const [extensions, setExtensions] = useState("");
  const [languageId, setLanguageId] = useState("");
  const [rootMarkers, setRootMarkers] = useState("");
  const formId = useId();
  const [saving, setSaving] = useState(false);
  const busyRef = useRef(false);
  const mountedRef = useRef(true);
  const submittedIdRef = useRef<{ signature: string; id: string } | null>(null);
  const fieldsRef = useRef({
    name,
    command,
    args,
    extensions,
    languageId,
    rootMarkers,
  });
  fieldsRef.current = {
    name,
    command,
    args,
    extensions,
    languageId,
    rootMarkers,
  };
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const parsedExts = extensions
    .split(",")
    .map((s) => s.trim().replace(/^\./, "").toLowerCase())
    .filter(Boolean);
  const valid =
    name.trim().length > 0 &&
    command.trim().length > 0 &&
    parsedExts.length > 0;

  const save = async () => {
    if (!valid || busyRef.current || !mountedRef.current) return;
    busyRef.current = true;
    setSaving(true);
    const submitted = fieldsRef.current;
    try {
      const langId = languageId.trim() || (parsedExts[0] ?? "");
      const signature = JSON.stringify(submitted);
      if (submittedIdRef.current?.signature !== signature)
        submittedIdRef.current = {
          signature,
          id: `custom-${crypto.randomUUID()}`,
        };
      const id = submittedIdRef.current.id;
      const parsedArgs: unknown = args.trim().startsWith("[")
        ? JSON.parse(args)
        : args.trim()
          ? args.trim().split(/\s+/)
          : [];
      if (
        !Array.isArray(parsedArgs) ||
        !parsedArgs.every((item) => typeof item === "string")
      )
        throw new Error(
          "Arguments must be a string array or whitespace-separated values",
        );
      const server: LspCustomServer = {
        id,
        name: name.trim(),
        command: command.trim(),
        args: parsedArgs,
        languages: Object.fromEntries(parsedExts.map((e) => [e, langId])),
        rootMarkers: rootMarkers
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean),
      };
      await queueCustomMutation(async () => {
        await setLspCustomServers([
          ...(await loadPreferences()).lspCustomServers.filter(
            (item) => item.id !== id,
          ),
          server,
        ]);
        await setLspActivation(id, "enabled");
      });
      if (
        !mountedRef.current ||
        JSON.stringify(fieldsRef.current) !== JSON.stringify(submitted)
      )
        return;
      setOpen(false);
      submittedIdRef.current = null;
      setName("");
      setCommand("");
      setArgs("");
      setExtensions("");
      setLanguageId("");
      setRootMarkers("");
    } catch (error) {
      errorToast("Could not add language server", error);
    } finally {
      busyRef.current = false;
      if (mountedRef.current) setSaving(false);
    }
  };

  const field = (
    key: string,
    label: string,
    value: string,
    onChange: (v: string) => void,
    placeholder: string,
  ) => (
    <div className="flex flex-col gap-1">
      <Label htmlFor={`${formId}-${key}`} className="text-[11px]">
        {label}
      </Label>
      <Input
        id={`${formId}-${key}`}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className="h-7 text-xs"
      />
    </div>
  );

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="outline" size="sm" className="h-6 px-2 text-[11px]">
          添加自定义服务器
        </Button>
      </DialogTrigger>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle className="text-sm">自定义语言服务器</DialogTitle>
        </DialogHeader>
        <div className="flex flex-col gap-2.5">
          {field("name", "名称", name, setName, "Zig")}
          {field("command", "命令", command, setCommand, "zls")}
          {field(
            "args",
            "参数",
            args,
            setArgs,
            '--stdio 或 ["--config", "C:/Program Files/config.json"]',
          )}
          {field("exts", "文件扩展名", extensions, setExtensions, "zig, zon")}
          {field("langid", "LSP 语言 id", languageId, setLanguageId, "zig")}
          {field(
            "roots",
            "根目录标记",
            rootMarkers,
            setRootMarkers,
            "build.zig",
          )}
        </div>
        <DialogFooter>
          <Button
            size="sm"
            disabled={!valid || saving}
            onClick={() => void save()}
          >
            添加服务器
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
