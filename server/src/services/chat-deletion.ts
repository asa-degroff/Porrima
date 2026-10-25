import { closeBrowserSession } from "./browser-session.js";
import { cancelQueuedWarms } from "./cache-warm-queue.js";
import { endLiveStream, liveStreams } from "./live-streams.js";
import { cancelImmediateExtractionQueue, markChatInactive } from "./memory-extraction.js";
import * as messageQueue from "./message-queue.js";
import { resetMemoryContext } from "./memory-context.js";
import { cleanupChat } from "./tool-output-store.js";
import { clearLlmRequests } from "./request-log.js";
import { invalidateKvSnapshot } from "./kv-snapshot.js";
import { disposeKernel } from "./python-kernel.js";
import { deleteChatSupervisorOutputs, stopChatSupervisorJobs } from "./job-runtime.js";
import { setNoticesSuppressedForChat } from "./job-view.js";

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
  cancelImmediateExtractionQueue(chatId);
  resetMemoryContext(chatId);
  markChatInactive(chatId);
  await closeBrowserSession(chatId).catch(() => {});
  await cleanupChat(chatId).catch(() => {});
  // No completion notice may outlive the chat that owns it.
  setNoticesSuppressedForChat(chatId);
  await disposeKernel(chatId, { removeState: true }).catch(() => {});
  // Supervisor-owned commands/services are a separate process plane: stop the
  // groups, then mark their view rows (chat-deleted). A missing supervisor
  // marks the rows lost instead of pretending they stopped.
  await stopChatSupervisorJobs(chatId).catch(() => {});
  // Job output is chat-owned data. The supervisor keeps the ledger rows for
  // audit but drops the files once no live group or journal hold remains.
  await deleteChatSupervisorOutputs(chatId).catch(() => {});
  // porrima.db side of the ledger: drop this chat's recorded LLM requests.
  clearLlmRequests(chatId);
  // ...and its parked KV snapshot + file (docs/design/kv-snapshot-parking.md).
  await invalidateKvSnapshot(chatId, "chat-deleted").catch(() => {});
}
