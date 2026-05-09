import { createHash } from "crypto";

type PromptKind = "warm" | "chat";

interface PromptSnapshot {
  chatId: string;
  kind: PromptKind;
  modelId: string;
  payloadDigest: string;
  promptDigest: string;
  promptChars: number;
  prompt: string;
  messageCount: number;
  requestChars: number;
  createdAt: number;
}

const recentWarmPrompts = new Map<string, PromptSnapshot>();

export function digestPromptText(prompt: string): string {
  return createHash("sha1")
    .update(prompt)
    .digest("hex")
    .slice(0, 12);
}

function compactSnippet(value: string, center: number, radius = 120): string {
  const start = Math.max(0, center - radius);
  const end = Math.min(value.length, center + radius);
  return value
    .slice(start, end)
    .replace(/\r/g, "\\r")
    .replace(/\n/g, "\\n")
    .replace(/\t/g, "\\t");
}

function firstDiffIndex(a: string, b: string): number {
  const len = Math.min(a.length, b.length);
  for (let i = 0; i < len; i++) {
    if (a.charCodeAt(i) !== b.charCodeAt(i)) return i;
  }
  return a.length === b.length ? -1 : len;
}

function snapshotSummary(snapshot: PromptSnapshot): string {
  return (
    `kind=${snapshot.kind} model=${snapshot.modelId} ` +
    `payload=${snapshot.payloadDigest} prompt=${snapshot.promptDigest} ` +
    `chars=${snapshot.promptChars} messages=${snapshot.messageCount} req_chars=${snapshot.requestChars}`
  );
}

export function recordWarmPromptSnapshot(input: Omit<PromptSnapshot, "kind" | "createdAt">): void {
  const snapshot: PromptSnapshot = {
    ...input,
    kind: "warm",
    createdAt: Date.now(),
  };
  recentWarmPrompts.set(input.chatId, snapshot);
  console.log(`[prompt-debug] chat=${input.chatId} warm ${snapshotSummary(snapshot)}`);
}

export function compareWithWarmPrompt(input: Omit<PromptSnapshot, "kind" | "createdAt">): void {
  const current: PromptSnapshot = {
    ...input,
    kind: "chat",
    createdAt: Date.now(),
  };
  const warm = recentWarmPrompts.get(input.chatId);
  if (!warm) {
    console.log(`[prompt-debug] chat=${input.chatId} chat ${snapshotSummary(current)} warm=missing`);
    return;
  }

  if (warm.promptDigest === current.promptDigest) {
    console.log(
      `[prompt-debug] chat=${input.chatId} chat ${snapshotSummary(current)} ` +
      `warm_prompt=${warm.promptDigest} match=true`,
    );
    return;
  }

  const diff = firstDiffIndex(warm.prompt, current.prompt);
  const warmChar = diff >= 0 && diff < warm.prompt.length ? JSON.stringify(warm.prompt[diff]) : "<eof>";
  const chatChar = diff >= 0 && diff < current.prompt.length ? JSON.stringify(current.prompt[diff]) : "<eof>";
  console.warn(
    `[prompt-debug] chat=${input.chatId} prompt mismatch ` +
    `warm{${snapshotSummary(warm)}} chat{${snapshotSummary(current)}} ` +
    `first_diff=${diff} warm_char=${warmChar} chat_char=${chatChar}`,
  );
  if (diff >= 0) {
    console.warn(`[prompt-debug] chat=${input.chatId} warm excerpt: ${compactSnippet(warm.prompt, diff)}`);
    console.warn(`[prompt-debug] chat=${input.chatId} chat excerpt: ${compactSnippet(current.prompt, diff)}`);
  }
}
