import { Router, Request, Response } from 'express';
import { getBlueskyAgent, BlueskyAgent } from '../services/bluesky-agent.js';
import { getBlueskyPoller } from '../services/bluesky-poller.js';
import { getSettings, saveSettings, createChat, findBlueskyChatId } from '../services/chat-storage.js';
import { v4 as uuidv4 } from 'uuid';

const router = Router();

router.post('/login', async (req: Request, res: Response) => {
  try {
    const { identifier, password } = req.body;
    if (!identifier || !password) {
      return res.status(400).json({ error: 'identifier and password are required' });
    }
    const agent = getBlueskyAgent();
    await agent.login(identifier, password);
    res.json({ success: true, did: agent.getDid(), handle: agent.getHandle() });
  } catch (err: any) {
    res.status(500).json({ error: err.message ?? 'Login failed' });
  }
});

router.post('/logout', async (req: Request, res: Response) => {
  try {
    const agent = getBlueskyAgent();
    if (agent.getDid()) await agent.logout();
    res.json({ success: true });
  } catch (err: any) {
    res.status(500).json({ error: err.message ?? 'Logout failed' });
  }
});

router.post('/restore', async (req: Request, res: Response) => {
  try {
    const { did } = req.body;
    if (!did) return res.status(400).json({ error: 'did is required' });
    const agent = getBlueskyAgent();
    const success = await agent.restoreSession(did);
    if (!success) return res.status(401).json({ error: 'Session expired or invalid' });
    res.json({ success: true, did: agent.getDid(), handle: agent.getHandle() });
  } catch (err: any) {
    res.status(500).json({ error: err.message ?? 'Restore failed' });
  }
});

router.get('/status', async (req: Request, res: Response) => {
  try {
    const agent = getBlueskyAgent();
    res.json({
      authenticated: agent.isAuthenticated(),
      currentDid: agent.getDid(),
      currentHandle: agent.getHandle(),
      sessions: BlueskyAgent.getAllSessionInfo(),
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message ?? 'Status check failed' });
  }
});

router.get('/notifications', async (req: Request, res: Response) => {
  try {
    const agent = getBlueskyAgent();
    if (!agent.isAuthenticated()) return res.status(401).json({ error: 'Not authenticated' });
    const limit = parseInt(req.query.limit as string) || 50;
    const reasons = req.query.reasons ? (req.query.reasons as string).split(',') : undefined;
    const notifications = await agent.listNotifications({ limit, reasons });
    res.json({
      notifications: notifications.map((n: any) => ({
        uri: n.uri, cid: n.cid, reason: n.reason,
        author: { did: n.author.did, handle: n.author.handle, displayName: n.author.displayName },
        record: n.record, indexedAt: n.indexedAt, isRead: n.isRead,
      })),
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message ?? 'Failed to fetch notifications' });
  }
});

router.post('/settings', async (req: Request, res: Response) => {
  try {
    const settings = await getSettings();
    const blueskySettings = req.body;
    const updated = { ...settings, bluesky: { ...settings.bluesky, ...blueskySettings } };

    if (blueskySettings.enabled && !updated.bluesky?.blueskyChatId) {
      const existing = await findBlueskyChatId();
      if (existing) {
        updated.bluesky!.blueskyChatId = existing;
      } else {
        const chatId = uuidv4();
        await createChat({
          id: chatId, title: 'Bluesky', type: 'bluesky',
          modelId: settings.defaultModelId,
          systemPrompt: 'You are a social media assistant with access to Bluesky.',
          messages: [],
          createdAt: new Date().toISOString(),
          lastModified: new Date().toISOString(),
        });
        updated.bluesky!.blueskyChatId = chatId;
      }
    }

    await saveSettings(updated);

    const poller = getBlueskyPoller();
    if (updated.bluesky?.enabled) {
      poller.start(updated.bluesky.pollingIntervalMinutes ?? 10);
    } else {
      poller.stop();
    }

    res.json({ success: true, settings: updated.bluesky });
  } catch (err: any) {
    res.status(500).json({ error: err.message ?? 'Failed to update settings' });
  }
});

router.get('/settings', async (req: Request, res: Response) => {
  try {
    // Re-read settings fresh in case the scheduler already backfilled
    const settings = await getSettings();
    let bluesky = settings.bluesky ?? { enabled: false };

    // Backfill: if Bluesky is enabled but the dedicated chat was never created
    // (e.g. interrupted turn, direct settings edit), create it now.
    // First check if a bluesky chat already exists (scheduler may have created one).
    if (bluesky.enabled && !bluesky.blueskyChatId) {
      const existing = await findBlueskyChatId();
      if (existing) {
        bluesky = { ...bluesky, blueskyChatId: existing };
      } else {
        const chatId = uuidv4();
        await createChat({
          id: chatId, title: 'Bluesky', type: 'bluesky',
          modelId: settings.defaultModelId,
          systemPrompt: 'You are a social media assistant with access to Bluesky.',
          messages: [],
          createdAt: new Date().toISOString(),
          lastModified: new Date().toISOString(),
        });
        bluesky = { ...bluesky, blueskyChatId: chatId };
      }
      await saveSettings({ ...settings, bluesky });
      console.log(`[bluesky] backfilled blueskyChatId: ${bluesky.blueskyChatId}`);
    }

    res.json({ bluesky });
  } catch (err: any) {
    res.status(500).json({ error: err.message ?? 'Failed to get settings' });
  }
});

export default router;
