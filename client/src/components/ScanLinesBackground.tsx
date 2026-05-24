export function ScanLinesBackground() {
  return (
    <div
      className="fixed pointer-events-none"
      style={{
        left: 0,
        right: 0,
        top: 0,
        bottom: 0,
        zIndex: -1,
        backgroundImage: `repeating-linear-gradient(
          to bottom,
          rgba(0, 0, 0, 0.1) 0px,
          rgba(0, 0, 0, 0.1) 2px,
          transparent 2px,
          transparent 4px
        )`,
      }}
    />
  );
}
