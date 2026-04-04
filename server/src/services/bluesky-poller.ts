import { EventEmitter } from 'events';
import { getBlueskyAgent } from './bluesky-agent.js';
import { getSettings, getChat, saveChat } from './chat-storage.js';
import { streamChat, chatMessagesToPiMessages } from './agent.js';
import { getAgentTools, executeTool } from './agent-tools.js';
import { buildMemoryAugmentedPrompt } from './memory-context.js';
import { extractMemories } from './memory-extraction.js';
import { ChatMessage, BlueskyNotification } from '../types.js';

const POLL_INTERVAL_DEFAULT = 10; // minutes

/**
 * BlueskyPoller periodically fetches notifications and emits them via SSE.
 * Can optionally auto-send notifications to the Bluesky chat as system messages.
 */
export class BlueskyPoller extends EventEmitter {
  private interval: NodeJS.Timeout | null = null;
  private lastNotificationDate: string | null = null;
  private isRunning: boolean = false;
  private responding: boolean = false;
  private pendingNotifications: BlueskyNotification[] = [];

  /**
   * Start polling for notifications.
   */
  start(intervalMinutes: number = POLL_INTERVAL_DEFAULT): void {
    if (this.isRunning) {
      console.warn('[bluesky-poller] Already running, stopping first...');
      this.stop();
    }

    this.isRunning = true;
    const intervalMs = intervalMinutes * 60 * 1000;

    console.log(`[bluesky-poller] Starting poller (interval: ${intervalMinutes}min)`);
    
    // Poll immediately on start
    this.poll();
    
    // Then poll at regular intervals
    this.interval = setInterval(() => {
      this.poll();
    }, intervalMs);
  }

