import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { errorToast } from "@/lib/errorToast";
import { usePreferencesStore } from "@/modules/settings/preferences";
import {
  type AgentEnvPreset,
  setAgentEnvPresets,
} from "@/modules/settings/store";
import {
  Delete02Icon,
  PencilEdit02Icon,
  SlidersHorizontalIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { invoke } from "@tauri-apps/api/core";
import { useState } from "react";
import { toast } from "sonner";

/** The three variables Claude Code reads for an alternate endpoint. */
const VARS = [
  "ANTHROPIC_BASE_URL",
  "ANTHROPIC_AUTH_TOKEN",
  "ANTHROPIC_MODEL",
] as const;

type Props = {
  /** Types into the terminal the panel is acting on. Absent when there is no
   *  live terminal, which is when the panel has nothing to act on. */
  onApply: ((command: string) => boolean) | undefined;
};

/**
 * Set Claude Code's endpoint parameters on the command line in front of you.
 *
 * The variables are typed into the CURRENT shell, so they last as long as that
 * shell and do not follow a new tab. That is the intent of "temporary"; it is
 * also why applying one does nothing to a Claude Code that is already running,
 * since a process reads its environment once at startup.
 */
export function AgentEnvButton({ onApply }: Props) {
  const presets = usePreferencesStore((s) => s.agentEnvPresets);
  const [open, setOpen] = useState(false);
  const [alias, setAlias] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const [token, setToken] = useState("");
  const [model, setModel] = useState("");
  const [busy, setBusy] = useState(false);

  /* Entries written by older builds hold DPAPI ciphertext instead of the
     token. Decrypt those once so they keep working; everything saved from now
     on is plain. */
  const readToken = async (preset: AgentEnvPreset): Promise<string> => {
    if (preset.token) return preset.token;
    if (!preset.tokenCipher) return "";
    return await invoke<string>("secret_unprotect", {
      value: preset.tokenCipher,
    });
  };

  const run = (command: string): boolean => {
    if (!onApply) {
      toast.error("没有可用的命令行");
      return false;
    }
    return onApply(command);
  };

  const apply = async () => {
    if (!baseUrl.trim() || !token.trim() || !model.trim()) return;
    setBusy(true);
    try {
      const values = [baseUrl.trim(), token.trim(), model.trim()];
      if (!run(assignments(values))) return;

      const next: AgentEnvPreset = {
        id: `${Date.now()}`,
        alias: alias.trim() || undefined,
        baseUrl: baseUrl.trim(),
        model: model.trim(),
        token: token.trim(),
        usedAt: Date.now(),
      };
      await setAgentEnvPresets([
        next,
        // Same endpoint, same model and same token is the same entry; keep one.
        ...presets.filter(
          (p) =>
            p.baseUrl !== next.baseUrl ||
            p.model !== next.model ||
            p.token !== next.token,
        ),
      ]);
      setOpen(false);
      toast.success("已设置，下次启动 claude 时生效");
    } catch (e) {
      toast.error(typeof e === "string" ? e : String(e));
    } finally {
      setBusy(false);
    }
  };

  /* Load a saved set back into the form so it can be corrected instead of
     retyped. The token is decrypted into the field, which is a password input,
     so it is no more exposed than while it was first being entered. */
  const editPreset = async (preset: AgentEnvPreset) => {
    setBusy(true);
    try {
      const plain = await readToken(preset);
      setAlias(preset.alias ?? "");
      setBaseUrl(preset.baseUrl);
      setToken(plain);
      setModel(preset.model);
    } catch (e) {
      errorToast("读取历史配置失败", e);
    } finally {
      setBusy(false);
    }
  };

  /* Forget one saved set. No confirmation: it holds nothing that cannot be
     entered again, and the entry it deletes is the one under the pointer. */
  const deletePreset = async (preset: AgentEnvPreset) => {
    setBusy(true);
    try {
      await setAgentEnvPresets(presets.filter((p) => p.id !== preset.id));
    } catch (e) {
      errorToast("删除历史配置失败", e);
    } finally {
      setBusy(false);
    }
  };

  const applyPreset = async (preset: AgentEnvPreset) => {
    setBusy(true);
    try {
      const plain = await readToken(preset);
      if (!run(assignments([preset.baseUrl, plain, preset.model]))) return;
      await setAgentEnvPresets([
        { ...preset, usedAt: Date.now() },
        ...presets.filter((p) => p.id !== preset.id),
      ]);
      setOpen(false);
      toast.success("已设置，下次启动 claude 时生效");
    } catch (e) {
      toast.error(typeof e === "string" ? e : String(e));
    } finally {
      setBusy(false);
    }
  };

  const clear = () => {
    if (!run(VARS.map((v) => `Remove-Item Env:${v} -ErrorAction Ignore`).join("; "))) {
      return;
    }
    setOpen(false);
    toast.success("已清空，下次启动 claude 时生效");
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          className="size-6 text-muted-foreground hover:text-foreground"
          title="Claude Code 参数"
          aria-label="Claude Code 参数"
        >
          <HugeiconsIcon
            icon={SlidersHorizontalIcon}
            size={13}
            strokeWidth={2}
          />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" side="top" className="w-96 p-3">
        <div className="flex flex-col gap-2.5">
          <div className="flex flex-col gap-1">
            <Label className="text-[11px]">别名</Label>
            <Input
              className="h-8"
              value={alias}
              onChange={(e) => setAlias(e.target.value)}
              placeholder="例如 DeepSeek 正式"
              spellCheck={false}
            />
          </div>
          <div className="flex flex-col gap-1">
            <Label className="text-[11px]">Base URL</Label>
            <Input
              className="h-8"
              value={baseUrl}
              onChange={(e) => setBaseUrl(e.target.value)}
              placeholder="https://api.deepseek.com/anthropic"
              spellCheck={false}
            />
          </div>
          <div className="flex flex-col gap-1">
            <Label className="text-[11px]">Auth Token</Label>
            <Input
              className="h-8"
              value={token}
              onChange={(e) => setToken(e.target.value)}
              placeholder="sk-..."
              autoComplete="off"
              spellCheck={false}
            />
          </div>
          <div className="flex flex-col gap-1">
            <Label className="text-[11px]">Model</Label>
            <Input
              className="h-8"
              value={model}
              onChange={(e) => setModel(e.target.value)}
              placeholder="deepseek-v4-pro[1m]"
              spellCheck={false}
            />
          </div>

          <p className="text-[10.5px] leading-snug text-muted-foreground">
            写入当前命令行，只对这个 shell 有效。已经在运行的 claude
            不会改变，需要重新启动。
          </p>

          <div className="flex items-center gap-2">
            <Button
              size="sm"
              className="flex-1"
              disabled={busy || !baseUrl.trim() || !token.trim() || !model.trim()}
              onClick={() => void apply()}
            >
              设置
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={busy}
              onClick={clear}
            >
              清空
            </Button>
          </div>

          {presets.length > 0 ? (
            <div className="flex flex-col gap-1 border-t border-border/60 pt-2">
              <span className="text-[10.5px] text-muted-foreground">
                历史配置
              </span>
              {presets.map((preset) => (
                <div
                  key={preset.id}
                  className="group flex items-center gap-1 rounded-md pr-1 hover:bg-foreground/[0.06]"
                >
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => void applyPreset(preset)}
                    title="套用这组参数"
                    className="flex min-w-0 flex-1 flex-col items-start gap-0.5 px-2 py-1.5 text-left disabled:opacity-50"
                  >
                    <span className="w-full truncate text-[11px] text-foreground">
                      {preset.alias || preset.model}
                    </span>
                    <span className="w-full truncate text-[10px] text-muted-foreground">
                      {preset.alias ? `${preset.model} · ` : ""}
                      {preset.baseUrl}
                      {preset.token ? ` · ${preset.token}` : ""}
                    </span>
                  </button>
                  {/* Shown on hover so a list of endpoints stays readable, but
                      kept in the tab order and visible on focus: hover-only
                      controls are unreachable from the keyboard. */}
                  <span className="flex shrink-0 items-center gap-0.5 opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100">
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => void editPreset(preset)}
                      title="编辑：载入上方表单"
                      className="flex size-6 items-center justify-center rounded text-muted-foreground hover:bg-foreground/10 hover:text-foreground disabled:opacity-50"
                    >
                      <HugeiconsIcon icon={PencilEdit02Icon} size={12} strokeWidth={1.75} />
                    </button>
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => void deletePreset(preset)}
                      title="删除这条历史"
                      className="flex size-6 items-center justify-center rounded text-muted-foreground hover:bg-destructive/15 hover:text-destructive disabled:opacity-50"
                    >
                      <HugeiconsIcon icon={Delete02Icon} size={12} strokeWidth={1.75} />
                    </button>
                  </span>
                </div>
              ))}
            </div>
          ) : null}
        </div>
      </PopoverContent>
    </Popover>
  );
}

/** PowerShell assignments, single-quoted so nothing in a URL, token or model
 *  string is interpreted. A literal quote is doubled, which is the escape
 *  PowerShell uses inside a single-quoted string. */
function assignments(values: string[]): string {
  return VARS.map(
    (name, i) => `$env:${name}='${values[i].replace(/'/g, "''")}'`,
  ).join("; ");
}


