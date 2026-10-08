import { useEffect, useMemo, useState } from "react";
import type { BlockMode } from "../block/lib/modeMachine";
import {
  getLeafBlockMode,
  interruptLeaf,
  leafCwd,
  submitToLeaf,
  subscribeLeafBlockMode,
} from "./useTerminalSession";

export type BlockController = {
  blockMode: BlockMode;
  submitCommand: (text: string) => boolean;
  interrupt: () => void;
  getCwd: () => string | null;
};

export function useBlockController(
  leafId: number | null,
): BlockController | null {
  const [observed, setObserved] = useState<{
    leafId: number | null;
    mode: BlockMode;
  }>({ leafId, mode: leafId === null ? "prompt" : getLeafBlockMode(leafId) });
  const blockMode =
    leafId === null
      ? "prompt"
      : observed.leafId === leafId
        ? observed.mode
        : getLeafBlockMode(leafId);

  useEffect(() => {
    if (leafId == null) return;
    const sync = () => setObserved({ leafId, mode: getLeafBlockMode(leafId) });
    sync();
    return subscribeLeafBlockMode(leafId, sync);
  }, [leafId]);

  return useMemo(() => {
    if (leafId == null) return null;
    return {
      blockMode,
      submitCommand: (text) => submitToLeaf(leafId, text),
      interrupt: () => interruptLeaf(leafId),
      getCwd: () => leafCwd(leafId),
    };
  }, [leafId, blockMode]);
}
