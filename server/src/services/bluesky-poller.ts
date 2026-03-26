import { EventEmitter } from 'events';
import { getBlueskyAgent } from './bluesky-agent.js';
import { getSettings, getChat, saveChat } from './chat-storage.js';
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
        await this.sendNotificationsToAgent(converted, settings.bluesky.blueskyChatId);
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
        const handle = `@${notif.author.handle}`;
        const text = notif.record.text ? `"${notif.record.text}"` : '(no text)';
        const time = new Date(notif.indexedAt).toLocaleString();
        
        message += `- **${handle}** ${time}\n`;
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
    chatId: string
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

      console.log(`[bluesky-poller] Sent ${notifications.length} notifications to chat ${chatId}, triggering agent response...`);
      
      // Trigger agent to respond
      this.triggerAgentResponse(chatId).catch(err => {
        console.error('[bluesky-poller] Failed to trigger agent response:', err.message);
      });
      
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
   * Trigger the agent to respond to the latest message in a chat.
   * For now, this is a no-op - the agent will respond when the user opens the chat.
   * Auto-response would require refactoring the chat route to separate agent loop from SSE.
   */
  private async triggerAgentResponse(chatId: string): Promise<void> {
    // Placeholder - agent responds when user interacts with chat
    console.log(`[bluesky-poller] Notifications sent to chat ${chatId}, agent will respond when chat is opened`);
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
