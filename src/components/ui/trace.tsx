import * as React from "react";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { ACTIVITY_TRANSITION } from "@/lib/activity-motion";
import { ChevronRightIcon } from "lucide-react";
import { cn } from "cn";

/**
Group related assistant activity lines using the shared trace layout.
@param props - Native attributes, children and the declared appearance or composition options.
@returns The composed element with caller props and classes preserved.
*/
function Trace({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="trace"
      className={cn(
        "flex w-full min-w-0 flex-col gap-2 *:has-[>[data-slot=trace-line]]:flex *:has-[>[data-slot=trace-line]]:w-fit *:has-[>[data-slot=trace-line]]:max-w-full *:has-[>[data-slot=trace-line]]:min-w-0 *:has-[>[data-slot=trace-line]]:rounded-md *:has-[>[data-slot=trace-line]]:text-left *:has-[>[data-slot=trace-line]]:outline-none *:has-[>[data-slot=trace-line]]:focus-visible:ring-3 *:has-[>[data-slot=trace-line]]:focus-visible:ring-ring/50",
        className
      )}
      {...props}
    />
  );
}

/**
Present one activity line with its declared status and connector treatment.
@param props - Native attributes, children and the declared appearance or composition options.
@returns The composed element with caller props and classes preserved.
*/
function TraceLine({
  className,
  status,
  size = "sm",
  variant = "default",
  ...props
}: React.ComponentProps<"span"> & {
  status?: "running" | "error" | "pending";
  size?: "sm" | "md";
  variant?: "default" | "activity";
}) {
  return (
    <span
      data-slot="trace-line"
      data-status={status}
      data-variant={variant}
      className={cn(
        "flex w-fit max-w-full min-w-0 items-center gap-2 text-muted-foreground transition-colors in-[a,button]:cursor-pointer in-[a:hover,button:hover]:text-foreground data-[status=error]:text-destructive data-[status=error]:in-[a:hover,button:hover]:text-destructive data-[status=pending]:opacity-60 data-[status=running]:*:data-[slot=trace-title]:shimmer",
        size === "md" ? "text-base" : "text-sm",
        variant === "activity" && "in-[a:hover,button:hover]:text-muted-foreground",
        className
      )}
      {...props}
    />
  );
}

/**
Reserve the existing icon slot within an activity line.
@param props - Native attributes, children and the declared appearance or composition options.
@returns The composed element with caller props and classes preserved.
*/
function TraceIcon({ className, ...props }: React.ComponentProps<"span">) {
  return (
    <span
      data-slot="trace-icon"
      aria-hidden="true"
      className={cn(
        "flex size-4 shrink-0 items-center justify-center [&_svg]:pointer-events-none [&_svg:not([class*='size-'])]:size-4 [[data-slot=trace-title]~&]:-ml-1",
        className
      )}
      {...props}
    />
  );
}

/**
Keep an activity title truncated within the available line width.
@param props - Native attributes, children and the declared appearance or composition options.
@returns The composed element with caller props and classes preserved.
*/
function TraceTitle({ className, ...props }: React.ComponentProps<"span">) {
  return (
    <span data-slot="trace-title" className={cn("min-w-0 truncate motion-reduce:shimmer-none", className)} {...props} />
  );
}

/**
Delegate expandable activity state to the existing disclosure primitive.
@param props - Native attributes, children and the declared appearance or composition options.
@returns The composed element with caller props and classes preserved.
*/
function TraceCollapsible({
  className,
  ...props
}: Omit<React.ComponentProps<typeof Collapsible>, "open"> &
  (
    | { open?: undefined }
    | {
        open: boolean;
        onOpenChange: NonNullable<React.ComponentProps<typeof Collapsible>["onOpenChange"]>;
      }
  )) {
  return (
    <Collapsible data-slot="trace-collapsible" className={cn("flex w-full min-w-0 flex-col", className)} {...props} />
  );
}

/**
Render a keyboard-operable activity disclosure trigger with its existing chevron.
@param props - Native attributes, children and the declared appearance or composition options.
@returns The composed element with caller props and classes preserved.
*/
function TraceCollapsibleTrigger({
  className,
  children,
  variant = "default",
  ...props
}: React.ComponentProps<typeof CollapsibleTrigger> & { variant?: "default" | "activity" }) {
  return (
    <CollapsibleTrigger
      data-slot="trace-collapsible-trigger"
      data-variant={variant}
      className={cn(
        "group/trace-collapsible-trigger flex w-fit max-w-full min-w-0 cursor-pointer items-center gap-1 rounded-md text-left text-muted-foreground transition-colors outline-none hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50 has-[[data-status=error]]:text-destructive",
        variant === "activity" && "opacity-70 hover:text-muted-foreground",
        className
      )}
      {...props}
    >
      {children}
      <TraceIcon
        style={ACTIVITY_TRANSITION}
        className="transition-transform motion-reduce:transition-none group-aria-expanded/trace-collapsible-trigger:rotate-90"
      >
        <ChevronRightIcon />
      </TraceIcon>
    </CollapsibleTrigger>
  );
}

/**
Render expanded activity content using its declared messages or default layout.
@param props - Native attributes, children and the declared appearance or composition options.
@returns The composed element with caller props and classes preserved.
*/
function TraceCollapsibleContent({
  className,
  children,
  variant = "default",
  style,
  ...props
}: React.ComponentProps<typeof CollapsibleContent> & { variant?: "default" | "messages" }) {
  return (
    <CollapsibleContent
      data-slot="trace-collapsible-content"
      className="h-(--collapsible-panel-height) min-w-0 overflow-hidden transition-[height] motion-reduce:transition-none data-ending-style:h-0 data-starting-style:h-0"
      style={(state) => ({ ...ACTIVITY_TRANSITION, ...(typeof style === "function" ? style(state) : style) })}
      {...props}
    >
      <div
        data-slot="trace-collapsible-content-inner"
        className={cn(
          "min-w-0 leading-relaxed wrap-break-word",
          variant === "messages"
            ? "pt-4 text-foreground"
            : "mt-2 mb-1 ml-[calc(--spacing(2)-1px)] border-l pr-1 pl-4 text-muted-foreground",
          className
        )}
      >
        {children}
      </div>
    </CollapsibleContent>
  );
}

export { Trace, TraceCollapsible, TraceCollapsibleContent, TraceCollapsibleTrigger, TraceIcon, TraceLine, TraceTitle };
