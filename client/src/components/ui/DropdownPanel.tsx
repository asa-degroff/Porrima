// Dropdown panel — owns the visual chrome (backdrop, border, shadow) and the
// slide-down reveal animation. Callers pass positioning/sizing classes via
// `className` (e.g. "left-0 right-0 top-full mt-1 max-h-[280px] overflow-y-auto").
export function DropdownPanel({ open, className = "", children }: {
  open: boolean;
  className?: string;
  children: React.ReactNode;
}) {
  if (!open) return null;

  return (
    <div
      className={`absolute z-30 app-solid-popover border rounded-xl shadow-2xl py-1 animate-dropdown-enter ${className}`}
      style={{
        backgroundColor: `color-mix(in srgb, rgb(var(--theme-primary)) 8%, rgb(15, 15, 20) 92%)`,
        borderColor: `rgba(var(--theme-primary-border))`,
      }}
    >
      {children}
    </div>
  );
}
