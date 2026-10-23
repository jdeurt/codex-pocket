"use client";
import { Collapsible as CollapsiblePrimitive } from "@base-ui/react/collapsible";
import { ACTIVITY_TRANSITION } from "@/lib/activity-motion";
import { cn } from "cn";

/**
Delegate controlled disclosure state and native events to the Base UI root.
@param props - Native attributes, children and the declared appearance or composition options.
@returns The composed element with caller props and classes preserved.
*/
function Collapsible({ ...props }: CollapsiblePrimitive.Root.Props) {
  return <CollapsiblePrimitive.Root data-slot="collapsible" {...props} />;
}

/**
Expose the native keyboard-operable trigger for its owning disclosure.
@param props - Native attributes, children and the declared appearance or composition options.
@returns The composed element with caller props and classes preserved.
*/
function CollapsibleTrigger({ ...props }: CollapsiblePrimitive.Trigger.Props) {
  return <CollapsiblePrimitive.Trigger data-slot="collapsible-trigger" {...props} />;
}

/**
Delegate disclosure panel mounting and visibility to the native primitive.
@param props - Native attributes, children and the declared appearance or composition options.
@returns The composed element with caller props and classes preserved.
*/
function CollapsibleContent({ className, style, ...props }: CollapsiblePrimitive.Panel.Props) {
  const panelClass = (state: CollapsiblePrimitive.Panel.State) =>
    cn(
      "h-(--collapsible-panel-height) min-w-0 overflow-hidden transition-[height] " +
        "motion-reduce:transition-none data-ending-style:h-0 data-starting-style:h-0",
      typeof className === "function" ? className(state) : className
    );

  return (
    <CollapsiblePrimitive.Panel
      data-slot="collapsible-content"
      className={panelClass}
      style={(state) => ({ ...ACTIVITY_TRANSITION, ...(typeof style === "function" ? style(state) : style) })}
      {...props}
    />
  );
}

export { Collapsible, CollapsibleContent, CollapsibleTrigger };
