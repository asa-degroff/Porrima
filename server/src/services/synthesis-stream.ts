import type {
  Artifact,
  ChatMessage,
  ChatToolCall,
  ChatToolResult,
  InlineVisual,
  MessageUsage,
  TurnResyncPayload,
} from "../types.js";
import {
  type LiveStream,
  emitToStream,
  endLiveStreamIfCurrent,
  installHeadlessLiveStream,
} from "./live-streams.js";

// ---------------------------------------------------------------------------
// Synthesis SSE emitter
//
// Wraps a headless LiveStream with typed emit methods that mirror the SSE
// frame format used by the regular chat route (see server/src/routes/chat.ts).
// Clients that open the system chat reconnect to the underlying LiveStream via
// /api/chat/reconnect/:chatId and consume the same event stream that a normal
// chat turn would produce, so synthesis output renders with full streaming
// support — text deltas, thinking deltas, tool calls + results, and segments
// for interleaved display.
// ---------------------------------------------------------------------------

export interface OutputSegment {
  seq: number;
  type: "text" | "tool_call" | "tool_result" | "artifact" | "visual";
  content?: string;
  toolCall?: ChatToolCall;
  toolResult?: ChatToolResult;
  artifact?: Artifact;
  visual?: InlineVisual;
}

export interface SynthesisStreamState {
  fullText: string;
  thinkingText: string;
  toolCalls: ChatToolCall[];
  toolResults: ChatToolResult[];
  artifacts: Artifact[];
  visuals: InlineVisual[];
  segments: OutputSegment[];
  seqCounter: number;
  pendingText: string;
  /** Most recent model usage report, refreshed every iteration. */
  finalUsage?: MessageUsage;
}

// ---------------------------------------------------------------------------
// Live-only preview frames
//
// Shared by the HTTP chat route (chat.ts) and the headless runner
// (chat-turn-runner.ts) so in-flight preview frames cannot drift between the
// transports. All of these are live-only: never persisted, never replayed,
// never entered into the model context — the final tool result carries the
// authoritative output.
// ---------------------------------------------------------------------------

/**
 * Text from a streaming tool update (`tool_execution_update.partialResult`),
 * joined across text items. Mirrors the HTTP route's extraction so both
 * transports render the same view.
 */
export function partialToolText(partialResult: any): string {
  const content = partialResult?.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((item: any) => item?.type === "text" && typeof item.text === "string")
    .map((item: any) => item.text)
    .join("");
}

/** SSE frame for one in-flight tool update. */
export function toolPartialFrame(toolCallId: string, name: string, text: string): string {
  return `event: tool_partial\ndata: ${JSON.stringify({ toolCallId, name, text })}\n\n`;
}

/** SSE frame for the start of a streamed tool-call argument block. */
export function toolCallStartFrame(index: number, name: string, id?: string): string {
  return `event: tool_call_start\ndata: ${JSON.stringify({ index, name, id })}\n\n`;
}

/** SSE frame for one streamed tool-call argument delta. */
export function toolCallDeltaFrame(index: number, delta: string): string {
  return `event: tool_call_delta\ndata: ${JSON.stringify({ index, delta })}\n\n`;
}

export class SynthesisEmitter {
  readonly stream: LiveStream;
  readonly state: SynthesisStreamState;
  private keepaliveInterval: NodeJS.Timeout | null = null;
  /** Last emitted iteration event — resync snapshot for the token indicator. */
  private lastIteration: TurnResyncPayload["iteration"] | null = null;

  constructor(chatId: string) {
    this.stream = installHeadlessLiveStream(chatId);
    this.state = {
      fullText: "",
      thinkingText: "",
      toolCalls: [],
      toolResults: [],
      artifacts: [],
      visuals: [],
      segments: [],
      seqCounter: 0,
      pendingText: "",
      finalUsage: undefined,
    };
    // Resync on attach: headless runs persist nothing until the end, so the
    // whole accumulated state IS the uncommitted tail — a client attaching
    // via /reconnect hydrates from this snapshot.
    this.stream.buildResync = () => this.buildResyncPayload();
    // Emit a connected comment so reconnecting clients see something on
    // attach. Matches the regular chat ensureSSEStream behavior.
    this.write(`: connected\n\n`);
    // Periodic keepalive comments prevent the client's 95s inactivity timer
    // from firing during long silent gaps (model load, big tool execution).
    this.keepaliveInterval = setInterval(() => {
      this.write(`: keepalive\n\n`);
    }, 10_000);
  }

  private write(chunk: string): void {
    emitToStream(this.stream, chunk);
  }

  private writeEvent(event: string, data: unknown): void {
    this.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  }

  /** Emit a single text delta to subscribers and accumulate it. */
  emitTextDelta(delta: string): void {
    if (!delta) return;
    this.state.fullText += delta;
    this.state.pendingText += delta;
    this.writeEvent("text_delta", { delta });
  }

