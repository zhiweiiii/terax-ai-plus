export type TerminalTokens = {
  background: string;
  foreground: string;
  cursor: string;
  cursorAccent: string;
  selection: string;
  ansiBlack: string;
  ansiRed: string;
  ansiGreen: string;
  ansiYellow: string;
  ansiBlue: string;
  ansiMagenta: string;
  ansiCyan: string;
  ansiWhite: string;
  ansiBrightBlack: string;
  ansiBrightRed: string;
  ansiBrightGreen: string;
  ansiBrightYellow: string;
  ansiBrightBlue: string;
  ansiBrightMagenta: string;
  ansiBrightCyan: string;
  ansiBrightWhite: string;
};

const VAR_BY_KEY: Record<keyof TerminalTokens, string> = {
  background: "--terminal-background",
  foreground: "--terminal-foreground",
  cursor: "--terminal-cursor",
  cursorAccent: "--terminal-cursor-accent",
  selection: "--terminal-selection",
  ansiBlack: "--terminal-ansi-black",
  ansiRed: "--terminal-ansi-red",
  ansiGreen: "--terminal-ansi-green",
  ansiYellow: "--terminal-ansi-yellow",
  ansiBlue: "--terminal-ansi-blue",
  ansiMagenta: "--terminal-ansi-magenta",
  ansiCyan: "--terminal-ansi-cyan",
  ansiWhite: "--terminal-ansi-white",
  ansiBrightBlack: "--terminal-ansi-bright-black",
  ansiBrightRed: "--terminal-ansi-bright-red",
  ansiBrightGreen: "--terminal-ansi-bright-green",
  ansiBrightYellow: "--terminal-ansi-bright-yellow",
  ansiBrightBlue: "--terminal-ansi-bright-blue",
  ansiBrightMagenta: "--terminal-ansi-bright-magenta",
  ansiBrightCyan: "--terminal-ansi-bright-cyan",
  ansiBrightWhite: "--terminal-ansi-bright-white",
};

const KEYS = Object.keys(VAR_BY_KEY) as (keyof TerminalTokens)[];

let probe: HTMLDivElement | null = null;
let colors: Map<keyof TerminalTokens, HTMLSpanElement> | null = null;

function getColorProbes(): Map<keyof TerminalTokens, HTMLSpanElement> {
  if (probe?.isConnected && colors) return colors;
  const el = document.createElement("div");
  el.setAttribute("aria-hidden", "true");
  el.style.cssText =
    "position:absolute;visibility:hidden;pointer-events:none;contain:strict;width:0;height:0;";
  const next = new Map<keyof TerminalTokens, HTMLSpanElement>();
  for (const key of KEYS) {
    const color = document.createElement("span");
    color.style.color = `var(${VAR_BY_KEY[key]})`;
    el.appendChild(color);
    next.set(key, color);
  }
  probe = el;
  colors = next;
  document.body.appendChild(el);
  return next;
}

export function readTerminalTokens(): TerminalTokens {
  const probes = getColorProbes();
  const out = {} as TerminalTokens;
  for (const [key, element] of probes) {
    out[key] = getComputedStyle(element).color;
  }
  return out;
}
