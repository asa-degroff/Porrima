import { cancelQueuedWarms } from "./cache-warm-queue.js";
import { endLiveStream, liveStreams } from "./live-streams.js";
import { markChatInactive } from "./memory-extraction.js";
import * as messageQueue from "./message-queue.js";
import { resetMemoryContext } from "./memory-context.js";

/**
 * Clear process-local work that can continue after the chat row is deleted.
 * Persistence cleanup stays in chat-storage.deleteChat(); this handles active
 * streams, queued follow-ups, cache warm jobs, and prompt/memory state.
 */
export async function cancelDeletedChatWork(chatId: string): Promise<void> {
  const stream = liveStreams.get(chatId);
  if (stream && !stream.abort.signal.aborted) {
    stream.abort.abort(new Error("Chat deleted"));
  }
  if (stream && !stream.ended) {
    endLiveStream(chatId);
  }

  await messageQueue.clear(chatId);
  cancelQueuedWarms(chatId);
  resetMemoryContext(chatId);
  markChatInactive(chatId);
}
