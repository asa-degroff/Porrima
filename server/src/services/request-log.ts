import Database from "better-sqlite3";
import { createHash } from "crypto";
import { appDataPath } from "./paths.js";

/**
 * Per-turn LLM request log — the storage side of the request viewer feature
 * (docs/design/request-viewer.md).
 *
 * The OpenAI-compatible provider records the exact wire body it dispatches and
 * the accumulated response when it finalizes. This is a pure side-channel:
 * recording never mutates or delays the request (callers wrap every entry
 * point in try/catch), so the byte-identical KV-cache prefix contract is
 * untouched.
 *
 * Storage notes:
 * - Transcript rows are re-sent in full on every iteration, so message-level
 *   content-addressed blobs (`llm_request_blobs`) collapse the otherwise
 *   quadratic growth to "first copy + hash pointers".
 * - Retention mirrors model-stats: the newest N rows per chat, pruned on
 *   insert; blobs are vacuumed (by remaining reference set) on a throttle.
 * - Only chat-turn traffic is recorded in v1 (`purpose='chat'`). Cache-warm,
 *   extraction, title, and rerank calls never reach these entry points — the
 *   recorder is gated on the per-turn request id that only real turns carry.
 */

const DB_PATH = appDataPath("porrima.db");

/** Newest N recorded requests kept per chat (mirrors MAX_RUNS_PER_MODEL). */
const MAX_REQUESTS_PER_CHAT = 50;

/** Run the global blob vacuum every N prunes so inserts stay cheap. */
const BLOB_VACUUM_EVERY = 20;

export type RequestRecordStatus = "in_progress" | "done" | "error" | "aborted";

export interface LlmRequestStartInfo {
  chatId: string;
  requestId: string;
  turnId?: string;
  iteration?: number;
  modelId: string;
  provider: string;
  /** The exact wire body about to be dispatched (recorded by value). */
  body: any;
  requestDigest?: string;
}

export interface LlmRequestEndInfo {
  chatId: string;
  requestId: string;
  status: Exclude<RequestRecordStatus, "in_progress">;
  output?: {
    content?: unknown[];
    stopReason?: string;
    usage?: unknown;
    errorMessage?: string;
  };
  cachedTokens?: number;
  durationMs?: number;
}

export interface LlmRequestEvent {
  type: "start" | "end";
  chatId: string;
  requestId: string;
  turnId?: string;
  iteration?: number;
  modelId?: string;
  timestamp: number;
  messageCount?: number;
  toolCount?: number;
  status?: RequestRecordStatus;
  stopReason?: string;
  promptTokens?: number;
  completionTokens?: number;
  cachedTokens?: number;
  durationMs?: number;
  errorMessage?: string;
}

export interface LlmRequestSummary {
  id: string;
  chatId: string;
  turnId: string | null;
  iteration: number | null;
  timestamp: number;
  modelId: string;
  provider: string;
  purpose: string;
  status: RequestRecordStatus;
  messageCount: number | null;
  toolCount: number | null;
  promptTokens: number | null;
  completionTokens: number | null;
  cachedTokens: number | null;
  durationMs: number | null;
  requestDigest: string | null;
  stopReason: string | null;
  errorMessage: string | null;
}

export interface LlmRequestDetail extends LlmRequestSummary {
  /** Rehydrated wire body: { model, params, messages, tools } or null when the
   *  row predates available blobs (content reclaimed). */
  request: {
    params: Record<string, unknown>;
    messages: Array<Record<string, unknown>>;
    tools: Array<Record<string, unknown>> | null;
    reclaimed: number;
  } | null;
  response: {
    content?: unknown[];
    stopReason?: string;
    usage?: unknown;
    errorMessage?: string;
  } | null;
}

type Row = Record<string, unknown>;

let db: Database.Database | null = null;
let insertCounter = 0;
let warnedOnce = false;

function warnOnce(op: string, err: unknown): void {
  const message = err instanceof Error ? err.message : String(err);
  if (warnedOnce) return;
  warnedOnce = true;
  console.warn(`[request-log] ${op} failed (further failures suppressed): ${message}`);
}

function getDb(): Database.Database {
  if (!db) {
    db = new Database(DB_PATH);
    db.pragma("journal_mode = WAL");
    initSchema(db);
  }
  return db;
}

