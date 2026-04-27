import type {
  ChatMessage,
  ChatToolCall,
  ChatToolResult,
  Artifact,
  GeneratedImage,
  InlineVisual,
  MessageUsage,
} from "../types.js";
import {
  type LiveStream,
  emitToStream,
  endLiveStream,
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
  type: "text" | "tool_call" | "tool_result" | "artifact" | "generated_image" | "visual";
  content?: string;
  toolCall?: ChatToolCall;
  toolResult?: ChatToolResult;
  artifact?: Artifact;
  generatedImage?: GeneratedImage;
  visual?: InlineVisual;
}

export interface SynthesisStreamState {
  fullText: string;
  thinkingText: string;
  toolCalls: ChatToolCall[];
  toolResults: ChatToolResult[];
  artifacts: Artifact[];
  visuals: InlineVisual[];
  generatedImages: GeneratedImage[];
  segments: OutputSegment[];
  seqCounter: number;
  pendingText: string;
  /** Most recent usage from a streamChat result — refreshed every iteration. */
  finalUsage?: MessageUsage;
}

export class SynthesisEmitter {
  readonly stream: LiveStream;
  readonly state: SynthesisStreamState;
  private keepaliveInterval: NodeJS.Timeout | null = null;

  constructor(chatId: string) {
    this.stream = installHeadlessLiveStream(chatId);
    this.state = {
      fullText: "",
      thinkingText: "",
      toolCalls: [],
      toolResults: [],
      artifacts: [],
      visuals: [],
      generatedImages: [],
      segments: [],
      seqCounter: 0,
      pendingText: "",
      finalUsage: undefined,
    };
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

  emitGeneratedImage(image: GeneratedImage): void {
    this.state.generatedImages.push(image);
    this.state.segments.push({
      seq: ++this.state.seqCounter,
      type: "generated_image",
      generatedImage: image,
    });
    this.writeEvent("generated_image", image);
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
    this.writeEvent("iteration", info);
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
      generatedImages:
        this.state.generatedImages.length > 0 ? this.state.generatedImages : undefined,
      segments: this.state.segments.length > 0 ? this.state.segments : undefined,
      timestamp: Date.now(),
      _isSystemMessage: true,
    };
  }

  /**
   * Update the most-recent usage. Called once per streamChat iteration.
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
   * Close the underlying live stream. Always call this — even on error — so
   * subscribers see EOF and the registry cleans up. It's safe to call multiple
   * times; endLiveStream is idempotent.
   */
  end(): void {
    if (this.keepaliveInterval) {
      clearInterval(this.keepaliveInterval);
      this.keepaliveInterval = null;
    }
    endLiveStream(this.stream.chatId);
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
  generatedImages: GeneratedImage[];
}

export function createEmitterSideEffects(
  emitter: SynthesisEmitter,
  buckets: EffectBuckets,
): {
  onArtifact: (a: Artifact) => void;
  onVisual: (v: InlineVisual) => void;
  onGeneratedImage: (img: GeneratedImage) => void;
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
    onGeneratedImage: (img) => {
      buckets.generatedImages.push(img);
      emitter.emitGeneratedImage(img);
    },
    onPendingReviewImage: () => {},
    onAskUser: () => {},
  };
}
