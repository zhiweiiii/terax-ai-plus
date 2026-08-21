import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { cn } from "@/lib/utils";
import { usePreferencesStore } from "@/modules/settings/preferences";
import {
  type AgentEnvPreset,
  setAgentEnvPresets,
} from "@/modules/settings/store";
import { SlidersHorizontalIcon } from "@hugeicons/core-free-icons";
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
  const [baseUrl, setBaseUrl] = useState("");
  const [token, setToken] = useState("");
  const [model, setModel] = useState("");
  const [busy, setBusy] = useState(false);

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
      const cipher = await invoke<string>("secret_protect", {
        value: token.trim(),
      });
      const values = [baseUrl.trim(), token.trim(), model.trim()];
      if (!run(assignments(values))) return;

      const next: AgentEnvPreset = {
        id: `${Date.now()}`,
        baseUrl: baseUrl.trim(),
        model: model.trim(),
        tokenCipher: cipher,
        tokenHint: hint(token.trim()),
        usedAt: Date.now(),
      };
      await setAgentEnvPresets([
        next,
        // Same endpoint, same model and same token is the same entry; keep one.
        ...presets.filter(
          (p) =>
            p.baseUrl !== next.baseUrl ||
            p.model !== next.model ||
            p.tokenHint !== next.tokenHint,
        ),
      ]);
      setToken("");
      setOpen(false);
      toast.success("已设置，下次启动 claude 时生效");
    } catch (e) {
      toast.error(typeof e === "string" ? e : String(e));
    } finally {
      setBusy(false);
    }
  };

  const applyPreset = async (preset: AgentEnvPreset) => {
    setBusy(true);
    try {
      const plain = await invoke<string>("secret_unprotect", {
        value: preset.tokenCipher,
      });
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
              type="password"
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
                <button
                  key={preset.id}
                  type="button"
                  disabled={busy}
                  onClick={() => void applyPreset(preset)}
                  className={cn(
                    "flex flex-col items-start gap-0.5 rounded-md px-2 py-1.5 text-left",
                    "hover:bg-foreground/[0.06] disabled:opacity-50",
                  )}
                >
                  <span className="truncate text-[11px] text-foreground">
                    {preset.model}
                  </span>
                  <span className="truncate text-[10px] text-muted-foreground">
                    {preset.baseUrl} · {preset.tokenHint}
                  </span>
                </button>
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

/** Enough of a token to recognise it, not enough to use it. */
function hint(token: string): string {
  return token.length <= 8 ? "····" : `····${token.slice(-4)}`;
}
