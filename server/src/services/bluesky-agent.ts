import { AtpAgent, CredentialSession, AtpSessionData } from '@atproto/api';
import { randomBytes, createCipheriv, createDecipheriv } from 'crypto';
import {
  saveBlueskySession,
  getBlueskySession,
  getAllBlueskySessions,
  deleteBlueskySession,
  updateBlueskySessionLastUsed,
} from './chat-storage.js';

const ENCRYPTION_KEY = Buffer.from('quje-bluesky-session-encryption-key-v1', 'utf-8').slice(0, 32);

export class BlueskyAgent {
  private agent: AtpAgent | null = null;
  private sessionManager: CredentialSession | null = null;
  private did: string | null = null;
  private handle: string | null = null;

  private static encryptSession(session: AtpSessionData): { encrypted: string; iv: string } {
    const iv = randomBytes(16);
    const cipher = createCipheriv('aes-256-cbc', ENCRYPTION_KEY, iv);
    const json = JSON.stringify(session);
    let encrypted = cipher.update(json, 'utf-8', 'hex');
    encrypted += cipher.final('hex');
    return { encrypted, iv: iv.toString('hex') };
  }

  private static decryptSession(encrypted: string, iv: string): AtpSessionData {
    const decipher = createDecipheriv('aes-256-cbc', ENCRYPTION_KEY, Buffer.from(iv, 'hex'));
    let decrypted = decipher.update(encrypted, 'hex', 'utf-8');
    decrypted += decipher.final('utf-8');
    return JSON.parse(decrypted) as AtpSessionData;
  }

  /**
   * Persist refreshed session tokens back to the database.
   * Called by @atproto/api's CredentialSession whenever tokens are refreshed.
   */
  private persistSession(evt: string, session: AtpSessionData | undefined): void {
    if (evt === 'update' && session && this.did) {
      const { encrypted, iv } = BlueskyAgent.encryptSession(session);
      saveBlueskySession({
        did: this.did,
        handle: session.handle,
        encryptedSession: encrypted,
        iv,
        createdAt: new Date().toISOString(),
        lastUsedAt: new Date().toISOString(),
      });
      console.log(`[bluesky-agent] Session tokens refreshed and persisted for ${session.handle}`);
    } else if (evt === 'expired') {
      console.warn(`[bluesky-agent] Session expired for ${this.did}`);
    }
  }

  private createSessionManager(): CredentialSession {
    return new CredentialSession(
      new URL('https://bsky.social'),
      undefined,
      (evt, session) => this.persistSession(evt, session)
    );
  }

  async login(identifier: string, password: string): Promise<void> {
    this.sessionManager = this.createSessionManager();
    await this.sessionManager.login({ identifier, password });

    const session = this.sessionManager.session;
    if (!session) {
      throw new Error('Login failed: no session returned');
    }

    this.agent = new AtpAgent(this.sessionManager);
    this.did = session.did;
    this.handle = session.handle;

    const { encrypted, iv } = BlueskyAgent.encryptSession(session);

    saveBlueskySession({
      did: this.did!,
      handle: this.handle!,
      encryptedSession: encrypted,
      iv,
      createdAt: new Date().toISOString(),
      lastUsedAt: new Date().toISOString(),
    });
  }

  async restoreSession(did: string): Promise<boolean> {
    const stored = getBlueskySession(did);

    if (!stored) {
      console.warn('[bluesky-agent] No session found for DID:', did);
      return false;
    }

    try {
      const sessionData = BlueskyAgent.decryptSession(stored.encryptedSession, stored.iv);
      this.sessionManager = this.createSessionManager();
      await this.sessionManager.resumeSession(sessionData);

      const session = this.sessionManager.session;
      if (!session) {
        console.warn('[bluesky-agent] Resumed session is invalid');
        return false;
      }

      this.agent = new AtpAgent(this.sessionManager);
      this.did = session.did;
      this.handle = session.handle;

      updateBlueskySessionLastUsed(did);
      return true;
    } catch (err: any) {
      // Session restoration failed (likely expired), but keep the stored credentials
      // so the UI can show "session expired" rather than "not logged in"
      console.warn('[bluesky-agent] Failed to restore session:', err.message);
      return false;
    }
  }

  async logout(): Promise<void> {
    if (!this.did) return;
    deleteBlueskySession(this.did);
    this.agent = null;
    this.sessionManager = null;
    this.did = null;
    this.handle = null;
  }

  getDid(): string | null {
    return this.did;
  }

