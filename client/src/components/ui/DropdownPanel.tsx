// Dropdown panel — owns the visual chrome (backdrop, border, shadow) and the
// slide-down reveal animation. Keep this raised-edge host non-scrolling:
// `className` controls positioning/width; `contentClassName` controls scrolling/clipping.
export function DropdownPanel({ open, className = "", contentClassName = "max-h-[280px] overflow-y-auto", children }: {
  open: boolean;
  className?: string;
  contentClassName?: string;
  children: React.ReactNode;
}) {
  if (!open) return null;

  return (
    <div
      className={`depth-raised absolute z-30 app-solid-popover border rounded-xl shadow-2xl py-1 animate-dropdown-enter ${className}`}
      style={{
        backgroundColor: `color-mix(in srgb, rgb(var(--theme-primary)) 8%, rgb(15, 15, 20) 92%)`,
        borderColor: `rgba(var(--theme-primary-border))`,
      }}
    >
      <div className={`rounded-xl ${contentClassName}`}>
        {children}
      </div>
    </div>
  );
}