  /**
   * Stop polling.
   */
  stop(): void {
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
    }
    this.isRunning = false;
    console.log('[bluesky-poller] Stopped');
  }

  /**
   * Poll for new notifications.
   */
  private async poll(): Promise<void> {
    const agent = getBlueskyAgent();
    
    if (!agent.isAuthenticated()) {
      console.warn('[bluesky-poller] Not authenticated, skipping poll');
      return;
    }

    try {
      const settings = await getSettings();
      const notificationTypes = settings.bluesky?.notificationTypes ?? ['mention', 'reply'];
      
      console.log('[bluesky-poller] Fetching notifications...');
      
      const notifications = await agent.listNotifications({
        limit: 50,
        reasons: notificationTypes,
      });

      // On first poll, just record the high-water mark so we don't
      // re-send the entire notification history on every server restart.
      if (!this.lastNotificationDate) {
        if (notifications.length > 0) {
          this.lastNotificationDate = notifications[0].indexedAt;
          console.log(`[bluesky-poller] First poll — set baseline to ${this.lastNotificationDate} (${notifications.length} existing notifications skipped)`);
        }
        return;
      }

      // Filter to new notifications since last poll
      const newNotifications = notifications.filter(n => {
        return n.indexedAt > this.lastNotificationDate!;
      });

      if (newNotifications.length === 0) {
        console.log('[bluesky-poller] No new notifications');
        return;
      }

      console.log(`[bluesky-poller] Found ${newNotifications.length} new notification(s)`);

      // Convert to our type
      const converted = newNotifications.map(n => this.convertNotification(n));

      // Update last notification date (most recent first)
      this.lastNotificationDate = converted[0].indexedAt;

      // Emit event for SSE clients
      this.emit('notifications', {
        notifications: converted,
        timestamp: new Date().toISOString(),
        count: converted.length,
      });

      // Auto-send to agent chat if enabled
      if (settings.bluesky?.autoSendToAgent && settings.bluesky.blueskyChatId) {
        await this.sendNotificationsToAgent(
          converted,
          settings.bluesky.blueskyChatId,
          settings.bluesky.autoRespondToNotifications ?? false
        );
      }

    } catch (err: any) {
      console.error('[bluesky-poller] Poll error:', err.message);
      
      // Emit error event
      this.emit('error', {
        error: err.message,
        timestamp: new Date().toISOString(),
      });
    }
  }

  /**
   * Convert @atproto/api notification to our type.
   */
  private convertNotification(notif: any): BlueskyNotification {
    const author = notif.author as any;
    const record = notif.record as any;
    
    return {
      uri: notif.uri,
      cid: notif.cid,
      reason: notif.reason as BlueskyNotification['reason'],
      author: {
        did: author.did,
        handle: author.handle,
        displayName: author.displayName,
      },
      record: {
        text: record.text,
        createdAt: record.createdAt,
        reply: record.reply ? {
          root: record.reply.root ? { uri: record.reply.root.uri, cid: record.reply.root.cid } : undefined,
          parent: record.reply.parent ? { uri: record.reply.parent.uri, cid: record.reply.parent.cid } : undefined,
        } : undefined,
      },
      indexedAt: notif.indexedAt,
      isRead: notif.isRead ?? false,
    };
  }

  /**
   * Format notifications as a batched message for the agent.
   * Groups multiple notifications into a single system message.
   */
  private formatNotificationsAsMessage(notifications: BlueskyNotification[]): string {
    const byReason = new Map<string, BlueskyNotification[]>();
    
    for (const notif of notifications) {
      const existing = byReason.get(notif.reason) ?? [];
      existing.push(notif);
      byReason.set(notif.reason, existing);
    }

    let message = `🔔 **Bluesky Notifications** (${notifications.length} total)\n\n`;

    for (const [reason, notifs] of byReason.entries()) {
      message += `### ${reason.toUpperCase()} (${notifs.length})\n\n`;
      
      for (const notif of notifs) {
        const displayName = notif.author.displayName;
        const handle = `@${notif.author.handle}`;
        const nameLabel = displayName ? `**${displayName}** (${handle})` : `**${handle}**`;
        const text = notif.record.text ? `"${notif.record.text}"` : '(no text)';
        const time = new Date(notif.indexedAt).toLocaleString();

        message += `- ${nameLabel} ${time}\n`;
        message += `  ${text}\n`;
        message += `  \`URI: ${notif.uri}\` \`CID: ${notif.cid}\`\n\n`;
      }
    }

    message += `---\n*Use bluesky_get_thread to fetch full context, or bluesky_reply to respond.*`;

    return message;
  }

  /**
   * Send batched notifications to the Bluesky chat as a user message and trigger agent response.
   */
  private async sendNotificationsToAgent(
    notifications: BlueskyNotification[],
    chatId: string,
    autoRespond: boolean
  ): Promise<void> {
    try {
      const content = this.formatNotificationsAsMessage(notifications);
      const chat = await getChat(chatId);

      if (!chat) {
        console.warn('[bluesky-poller] Bluesky chat not found:', chatId);
        return;
      }

      // Add as USER message (notifications are incoming events)
      const userMessage: ChatMessage = {
        role: 'user',
        content,
        timestamp: Date.now(),
        _inProgress: false,
      };

      chat.messages.push(userMessage);
      chat.lastModified = new Date().toISOString();
      await saveChat(chat);

      console.log(`[bluesky-poller] Sent ${notifications.length} notifications to chat ${chatId}`);

      // Trigger autonomous agent response if enabled
      if (autoRespond) {
        console.log(`[bluesky-poller] Auto-respond enabled, triggering agent response...`);
        this.triggerAgentResponse(chatId).catch(err => {
          console.error('[bluesky-poller] Failed to trigger agent response:', err.message);
        });
      }

      this.emit('sent_to_agent', {
        chatId,
        count: notifications.length,
        timestamp: new Date().toISOString(),
      });
    } catch (err: any) {
      console.error('[bluesky-poller] Failed to send notifications to agent:', err.message);
    }
  }

  /**
   * Trigger the agent to autonomously respond to notifications.
   * Runs a tool loop (like synthesis notebook) so the agent can read threads and reply.
   */
  private async triggerAgentResponse(chatId: string): Promise<void> {
    if (this.responding) {
      console.log('[bluesky-poller] Agent already responding, skipping');
      return;
    }

    this.responding = true;
    try {
      const chat = await getChat(chatId);
      if (!chat) {
        console.warn('[bluesky-poller] Chat not found for agent response:', chatId);
        return;
      }

      const settings = await getSettings();
      const modelId = chat.modelId || settings.defaultModelId;

      // Build memory-augmented system prompt with explicit tool-use instructions.
      // The base chat prompt may be terse, so we inject Bluesky-specific guidance
      // so the model knows to call tools directly using URIs/CIDs from notifications.
      const basePrompt = chat.systemPrompt || 'You are a helpful assistant.';
      const blueskyToolPrompt = `${basePrompt}

When Bluesky notifications arrive, you MUST use your tools to handle them — do not ask the user for information that is already present in the notification. Extract URI and CID values directly from the notification and pass them to tools. Use bluesky_get_thread to read full context before replying, then use bluesky_reply to respond. Keep replies concise and authentic to your persona.`;
      const systemPrompt = await buildMemoryAugmentedPrompt(
        blueskyToolPrompt,
        chat.messages,
        chat.id,
        chat.projectId,
        "bluesky"
      );

      // Convert all messages except the last (the notification) to pi-ai format
      const contextMessages = chatMessagesToPiMessages(
        chat.messages.slice(0, -1),
        modelId
      );

      // The last message (notifications) becomes the user prompt, with an
      // action directive so the agent knows it should review and respond.
      const lastMsg = chat.messages[chat.messages.length - 1];
      const actionPrompt = `${lastMsg.content}

---
Review the notifications above. For mentions and replies, use bluesky_get_thread to read the full conversation context, then decide whether to respond. If a response is appropriate, use bluesky_reply to post your reply. Keep responses authentic to your persona.`;

      const piMessages: any[] = [
        ...contextMessages,
        {
          role: 'user',
          content: actionPrompt,
          timestamp: lastMsg.timestamp || Date.now(),
        },
      ];

      // Tool loop — modeled after synthesis.ts notebook entry writing
      const MAX_ITERATIONS = 10;
      let iteration = 0;
      let finalContent = '';
      const allToolCalls: any[] = [];
      const allToolResults: Array<{ toolCallId: string; toolName: string; content: string; isError: boolean }> = [];

      const effects = {
        onArtifact: () => {},
        onVisual: () => {},
        onGeneratedImage: () => {},
        onPendingReviewImage: () => {},
        onAskUser: (question: string) => {
          console.log(`[bluesky-poller] ask_user skipped: ${question}`);
        },
      };

      while (iteration < MAX_ITERATIONS) {
        iteration++;
        console.log(`[bluesky-poller] Agent response iteration ${iteration}`);

        let iterationContent = '';
        let toolCalls: any[] = [];
        let stopReason = 'stop';
        let assistantMessage: any;

        const tools = getAgentTools(chatId, effects);
        if (iteration === 1) {
          console.log(`[bluesky-poller] Using model: ${modelId}, tools: ${tools.length} (${tools.map(t => t.name).join(', ')})`);
          console.log(`[bluesky-poller] Messages: ${piMessages.length}, last role: ${piMessages[piMessages.length - 1]?.role}`);
        }

        try {
          const result = await streamChat(
            modelId,
            piMessages,
            systemPrompt,
            (event) => {
              if (event.type === 'text_delta') iterationContent += event.delta;
            },
            {
              signal: AbortSignal.timeout(180_000),
              tools,
            }
          );

          toolCalls = result.toolCalls || [];
          stopReason = result.stopReason;
          assistantMessage = result.assistantMessage;

          console.log(`[bluesky-poller] Iteration ${iteration} result: stopReason=${stopReason}, toolCalls=${toolCalls.length}, contentLen=${iterationContent.length}, thinkingLen=${result.thinking?.length ?? 0}, usage=${JSON.stringify(result.usage)}, content=${iterationContent.slice(0, 200)}`);

          // Tool calls take priority: some providers return stopReason='stop'
          // even when tool calls are present (e.g. cloud-proxied models).
          if (toolCalls.length === 0 && stopReason === 'stop') {
            finalContent = iterationContent;
          }
        } catch (e) {
          console.error('[bluesky-poller] streamChat failed:', e);
          break;
        }

        if (toolCalls.length === 0) {
          break;
        }

        // Execute tool calls
        console.log(`[bluesky-poller] Executing ${toolCalls.length} tool call(s)`);
        allToolCalls.push(...toolCalls);

        const toolResults: Array<{ toolCallId: string; toolName: string; content: string; isError: boolean }> = [];
        for (const toolCall of toolCalls) {
          try {
            console.log(`[bluesky-poller] Executing tool: ${toolCall.name}`);
            const result = await executeTool(toolCall, chatId, effects);
            const tr = { toolCallId: toolCall.id, toolName: toolCall.name, content: JSON.stringify(result), isError: false };
            toolResults.push(tr);
            allToolResults.push(tr);
          } catch (e: any) {
            console.error(`[bluesky-poller] Tool execution failed: ${toolCall.name}`, e);
            const tr = { toolCallId: toolCall.id, toolName: toolCall.name, content: e.message || 'Tool execution failed', isError: true };
            toolResults.push(tr);
            allToolResults.push(tr);
          }
        }

        piMessages.push(assistantMessage);
        for (const tr of toolResults) {
          piMessages.push({
            role: 'toolResult' as const,
            toolCallId: tr.toolCallId,
            toolName: tr.toolName,
            content: [{ type: 'text' as const, text: tr.content }],
            isError: tr.isError,
            timestamp: Date.now(),
          });
        }
      }

      // Save the assistant response to chat (even if text is empty, tool calls matter)
      if (finalContent || allToolCalls.length > 0) {
        const assistantMsg: ChatMessage = {
          role: 'assistant',
          content: finalContent,
          timestamp: Date.now(),
          _inProgress: false,
          toolCalls: allToolCalls.length > 0 ? allToolCalls.map(tc => ({
            id: tc.id,
            name: tc.name,
            arguments: tc.input ?? tc.arguments,
          })) : undefined,
          toolResults: allToolResults.length > 0 ? allToolResults : undefined,
        };

        // Re-read chat in case it changed during the loop
        const freshChat = await getChat(chatId);
        if (freshChat) {
          freshChat.messages.push(assistantMsg);
          freshChat.lastModified = new Date().toISOString();
          await saveChat(freshChat);
        }

        console.log(`[bluesky-poller] Agent responded (${finalContent.length} chars, ${allToolCalls.length} tool calls)`);

        // Fire-and-forget memory extraction
        extractMemories(modelId, chatId, lastMsg.content, finalContent)
          .catch(err => console.error('[bluesky-poller] Memory extraction failed:', err));

        // Notify SSE clients
        this.emit('agent_response', {
          chatId,
          content: finalContent,
          toolCalls: allToolCalls.length,
          timestamp: new Date().toISOString(),
        });
      } else {
        console.warn('[bluesky-poller] Agent produced no response content');
      }
    } catch (err: any) {
      console.error('[bluesky-poller] triggerAgentResponse failed:', err.message);
    } finally {
      this.responding = false;
    }
  }

  /**
   * Get pending notifications (accumulated since last poll).
   */
  getPendingNotifications(): BlueskyNotification[] {
    return [...this.pendingNotifications];
  }

  /**
   * Clear pending notifications.
   */
  clearPendingNotifications(): void {
    this.pendingNotifications = [];
  }
}

// Singleton instance
let _poller: BlueskyPoller | null = null;

export function getBlueskyPoller(): BlueskyPoller {
  if (!_poller) {
    _poller = new BlueskyPoller();
  }
  return _poller;
}
