// Static grid overlay — no animation, no warp, no canvas.
// Uses CSS repeating-linear-gradient driven by theme custom properties
// so it picks up grid color and opacity automatically on theme switch.
// Grid spacing (20px) is roughly 1/3 of RippleGrid's 55px for a finer "graph paper" feel.

export function GraphPaperBackground() {
  return (
    <div
      className="fixed pointer-events-none"
      style={{
        left: 0,
        right: 0,
        top: 0,
        bottom: 0,
        zIndex: -1,
        backgroundImage: `
          linear-gradient(
            0deg,
            rgba(var(--theme-grid), calc(var(--theme-grid-opacity) * 0.5)) 1px,
            transparent 1px
          ),
          linear-gradient(
            90deg,
            rgba(var(--theme-grid), calc(var(--theme-grid-opacity) * 0.5)) 1px,
            transparent 1px
          )
        `,
        backgroundSize: "20px 20px",
      }}
    />
  );
}
