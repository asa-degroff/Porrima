interface ChevronProps {
  open: boolean;
  size?: number;
  className?: string;
  /**
   * "flip" (default, dropdown triggers): points down when closed, rotates up
   * when open.
   * "tree" (collapsible nodes): points right when closed, rotates down when
   * open.
   */
  variant?: "flip" | "tree";
}

export function Chevron({ open, size = 10, className = "", variant = "flip" }: ChevronProps) {
  const rotation =
    variant === "tree" ? (open ? "rotate-0" : "-rotate-90") : open ? "rotate-180" : "";
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={`shrink-0 transition-transform ${rotation} ${className}`}
    >
      <path d="M6 9l6 6 6-6" />
    </svg>
  );
}
