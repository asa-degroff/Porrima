import { useEffect, useRef, useState } from "react";

interface PrefillActivityIconProps {
  className?: string;
  colorClass?: string;
}

export function PrefillActivityIcon({ className = "", colorClass = "bg-accent-text" }: PrefillActivityIconProps) {
  const [lineStates, setLineStates] = useState<Array<"empty" | "filling" | "full">>(["empty", "empty", "empty"]);
  const [shifting, setShifting] = useState(false);
  const fillRef = useRef<number | null>(null);
  const shiftRef = useRef<number | null>(null);
  const cycleRef = useRef<number | null>(null);

  const gap = 5;
  const fillMs = 1200;
  const shiftMs = 220;

  useEffect(() => {
    function runCycle() {
      setLineStates(["full", "full", "filling"]);

      fillRef.current = window.setTimeout(() => {
        setLineStates(["full", "full", "full"]);
        setShifting(true);

        shiftRef.current = window.setTimeout(() => {
          setShifting(false);
          setLineStates((prev) => [prev[1], prev[2], "empty"]);
          cycleRef.current = window.setTimeout(runCycle, 60);
        }, shiftMs);
      }, fillMs);
    }

    runCycle();

    return () => {
      if (fillRef.current !== null) window.clearTimeout(fillRef.current);
      if (shiftRef.current !== null) window.clearTimeout(shiftRef.current);
      if (cycleRef.current !== null) window.clearTimeout(cycleRef.current);
    };
  }, []);

  return (
    <>
      <style>{`
        @keyframes prefill-shift {
          to { transform: translateY(-${gap}px); }
        }
        @keyframes prefill-fill {
          to { width: 100%; }
        }
      `}</style>
      <div className={`relative w-3 overflow-hidden ${className}`} style={{ height: gap * 4 }}>
        <div
          className="absolute top-0 left-0 right-0"
          style={{
            animation: shifting ? `prefill-shift ${shiftMs}ms cubic-bezier(0.4, 0, 0.2, 1) forwards` : "none",
          }}
        >
          {lineStates.map((state, i) => {
            const top = gap * (i + 1);
            const isFilling = state === "filling";
            const isFull = state === "full";
            const width = isFull ? "100%" : "0%";
            return (
              <div
                key={i}
                className="absolute left-0 h-[1.5px] rounded-full"
                style={{
                  top,
                  width,
                  backgroundColor: `rgba(var(--theme-accent), 0.7)`,
                  animation: isFilling
                    ? `prefill-fill ${fillMs}ms cubic-bezier(0.4, 0, 0.2, 1) forwards`
                    : "none",
                }}
              />
            );
          })}
        </div>
      </div>
    </>
  );
}
