import {
  FindBox as PrimitiveFindBox,
  type FindBoxHandle,
} from "@/components/ui/find-box";
import { forwardRef, type ComponentProps } from "react";

export type { FindBoxHandle, FindMatch } from "@/components/ui/find-box";

type Props = ComponentProps<typeof PrimitiveFindBox>;

export const FindBox = forwardRef<FindBoxHandle, Props>(function FindBox(
  { matches, onJump, ...props },
  ref,
) {
  return (
    <div
      className="contents"
      onKeyDownCapture={(event) => {
        if (event.nativeEvent.isComposing || event.keyCode === 229)
          event.stopPropagation();
      }}
    >
      <PrimitiveFindBox
        {...props}
        ref={ref}
        matches={matches}
        onJump={(index) => {
          if (matches.length === 0 || !Number.isInteger(index)) return;
          onJump(Math.max(0, Math.min(matches.length - 1, index)));
        }}
      />
    </div>
  );
});
