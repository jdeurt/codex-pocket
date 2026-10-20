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

// Keep focused table regions keyboard-scrollable across browsers.
function scrollTableWithKeyboard(event: React.KeyboardEvent<HTMLDivElement>) {
  if (event.target !== event.currentTarget || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) {
    return;
  }

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

function TableHeader({ className, ...props }: React.ComponentProps<"thead">) {
  return <thead data-slot="table-header" className={cn("[&_tr]:border-b", className)} {...props} />;
}

function TableBody({ className, ...props }: React.ComponentProps<"tbody">) {
  return <tbody data-slot="table-body" className={cn("[&_tr:last-child]:border-0", className)} {...props} />;
}

function TableFooter({ className, ...props }: React.ComponentProps<"tfoot">) {
  return (
    <tfoot
      data-slot="table-footer"
      className={cn("border-t bg-muted/50 font-medium [&>tr]:last:border-b-0", className)}
      {...props}
    />
  );
}

function TableRow({ className, ...props }: React.ComponentProps<"tr">) {
  return (
    <tr
      data-slot="table-row"
      className={cn(
        "border-b transition-colors hover:bg-muted/50 has-aria-expanded:bg-muted/50 data-[state=selected]:bg-muted",
        className
      )}
      {...props}
    />
  );
}

function TableHead({ className, ...props }: React.ComponentProps<"th">) {
  return (
    <th
      data-slot="table-head"
      className={cn(
        "h-10 px-2 text-left align-middle font-medium whitespace-nowrap text-foreground [&:has([role=checkbox])]:pr-0",
        className
      )}
      {...props}
    />
  );
}

function TableCell({ className, ...props }: React.ComponentProps<"td">) {
  return (
    <td
      data-slot="table-cell"
      className={cn("p-2 align-middle whitespace-nowrap [&:has([role=checkbox])]:pr-0", className)}
      {...props}
    />
  );
}

function TableCaption({ className, ...props }: React.ComponentProps<"caption">) {
  return (
    <caption data-slot="table-caption" className={cn("mt-4 text-sm text-muted-foreground", className)} {...props} />
  );
}

export { Table, TableBody, TableCaption, TableCell, TableFooter, TableHead, TableHeader, TableRow };