  /** Emit a single thinking delta. */
  emitThinkingDelta(delta: string): void {
    if (!delta) return;
    this.state.thinkingText += delta;
    this.writeEvent("thinking_delta", { delta });
  }

  /** Streamed tool-call argument block start (live preview only). */
  emitToolCallStart(index: number, name: string, id?: string): void {
    this.write(toolCallStartFrame(index, name, id || undefined));
  }

  /** Streamed tool-call argument delta (live preview only). */
  emitToolCallDelta(index: number, delta: string): void {
    if (!delta) return;
    this.write(toolCallDeltaFrame(index, delta));
  }

  /**
   * Forward one in-flight tool output update — e.g. bash's streaming view or
   * a Python kernel cell's stdout so far (live preview only; the final tool
   * result carries the full output).
   */
  emitToolPartial(toolCallId: string, name: string, text: string): void {
    if (!text) return;
    this.write(toolPartialFrame(toolCallId, name, text));
  }

  /**
   * Flush any accumulated pendingText into a finalized segment. Called when a
   * tool call interrupts the text stream so the segment ordering reflects the
   * interleaving the user actually saw.
   */
  flushPendingText(): void {
    if (this.state.pendingText.trim().length === 0) {
      this.state.pendingText = "";
      return;
    }
    this.state.segments.push({
      seq: ++this.state.seqCounter,
      type: "text",
      content: this.state.pendingText,
    });
    this.state.pendingText = "";
  }

  /**
   * Emit a tool_call segment + tool_status running. Call this when the agent
   * has produced a tool call but execution hasn't started yet.
   */
  emitToolCall(toolCall: ChatToolCall): void {
    this.flushPendingText();
    this.state.toolCalls.push(toolCall);
    const segment: OutputSegment = {
      seq: ++this.state.seqCounter,
      type: "tool_call",
      toolCall,
    };
    this.state.segments.push(segment);
    this.writeEvent("segment", segment);
    this.writeEvent("tool_status", { name: toolCall.name, status: "running" });
  }

  /**
   * Emit a tool_result segment + tool_status done|error. The result segment
   * is inserted directly after its matching tool_call segment so visual /
   * artifact / image segments emitted during the tool's run stay after the
   * call/result pair (matching regular chat layout).
   */
  emitToolResult(toolResult: ChatToolResult): void {
    this.state.toolResults.push(toolResult);
    const callIdx = this.state.segments.findIndex(
      (s) => s.type === "tool_call" && s.toolCall?.id === toolResult.toolCallId,
    );
    const segment: OutputSegment = {
      seq: ++this.state.seqCounter,
      type: "tool_result",
      toolResult,
    };
    if (callIdx >= 0) {
      this.state.segments.splice(callIdx + 1, 0, segment);
    } else {
      this.state.segments.push(segment);
    }
    this.writeEvent("segment", segment);
    this.writeEvent("tool_status", {
      name: toolResult.toolName,
      status: toolResult.isError ? "error" : "done",
      result: toolResult.content,
    });
  }

  emitArtifact(artifact: Artifact): void {
    this.state.artifacts.push(artifact);
    this.state.segments.push({
      seq: ++this.state.seqCounter,
      type: "artifact",
      artifact,
    });
    this.writeEvent("artifact", artifact);
  }

  emitVisual(visual: InlineVisual): void {
    this.state.visuals.push(visual);
    this.state.segments.push({
      seq: ++this.state.seqCounter,
      type: "visual",
      visual,
    });
    this.writeEvent("visual", visual);
  }

  /**
   * Per-iteration update with usage + estimate. The client's TokenIndicator
   * reads this to update the bar mid-loop.
   */
  emitIteration(info: {
    iteration: number;
    stopReason?: string;
    toolCount?: number;
    usage?: MessageUsage;
    estimatedTokens?: number;
  }): void {
    this.lastIteration = {
      iteration: info.iteration,
      stopReason: info.stopReason ?? "stop",
      toolCount: info.toolCount ?? 0,
      usage: info.usage,
      estimatedTokens: info.estimatedTokens,
    };
    this.writeEvent("iteration", info);
  }

  emitTitleUpdate(title: string): void {
    this.writeEvent("title_update", { chatId: this.stream.chatId, title });
  }

  emitWarning(warning: { type: string; message: string }): void {
    this.writeEvent("warning", warning);
  }

  /**
   * After all phases complete and the assistant message has been persisted,
   * emit `done` so reconnected clients close their stream cleanly. Matches
   * the regular chat route's terminal event.
   */
  emitDone(message: ChatMessage, iterations: number): void {
    this.flushPendingText();
    this.writeEvent("done", { message, iterations });
  }

  /**
   * Emit an error event before closing. Without this, an early-exit `end()`
   * looks to the client like an abrupt disconnect — its inactivity check
   * surfaces "Connection lost — no response received from model" which
   * misattributes failures like "no model available" or "system chat not
   * found". Mirrors the regular chat route's `event: error` shape.
   */
  emitError(message: string): void {
    this.writeEvent("error", { error: message });
  }