  getHandle(): string | null {
    return this.handle;
  }

  getAgent(): AtpAgent {
    if (!this.agent) {
      throw new Error('BlueskyAgent not authenticated');
    }
    return this.agent;
  }

  isAuthenticated(): boolean {
    return this.agent !== null && this.did !== null;
  }

  async listNotifications(options?: { limit?: number; reasons?: string[]; cursor?: string }) {
    const agent = this.getAgent();
    const response = await agent.api.app.bsky.notification.listNotifications({
      limit: options?.limit ?? 50,
      reasons: options?.reasons,
      cursor: options?.cursor,
    });
    return response.data.notifications;
  }

  async getPostThread(uri: string, options?: { parentHeight?: number; depth?: number }) {
    const agent = this.getAgent();
    const response = await agent.api.app.bsky.feed.getPostThread({
      uri,
      parentHeight: options?.parentHeight ?? 80,
      depth: options?.depth ?? 25,
    });
    return response.data;
  }

  async replyToPost(params: {
    uri: string;
    cid: string;
    text: string | string[];
    lang?: string;
    rootUri?: string;
    rootCid?: string;
  }): Promise<{ uri: string; cid: string }[]> {
    const agent = this.getAgent();
    const texts = Array.isArray(params.text) ? params.text : [params.text];
    
    if (texts.length === 0) {
      throw new Error('Text cannot be empty');
    }

    let rootUri = params.rootUri ?? params.uri;
    let rootCid = params.rootCid ?? params.cid;

    if (!params.rootUri) {
      try {
        const postResp = await agent.api.app.bsky.feed.getPosts({ uris: [params.uri] });
        const post = postResp.data.posts[0];
        const record = post.record as any;
        if (record?.reply?.root) {
          rootUri = record.reply.root.uri;
          rootCid = record.reply.root.cid;
        }
      } catch (err) {
        console.warn('[bluesky-agent] Failed to fetch post for root detection:', err);
      }
    }

    const results: { uri: string; cid: string }[] = [];
    let parentUri = params.uri;
    let parentCid = params.cid;

    for (const text of texts) {
      const record: any = {
        $type: 'app.bsky.feed.post',
        text,
        createdAt: new Date().toISOString(),
        reply: {
          parent: { uri: parentUri, cid: parentCid },
          root: { uri: rootUri, cid: rootCid },
        },
      };
      if (params.lang) record.langs = [params.lang];

      const result = await agent.api.app.bsky.feed.post.create(
        { repo: this.did! },
        record
      );
      results.push({ uri: result.uri, cid: result.cid });
      parentUri = result.uri;
      parentCid = result.cid;
    }

    return results;
  }

  async createPost(params: { text: string; lang?: string }): Promise<{ uri: string; cid: string }> {
    const agent = this.getAgent();
    const record: any = {
      $type: 'app.bsky.feed.post',
      text: params.text,
      createdAt: new Date().toISOString(),
    };
    if (params.lang) record.langs = [params.lang];
    const result = await agent.api.app.bsky.feed.post.create({ repo: this.did! }, record);
    return { uri: result.uri, cid: result.cid };
  }

  async resolveHandle(handle: string): Promise<string> {
    const agent = this.getAgent();
    const response = await agent.api.com.atproto.identity.resolveHandle({ handle });
    return response.data.did;
  }

  async getProfile(actor: string) {
    const agent = this.getAgent();
    const response = await agent.api.app.bsky.actor.getProfile({ actor });
    return response.data;
  }

  async like(uri: string, cid: string): Promise<{ uri: string }> {
    const agent = this.getAgent();
    const result = await agent.like(uri, cid);
    return { uri: result.uri };
  }

  async repost(uri: string, cid: string): Promise<{ uri: string }> {
    const agent = this.getAgent();
    const result = await agent.repost(uri, cid);
    return { uri: result.uri };
  }

  async follow(did: string): Promise<{ uri: string }> {
    const agent = this.getAgent();
    const result = await agent.follow(did);
    return { uri: result.uri };
  }

  static getAllSessionInfo() {
    const sessions = getAllBlueskySessions();
    return sessions.map(s => ({
      did: s.did,
      handle: s.handle,
      createdAt: s.createdAt,
      lastUsedAt: s.lastUsedAt,
    }));
  }
}

let _blueskyAgent: BlueskyAgent | null = null;
export function getBlueskyAgent(): BlueskyAgent {
  if (!_blueskyAgent) _blueskyAgent = new BlueskyAgent();
  return _blueskyAgent;
}
