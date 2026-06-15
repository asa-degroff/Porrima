import type { BackgroundEffect } from "../types";

const PREVIEW_CLASS: Record<BackgroundEffect, string> = {
  static: "bg-effect-preview-static",
  "ripple-grid": "bg-effect-preview-ripple-grid",
  "scan-lines": "bg-effect-preview-scan-lines",
  "ripple-dots": "bg-effect-preview-ripple-dots",
  "graph-paper": "bg-effect-preview-graph-paper",
};

interface Props {
  effect: BackgroundEffect;
  className?: string;
  children?: React.ReactNode;
}

export function BackgroundEffectPreview({ effect, className = "", children }: Props) {
  return (
    <div className={`${PREVIEW_CLASS[effect]} ${className}`} aria-hidden="true">
      {children}
    </div>
  );
}
