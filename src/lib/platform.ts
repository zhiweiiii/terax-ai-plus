import { platform } from "@tauri-apps/plugin-os";

const PLATFORM = (() => {
  try {
    return platform();
  } catch {
    return "";
  }
})();

export const IS_WINDOWS = PLATFORM === "windows";

/** Custom window controls (min/max/close) are rendered by us. */
export const USE_CUSTOM_WINDOW_CONTROLS = true;

export const MOD_KEY = "Ctrl";
/** KeyBinding property name for the platform's primary modifier. */
export const MOD_PROP: "meta" | "ctrl" = "ctrl";
export const CTRL_KEY = "Ctrl";
export const ALT_KEY = "Alt";
export const SHIFT_KEY = "Shift";
export const TAB_KEY = "Tab";
export const ENTER_KEY = "Enter";

export const KEY_SEP = "+";

export function fmtShortcut(...parts: string[]): string {
  return parts.join(KEY_SEP);
}
