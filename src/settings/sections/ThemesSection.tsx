import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectSeparator,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { SettingSlider } from "@/settings/components/SettingSlider";
import { cn } from "@/lib/utils";
import { errorToast } from "@/lib/errorToast";
import { usePreferencesStore } from "@/modules/settings/preferences";
import {
  EDITOR_THEME_AUTO,
  EDITOR_THEME_LABELS,
  EDITOR_THEME_MODE,
  EDITOR_THEMES,
  type EditorThemePref,
  setBackgroundBlur,
  setBackgroundImageId,
  setBackgroundKind,
  setBackgroundOpacity,
  setEditorTheme,
} from "@/modules/settings/store";
import { useTheme } from "@/modules/theme/ThemeProvider";
import {
  deleteBgImage,
  importBgImageFromFile,
} from "@/modules/theme/bgImageStore";
import {
  deleteCustomTheme,
  saveCustomTheme,
} from "@/modules/theme/customThemes";
import { deleteThemeFile, emitThemeEdit } from "@/modules/theme/themeFiles";
import { listBuiltinThemes } from "@/modules/theme/themes";
import { DEFAULT_THEME_ID } from "@/modules/theme/types";
import { validateTheme } from "@/modules/theme/validateTheme";
import { Edit02Icon, PlusSignIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { useEffect, useMemo, useRef, useState } from "react";
import { SectionHeader } from "../components/SectionHeader";

export function ThemesSection() {
  const { themeId, setThemeId, resolvedMode, customThemes } = useTheme();
  const builtinThemes = listBuiltinThemes();
  const themes = useMemo(
    () =>
      Array.from(
        new Map(
          [...builtinThemes, ...customThemes].map((theme) => [theme.id, theme]),
        ).values(),
      ),
    [builtinThemes, customThemes],
  );
  const customIds = useMemo(
    () => new Set(customThemes.map((t) => t.id)),
    [customThemes],
  );

  const [importError, setImportError] = useState<string | null>(null);
  const [bgError, setBgError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const bgInputRef = useRef<HTMLInputElement | null>(null);
  const themeBusy = useRef(false);
  const backgroundBusy = useRef(false);
  const mounted = useRef(false);
  const selectedTheme = useRef(themeId);
  selectedTheme.current = themeId;
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const onCreateTheme = () => {
    void emitThemeEdit({ action: "create" })
      .then(() => getCurrentWindow().hide())
      .catch((error) => errorToast("创建主题失败", error));
  };

  const onEditTheme = (id: string) => {
    void emitThemeEdit({ action: "edit", id })
      .then(() => getCurrentWindow().hide())
      .catch((error) => errorToast("编辑主题失败", error));
  };

  const editorThemePref = usePreferencesStore((s) => s.editorTheme);
  const backgroundKind = usePreferencesStore((s) => s.backgroundKind);
  const backgroundImageId = usePreferencesStore((s) => s.backgroundImageId);
  const backgroundOpacity = usePreferencesStore((s) => s.backgroundOpacity);
  const backgroundBlur = usePreferencesStore((s) => s.backgroundBlur);

  const handleThemeFiles = async (files: FileList | null) => {
    if (themeBusy.current) return;
    setImportError(null);
    if (!files || files.length === 0) return;
    themeBusy.current = true;
    try {
      for (const file of Array.from(files)) {
        try {
          if (file.size > 1024 * 1024)
            throw new Error("Theme files are limited to 1 MiB");
          const text = await file.text();
          if (!mounted.current) return;
          const parsed = JSON.parse(text);
          const result = validateTheme(parsed);
          if (!result.ok) {
            setImportError(`${file.name}: ${result.error}`);
            return;
          }
          await saveCustomTheme(result.theme);
          if (!mounted.current) return;
          setThemeId(result.theme.id);
        } catch (e) {
          if (!mounted.current) return;
          setImportError(
            `${file.name}: ${e instanceof Error ? e.message : "读取失败"}`,
          );
          return;
        }
      }
    } finally {
      themeBusy.current = false;
    }
  };

  const onPickThemeFile = () => fileInputRef.current?.click();

  const onRemoveCustomTheme = async (id: string) => {
    if (themeBusy.current) return;
    themeBusy.current = true;
    try {
      await deleteCustomTheme(id);
      if (mounted.current && selectedTheme.current === id)
        setThemeId(DEFAULT_THEME_ID);
      await deleteThemeFile(id);
    } catch (error) {
      if (mounted.current) errorToast("删除主题失败", error);
    } finally {
      themeBusy.current = false;
    }
  };

  const onPickBgFile = () => bgInputRef.current?.click();

  const handleBgFiles = async (files: FileList | null) => {
    if (backgroundBusy.current) return;
    setBgError(null);
    if (!files || files.length === 0) return;
    const file = files[0];
    if (!file.type.startsWith("image/")) {
      setBgError(`${file.name}: not an image`);
      return;
    }
    backgroundBusy.current = true;
    try {
      const prev = backgroundImageId;
      const { id } = await importBgImageFromFile(file);
      if (!mounted.current) {
        await deleteBgImage(id);
        return;
      }
      await setBackgroundImageId(id);
      await setBackgroundKind("image");
      if (prev && prev !== id) await deleteBgImage(prev).catch(() => undefined);
    } catch (e) {
      if (mounted.current)
        setBgError(e instanceof Error ? e.message : "图片导入失败");
    } finally {
      backgroundBusy.current = false;
    }
  };

  const onRemoveBackground = async () => {
    if (backgroundBusy.current) return;
    backgroundBusy.current = true;
    try {
      setBgError(null);
      const prev = backgroundImageId;
      await setBackgroundKind("none");
      await setBackgroundImageId(null);
      if (prev) await deleteBgImage(prev).catch(() => undefined);
    } catch (error) {
      if (mounted.current) setBgError(String(error));
    } finally {
      backgroundBusy.current = false;
    }
  };

  return (
    <div className="flex flex-col gap-6">
      <SectionHeader
        title="主题"
        description="配色主题、背景图与个性化设置。"
      />

      <section
        aria-label="主题文件导入"
        className="flex flex-col gap-2"
        onDragOver={(e) => {
          e.preventDefault();
          e.dataTransfer.dropEffect = "copy";
        }}
        onDrop={(e) => {
          e.preventDefault();
          void handleThemeFiles(e.dataTransfer.files);
        }}
      >
        <div className="flex items-center justify-between">
          <Label>主题</Label>
          <div className="flex items-center gap-1.5">
            <Button
              variant="outline"
              size="sm"
              className="h-7 gap-1.5 px-2 text-[11px]"
              onClick={onCreateTheme}
            >
              <HugeiconsIcon icon={PlusSignIcon} size={11} strokeWidth={2} />
              新建
            </Button>
            <Button
              variant="outline"
              size="sm"
              className="h-7 px-2 text-[11px]"
              onClick={onPickThemeFile}
            >
              导入 .awei-work-theme
            </Button>
          </div>
          <input
            ref={fileInputRef}
            type="file"
            accept=".awei-work-theme,.terax-theme,.json,application/json"
            className="hidden"
            onChange={(e) => {
              void handleThemeFiles(e.target.files);
              e.target.value = "";
            }}
          />
        </div>
        {importError ? (
          <div className="rounded-md border border-destructive/40 bg-destructive/10 px-2.5 py-1.5 text-[11.5px] text-destructive">
            {importError}
          </div>
        ) : null}
        <div className="grid grid-cols-2 gap-2">
          {themes.map((t) => {
            const v =
              t.variants[resolvedMode] ?? t.variants.dark ?? t.variants.light;
            const c = v?.colors;
            const swatchBg = c?.background ?? "var(--background)";
            const swatchFg = c?.foreground ?? "var(--foreground)";
            const swatchAccent = c?.primary ?? c?.accent ?? "var(--accent)";
            const swatchMuted = c?.muted ?? "var(--muted)";
            const selected = themeId === t.id;
            const isCustom = customIds.has(t.id);
            return (
              <div
                key={t.id}
                className={cn(
                  "group flex items-center gap-3 rounded-lg border p-2.5 text-left transition-all",
                  selected
                    ? "border-foreground/60 ring-1 ring-foreground/20"
                    : "border-border/60 hover:border-border",
                )}
              >
                <button
                  type="button"
                  aria-pressed={selected}
                  onClick={() => setThemeId(t.id)}
                  className="flex min-w-0 flex-1 items-center gap-3 rounded-md text-left outline-none focus-visible:ring-2 focus-visible:ring-ring"
                >
                  <div
                    className="flex h-10 w-14 shrink-0 items-center justify-center gap-1 rounded-md border border-border/40"
                    style={{ background: swatchBg }}
                  >
                    <span
                      className="h-5 w-2 rounded-sm"
                      style={{ background: swatchAccent }}
                    />
                    <span
                      className="h-5 w-2 rounded-sm"
                      style={{ background: swatchFg, opacity: 0.7 }}
                    />
                    <span
                      className="h-5 w-2 rounded-sm"
                      style={{ background: swatchMuted }}
                    />
                  </div>
                  <div className="flex min-w-0 flex-1 flex-col">
                    <span className="truncate text-[12.5px] font-medium">
                      {t.name}
                    </span>
                    {t.description ? (
                      <span className="truncate text-[11px] text-muted-foreground">
                        {t.description}
                      </span>
                    ) : null}
                  </div>
                </button>
                {isCustom ? (
                  <span className="ml-1 flex shrink-0 items-center gap-0.5 opacity-0 transition group-hover:opacity-100 group-focus-within:opacity-100">
                    <button
                      type="button"
                      aria-label={`编辑 ${t.name}`}
                      className="inline-flex h-6 w-6 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground"
                      onClick={(e) => {
                        e.stopPropagation();
                        onEditTheme(t.id);
                      }}
                    >
                      <HugeiconsIcon
                        icon={Edit02Icon}
                        size={12}
                        strokeWidth={1.75}
                      />
                    </button>
                    <button
                      type="button"
                      aria-label={`移除 ${t.name}`}
                      className="inline-flex h-6 w-6 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-destructive"
                      onClick={(e) => {
                        e.stopPropagation();
                        void onRemoveCustomTheme(t.id);
                      }}
                    >
                      ×
                    </button>
                  </span>
                ) : null}
              </div>
            );
          })}
        </div>
      </section>

      <div className="flex flex-col gap-2">
        <div className="flex items-center justify-between gap-3">
          <div className="flex min-w-0 flex-col">
            <Label>编辑器主题</Label>
            <span className="text-[11px] text-muted-foreground">
              代码编辑器的语法配色。选择自动则跟随应用主题。
            </span>
          </div>
          <Select
            value={editorThemePref}
            onValueChange={(v) =>
              void setEditorTheme(v as EditorThemePref).catch((error) =>
                errorToast("保存编辑器主题失败", error),
              )
            }
          >
            <SelectTrigger
              aria-label="编辑器主题"
              size="sm"
              className="h-8 w-44 text-[12px]"
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={EDITOR_THEME_AUTO} className="text-[12px]">
                自动 (跟随应用主题)
              </SelectItem>
              <SelectSeparator />
              {[...EDITOR_THEMES]
                .sort(
                  (a, b) =>
                    (EDITOR_THEME_MODE[a] === resolvedMode ? 0 : 1) -
                    (EDITOR_THEME_MODE[b] === resolvedMode ? 0 : 1),
                )
                .map((id) => (
                  <SelectItem
                    key={id}
                    value={id}
                    disabled={EDITOR_THEME_MODE[id] !== resolvedMode}
                    className="text-[12px]"
                  >
                    {EDITOR_THEME_LABELS[id]}
                  </SelectItem>
                ))}
            </SelectContent>
          </Select>
        </div>
      </div>

      <section
        aria-label="背景图片导入"
        className="flex flex-col gap-2"
        onDragOver={(e) => {
          e.preventDefault();
          e.dataTransfer.dropEffect = "copy";
        }}
        onDrop={(e) => {
          e.preventDefault();
          void handleBgFiles(e.dataTransfer.files);
        }}
      >
        <div className="flex items-center justify-between">
          <Label>背景</Label>
          <div className="flex items-center gap-2">
            {backgroundKind === "image" && backgroundImageId ? (
              <Button
                variant="ghost"
                size="sm"
                className="h-7 px-2 text-[11px] text-muted-foreground hover:text-destructive"
                onClick={() => void onRemoveBackground()}
              >
                移除
              </Button>
            ) : null}
            <Button
              variant="outline"
              size="sm"
              className="h-7 px-2 text-[11px]"
              onClick={onPickBgFile}
            >
              {backgroundKind === "image" ? "更换图片" : "选择图片"}
            </Button>
            <input
              ref={bgInputRef}
              type="file"
              accept="image/*"
              className="hidden"
              onChange={(e) => {
                void handleBgFiles(e.target.files);
                e.target.value = "";
              }}
            />
          </div>
        </div>
        {bgError ? (
          <div className="rounded-md border border-destructive/40 bg-destructive/10 px-2.5 py-1.5 text-[11.5px] text-destructive">
            {bgError}
          </div>
        ) : null}
        {backgroundKind === "image" && backgroundImageId ? (
          <div className="flex flex-col gap-3 rounded-lg border border-border/60 p-3">
            <div className="flex items-center justify-between gap-3">
              <span className="text-[11.5px] text-muted-foreground">
                不透明度
              </span>
              <span className="tabular-nums text-[11px] text-muted-foreground">
                {Math.round(backgroundOpacity * 100)}%
              </span>
            </div>
            <SettingSlider
              value={[backgroundOpacity]}
              label="背景不透明度"
              min={0}
              max={1}
              step={0.01}
              onValueChange={(v) =>
                void setBackgroundOpacity(v[0] ?? 0).catch((error) =>
                  errorToast("保存背景不透明度失败", error),
                )
              }
            />
            <div className="flex items-center justify-between gap-3 pt-1">
              <span className="text-[11.5px] text-muted-foreground">模糊</span>
              <span className="tabular-nums text-[11px] text-muted-foreground">
                {backgroundBlur}px
              </span>
            </div>
            <SettingSlider
              value={[backgroundBlur]}
              label="背景模糊（像素）"
              min={0}
              max={64}
              step={1}
              onValueChange={(v) =>
                void setBackgroundBlur(v[0] ?? 0).catch((error) =>
                  errorToast("保存背景模糊设置失败", error),
                )
              }
            />
          </div>
        ) : (
          <p className="text-[11px] text-muted-foreground">
            把图片拖到这里，或点击选择。图片仅存储在本地，未设置前不影响默认外观。
          </p>
        )}
      </section>
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
