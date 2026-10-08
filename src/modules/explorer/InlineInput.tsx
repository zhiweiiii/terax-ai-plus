import { useLayoutEffect, useRef, useState } from "react";
import { toast } from "sonner";

type Props = {
  initial: string;
  placeholder?: string;
  onCommit: (value: string) => boolean | Promise<boolean>;
  onCancel: () => void;
};

/**
 * Self-focusing single-line input for rename / create flows in the tree.
 * Enter commits, Escape cancels, blur commits (matches VSCode behavior —
 * dismissing the input is an implicit commit so a typed name isn't lost).
 */
export function InlineInput({
  initial,
  placeholder,
  onCommit,
  onCancel,
}: Props) {
  const [value, setValue] = useState(initial);
  const ref = useRef<HTMLInputElement>(null);
  const committedRef = useRef(false);
  const settledRef = useRef(false);
  const interactedRef = useRef(false);
  const composingRef = useRef(false);
  const aliveRef = useRef(false);
  const [pending, setPending] = useState(false);

  useLayoutEffect(() => {
    aliveRef.current = true;
    settledRef.current = false;
    const el = ref.current;
    if (!el) return;
    // Two-tick focus to win against parent click handlers and Radix portal
    // restorations that can steal focus right after mount. Until the second
    // tick lands we treat the input as "unsettled" — any blur during that
    // window is the portal teardown stealing focus, not the user dismissing
    // the input, so we refocus instead of committing an empty value.
    //
    // preventScroll matters here (#123): the input mounts inside the
    // sidebar's flex column, which is small enough that focus-scroll can
    // nudge the parent's scroll position by a fraction of a pixel each
    // cycle. Repeated open/cancel pairs accumulate and walk the tree off
    // the left edge. We're already rendering the input where it should be
    // visible — there is no scroll-into-view we need from focus().
    const focus = () => {
      el.focus({ preventScroll: true });
      const dot = initial.lastIndexOf(".");
      if (dot > 0) el.setSelectionRange(0, dot);
      else el.select();
    };
    focus();
    const raf = requestAnimationFrame(() => {
      if (!interactedRef.current) focus();
    });
    const timer = setTimeout(() => {
      if (!interactedRef.current) focus();
      settledRef.current = true;
    }, 170);
    return () => {
      aliveRef.current = false;
      cancelAnimationFrame(raf);
      clearTimeout(timer);
    };
  }, [initial]);

  const commit = async () => {
    if (committedRef.current) return;
    committedRef.current = true;
    setPending(true);
    let accepted = false;
    try {
      accepted = await onCommit(value);
    } catch (error) {
      toast.error(`Could not save filename: ${String(error)}`);
    } finally {
      if (aliveRef.current) {
        setPending(false);
        if (!accepted) {
          committedRef.current = false;
          ref.current?.focus({ preventScroll: true });
        }
      }
    }
  };
  const cancel = () => {
    if (committedRef.current) return;
    committedRef.current = true;
    onCancel();
  };

  return (
    <input
      ref={ref}
      value={value}
      placeholder={placeholder}
      aria-busy={pending}
      readOnly={pending}
      onPointerDown={() => {
        interactedRef.current = true;
      }}
      onCompositionStart={() => {
        composingRef.current = true;
        interactedRef.current = true;
      }}
      onCompositionEnd={() => {
        composingRef.current = false;
      }}
      onChange={(e) => {
        interactedRef.current = true;
        setValue(e.target.value);
      }}
      onKeyDown={(e) => {
        interactedRef.current = true;
        if (
          composingRef.current ||
          e.nativeEvent.isComposing ||
          e.keyCode === 229
        )
          return;
        if (e.key === "Enter") {
          e.preventDefault();
          void commit();
        } else if (e.key === "Escape") {
          e.preventDefault();
          cancel();
        }
      }}
      onBlur={() => {
        if (composingRef.current) return;
        if (!settledRef.current) {
          ref.current?.focus({ preventScroll: true });
          return;
        }
        void commit();
      }}
      className="flex-1 min-w-0 truncate rounded-sm border border-border bg-background px-1.5 py-0.5 text-xs text-foreground outline-none ring-0 focus:border-ring"
    />
  );
}
