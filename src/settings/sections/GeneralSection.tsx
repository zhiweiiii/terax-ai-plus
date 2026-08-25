import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Slider } from "@/components/ui/slider";
import { Switch } from "@/components/ui/switch";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { usePreferencesStore } from "@/modules/settings/preferences";
import type { ThemePref } from "@/modules/settings/store";
import {
  setAutostart,
  setDefaultWorkspaceEnv,
  setAgentKeyPassthrough,
  setExplorerGitDecorations,
  setRestoreWindowState,
  setTerminalCursorBlink,
  setTerminalCursorStyle,
  setTerminalFontFamily,
  setTerminalFontSize,
  setTerminalFontWeight,
  setTerminalLetterSpacing,
  setTerminalScrollback,
  setTerminalShell,
  setTerminalWebglEnabled,
  setZoomLevel,
  TERMINAL_FONT_SIZES,
  TERMINAL_SCROLLBACK_PRESETS,
} from "@/modules/settings/store";
import { useTheme } from "@/modules/theme";
import {
  ComputerIcon,
  Moon02Icon,
  Sun03Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { invoke } from "@tauri-apps/api/core";
import { disable, enable, isEnabled } from "@tauri-apps/plugin-autostart";
import { useEffect, useState } from "react";
import { SectionHeader } from "../components/SectionHeader";
import { SettingRow } from "../components/SettingRow";

const APPEARANCE: {
  id: ThemePref;
  label: string;
  icon: typeof ComputerIcon;
}[] = [
  { id: "system", label: "跟随系统", icon: ComputerIcon },
  { id: "light", label: "浅色", icon: Sun03Icon },
  { id: "dark", label: "深色", icon: Moon02Icon },
];

const TERMINAL_FONT_WEIGHTS = [
  { value: "normal", label: "常规" },
  { value: "500", label: "中等" },
  { value: "600", label: "半粗" },
  { value: "bold", label: "粗体" },
] as const;
const TERMINAL_CURSOR_STYLES = [
  { value: "bar", label: "竖线" },
  { value: "block", label: "方块" },
  { value: "underline", label: "下划线" },
] as const;
const LETTER_SPACINGS = [-4, -3, -2, -1, 0, 1, 2, 3, 4] as const;

type ShellInfo = { name: string; path: string; integrated: boolean };
const SHELL_AUTO = "auto";
const ZOOM_MIN = 0.5;
const ZOOM_MAX = 2.0;
const ZOOM_STEP = 0.05;

export function GeneralSection() {
  const { mode, setMode } = useTheme();

  const autostart = usePreferencesStore((s) => s.autostart);
  const restoreWindowState = usePreferencesStore((s) => s.restoreWindowState);
  const explorerGitDecorations = usePreferencesStore(
    (s) => s.explorerGitDecorations,
  );
  const agentKeyPassthrough = usePreferencesStore((s) => s.agentKeyPassthrough);
  const terminalWebglEnabled = usePreferencesStore(
    (s) => s.terminalWebglEnabled,
  );
  const terminalCursorBlink = usePreferencesStore((s) => s.terminalCursorBlink);
  const terminalCursorStyle = usePreferencesStore((s) => s.terminalCursorStyle);
  const terminalFontFamily = usePreferencesStore((s) => s.terminalFontFamily);
  const terminalFontWeight = usePreferencesStore((s) => s.terminalFontWeight);
  const terminalShell = usePreferencesStore((s) => s.terminalShell);
  const [shells, setShells] = useState<ShellInfo[]>([]);
  const [wslDistros, setWslDistros] = useState<{ name: string }[]>([]);
  const defaultWorkspaceEnv = usePreferencesStore((s) => s.defaultWorkspaceEnv);
  const terminalLetterSpacing = usePreferencesStore(
    (s) => s.terminalLetterSpacing,
  );
  const terminalFontSize = usePreferencesStore((s) => s.terminalFontSize);
  const terminalScrollback = usePreferencesStore((s) => s.terminalScrollback);
  const zoomLevel = usePreferencesStore((s) => s.zoomLevel);

  useEffect(() => {
    let alive = true;
    void isEnabled()
      .then((on) => {
        if (!alive) return;
        if (on !== usePreferencesStore.getState().autostart) {
          void setAutostart(on);
        }
      })
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, []);

  useEffect(() => {
    void invoke<ShellInfo[]>("pty_list_shells")
      .then(setShells)
      .catch(() => {});
    void invoke<{ name: string }[]>("wsl_list_distros")
      .then(setWslDistros)
      .catch(() => {});
  }, []);

  const onToggleAutostart = async (next: boolean) => {
    try {
      if (next) await enable();
      else await disable();
      await setAutostart(next);
    } catch (e) {
      console.error("autostart toggle failed", e);
    }
  };

  return (
    <div className="flex flex-col gap-6">
      <SectionHeader title="通用" description="外观模式、终端与启动项。" />

      <div className="flex flex-col gap-2">
        <Label>外观</Label>
        <div className="grid grid-cols-3 gap-2">
          {APPEARANCE.map((o) => (
            <button
              key={o.id}
              type="button"
              onClick={() => setMode(o.id)}
              className={cn(
                "group flex h-20 flex-col items-center justify-center gap-1.5 rounded-lg border bg-card transition-all",
                mode === o.id
                  ? "border-foreground/60 ring-1 ring-foreground/20"
                  : "border-border/60 hover:border-border",
              )}
            >
              <HugeiconsIcon icon={o.icon} size={18} strokeWidth={1.5} />
              <span className="text-[11.5px]">{o.label}</span>
            </button>
          ))}
        </div>
        <p className="text-[11px] text-muted-foreground">
          主题配色、背景图与个性化设置请前往{" "}
          <strong className="font-medium text-foreground">主题</strong> 标签页。
        </p>
      </div>

      <div className="flex flex-col gap-2">
        <Label>缩放</Label>
        <div className="flex flex-col gap-3 rounded-lg border border-border/60 p-3">
          <div className="flex items-center justify-between gap-3">
            <span className="text-[11.5px] text-muted-foreground">
              界面缩放比例
            </span>
            <span className="tabular-nums text-[11px] text-muted-foreground">
              {Math.round(zoomLevel * 100)}%
            </span>
          </div>
          <Slider
            value={[zoomLevel]}
            min={ZOOM_MIN}
            max={ZOOM_MAX}
            step={ZOOM_STEP}
            onValueChange={(v) => void setZoomLevel(v[0] ?? 1)}
          />
        </div>
      </div>

      <div className="flex flex-col gap-2">
        <Label>编码 agent</Label>
        <SettingRow
          title="快捷键交给运行中的 agent"
          description="Claude Code、opencode 这类程序自己绑定了 Ctrl+P / Ctrl+T。开启后，当焦点在正在运行 agent 的命令行里时，这四个键（Ctrl+P、Ctrl+Shift+P、Ctrl+T、Ctrl+Shift+T）交给 agent，不再触发 Terax 的命令面板和新建标签页。关闭则始终由 Terax 处理。"
        >
          <Switch
            checked={agentKeyPassthrough}
            onCheckedChange={(v) => void setAgentKeyPassthrough(v)}
          />
        </SettingRow>
      </div>

      <div className="flex flex-col gap-2">
        <Label>文件浏览器</Label>
        <SettingRow
          title="Git 状态标记"
          description="在文件浏览器中为已改动的文件着色，并淡化被 gitignore 忽略的条目。"
        >
          <Switch
            checked={explorerGitDecorations}
            onCheckedChange={(v) => void setExplorerGitDecorations(v)}
          />
        </SettingRow>
      </div>

      <WebPassword />

      <div className="flex flex-col gap-2">
        <Label>终端</Label>
        <SettingRow
          title={
            <span className="inline-flex items-center gap-1.5">
              使用 WebGL 渲染器
              <TooltipProvider delayDuration={200}>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <span
                      className="cursor-help text-[11px] text-muted-foreground/70 leading-none"
                      aria-label="关于 WebGL 渲染器的更多说明"
                    >
                      ⓘ
                    </span>
                  </TooltipTrigger>
                  <TooltipContent side="top" className="max-w-65 text-[11px]">
                    xterm 的 WebGL 渲染器会把字形缓存在 GPU 纹理图集中。在部分
                    macOS 环境下 (尤其是配合 Nerd Font 时)，图集会损坏，导致终端
                    文字无法辨认。此时可关闭此项作为兜底方案: 性能会略有下降，但
                    DOM 渲染器能正确显示文字。
                  </TooltipContent>
                </Tooltip>
              </TooltipProvider>
            </span>
          }
          description="硬件加速渲染。若出现文字错乱或空白色块，请关闭此项。"
        >
          <Switch
            checked={terminalWebglEnabled}
            onCheckedChange={(v) => void setTerminalWebglEnabled(v)}
          />
        </SettingRow>
        <SettingRow
          title="光标闪烁"
          description="让终端光标闪烁。默认关闭以降低空闲时的 CPU 占用，与 VS Code 和 macOS 终端保持一致。"
        >
          <Switch
            checked={terminalCursorBlink}
            onCheckedChange={(v) => void setTerminalCursorBlink(v)}
          />
        </SettingRow>
        <SettingRow
          title="光标样式"
          description="终端光标的形状。"
        >
          <Select
            value={terminalCursorStyle}
            onValueChange={(v) => void setTerminalCursorStyle(v)}
          >
            <SelectTrigger
              value={terminalCursorStyle}
              className="h-8 w-28 text-[12px]"
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {TERMINAL_CURSOR_STYLES.map((style) => (
                <SelectItem
                  key={style.value}
                  value={style.value}
                  className="text-[12px]"
                >
                  {style.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </SettingRow>
        <FontFamilyInput
          value={terminalFontFamily}
          onCommit={(v) => void setTerminalFontFamily(v)}
        />
        <SettingRow
          title="字重"
          description="终端字符的粗细"
        >
          <Select
            value={terminalFontWeight}
            onValueChange={(v) => void setTerminalFontWeight(v)}
          >
            <SelectTrigger
              value={terminalFontWeight}
              className="h-8 w-28 text-[12px]"
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {TERMINAL_FONT_WEIGHTS.map((w) => (
                <SelectItem
                  key={w.value}
                  value={w.value}
                  className="text-[12px]"
                >
                  {w.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </SettingRow>
        <SettingRow
          title="集成终端 Shell"
          description={
            shells.find((s) => s.path === terminalShell)?.integrated === false
              ? "该 Shell 不支持命令块和目录跟踪。"
              : wslDistros.length > 0
                ? "集成终端使用的 Shell。WSL 工作区使用该发行版的登录 Shell。已打开的标签页保持原有 Shell。"
                : "新建终端标签页使用的 Shell。已打开的标签页保持原有 Shell。"
          }
        >
          <Select
            value={terminalShell || SHELL_AUTO}
            onValueChange={(v) =>
              void setTerminalShell(v === SHELL_AUTO ? "" : v)
            }
          >
            <SelectTrigger
              value={terminalShell || SHELL_AUTO}
              className="h-8 w-40 text-[12px]"
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={SHELL_AUTO} className="text-[12px]">
                自动
              </SelectItem>
              {shells.map((s) => (
                <SelectItem key={s.path} value={s.path} className="text-[12px]">
                  {s.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </SettingRow>
        {(wslDistros.length > 0 || defaultWorkspaceEnv !== "local") && (
          <SettingRow
            title="工作区环境"
            description="新建工作区的运行环境，终端和 AI 智能体都适用: Windows 或某个 WSL 发行版。已有工作区保持原设置，可在状态栏随时切换。"
          >
            <Select
              value={defaultWorkspaceEnv}
              onValueChange={(v) => void setDefaultWorkspaceEnv(v)}
            >
              <SelectTrigger
                value={defaultWorkspaceEnv}
                className="h-8 w-40 text-[12px]"
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="local" className="text-[12px]">
                  Windows
                </SelectItem>
                {wslDistros.map((d) => (
                  <SelectItem
                    key={d.name}
                    value={`wsl:${d.name}`}
                    className="text-[12px]"
                  >
                    WSL: {d.name}
                  </SelectItem>
                ))}
                {defaultWorkspaceEnv.startsWith("wsl:") &&
                  !wslDistros.some(
                    (d) => `wsl:${d.name}` === defaultWorkspaceEnv,
                  ) && (
                    <SelectItem
                      value={defaultWorkspaceEnv}
                      className="text-[12px]"
                    >
                      {defaultWorkspaceEnv.slice("wsl:".length)} (不可用)
                    </SelectItem>
                  )}
              </SelectContent>
            </Select>
          </SettingRow>
        )}
        <SettingRow
          title="字符间距"
          description="字符之间额外的水平间距 (px)。使用负值可收紧 Nerd Font。"
        >
          <Select
            value={String(terminalLetterSpacing)}
            onValueChange={(v) => void setTerminalLetterSpacing(Number(v))}
          >
            <SelectTrigger size="sm" className="h-8 w-28 text-[12px]">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {LETTER_SPACINGS.map((v) => (
                <SelectItem key={v} value={String(v)} className="text-[12px]">
                  {v > 0 ? `+${v}` : v} px
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </SettingRow>
        <SettingRow title="字号" description="终端文字大小。">
          <Select
            value={String(terminalFontSize)}
            onValueChange={(v) => void setTerminalFontSize(Number(v))}
          >
            <SelectTrigger size="sm" className="h-8 w-28 text-[12px]">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {TERMINAL_FONT_SIZES.map((size) => (
                <SelectItem
                  key={size}
                  value={String(size)}
                  className="text-[12px]"
                >
                  {size} px
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </SettingRow>
        <SettingRow
          title="回滚缓冲"
          description="每个终端保留的历史行数。数值越大占用内存越多 (约 3 KB / 行)。"
        >
          <Select
            value={String(terminalScrollback)}
            onValueChange={(v) => void setTerminalScrollback(Number(v))}
          >
            <SelectTrigger size="sm" className="h-8 w-36 text-[12px]">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {TERMINAL_SCROLLBACK_PRESETS.map((lines) => (
                <SelectItem
                  key={lines}
                  value={String(lines)}
                  className="text-[12px]"
                >
                  {lines.toLocaleString()} 行
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </SettingRow>
      </div>

      <div className="flex flex-col gap-2">
        <Label>启动</Label>
        <div className="flex flex-col gap-2">
          <SettingRow
            title="开机自启"
            description="登录系统时自动打开 Terax。"
          >
            <Switch
              checked={autostart}
              onCheckedChange={(v) => void onToggleAutostart(v)}
            />
          </SettingRow>
          <SettingRow
            title="恢复窗口位置与大小"
            description="下次启动时，主窗口在你上次关闭的位置和大小重新打开。"
          >
            <Switch
              checked={restoreWindowState}
              onCheckedChange={(v) => void setRestoreWindowState(v)}
            />
          </SettingRow>
        </div>
      </div>
    </div>
  );
}

function Label({ children }: { children: React.ReactNode }) {
  return (
    <span className="text-[11px] font-medium tracking-tight text-muted-foreground">
      {children}
    </span>
  );
}

/** Set the password the phone bridge asks for.
 *
 *  The old password is not required to change it: whoever is at this machine
 *  already has the terminals themselves, so asking would protect nothing. What
 *  it does do is sign every phone out, because the session token is regenerated
 *  with the password. */
function WebPassword() {
  const [value, setValue] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [custom, setCustom] = useState<boolean | null>(null);

  useEffect(() => {
    void invoke<boolean>("web_has_custom_password")
      .then(setCustom)
      .catch(() => setCustom(null));
  }, []);

  const mismatch = confirm !== "" && confirm !== value;
  const canSave = value.length >= 6 && confirm === value && !busy;

  const save = () => {
    setBusy(true);
    invoke("web_set_password", { password: value })
      .then(() => {
        setValue("");
        setConfirm("");
        setCustom(true);
        toast.success("密码已更新，已登录的手机需要重新输入");
      })
      .catch((e) => toast.error(typeof e === "string" ? e : String(e)))
      .finally(() => setBusy(false));
  };

  return (
    <div className="flex flex-col gap-2">
      <Label>手机访问</Label>
      <SettingRow
        title="访问密码"
        description={
          custom === false
            ? "当前使用内置的默认密码。设置一个自己的密码，并让已登录的手机重新登录。"
            : "修改后，所有已登录的手机都需要重新输入密码。"
        }
      >
        <div className="flex flex-col items-end gap-1.5">
          <Input
            type="password"
            value={value}
            onChange={(e) => setValue(e.target.value)}
            placeholder="新密码（至少 6 位）"
            className="h-8 w-56"
            autoComplete="new-password"
          />
          <Input
            type="password"
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
            placeholder="再输入一次"
            className={cn("h-8 w-56", mismatch && "border-destructive")}
            autoComplete="new-password"
          />
          <Button size="sm" disabled={!canSave} onClick={save}>
            {busy ? "保存中…" : "保存密码"}
          </Button>
        </div>
      </SettingRow>
    </div>
  );
}

function FontFamilyInput({
  value,
  onCommit,
}: {
  value: string;
  onCommit: (v: string) => void;
}) {
  const [draft, setDraft] = useState(value);

  useEffect(() => {
    setDraft(value);
  }, [value]);

  // Commit (and trim) only on blur/Enter so a trailing space can be typed
  // mid-edit, e.g. "JetBrains Mono ".
  const commit = () => {
    const next = draft.trim();
    if (next !== draft) setDraft(next);
    if (next !== value) onCommit(next);
  };

  return (
    <SettingRow
      title="字体"
      description='用于显示图标的 Nerd Font 名称 (例如 "CaskaydiaCove Nerd Font Mono")。留空则自动检测。'
    >
      <input
        type="text"
        value={draft}
        placeholder="自动检测"
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Enter") e.currentTarget.blur();
        }}
        className="h-8 w-48 rounded-md border border-border bg-background px-2.5 text-[12px] outline-none focus:border-foreground/40"
      />
    </SettingRow>
  );
}
