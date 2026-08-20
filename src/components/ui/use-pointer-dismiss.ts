import * as React from "react";

/**
 * Keep a menu from stealing focus back when a click outside dismissed it.
 *
 * Radix returns focus to the trigger when an overlay closes, on a later tick.
 * That is right for the keyboard - press Escape and you are back where you
 * started - but wrong for a pointer: you clicked somewhere to go THERE. The
 * terminal took focus on mousedown, the overlay handed it back to its trigger
 * a moment later, and the click that was meant to return you to the terminal
 * did nothing. It took two.
 *
 * So the restore is cancelled only when the dismissal came from a pointer.
 * Spread the result onto a Radix `Content`.
 */
export function usePointerDismiss() {
  const byPointer = React.useRef(false);
  return {
    onPointerDownOutside: () => {
      byPointer.current = true;
    },
    onCloseAutoFocus: (event: Event) => {
      if (byPointer.current) event.preventDefault();
      byPointer.current = false;
    },
  };
}
