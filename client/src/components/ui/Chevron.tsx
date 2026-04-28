interface ChevronProps {
  open: boolean;
  size?: number;
  className?: string;
}

export function Chevron({ open, size = 10, className = "" }: ChevronProps) {
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
      className={`shrink-0 transition-transform ${open ? "rotate-180" : ""} ${className}`}
    >
      <path d="M6 9l6 6 6-6" />
    </svg>
  );
}
