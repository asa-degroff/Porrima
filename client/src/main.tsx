import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { registerSW } from "virtual:pwa-register";
import App from "./App";
import "./styles/glass.css";

// Explicit SW registration — required when vite-plugin-pwa is in
// injectManifest mode (the auto-registered snippet is only injected for
// generateSW). We use autoUpdate so existing installs pick up new versions
// without a prompt.
registerSW({ immediate: true });

// Disable pinch-to-zoom in standalone (installed) PWA mode only
const isStandalone =
  window.matchMedia("(display-mode: standalone)").matches ||
  (navigator as unknown as { standalone?: boolean }).standalone === true;

if (isStandalone) {
  const viewport = document.querySelector('meta[name="viewport"]');
  if (viewport) {
    viewport.setAttribute(
      "content",
      "width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no, interactive-widget=overlays-content"
    );
  }
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>
);
