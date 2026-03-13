import express from "express";
import cors from "cors";
import session from "express-session";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import type { Request, Response, NextFunction } from "express";
import modelsRouter from "./routes/models.js";
import chatsRouter from "./routes/chats.js";
import chatRouter from "./routes/chat.js";
import settingsRouter from "./routes/settings.js";
import memoryRouter from "./routes/memory.js";
import artifactsRouter from "./routes/artifacts.js";
import imagesRouter from "./routes/images.js";
import visionRouter from "./routes/vision.js";
import authRouter from "./routes/auth.js";
import personaRouter from "./routes/persona.js";
import ttsRouter from "./routes/tts.js";
import skillsRouter from "./routes/skills.js";
import userImagesRouter from "./routes/user-images.js";
import { requireAuth } from "./middleware/auth.js";
import { getSessionSecret } from "./services/auth-storage.js";
import { startScheduler } from "./services/scheduler.js";
import { initializePersona } from "./services/persona-store.js";

const isProd = process.env.NODE_ENV === "production";
const PORT = parseInt(process.env.PORT || "3001");
const sessionSecret = await getSessionSecret();

// Initialize persona system on startup
await initializePersona();

const app = express();

// Trust proxy (Cloudflare Tunnel terminates TLS upstream)
if (isProd) {
  app.set("trust proxy", 1);
}

// Session middleware
app.use(
  session({
    secret: sessionSecret,
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      secure: isProd,
      sameSite: "lax",
      maxAge: 30 * 24 * 60 * 60 * 1000, // 30 days
    },
  })
);

// CORS
if (isProd) {
  app.use(cors({ origin: false }));
} else {
  app.use(cors({ origin: true, credentials: true }));
}

app.use(express.json({ limit: "50mb" }));

// Auth routes (unprotected)
app.use("/api/auth", authRouter);

// Auth middleware (protects all other /api/* routes)
app.use("/api", requireAuth);

// Protected API routes
app.use("/api/models", modelsRouter);
app.use("/api/chats", chatsRouter);
app.use("/api/chat", chatRouter);
app.use("/api/settings", settingsRouter);
app.use("/api/memory", memoryRouter);
app.use("/api/persona", personaRouter);
app.use("/api/artifacts", artifactsRouter);
app.use("/api/images", imagesRouter);
app.use("/api/vision", visionRouter);
app.use("/api/tts", ttsRouter);
app.use("/api/skills", skillsRouter);
app.use("/api/user-images", userImagesRouter);

// Production static serving
if (isProd) {
  const __dirname = dirname(fileURLToPath(import.meta.url));
  const clientDist = join(__dirname, "../../client/dist");
  app.use(express.static(clientDist));
  // SPA fallback for non-API routes
  app.get("*path", (_req, res) => {
    res.sendFile(join(clientDist, "index.html"));
  });
}

// Global error handler - must be after all routes
app.use((err: any, _req: Request, res: Response, _next: NextFunction) => {
  console.error("Unhandled error:", err);
  res.status(err.status || 500).json({ error: err.message || "Internal server error" });
});

app.listen(PORT, () => {
  console.log(`qu.je agent server running on http://localhost:${PORT}`);
  startScheduler();
});
