import express from "express";
import cors from "cors";
import session from "express-session";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import modelsRouter from "./routes/models.js";
import chatsRouter from "./routes/chats.js";
import chatRouter from "./routes/chat.js";
import settingsRouter from "./routes/settings.js";
import memoryRouter from "./routes/memory.js";
import artifactsRouter from "./routes/artifacts.js";
import authRouter from "./routes/auth.js";
import { requireAuth } from "./middleware/auth.js";
import { getSessionSecret } from "./services/auth-storage.js";
import { startScheduler } from "./services/scheduler.js";

const isProd = process.env.NODE_ENV === "production";
const PORT = parseInt(process.env.PORT || "3001");
const sessionSecret = await getSessionSecret();

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

app.use(express.json());

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
app.use("/api/artifacts", artifactsRouter);

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

app.listen(PORT, () => {
  console.log(`qu.je agent server running on http://localhost:${PORT}`);
  startScheduler();
});
