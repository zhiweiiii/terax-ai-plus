import type { Terminal } from "@xterm/xterm";

type TerminalCore = {
  coreService: { isCursorHidden: boolean };
  _renderService: {
    dimensions: { css: { cell: { width: number; height: number } } };
  };
  _syncTextArea: () => void;
  _compositionHelper: {
    updateCompositionElements: (dontRecurse?: boolean) => void;
  };
};

// Isolate the xterm v6 internals used for IME placement and cursor visibility.
export function stabilizeTerminalInput(
  term: Terminal,
  enabled: () => boolean,
  visible: () => boolean = () => true,
): { reset: () => void; dispose: () => void } {
  const noop = { reset: () => {}, dispose: () => {} };
  const core = (term as unknown as { _core: TerminalCore })._core;
  const textarea = term.textarea;
  const screen = term.element?.querySelector<HTMLElement>(".xterm-screen");
  const composition =
    term.element?.querySelector<HTMLElement>(".composition-view");
  const descriptor =
    core?.coreService &&
    Object.getOwnPropertyDescriptor(core.coreService, "isCursorHidden");
  if (
    !textarea ||
    !screen ||
    !composition ||
    !descriptor?.configurable ||
    !("value" in descriptor) ||
    !core._renderService?.dimensions?.css?.cell ||
    typeof core._syncTextArea !== "function" ||
    typeof core._compositionHelper?.updateCompositionElements !== "function"
  ) {
    console.warn("[terax] xterm input anchor compatibility check failed");
    return noop;
  }
  const service = core.coreService;
  const sync = core._syncTextArea;
  const helper = core._compositionHelper;
  const update = helper.updateCompositionElements;
  const caret = document.createElement("div");
  caret.style.cssText =
    "position:absolute;pointer-events:none;z-index:8;display:none;";
  caret.setAttribute("aria-hidden", "true");
  screen.appendChild(caret);
  let requestedHidden = service.isCursorHidden;
  let composing = false;
  let disposed = false;
  let paintedState = "";
  const setStyle = (element: HTMLElement, property: string, value: string) => {
    if (element.style.getPropertyValue(property) !== value) {
      element.style.setProperty(property, value);
    }
  };
  let position: {
    x: number;
    line: number;
    buffer: "normal" | "alternate";
  } | null = null;
  let compositionPosition: { left: string; top: string } | null = null;
  const capture = () => {
    const buffer = term.buffer.active;
    position = {
      x: Math.min(buffer.cursorX, term.cols - 1),
      line: buffer.baseY + buffer.cursorY,
      buffer: buffer.type,
    };
  };
  const paint = () => {
    if (disposed) return;
    const buffer = term.buffer.active;
    const row = position ? position.line - buffer.viewportY : -1;
    const valid =
      enabled() &&
      visible() &&
      !document.hidden &&
      document.activeElement === textarea &&
      position?.buffer === buffer.type &&
      row >= 0 &&
      row < term.rows &&
      !term.options.disableStdin;
    if (!valid || !position) {
      setStyle(caret, "display", "none");
      paintedState = "";
      return;
    }
    // Use xterm's measured cell cache, never force layout in its output callbacks.
    const { width, height } = core._renderService.dimensions.css.cell;
    if (width <= 0 || height <= 0) return;
    const color = term.options.theme?.cursor ?? "var(--foreground)";
    const state = [
      position.x,
      row,
      width,
      height,
      term.options.cursorStyle,
      color,
      requestedHidden,
      composing,
    ].join("|");
    if (state === paintedState) return;
    paintedState = state;
    setStyle(
      caret,
      "display",
      !requestedHidden && !composing ? "block" : "none",
    );
    const left = `${position.x * width}px`;
    const top = `${row * height}px`;
    const underline = term.options.cursorStyle === "underline";
    setStyle(caret, "left", left);
    setStyle(
      caret,
      "top",
      `${(row + (underline ? 1 : 0)) * height - (underline ? 2 : 0)}px`,
    );
    setStyle(caret, "width", `${underline ? width : 2}px`);
    setStyle(caret, "height", `${underline ? 2 : height}px`);
    setStyle(caret, "background-color", color);
    if (!composing) {
      setStyle(textarea, "left", left);
      setStyle(textarea, "top", top);
      setStyle(textarea, "width", `${Math.max(width, 1)}px`);
      setStyle(textarea, "height", `${Math.max(height, 1)}px`);
      setStyle(textarea, "line-height", `${height}px`);
    }
  };
  Object.defineProperty(service, "isCursorHidden", {
    configurable: true,
    enumerable: descriptor.enumerable,
    get: () => requestedHidden || term.options.disableStdin || enabled(),
    set: (value: boolean) => {
      requestedHidden = value;
    },
  });
  core._syncTextArea = () => {
    if (!enabled()) sync.call(core);
  };
  // A synchronized-output boundary can finish an animation-only update.
  // Only an explicit cursor-show request identifies an input cursor anchor.
  const show = term.parser.registerCsiHandler(
    { prefix: "?", final: "h" },
    (params) => {
      if (enabled() && params.includes(25)) capture();
      return false;
    },
  );
  const start = () => {
    if (!enabled()) return;
    paint();
    composing = true;
    compositionPosition = {
      left: textarea.style.left,
      top: textarea.style.top,
    };
    paint();
  };
  const end = () => {
    composing = false;
    compositionPosition = null;
    paint();
  };
  helper.updateCompositionElements = (dontRecurse) => {
    if (disposed) return;
    if (!composing || !compositionPosition) {
      update.call(helper, dontRecurse);
      return;
    }
    for (const element of [textarea, composition]) {
      setStyle(element, "left", compositionPosition.left);
      setStyle(element, "top", compositionPosition.top);
    }
    setStyle(
      composition,
      "font-family",
      term.options.fontFamily ?? "monospace",
    );
    setStyle(composition, "font-size", `${term.options.fontSize}px`);
    setStyle(composition, "height", textarea.style.height);
    setStyle(composition, "line-height", textarea.style.lineHeight);
  };
  const compositionObserver = new ResizeObserver((entries) => {
    if (!composing || disposed || !enabled()) return;
    const entry = entries[0];
    if (entry)
      setStyle(textarea, "width", `${Math.max(entry.contentRect.width, 1)}px`);
  });
  compositionObserver.observe(composition);
  document.addEventListener("visibilitychange", paint);
  textarea.addEventListener("compositionstart", start, true);
  textarea.addEventListener("compositionend", end, true);
  textarea.addEventListener("blur", end);
  textarea.addEventListener("focus", paint);
  const listeners = [
    term.onWriteParsed(paint),
    term.onRender(paint),
    term.onScroll(paint),
    term.onResize(paint),
  ];
  const reset = () => {
    composing = false;
    compositionPosition = null;
    position = null;
    paintedState = "";
    caret.style.display = "none";
  };
  return {
    reset,
    dispose: () => {
      disposed = true;
      reset();
      for (const listener of listeners) listener.dispose();
      show.dispose();
      compositionObserver.disconnect();
      document.removeEventListener("visibilitychange", paint);
      textarea.removeEventListener("compositionstart", start, true);
      textarea.removeEventListener("compositionend", end, true);
      textarea.removeEventListener("blur", end);
      textarea.removeEventListener("focus", paint);
      caret.remove();
      core._syncTextArea = sync;
      helper.updateCompositionElements = update;
      Object.defineProperty(service, "isCursorHidden", {
        ...descriptor,
        value: requestedHidden,
      });
    },
  };
}
