import { cn } from "cn";

/**
Render the existing accessible SVG loading indicator and its shared animation.
@param props - Native SVG attributes and classes; the indicator supplies its own circle.
@returns A status SVG containing the existing animated circle.
*/
function Spinner({ className, ...props }: React.ComponentProps<"svg">) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      data-slot="spinner"
      role="status"
      aria-label="Loading"
      className={cn("block size-4 shrink-0", className)}
      {...props}
    >
      <circle
        className="spinner-arc"
        cx="12"
        cy="12"
        r="9"
        pathLength="100"
        strokeDasharray="80 20"
        strokeDashoffset="0"
      />
    </svg>
  );
}

export { Spinner };
