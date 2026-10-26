import { withHeadlessAskUser } from "./headless-tools.js";
import { buildSkillAugmentedPrompt, discoverSkills, type Skill } from "./skills.js";
import { getChat, getProject, getSettings, saveChat } from "./chat-storage.js";
import { createPiModelFromProvider, discoverAllModels } from "./models.js";
import { getAgentTools } from "./agent-tools.js";
import {
  COMPACTION_TRIGGER_RATIO,
  estimateContextTokens,
  truncateBeforeSend,
} from "./compaction.js";
import { runEndOfTurnCompaction } from "./turn-compaction.js";
import { preCompactionFlushHook } from "./memory-extraction.js";
import { buildSplitAugmentedPrompt, commitMemoryDelta } from "./memory-context.js";
import { resolveCurrentMessageIndex } from "./current-message.js";
import { createTimeMarkerState } from "./time-marker.js";
import { SynthesisEmitter, createEmitterSideEffects } from "./synthesis-stream.js";
import { runHeadlessChatTurn } from "./chat-turn-runner.js";
import type { Chat, JobNoticeMetadata } from "../types.js";

/**
 * A notice wake is a full agent turn on the same wire as an automation. This
 * is a policy budget (the custom-automation class), not a prefill-speed or
 * context-size estimate: both vary with the model and hardware. Operators can
 * tune it with PORRIMA_JOB_NOTICE_TIMEOUT_MS; pre-send compaction still bounds
 * the prompt the turn actually pays for.
 */
export const NOTICE_TURN_TIMEOUT_MS =
  Number(process.env.PORRIMA_JOB_NOTICE_TIMEOUT_MS) || 30 * 60_000;

/**
 * Agent-chat wake turn for a completion notice (docs/design/kernel-durability.md
 * §3.3). This is the same prompt/tool/memory/compaction path as an automation
 * run, without an automation task row: the notice row is already the tail user
 * message, so the turn starts from the persisted transcript.
 *
 * The caller must already hold the chat's turn-gate lease; this function does
 * not acquire one.
 */
export async function runNoticeTurn(
  chatId: string,
  notice: JobNoticeMetadata,
): Promise<boolean> {
  const chat = await getChat(chatId);
  if (!chat) return false;
  if (chat.type === "system") return false;

  const modelId = await resolveChatFirstModelId(chat);
  if (!modelId) {
    console.warn(`[jobs] notice wake skipped for chat=${chatId}: no model available`);
    return false;
  }
  const models = await discoverAllModels();
  const piModel = models.find((model) => model.id === modelId);
  if (!piModel) {
    console.warn(`[jobs] notice wake skipped for chat=${chatId}: model ${modelId} unavailable`);
    return false;
  }

  const contextWindow = piModel.contextWindow || 32768;
  const runtimeModel = await createPiModelFromProvider(piModel);
  runtimeModel.contextWindow = contextWindow;
  if (!chat.modelId) {
    chat.modelId = modelId;
    await saveChat(chat);
  }

  const project = chat.projectId ? await getProject(chat.projectId) : null;
  const settings = await getSettings().catch(() => ({ timeMarkerIntervalMinutes: undefined }));
  const emitter = new SynthesisEmitter(chatId);
  try {
    const splitPrompt = await buildSplitAugmentedPrompt(
      chat.messages,
      chat.id,
      chat.projectId,
      chat.type,
      project?.path,
    );
    let systemPrompt = splitPrompt.systemPrompt;
    if (chat.activeSkills?.length) {
      const skillsCache = new Map<string, Skill>();
      for (const skill of await discoverSkills()) skillsCache.set(skill.name, skill);
      systemPrompt = buildSkillAugmentedPrompt(systemPrompt, chat.activeSkills, skillsCache);
    }

    const artifacts: any[] = [];
    const visuals: any[] = [];
    const effects = createEmitterSideEffects(emitter, { artifacts, visuals });
    const tools = withHeadlessAskUser(
      await getAgentTools(
        chat.id,
        effects,
        contextWindow,
        project ?? undefined,
        chat.type,
        createTimeMarkerState(settings.timeMarkerIntervalMinutes),
      ),
    );

    const compaction = await truncateBeforeSend(
      chat,
      contextWindow,
      systemPrompt,
      () => emitter.emitCompacting(),
      undefined,
      tools,
      undefined,
      preCompactionFlushHook(chat, "job-notice pre-send flush failed"),
      emitter.stream.abort.signal,
    );
    if (compaction?.truncated) await saveChat(chat);

    if (splitPrompt.memoriesMessage) {
      const noticeRow = [...chat.messages].reverse().find((message) => message._isJobNotice);
      if (noticeRow) {
        const insertAt = resolveCurrentMessageIndex(chat.messages, noticeRow);
        chat.messages.splice(insertAt, 0, {
          role: "system",
          content: `[System context — updated memories]\n${splitPrompt.memoriesMessage}`,
          timestamp: Date.now(),
        });
        await saveChat(chat);
        commitMemoryDelta(chat.id, splitPrompt.newMemoryIds);
      }
    }

    const turn = await runHeadlessChatTurn({
      chat,
      modelId,
      model: runtimeModel,
      systemPrompt,
      tools,
      emitter,
      contextWindow,
      maxIterations: Number(process.env.PORRIMA_JOB_NOTICE_MAX_ITERATIONS) || 8,
      timeoutMs: NOTICE_TURN_TIMEOUT_MS,
      keepAlive: `${Math.max(1, Math.ceil(NOTICE_TURN_TIMEOUT_MS / 60_000))}m`,
      logPrefix: `job-notice:${chatId}:${notice.group}`,
      saveChat,
      passiveMemoryRecall: {
        enabled: true,
        chatType: chat.type,
        projectId: chat.projectId,
      },
      getFollowUp: async () => null,
      summarize: (state) =>
        state.textSummary ||
        `*The notice turn ended without visible output (stopReason=${state.stopReason}).*`,
    });

    await runEndOfTurnCompaction({
      chat,
      contextWindow,
      lastUsage: turn.assistantMessage.usage?.totalTokens ?? 0,
      hitContextLimit: turn.stopReason === "length",
      estimatedTokens: estimateContextTokens(chat.messages, systemPrompt, tools),
      systemPrompt,
      tools,
      signal: emitter.stream.abort.signal,
      stoppedReason: turn.stopSource,
      triggerRatio: COMPACTION_TRIGGER_RATIO,
      emitCompacting: () => emitter.emitCompacting(),
      preFlush: preCompactionFlushHook(chat, "job-notice end-of-turn flush failed"),
      logPrefix: `job-notice:${chatId}`,
    });

    return turn.success;
  } catch (error: any) {
    console.warn(`[jobs] notice turn failed for chat=${chatId}:`, error?.message ?? error);
    try {
      emitter.emitError(error?.message || "Job notice turn failed");
    } catch {
      // The stream may already be closed.
    }
    return false;
  } finally {
    emitter.end();
  }
}

async function resolveChatFirstModelId(chat: Chat): Promise<string | null> {
  const models = await discoverAllModels();
  if (models.length === 0) return null;
  if (chat.modelId) {
    const stored = models.find((model) => model.id === chat.modelId);
    if (stored) return stored.id;
  }
  try {
    const settings = await getSettings();
    if (settings.defaultModelId) {
      const found = models.find((model) => model.id === settings.defaultModelId);
      if (found) return found.id;
    }
  } catch {
    // Fall through to first available.
  }
  return models[0].id;
}