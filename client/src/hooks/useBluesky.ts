import { useState, useEffect, useCallback } from 'react';

export interface BlueskyStatus {
  authenticated: boolean;
  currentDid: string | null;
  currentHandle: string | null;
  sessions: Array<{
    did: string;
    handle: string;
    createdAt: string;
    lastUsedAt: string;
  }>;
}

export interface BlueskySettings {
  enabled: boolean;
  username?: string;
  appPassword?: string;
  pollingIntervalMinutes?: number;
  notificationTypes?: string[];
  autoSendToAgent?: boolean;
  blueskyChatId?: string;
}

export interface BlueskyNotification {
  uri: string;
  cid: string;
  reason: string;
  author: {
    did: string;
    handle: string;
    displayName?: string;
  };
  record: {
    text?: string;
    createdAt?: string;
  };
  indexedAt: string;
  isRead: boolean;
}

interface UseBlueskyReturn {
  status: BlueskyStatus | null;
  settings: BlueskySettings | null;
  notifications: BlueskyNotification[];
  loading: boolean;
  error: string | null;
  login: (identifier: string, password: string) => Promise<void>;
  logout: () => Promise<void>;
  updateSettings: (settings: Partial<BlueskySettings>) => Promise<void>;
  refreshStatus: () => Promise<void>;
  refreshNotifications: () => Promise<void>;
}

export function useBluesky(): UseBlueskyReturn {
  const [status, setStatus] = useState<BlueskyStatus | null>(null);
  const [settings, setSettings] = useState<BlueskySettings | null>(null);
  const [notifications, setNotifications] = useState<BlueskyNotification[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchStatus = useCallback(async () => {
    try {
      const res = await fetch('/api/bluesky/status');
      if (!res.ok) throw new Error('Failed to fetch status');
      const data = await res.json();
      setStatus(data);
      setError(null);
    } catch (err: any) {
      setError(err.message);
    }
  }, []);

  const fetchSettings = useCallback(async () => {
    try {
      const res = await fetch('/api/bluesky/settings');
      if (!res.ok) throw new Error('Failed to fetch settings');
      const data = await res.json();
      setSettings(data.bluesky);
    } catch (err: any) {
      console.warn('Failed to fetch Bluesky settings:', err.message);
    }
  }, []);

  const fetchNotifications = useCallback(async () => {
    try {
      const res = await fetch('/api/bluesky/notifications?limit=20');
      if (!res.ok) return;
      const data = await res.json();
      setNotifications(data.notifications || []);
    } catch (err: any) {
      console.warn('Failed to fetch notifications:', err.message);
    }
  }, []);

  const login = useCallback(async (identifier: string, password: string) => {
    setLoading(true);
    try {
      const res = await fetch('/api/bluesky/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ identifier, password }),
      });
      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || 'Login failed');
      }
      await fetchStatus();
      await fetchSettings();
    } finally {
      setLoading(false);
    }
  }, [fetchStatus, fetchSettings]);

  const logout = useCallback(async () => {
    setLoading(true);
    try {
      await fetch('/api/bluesky/logout', { method: 'POST' });
      setStatus({ authenticated: false, currentDid: null, currentHandle: null, sessions: [] });
      setSettings(prev => prev ? { ...prev, enabled: false } : null);
    } finally {
      setLoading(false);
    }
  }, []);

  const updateSettings = useCallback(async (newSettings: Partial<BlueskySettings>) => {
    try {
      const res = await fetch('/api/bluesky/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(newSettings),
      });
      if (!res.ok) throw new Error('Failed to update settings');
      const data = await res.json();
      setSettings(data.settings);
      await fetchStatus();
    } catch (err: any) {
      setError(err.message);
      throw err;
    }
  }, [fetchStatus]);

  const refreshStatus = useCallback(async () => {
    await fetchStatus();
  }, [fetchStatus]);

  const refreshNotifications = useCallback(async () => {
    await fetchNotifications();
  }, [fetchNotifications]);

  useEffect(() => {
    setLoading(true);
    Promise.all([fetchStatus(), fetchSettings(), fetchNotifications()])
      .finally(() => setLoading(false));
  }, [fetchStatus, fetchSettings, fetchNotifications]);

  // Auto-refresh notifications every 10 minutes (matches server poller)
  useEffect(() => {
    const interval = setInterval(() => {
      fetchNotifications();
      fetchStatus();
    }, 10 * 60 * 1000);
    return () => clearInterval(interval);
  }, [fetchNotifications, fetchStatus]);

  return {
    status,
    settings,
    notifications,
    loading,
    error,
    login,
    logout,
    updateSettings,
    refreshStatus,
    refreshNotifications,
  };
}
