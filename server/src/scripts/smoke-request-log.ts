/**
 * Smoke test for the request-log recorder + routes (run with tsx).
 * Writes throwaway rows under chatId "request-log-smoke" and removes them at
 * the end. Exercises: start/end recording, blob dedup, retention pruning,
 * rehydration, latest-system-prompt lookup, HTTP routes, and clear.
 */
import express from "express";
import {
  recordLlmRequestStart,
  recordLlmRequestEnd,
  listLlmRequests,
  getLlmRequestDetail,
  getLatestRecordedSystemPrompt,
  clearLlmRequests,
  onLlmRequestEvent,
} from "../services/request-log.js";
import requestLogRouter from "../routes/request-log.js";

const CHAT = "request-log-smoke";
const TURN = "smoke-turn-1";

function assert(cond: unknown, msg: string): void {
  if (!cond) {
    console.error("FAIL:", msg);
    process.exit(1);
  }
  console.log("ok:", msg);
}

// 1. Event listener wiring
const events: string[] = [];
const unsub = onLlmRequestEvent((ev) => events.push(`${ev.type}:${ev.requestId}`));

// 2. Two requests sharing a prefix (iteration 2 = iteration 1 + tool round)
const systemMsg = { role: "system", content: "You are Porrima. FROZEN MEMORIES HERE." };
const userMsg = { role: "user", content: "hello, what's the weather tool story" };
const assistantMsg = { role: "assistant", content: null, tool_calls: [{ id: "c1", type: "function", function: { name: "web_fetch", arguments: "{\"url\":\"https://example.com\"}" } }] };
const toolMsg = { role: "tool", tool_call_id: "c1", content: "weather: sun, 21C" };
const tools = [{ type: "function", function: { name: "web_fetch", description: "fetch", parameters: { type: "object" } } }];

recordLlmRequestStart({
  chatId: CHAT,
  requestId: `${TURN}:1`,
  turnId: TURN,
  iteration: 1,
  modelId: "test-model",
  provider: "llamacpp",
  body: { model: "test-model", stream: true, stream_options: { include_usage: true }, cache_prompt: true, id_slot: 3, messages: [systemMsg, userMsg], tools },
  requestDigest: "aaaa11112222",
});
recordLlmRequestEnd({
  chatId: CHAT,
  requestId: `${TURN}:1`,
  status: "done",
  output: { content: [{ type: "text", text: "checking" }, assistantMsg.tool_calls[0]], stopReason: "toolUse", usage: { input: 120, output: 30, cacheRead: 100 } },
  cachedTokens: 100,
  durationMs: 950,
});

recordLlmRequestStart({
  chatId: CHAT,
  requestId: `${TURN}:2`,
  turnId: TURN,
  iteration: 2,
  modelId: "test-model",
  provider: "llamacpp",
  body: { model: "test-model", stream: true, cache_prompt: true, messages: [systemMsg, userMsg, assistantMsg, toolMsg], tools },
  requestDigest: "bbbb22223333",
});
// leave request 2 in_progress on purpose? No — finish it.
recordLlmRequestEnd({
  chatId: CHAT,
  requestId: `${TURN}:2`,
  status: "done",
  output: { content: [{ type: "text", text: "It is sunny, 21C." }], stopReason: "stop", usage: { input: 260, output: 12, cacheRead: 240 } },
  cachedTokens: 240,
  durationMs: 610,
});

assert(events.includes("start:smoke-turn-1:1") && events.includes("end:smoke-turn-1:2"), "start/end events emitted");
unsub();

// 3. List + detail + dedup rehydration
const list = listLlmRequests(CHAT);
assert(list.length === 2 && list[0].id === `${TURN}:2`, "list newest-first");
assert(list[0].promptTokens === 260 && list[0].cachedTokens === 240 && list[0].stopReason === "stop", "summary metrics stored");

const d2 = getLlmRequestDetail(`${TURN}:2`);
assert(d2 !== null && d2.request?.messages.length === 4, "detail rehydrates 4 messages");
assert((d2?.request?.messages[0] as any)?.content === systemMsg.content, "system prompt blob round-trips");
assert(d2?.request?.params?.cache_prompt === true && d2?.request?.params?.model === "test-model", "params preserved, tools/messages lifted");
assert((d2?.request?.tools?.length ?? 0) === 1, "tools blob rehydrated");
assert((d2?.response?.content as any)?.[0]?.text === "It is sunny, 21C.", "response blocks round-trip");
assert(d2?.request?.reclaimed === 0, "nothing reclaimed");

assert(getLatestRecordedSystemPrompt(CHAT) === systemMsg.content, "latest system prompt from request log");

// 4. Retention pruning: insert 60 tiny rows, expect cap at 50
for (let i = 3; i < 63; i++) {
  recordLlmRequestStart({
    chatId: CHAT,
    requestId: `${TURN}:${i}`,
    turnId: TURN,
    iteration: i,
    modelId: "test-model",
    provider: "llamacpp",
    body: { model: "test-model", messages: [{ role: "user", content: `tick ${i}` }] },
  });
}
assert(listLlmRequests(CHAT).length === 50, "pruned to 50 per chat");

// 5. HTTP routes in-process
const app = express();
app.use("/api/llm-requests", requestLogRouter);
const server = app.listen(0, async () => {
  const port = (server.address() as any).port;
  const base = `http://127.0.0.1:${port}/api/llm-requests`;
  const listRes = await fetch(`${base}?chatId=${CHAT}`);
  const listJson: any = await listRes.json();
  assert(listRes.status === 200 && listJson.requests.length === 50, "GET list route");

  const detailRes = await fetch(`${base}/${encodeURIComponent(`${TURN}:62`)}`);
  assert(detailRes.status === 200, "GET detail route");

  const badRes = await fetch(base);
  assert(badRes.status === 400, "GET without chatId rejected");

  const missingRes = await fetch(`${base}/does-not-exist`);
  assert(missingRes.status === 404, "unknown id 404");

  const delRes = await fetch(`${base}?chatId=${CHAT}`, { method: "DELETE" });
  const delJson: any = await delRes.json();
  assert(delRes.status === 200 && delJson.removed === 50, "DELETE clear route");
  assert(listLlmRequests(CHAT).length === 0, "chat cleared");
  assert(getLatestRecordedSystemPrompt(CHAT) === null, "system prompt lookup empty after clear");

  server.close();
  console.log("\nSMOKE PASSED");
});
