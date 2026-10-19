import { cn } from "cn";

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
      className={cn(
        "block size-4 shrink-0 origin-center animate-spin [transform-box:view-box] motion-reduce:animate-none",
        className
      )}
      {...props}
    >
      <circle cx="12" cy="12" r="9" opacity="0.25" />
      <path d="M12 3a9 9 0 1 1-9 9" />
    </svg>
  );
}

export { Spinner };