  /**
   * Build the final ChatMessage that gets persisted to chat history. Mirrors
   * buildCurrentAssistantMessage() in the regular chat route.
   */
  buildAssistantMessage(thinking: string, summary: string): ChatMessage {
    this.flushPendingText();
    return {
      role: "assistant",
      content: summary,
      thinking: thinking || undefined,
      usage: this.state.finalUsage,
      toolCalls: this.state.toolCalls.length > 0 ? this.state.toolCalls : undefined,
      toolResults: this.state.toolResults.length > 0 ? this.state.toolResults : undefined,
      artifacts: this.state.artifacts.length > 0 ? this.state.artifacts : undefined,
      visuals: this.state.visuals.length > 0 ? this.state.visuals : undefined,
      segments: this.state.segments.length > 0 ? this.state.segments : undefined,
      timestamp: Date.now(),
      _isSystemMessage: true,
    };
  }

  /**
   * Update the most-recent usage. Called once per model iteration.
   *
   * The zero-totalTokens guard is intentional: some providers (and some
   * thinking-only outputs that bail before producing tokens) report a usage
   * object full of zeros. Overwriting a real prior count with zeros would
   * blank the TokenIndicator mid-loop. Better to keep the last known good
   * count until a real usage report lands.
   */
  setUsage(usage: MessageUsage | undefined): void {
    if (!usage) return;
    if (usage.totalTokens > 0) {
      this.state.finalUsage = usage;
    }
  }

  /**
   * Resync snapshot for clients attaching via /chat/reconnect. Headless runs
   * persist nothing until the end, so the entire accumulated state is the
   * uncommitted tail. Non-mutating: reads pendingText instead of flushing it
   * so the live segment stream keeps its boundaries. Installed on the
   * LiveStream in the constructor.
   */
  private buildResyncPayload(): TurnResyncPayload {
    const s = this.state;
    const segments: OutputSegment[] = s.segments.map((seg) => ({ ...seg }));
    if (s.pendingText.trim()) {
      segments.push({ seq: s.seqCounter + 1, type: "text", content: s.pendingText });
    }
    const hasActivity =
      !!s.fullText ||
      !!s.thinkingText ||
      s.toolCalls.length > 0 ||
      s.artifacts.length > 0 ||
      s.visuals.length > 0 ||
      segments.length > 0;
    const message: ChatMessage | null = hasActivity
      ? {
          role: "assistant",
          content: s.fullText,
          thinking: s.thinkingText || undefined,
          usage: s.finalUsage,
          toolCalls: s.toolCalls.length > 0 ? s.toolCalls : undefined,
          toolResults: s.toolResults.length > 0 ? s.toolResults : undefined,
          artifacts: s.artifacts.length > 0 ? s.artifacts : undefined,
          visuals: s.visuals.length > 0 ? s.visuals : undefined,
          segments: segments.length > 0 ? segments : undefined,
          timestamp: Date.now(),
          _isSystemMessage: true,
        }
      : null;
    return {
      message,
      iteration: this.lastIteration ? { ...this.lastIteration } : undefined,
      modelProgress: null,
    };
  }

  /**
   * Close the underlying live stream. Always call this — even on error — so
   * subscribers see EOF and the registry cleans up. Ownership-guarded: if a
   * user turn has since replaced this headless stream for the same chat,
   * this teardown is a no-op for the newer turn's stream.
   */
  end(): void {
    if (this.keepaliveInterval) {
      clearInterval(this.keepaliveInterval);
      this.keepaliveInterval = null;
    }
    endLiveStreamIfCurrent(this.stream);
  }
}

// ---------------------------------------------------------------------------
// Side-effects factory
//
// Both runSystemSynthesis and runWakeCycle wire the same ToolSideEffects
// pattern: each artifact / visual / generated image needs to be pushed into a
// local accumulator (so the SynthesisResult return value carries it) AND
// emitted to the live stream (so reconnected clients see segments in real
// time). This helper centralizes the dual-write so a third caller can adopt
// the same pattern without copy-paste drift.
// ---------------------------------------------------------------------------

export interface EffectBuckets {
  artifacts: Artifact[];
  visuals: InlineVisual[];
}

export function createEmitterSideEffects(
  emitter: SynthesisEmitter,
  buckets: EffectBuckets,
): {
  onArtifact: (a: Artifact) => void;
  onVisual: (v: InlineVisual) => void;
  onPendingReviewImage: () => void;
  onAskUser: () => void;
} {
  return {
    onArtifact: (a) => {
      buckets.artifacts.push(a);
      emitter.emitArtifact(a);
    },
    onVisual: (v) => {
      buckets.visuals.push(v);
      emitter.emitVisual(v);
    },
    onPendingReviewImage: () => {},
    onAskUser: () => {},
  };
}
