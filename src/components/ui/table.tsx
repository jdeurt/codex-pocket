"use client";
import * as React from "react";
import { type VariantProps, cva } from "class-variance-authority";
import { cn } from "cn";

const tableVariants = cva("caption-bottom", {
  variants: {
    variant: {
      default: "w-full text-sm",
      markdown: "w-max text-inherit",
    },
  },
});

/**
Apply a supported horizontal navigation key within an already eligible table region.
@param event - Unmodified key event targeted at the scroll region itself.
*/
function scrollFocusedTable(event: React.KeyboardEvent<HTMLDivElement>) {
  const element = event.currentTarget;
  const STEP = 48;
  const positions: Record<string, number | undefined> = {
    ArrowLeft: element.scrollLeft - STEP,
    ArrowRight: element.scrollLeft + STEP,
    Home: 0,
    End: element.scrollWidth,
  };
  const left = positions[event.key];

  if (left === undefined) {
    return;
  }

  event.preventDefault();
  element.scrollTo({ left });
}

/**
Keep focused table regions keyboard-scrollable without intercepting child controls or modified keys.
@param event - Native React keyboard event from the table's scroll container.
*/
function scrollTableWithKeyboard(event: React.KeyboardEvent<HTMLDivElement>) {
  if (event.target !== event.currentTarget || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) {
    return;
  }

  scrollFocusedTable(event);
}

/**
Wrap a native table in the existing keyboard-scrollable horizontal region.
@param props - Native attributes, children and the declared appearance or composition options.
@returns The composed element with caller props and classes preserved.
*/
function Table({
  className,
  variant = "default",
  containerProps,
  ...props
}: React.ComponentProps<"table"> &
  VariantProps<typeof tableVariants> & {
    containerProps?: React.ComponentProps<"div">;
  }) {
  return (
    <div
      data-slot="table-container"
      onKeyDown={scrollTableWithKeyboard}
      {...containerProps}
      className={cn(
        "relative w-full min-w-0 max-w-full overflow-x-auto overscroll-x-contain focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring",
        containerProps?.className
      )}
    >
      <table data-slot="table" className={cn(tableVariants({ variant }), className)} {...props} />
    </div>
  );
}

export { Table };
