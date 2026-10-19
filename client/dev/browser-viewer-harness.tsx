import { useRef } from "react";
import { createRoot } from "react-dom/client";
import "../src/styles/glass.css";
import { BrowserViewer } from "../src/components/BrowserViewer";

const svg = `<svg xmlns='http://www.w3.org/2000/svg' width='640' height='400'>
  <rect width='640' height='400' fill='#1e293b'/>
  <circle cx='320' cy='180' r='90' fill='#7c3aed'/>
  <text x='320' y='330' font-size='28' fill='#e2e8f0' text-anchor='middle' font-family='system-ui'>Harness frame</text>
</svg>`;
const frameUrl = `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`;

function Harness() {
  const wrapperRef = useRef<HTMLDivElement>(null);
  return (
    <div
      ref={wrapperRef}
      className="relative mx-auto my-4 h-[600px] w-full max-w-[800px] overflow-hidden rounded-xl border border-white/10 bg-zinc-900 p-4"
    >
      <div className="mb-3 text-xs text-white/40">messages wrapper (positioned ancestor)</div>
      <BrowserViewer
        frame={{
          image: { url: frameUrl, mimeType: "image/svg+xml", name: "harness-frame" },
          pageUrl: "https://example.com/harness",
          pageTitle: "Harness Page",
          at: Date.now(),
        }}
        active={false}
        wrapperRef={wrapperRef}
      />
    </div>
  );
}

createRoot(document.getElementById("root")!).render(<Harness />);
