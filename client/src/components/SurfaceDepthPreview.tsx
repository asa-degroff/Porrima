import { useState } from "react";

/** Local scope previews the draft without changing the saved app appearance. */
export function SurfaceDepthPreview({ depth }: { depth: "flat" | "beveled" }) {
  const [open, setOpen] = useState(false);

  return (
    <div data-depth={depth} className="space-y-3" aria-label="Surface depth preview">
      <div className="depth-raised relative rounded-xl border border-white/15 app-glass-surface p-4 space-y-3">
        <div>
          <p className="text-sm text-white/80">A little more dimension</p>
          <p className="text-xs text-white/40 mt-1">Raised edges above, a recessed field below.</p>
        </div>
        <label className="depth-inset relative block rounded-lg border border-white/15 app-input-surface theme-accent-focus">
          <span className="sr-only">Preview message</span>
          <input
            className="w-full bg-transparent rounded-lg px-3 py-2 text-sm text-white/80 placeholder:text-white/35 outline-none"
            placeholder="Try the recessed input…"
          />
        </label>
        <div className="flex items-center justify-between gap-3">
          <button
            type="button"
            className="depth-raised relative rounded-lg border border-white/15 bg-white/5 px-3 py-1.5 text-xs text-white/70 hover:bg-white/10 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white/60 pressable"
            aria-expanded={open}
            onClick={() => setOpen((value) => !value)}
          >
            {open ? "Hide panel ▴" : "Preview panel ▾"}
          </button>
          <button type="button" className="depth-raised relative rounded-lg px-4 py-1.5 text-sm theme-accent-btn focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white/60 pressable">
            Press me
          </button>
        </div>
      </div>
      {open && (
        <div className="depth-raised relative rounded-xl border border-white/15 app-solid-popover p-3 shadow-lg text-xs text-white/60">
          Dropdown edges use the same lighting, even on taller surfaces.
        </div>
      )}
    </div>
  );
}