function initSchema(database: Database.Database): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS llm_requests (
      id TEXT PRIMARY KEY,
      chat_id TEXT NOT NULL,
      turn_id TEXT,
      iteration INTEGER,
      purpose TEXT NOT NULL DEFAULT 'chat',
      timestamp INTEGER NOT NULL,
      model_id TEXT NOT NULL,
      provider TEXT NOT NULL,
      status TEXT NOT NULL,
      message_count INTEGER,
      tool_count INTEGER,
      prompt_tokens INTEGER,
      completion_tokens INTEGER,
      cached_tokens INTEGER,
      duration_ms REAL,
      request_digest TEXT,
      stop_reason TEXT,
      error_message TEXT,
      request_json TEXT,
      response_json TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_llm_requests_chat ON llm_requests(chat_id, timestamp DESC);
    CREATE INDEX IF NOT EXISTS idx_llm_requests_timestamp ON llm_requests(timestamp DESC);

    CREATE TABLE IF NOT EXISTS llm_request_blobs (
      hash TEXT PRIMARY KEY,
      text TEXT NOT NULL
    );
  `);

  // A restart always empties in-flight state: any row still marked
  // in_progress belongs to a turn that will never finalize.
  database.prepare("UPDATE llm_requests SET status = 'aborted' WHERE status = 'in_progress'").run();
}

// ---------------------------------------------------------------------------
// Event listeners (SSE fan-out is wired by routes/chat.ts)
// ---------------------------------------------------------------------------

type RequestEventListener = (event: LlmRequestEvent) => void;
const eventListeners = new Set<RequestEventListener>();

export function onLlmRequestEvent(listener: RequestEventListener): () => void {
  eventListeners.add(listener);
  return () => eventListeners.delete(listener);
}

function emitEvent(event: LlmRequestEvent): void {
  for (const listener of eventListeners) {
    try {
      listener(event);
    } catch (err) {
      warnOnce("event listener", err);
    }
  }
}

// ---------------------------------------------------------------------------
// Blob dedup
// ---------------------------------------------------------------------------

function hashText(text: string): string {
  return createHash("sha1").update(text).digest("hex");
}

function putBlob(database: Database.Database, text: string): string {
  const hash = hashText(text);
  database
    .prepare("INSERT OR IGNORE INTO llm_request_blobs (hash, text) VALUES (?, ?)")
    .run(hash, text);
  return hash;
}

function blobText(database: Database.Database, hash: string): string | null {
  const row = database.prepare("SELECT text FROM llm_request_blobs WHERE hash = ?").get(hash) as
    | { text: string }
    | undefined;
  return row?.text ?? null;
}

/** Collect every blob hash referenced by surviving request rows. */
function collectReferencedHashes(database: Database.Database): Set<string> {
  const used = new Set<string>();
  const rows = database.prepare("SELECT request_json FROM llm_requests WHERE request_json IS NOT NULL").all() as Array<{ request_json: string }>;
  for (const row of rows) {
    try {
      const parsed = JSON.parse(row.request_json);
      for (const ref of parsed?.messageRefs ?? []) used.add(ref);
      if (parsed?.toolsRef) used.add(parsed.toolsRef);
    } catch {
      // Malformed row: its blobs become garbage and get vacuumed. Acceptable.
    }
  }
  return used;
}

function vacuumBlobs(database: Database.Database): void {
  const used = collectReferencedHashes(database);
  const allHashes = database.prepare("SELECT hash FROM llm_request_blobs").all() as Array<{ hash: string }>;
  const del = database.prepare("DELETE FROM llm_request_blobs WHERE hash = ?");
  const removeUnreferenced = database.transaction(() => {
    let removed = 0;
    for (const { hash } of allHashes) {
      if (!used.has(hash)) {
        del.run(hash);
        removed++;
      }
    }
    return removed;
  });
  const removed = removeUnreferenced();
  if (removed > 0) {
    console.log(`[request-log] blob vacuum removed ${removed} unreferenced blob(s)`);
  }
}

function pruneChat(database: Database.Database, chatId: string): void {
  database
    .prepare(
      `DELETE FROM llm_requests
       WHERE chat_id = ?
         AND id NOT IN (
           SELECT id FROM llm_requests
           WHERE chat_id = ?
           ORDER BY timestamp DESC, iteration DESC
           LIMIT ?
         )`
    )
    .run(chatId, chatId, MAX_REQUESTS_PER_CHAT);

  insertCounter++;
  if (insertCounter % BLOB_VACUUM_EVERY === 0) {
    vacuumBlobs(database);
  }
}

// ---------------------------------------------------------------------------
// Recording
// ---------------------------------------------------------------------------

/**
 * Record the dispatch of a chat-turn LLM request. Never throws — recording
 * failures must not affect the turn.
 */
export function recordLlmRequestStart(info: LlmRequestStartInfo): void {
  try {
    const database = getDb();
    const messages = Array.isArray(info.body?.messages) ? info.body.messages : [];
    const tools = Array.isArray(info.body?.tools) && info.body.tools.length > 0 ? info.body.tools : null;

    const messageRefs: string[] = messages.map((message: unknown) => putBlob(database, JSON.stringify(message)));
    const toolsRef = tools ? putBlob(database, JSON.stringify(tools)) : null;

    const params: Record<string, unknown> = { ...(info.body ?? {}) };
    delete params.messages;
    delete params.tools;

    const requestJson = JSON.stringify({ v: 1, params, messageRefs, toolsRef });

    database
      .prepare(
        `INSERT OR REPLACE INTO llm_requests (
           id, chat_id, turn_id, iteration, purpose, timestamp, model_id, provider,
           status, message_count, tool_count, request_digest, request_json
         ) VALUES (@id, @chatId, @turnId, @iteration, 'chat', @timestamp, @modelId, @provider,
           'in_progress', @messageCount, @toolCount, @requestDigest, @requestJson)`
      )
      .run({
        id: info.requestId,
        chatId: info.chatId,
        turnId: info.turnId ?? null,
        iteration: info.iteration ?? null,
        timestamp: Date.now(),
        modelId: info.modelId,
        provider: info.provider,
        messageCount: messages.length,
        toolCount: tools?.length ?? 0,
        requestDigest: info.requestDigest ?? null,
        requestJson,
      });

    pruneChat(database, info.chatId);

    emitEvent({
      type: "start",
      chatId: info.chatId,
      requestId: info.requestId,
      turnId: info.turnId,
      iteration: info.iteration,
      modelId: info.modelId,
      timestamp: Date.now(),
      messageCount: messages.length,
      toolCount: tools?.length ?? 0,
    });
  } catch (err) {
    warnOnce("record start", err);
  }
}

/**
 * Record the finalization of a chat-turn LLM request. Never throws.
 */
export function recordLlmRequestEnd(info: LlmRequestEndInfo): void {
  try {
    const database = getDb();
    const output = info.output ?? {};
    const usage = output.usage as
      | { input?: number; output?: number; cacheRead?: number }
      | undefined;
    const responseJson = output
      ? JSON.stringify({
          content: output.content ?? [],
          stopReason: output.stopReason,
          usage: output.usage,
          errorMessage: output.errorMessage,
        })
      : null;

    const result = database
      .prepare(
        `UPDATE llm_requests
         SET status = @status, response_json = @responseJson, stop_reason = @stopReason,
             error_message = @errorMessage, prompt_tokens = @promptTokens,
             completion_tokens = @completionTokens, cached_tokens = @cachedTokens,
             duration_ms = @durationMs
         WHERE id = @id`
      )
      .run({
        id: info.requestId,
        status: info.status,
        responseJson,
        stopReason: output.stopReason ?? null,
        errorMessage: output.errorMessage ?? null,
        promptTokens: usage?.input ?? null,
        completionTokens: usage?.output ?? null,
        cachedTokens: info.cachedTokens ?? usage?.cacheRead ?? null,
        durationMs: info.durationMs ?? null,
      });
    if (result.changes === 0) {
      // Row was pruned mid-flight (or lost to a restart) — nothing to update.
      return;
    }

    const existing = database
      .prepare("SELECT turn_id, iteration, model_id, timestamp FROM llm_requests WHERE id = ?")
      .get(info.requestId) as Row | undefined;

    emitEvent({
      type: "end",
      chatId: info.chatId,
      requestId: info.requestId,
      turnId: typeof existing?.turn_id === "string" ? existing.turn_id : undefined,
      iteration: typeof existing?.iteration === "number" ? existing.iteration : undefined,
      modelId: typeof existing?.model_id === "string" ? existing.model_id : undefined,
      timestamp: Date.now(),
      status: info.status,
      stopReason: output.stopReason,
      promptTokens: usage?.input,
      completionTokens: usage?.output,
      cachedTokens: info.cachedTokens ?? usage?.cacheRead,
      durationMs: info.durationMs,
      errorMessage: output.errorMessage,
    });
  } catch (err) {
    warnOnce("record end", err);
  }
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

function rowToSummary(row: Row): LlmRequestSummary {
  return {
    id: String(row.id),
    chatId: String(row.chat_id),
    turnId: (row.turn_id as string | null) ?? null,
    iteration: (row.iteration as number | null) ?? null,
    timestamp: Number(row.timestamp),
    modelId: String(row.model_id),
    provider: String(row.provider),
    purpose: String(row.purpose),
    status: row.status as RequestRecordStatus,
    messageCount: (row.message_count as number | null) ?? null,
    toolCount: (row.tool_count as number | null) ?? null,
    promptTokens: (row.prompt_tokens as number | null) ?? null,
    completionTokens: (row.completion_tokens as number | null) ?? null,
    cachedTokens: (row.cached_tokens as number | null) ?? null,
    durationMs: (row.duration_ms as number | null) ?? null,
    requestDigest: (row.request_digest as string | null) ?? null,
    stopReason: (row.stop_reason as string | null) ?? null,
    errorMessage: (row.error_message as string | null) ?? null,
  };
}

export function listLlmRequests(chatId: string, limit = MAX_REQUESTS_PER_CHAT): LlmRequestSummary[] {
  const database = getDb();
  const rows = database
    .prepare(
      `SELECT id, chat_id, turn_id, iteration, purpose, timestamp, model_id, provider,
              status, message_count, tool_count, prompt_tokens, completion_tokens,
              cached_tokens, duration_ms, request_digest, stop_reason, error_message
       FROM llm_requests WHERE chat_id = ?
       ORDER BY timestamp DESC, iteration DESC LIMIT ?`
    )
    .all(chatId, Math.max(1, Math.min(limit, MAX_REQUESTS_PER_CHAT))) as Row[];
  return rows.map(rowToSummary);
}

export function getLlmRequestDetail(id: string): LlmRequestDetail | null {
  const database = getDb();
  const row = database
    .prepare(
      `SELECT id, chat_id, turn_id, iteration, purpose, timestamp, model_id, provider,
              status, message_count, tool_count, prompt_tokens, completion_tokens,
              cached_tokens, duration_ms, request_digest, stop_reason, error_message,
              request_json, response_json
       FROM llm_requests WHERE id = ?`
    )
    .get(id) as Row | undefined;
  if (!row) return null;

  let request: LlmRequestDetail["request"] = null;
  if (row.request_json) {
    try {
      const parsed = JSON.parse(String(row.request_json));
      const messages: Array<Record<string, unknown>> = [];
      let reclaimed = 0;
      for (const ref of parsed.messageRefs ?? []) {
        const text = blobText(database, ref);
        if (text === null) {
          messages.push({ role: "unknown", content: "[content reclaimed by storage retention]" });
          reclaimed++;
        } else {
          messages.push(JSON.parse(text));
        }
      }
      let tools: Array<Record<string, unknown>> | null = null;
      if (parsed.toolsRef) {
        const toolsText = blobText(database, parsed.toolsRef);
        tools = toolsText ? JSON.parse(toolsText) : null;
        if (!toolsText) reclaimed++;
      }
      request = { params: parsed.params ?? {}, messages, tools, reclaimed };
    } catch {
      request = null;
    }
  }

  let response: LlmRequestDetail["response"] = null;
  if (row.response_json) {
    try {
      response = JSON.parse(String(row.response_json));
    } catch {
      response = null;
    }
  }

  return { ...rowToSummary(row), request, response };
}

export function clearLlmRequests(chatId: string): number {
  const database = getDb();
  const result = database.prepare("DELETE FROM llm_requests WHERE chat_id = ?").run(chatId);
  vacuumBlobs(database);
  return result.changes;
}

/**
 * The system prompt of the most recently recorded request for a chat — the
 * persisted counterpart of the in-memory prompt cache, so the Context tab
 * survives server restarts (fixes the old `cached:false` cold-cache gap).
 */
export function getLatestRecordedSystemPrompt(chatId: string): string | null {
  const database = getDb();
  const row = database
    .prepare("SELECT request_json FROM llm_requests WHERE chat_id = ? ORDER BY timestamp DESC, iteration DESC LIMIT 1")
    .get(chatId) as { request_json: string | null } | undefined;
  if (!row?.request_json) return null;
  try {
    const parsed = JSON.parse(row.request_json);
    const firstRef = parsed.messageRefs?.[0];
    if (!firstRef) return null;
    const text = blobText(database, firstRef);
    if (!text) return null;
    const message = JSON.parse(text);
    if (message?.role !== "system") return null;
    if (typeof message.content === "string") return message.content;
    if (Array.isArray(message.content)) {
      return message.content
        .map((part: any) => (typeof part?.text === "string" ? part.text : ""))
        .join("");
    }
    return null;
  } catch {
    return null;
  }
}
