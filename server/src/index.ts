import express from "express";
import cors from "cors";
import modelsRouter from "./routes/models.js";
import chatsRouter from "./routes/chats.js";
import chatRouter from "./routes/chat.js";
import settingsRouter from "./routes/settings.js";
import memoryRouter from "./routes/memory.js";
import { startScheduler } from "./services/scheduler.js";

const app = express();
const PORT = 3001;

app.use(cors());
app.use(express.json());

app.use("/api/models", modelsRouter);
app.use("/api/chats", chatsRouter);
app.use("/api/chat", chatRouter);
app.use("/api/settings", settingsRouter);
app.use("/api/memory", memoryRouter);

app.listen(PORT, () => {
  console.log(`qu.je agent server running on http://localhost:${PORT}`);
  startScheduler();
});
