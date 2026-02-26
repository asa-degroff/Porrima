import express from "express";
import cors from "cors";
import modelsRouter from "./routes/models.js";
import chatsRouter from "./routes/chats.js";
import chatRouter from "./routes/chat.js";

const app = express();
const PORT = 3001;

app.use(cors());
app.use(express.json());

app.use("/api/models", modelsRouter);
app.use("/api/chats", chatsRouter);
app.use("/api/chat", chatRouter);

app.listen(PORT, () => {
  console.log(`Pi Web UI server running on http://localhost:${PORT}`);
});
