import type { Api, AssistantMessage, Message, Model, ToolCall } from "@earendil-works/pi-ai";

const NON_VISION_USER_IMAGE_PLACEHOLDER = "(image omitted: model does not support images)";
const NON_VISION_TOOL_IMAGE_PLACEHOLDER = "(tool image omitted: model does not support images)";

function replaceImagesWithPlaceholder<T extends Array<{ type: string; text?: string }>>(
  content: T,
  placeholder: string
): T {
  const result: Array<T[number]> = [];
  let previousWasPlaceholder = false;

  for (const block of content) {
    if (block.type === "image") {
      if (!previousWasPlaceholder) {
        result.push({ type: "text", text: placeholder } as T[number]);
      }
      previousWasPlaceholder = true;
      continue;
    }

    result.push(block);
    previousWasPlaceholder = block.text === placeholder;
  }

  return result as T;
}

function downgradeUnsupportedImages(messages: Message[], model: Model<Api>): Message[] {
  if (model.input.includes("image")) {
    return messages;
  }

  return messages.map((msg) => {
    if (msg.role === "user" && Array.isArray(msg.content)) {
      return {
        ...msg,
        content: replaceImagesWithPlaceholder(msg.content, NON_VISION_USER_IMAGE_PLACEHOLDER),
      };
    }

    if (msg.role === "toolResult") {
      return {
        ...msg,
        content: replaceImagesWithPlaceholder(msg.content, NON_VISION_TOOL_IMAGE_PLACEHOLDER),
      };
    }

    return msg;
  });
}

/**
 * Local copy of pi-ai's message normalization behavior.
 *
 * The package no longer exports this helper as a public subpath, but the custom
 * OpenAI-compatible provider still needs the same replay cleanup before it
 * serializes messages into llama.cpp chat-completions format.
 */
export function transformMessagesForProvider<TApi extends Api>(
  messages: Message[],
  model: Model<TApi>,
  normalizeToolCallId?: (id: string, model: Model<TApi>, source: AssistantMessage) => string
): Message[] {
  const toolCallIdMap = new Map<string, string>();
  const imageAwareMessages = downgradeUnsupportedImages(messages, model as Model<Api>);

  const transformed = imageAwareMessages.map((msg) => {
    if (msg.role === "user") {
      return msg;
    }

    if (msg.role === "toolResult") {
      const normalizedId = toolCallIdMap.get(msg.toolCallId);
      if (normalizedId && normalizedId !== msg.toolCallId) {
        return { ...msg, toolCallId: normalizedId };
      }
      return msg;
    }

    if (msg.role === "assistant") {
      const isSameModel =
        msg.provider === model.provider &&
        msg.api === model.api &&
        msg.model === model.id;

      const transformedContent = msg.content.flatMap((block) => {
        if (block.type === "thinking") {
          if (block.redacted) {
            return isSameModel ? block : [];
          }
          if (isSameModel && block.thinkingSignature) {
            return block;
          }
          if (!block.thinking || block.thinking.trim() === "") {
            return [];
          }
          if (isSameModel) {
            return block;
          }
          return {
            type: "text" as const,
            text: block.thinking,
          };
        }

        if (block.type === "text") {
          if (isSameModel) {
            return block;
          }
          return {
            type: "text" as const,
            text: block.text,
          };
        }

        if (block.type === "toolCall") {
          let normalizedToolCall: ToolCall = block;
          if (!isSameModel && block.thoughtSignature) {
            normalizedToolCall = { ...block };
            delete normalizedToolCall.thoughtSignature;
          }

          if (!isSameModel && normalizeToolCallId) {
            const normalizedId = normalizeToolCallId(block.id, model, msg);
            if (normalizedId !== block.id) {
              toolCallIdMap.set(block.id, normalizedId);
              normalizedToolCall = { ...normalizedToolCall, id: normalizedId };
            }
          }

          return normalizedToolCall;
        }

        return block;
      });

      return {
        ...msg,
        content: transformedContent,
      };
    }

    return msg;
  });

  const result: Message[] = [];
  let pendingToolCalls: ToolCall[] = [];
  let existingToolResultIds = new Set<string>();

  const insertSyntheticToolResults = () => {
    if (pendingToolCalls.length === 0) {
      return;
    }

    for (const toolCall of pendingToolCalls) {
      if (!existingToolResultIds.has(toolCall.id)) {
        result.push({
          role: "toolResult",
          toolCallId: toolCall.id,
          toolName: toolCall.name,
          content: [{ type: "text", text: "No result provided" }],
          isError: true,
          timestamp: Date.now(),
        });
      }
    }

    pendingToolCalls = [];
    existingToolResultIds = new Set();
  };

  for (const msg of transformed) {
    if (msg.role === "assistant") {
      insertSyntheticToolResults();

      if (msg.stopReason === "error" || msg.stopReason === "aborted") {
        continue;
      }

      const toolCalls = msg.content.filter((block): block is ToolCall => block.type === "toolCall");
      if (toolCalls.length > 0) {
        pendingToolCalls = toolCalls;
        existingToolResultIds = new Set();
      }

      result.push(msg);
    } else if (msg.role === "toolResult") {
      existingToolResultIds.add(msg.toolCallId);
      result.push(msg);
    } else if (msg.role === "user") {
      insertSyntheticToolResults();
      result.push(msg);
    } else {
      result.push(msg);
    }
  }

  insertSyntheticToolResults();
  return result;
}

export function sanitizeSurrogates(text: string): string {
  return text.replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, "");
}

const PROVIDER_UNSAFE_CONTROL_CHARS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g;

// When an mmproj (vision projector) is loaded, llama.cpp's mtmd tokenizer
// treats these media placeholder tokens as image anchors in the rendered
// prompt. If one appears as literal text — e.g. a tool result that dumped a
// Qwen chat template containing `<|vision_start|><|image_pad|><|vision_end|>`
// — the request fails hard with "number of media markers in text (N) exceeds
// number of bitmaps (0)" before generating anything. Strip them from all
// provider-bound text; real images are attached as image_url parts and the
// template inserts the markers itself at render time.
const PROVIDER_MEDIA_MARKERS = /<\|vision_start\|>|<\|vision_end\|>|<\|(?:image|video|audio)_pad\|>|<__(?:image|video|audio)__>/g;

export function sanitizeProviderText(text: string): string {
  return sanitizeSurrogates(text)
    .replace(PROVIDER_UNSAFE_CONTROL_CHARS, "")
    .replace(PROVIDER_MEDIA_MARKERS, "");
}
