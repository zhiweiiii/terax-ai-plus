/**
 * Which relay each terminal runs Claude Code against, keyed by leaf id.
 *
 * Terminal-scoped rather than global: the variables are injected into one shell
 * when it spawns, so the answer to "which provider am I on" belongs to a
 * terminal. Leaf ids come from a counter that never reuses a value, so an entry
 * cannot come to describe a different terminal.
 *
 * Deliberately not persisted and deliberately not defaulted from the stored
 * selection. Routing Claude Code through a relay is something to opt into for a
 * terminal, not a state the app should come up in: inheriting it would mean
 * opening the app quietly starts a listener and points every new shell at a paid
 * endpoint.
 *
 * Read at spawn time by `useTerminalSession`, written by the status bar panel,
 * which restarts the terminal so the new value takes effect.
 */
const pins = new Map<number, string>();

export function gatewayPin(leafId: number): string | undefined {
  return pins.get(leafId);
}

export function setGatewayPin(leafId: number, providerId: string | null): void {
  if (providerId === null) pins.delete(leafId);
  else pins.set(leafId, providerId);
}
