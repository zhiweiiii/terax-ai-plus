import type { BlockMode } from "@/modules/terminal/block/lib/modeMachine";

export function terminalInputOwner(state: {
  blocks: boolean;
  blockMode: BlockMode;
  shellExited: boolean;
  awaitingRestart: boolean;
}): "shell" | "terminal" | "none" {
  if (state.shellExited && !state.awaitingRestart) return "none";
  return state.blocks && state.blockMode === "prompt" && !state.awaitingRestart
    ? "shell"
    : "terminal";
}
