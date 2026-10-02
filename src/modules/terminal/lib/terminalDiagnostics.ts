type Event = {
  at: number;
  leafId: number;
  kind: string;
  data: Record<string, string | number | boolean | null>;
};
let enabled = false;
const events: Event[] = [];
const LIMIT = 256;

export function terminalDiagnosticsEnabled(): boolean {
  return enabled;
}

export function recordTerminalEvent(
  leafId: number,
  kind: string,
  data: Event["data"],
): void {
  if (!enabled) return;
  if (events.length === LIMIT) events.shift();
  events.push({ at: performance.now(), leafId, kind, data });
}

export function installTerminalDiagnostics(stats: () => unknown): void {
  Object.assign(window, {
    __teraxTerminalDiagnostics: {
      enable() {
        events.length = 0;
        enabled = true;
      },
      disable() {
        enabled = false;
        events.length = 0;
      },
      snapshot() {
        return { enabled, events: events.slice(), resources: stats() };
      },
    },
  });
}
