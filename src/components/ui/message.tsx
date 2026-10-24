import { nativeSlot } from "./native-slot";
import * as React from "react";
import { cn } from "cn";

/**
Lay out a message row using its declared start or end alignment.
@param props - Native attributes, children and the declared appearance or composition options.
@returns The composed element with caller props and classes preserved.
*/
function Message({ className, align = "start", ...props }: React.ComponentProps<"div"> & { align?: "start" | "end" }) {
  return (
    <div
      data-slot="message"
      data-align={align}
      className={cn(
        "group/message relative flex w-full min-w-0 gap-2 text-sm data-[align=end]:flex-row-reverse",
        className
      )}
      {...props}
    />
  );
}

/**
Keep message children within the existing flexible, bounded content column.
*/
const MessageContent = (nativeSlot<"div">).bind(
  undefined,
  "div",
  "message-content",
  "flex w-full min-w-0 flex-col gap-2.5 wrap-break-word group-data-[align=end]/message:*:data-slot:self-end"
);

export { Message, MessageContent };
