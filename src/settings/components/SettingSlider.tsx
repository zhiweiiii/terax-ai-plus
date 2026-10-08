import { Slider } from "radix-ui";
import type { ComponentProps } from "react";
import { cn } from "@/lib/utils";

type Props = Omit<ComponentProps<typeof Slider.Root>, "children" | "value"> & {
  label: string;
  value: [number];
};

export function SettingSlider({ label, className, ...props }: Props) {
  return (
    <Slider.Root
      {...props}
      className={cn(
        "relative flex w-full touch-none select-none items-center data-disabled:opacity-50 data-vertical:h-full data-vertical:min-h-40 data-vertical:w-auto data-vertical:flex-col",
        className,
      )}
    >
      <Slider.Track className="relative grow overflow-hidden rounded-full bg-input/90 data-horizontal:h-2 data-horizontal:w-full data-vertical:h-full data-vertical:w-2">
        <Slider.Range className="absolute rounded-full bg-primary data-horizontal:h-full data-vertical:w-full" />
      </Slider.Track>
      <Slider.Thumb
        aria-label={label}
        className="block h-4 w-6 shrink-0 rounded-full bg-white shadow-md ring-1 ring-black/10 transition-[color,box-shadow,background-color] not-dark:bg-clip-padding hover:ring-4 hover:ring-ring/30 focus-visible:outline-hidden focus-visible:ring-4 focus-visible:ring-ring/30 disabled:pointer-events-none disabled:opacity-50 data-vertical:h-6 data-vertical:w-4"
      />
    </Slider.Root>
  );
}
