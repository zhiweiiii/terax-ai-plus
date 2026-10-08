import { resolveFontFamily } from "@/lib/fonts";
import { fmtShortcut, MOD_KEY } from "@/lib/platform";
import { cn } from "@/lib/utils";
import { useTheme } from "@/modules/theme";
import { useCallback, useEffect, useRef } from "react";
import {
  clearLeafBlockSelection,
  getLeafDraft,
  leafGridSelection,
  setLeafDraft,
  setLeafInputActivity,
  setLeafInputFocus,
  setLeafInputPaste,
} from "../lib/useTerminalSession";
import { useTerminalFont } from "../lib/useTerminalFont";
import {
  historyCommands,
  historyList,
  historyRecord,
  historySuggest,
} from "./lib/history";
import type { BlockMode } from "./lib/modeMachine";
import { createShellEditor, type ShellEditorHandle } from "./lib/shellEditor";

type Props = {
  /** Active leaf the bar is driving; the editor retargets to it. */
  leafId: number;
  mode: BlockMode;
  focused: boolean;
  onSubmit: (text: string) => boolean;
  onInterrupt: () => void;
  getCwd: () => string | null;
};

export default function ShellInput({
  leafId,
  mode,
  focused,
  onSubmit,
  onInterrupt,
  getCwd,
}: Props) {
  const hostRef = useRef<HTMLDivElement>(null);
  const handleRef = useRef<ShellEditorHandle | null>(null);
  const commandsRef = useRef<string[]>([]);
  const cbRef = useRef({ onSubmit, onInterrupt, getCwd });
  cbRef.current = { onSubmit, onInterrupt, getCwd };
  const leafIdRef = useRef(leafId);
  leafIdRef.current = leafId;
  const atPrompt = mode === "prompt";
  const focusableRef = useRef(false);
  focusableRef.current = focused && atPrompt;
  const focusInput = useCallback(() => {
    if (focusableRef.current) handleRef.current?.focus();
  }, []);

  useEffect(() => {
    let alive = true;
    historyCommands("", 2000).then((cmds) => {
      if (alive) commandsRef.current = cmds;
    });
    return () => {
      alive = false;
    };
  }, []);

  const {
    fontFamily: fontFamilyPref,
    fontSize,
    fontWeight,
  } = useTerminalFont();
  const { activeTheme, resolvedMode } = useTheme();
  const fontFamily = resolveFontFamily(fontFamilyPref);
  const fontRef = useRef({ fontFamily, fontSize, fontWeight });
  fontRef.current = { fontFamily, fontSize, fontWeight };

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const handle = createShellEditor({
      parent: host,
      fontFamily: fontRef.current.fontFamily,
      fontSize: fontRef.current.fontSize,
      fontWeight: fontRef.current.fontWeight,
      placeholderText: `Run a command  -  ↑ history  ${fmtShortcut(MOD_KEY, "U")} switch to AI`,
      commandNames: () => commandsRef.current,
      getCwd: () => cbRef.current.getCwd(),
      onChange: (text) => {
        setLeafDraft(leafIdRef.current, text);
        setLeafInputActivity(leafIdRef.current, text.length > 0);
      },
      suggest: historySuggest,
      historyList,
      onSubmit: (text) => {
        if (cbRef.current.onSubmit(text) === false) return false;
        historyRecord(text);
        const first = text.trim().split(/\s+/)[0];
        if (first && !commandsRef.current.includes(first)) {
          commandsRef.current = [first, ...commandsRef.current];
        }
        return true;
      },
      onInterrupt: () => cbRef.current.onInterrupt(),
      onEscape: () => clearLeafBlockSelection(leafIdRef.current),
    });
    handleRef.current = handle;
    return () => {
      handle.destroy();
      handleRef.current = null;
    };
  }, []);

  // Retarget the single editor to the active leaf: register its focus callback
  // and swap drafts so each leaf keeps its own unsent command. New or switched
  // tabs land with the cursor already in the input.
  useEffect(() => {
    setLeafInputFocus(leafId, focusInput);
    setLeafInputPaste(leafId, (text) => {
      const handle = handleRef.current;
      if (!handle || leafIdRef.current !== leafId) return false;
      const view = handle.view;
      view.dispatch(view.state.replaceSelection(text));
      focusInput();
      return true;
    });
    handleRef.current?.setValue(getLeafDraft(leafId));
    requestAnimationFrame(() => {
      if (focusableRef.current && leafIdRef.current === leafId) {
        focusInput();
      }
    });
    return () => {
      const value = handleRef.current?.getValue() ?? getLeafDraft(leafId);
      setLeafDraft(leafId, value);
      setLeafInputActivity(leafId, value.length > 0);
      setLeafInputFocus(leafId, null);
      setLeafInputPaste(leafId, null);
    };
  }, [leafId, focusInput]);

  useEffect(() => {
    void activeTheme;
    void resolvedMode;
    handleRef.current?.retheme(fontFamily, fontSize, fontWeight);
  }, [fontFamily, fontSize, fontWeight, activeTheme, resolvedMode]);

  useEffect(() => {
    const handle = handleRef.current;
    if (!handle) return;
    handle.setEditable(atPrompt);
    if (atPrompt) focusInput();
    else handle.blur();
  }, [atPrompt, focusInput]);

  useEffect(() => {
    if (focused && atPrompt) focusInput();
  }, [focused, atPrompt, focusInput]);

  // The editor holds focus at the prompt, so a Cmd+C over a grid selection lands
  // here, not on the xterm. Copy the grid selection unless the editor has its own.
  const onCopyCapture = (e: React.ClipboardEvent) => {
    const view = handleRef.current?.view;
    if (view && !view.state.selection.main.empty) return;
    const sel = leafGridSelection(leafId);
    if (!sel) return;
    e.preventDefault();
    e.clipboardData.setData("text/plain", sel);
  };

  return (
    <div
      className={cn("flex items-start gap-2", !atPrompt && "opacity-45")}
      onCopyCapture={onCopyCapture}
    >
      <span
        className="select-none pt-px text-primary/80"
        style={{
          fontFamily,
          fontSize: `${fontSize}px`,
          fontWeight,
          lineHeight: 1.5,
        }}
      >
        ❯
      </span>
      <div ref={hostRef} className="min-w-0 flex-1" />
    </div>
  );
}
