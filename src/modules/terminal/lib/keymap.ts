export type TerminalKeyEvent = Pick<
  KeyboardEvent,
  "altKey" | "ctrlKey" | "metaKey" | "key" | "code"
>;

function terminalWordNavigationSequence(
  event: TerminalKeyEvent,
): string | null {
  if (!event.altKey || event.ctrlKey || event.metaKey) return null;
  if (event.key === "ArrowLeft" || event.code === "ArrowLeft") return "\x1bb";
  if (event.key === "ArrowRight" || event.code === "ArrowRight") return "\x1bf";
  return null;
}

function terminalDeleteSequence(event: TerminalKeyEvent): string | null {
  if (event.key !== "Backspace" && event.code !== "Backspace") return null;
  if (event.ctrlKey && !event.altKey && !event.metaKey) return "\x17";
  return null;
}

export function terminalReadlineSequence(
  event: TerminalKeyEvent,
  opts: { isAlternateScreen: boolean },
): string | null {
  if (opts.isAlternateScreen) return null;
  return terminalWordNavigationSequence(event) ?? terminalDeleteSequence(event);
}
