import { useState } from 'react';
import { useBluesky } from '../hooks/useBluesky';

interface BlueskySectionProps {
  onOpenSettings: () => void;
  onSelectChat: (id: string) => void;
}

export function BlueskySection({ onOpenSettings, onSelectChat }: BlueskySectionProps) {
  const { status, settings, notifications, loading, logout, updateSettings } = useBluesky();
  const [isExpanded, setIsExpanded] = useState(false);

  const isAuthenticated = status?.authenticated ?? false;
  const handle = status?.currentHandle;
  const unreadCount = notifications.filter(n => !n.isRead).length;

  const handleConnect = () => {
    onOpenSettings();
  };

  const handleDisconnect = async () => {
    if (confirm('Disconnect from Bluesky?')) {
      await logout();
      await updateSettings({ enabled: false });
    }
  };

  const handleOpenChat = () => {
    if (settings?.blueskyChatId) {
      onSelectChat(settings.blueskyChatId);
    }
  };

  const toggleExpanded = () => {
    setIsExpanded(!isExpanded);
  };

  return (
    <div className="mb-4">
      <div className="flex items-center justify-between px-3 py-2 mb-1">
        <div className="flex items-center gap-2">
          <button
            onClick={toggleExpanded}
            className="w-5 h-5 flex items-center justify-center text-emerald-400 hover:text-emerald-300 transition-colors"
          >
            <svg
              className={`w-4 h-4 transition-transform ${isExpanded ? 'rotate-90' : ''}`}
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
            >
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
            </svg>
          </button>
          <span className="text-xs font-semibold text-emerald-400 uppercase tracking-wider">
            Bluesky
          </span>
        </div>
        <button
          onClick={onOpenSettings}
          className="text-emerald-500 hover:text-emerald-400 transition-colors"
          title="Settings"
        >
          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={1.5}
              d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z"
            />
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={1.5}
              d="M15 12a3 3 0 11-6 0 3 3 0 016 0z"
            />
          </svg>
        </button>
      </div>

      {isExpanded && (
        <div className="ml-5 pl-3 border-l border-emerald-500/20 space-y-2">
          {loading ? (
            <div className="text-xs text-emerald-500/60">Loading...</div>
          ) : isAuthenticated ? (
            <>
              <div className="flex items-center gap-2 text-xs">
                <span className="w-2 h-2 rounded-full bg-emerald-400 animate-pulse" />
                <span className="text-emerald-300 truncate" title={handle || ''}>
                  @{handle}
                </span>
              </div>

              {unreadCount > 0 && (
                <div
                  className="flex items-center gap-2 text-xs text-emerald-400/80 hover:text-emerald-300 cursor-pointer"
                  onClick={handleOpenChat}
                >
                  <span className="relative">
                    <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        strokeWidth={1.5}
                        d="M15 17h5l-1.405-1.405A2.032 2.032 0 0118 14.158V11a6.002 6.002 0 00-4-5.659V5a2 2 0 10-4 0v.341C7.67 6.165 6 8.388 6 11v3.159c0 .538-.214 1.055-.595 1.436L4 17h5m6 0v1a3 3 0 11-6 0v-1m6 0H9"
                      />
                    </svg>
                    <span className="absolute -top-1 -right-1 w-3 h-3 bg-emerald-500 rounded-full text-[9px] flex items-center justify-center text-white font-medium">
                      {unreadCount}
                    </span>
                  </span>
                  <span>{unreadCount} notification{unreadCount !== 1 ? 's' : ''}</span>
                </div>
              )}

              <button
                onClick={handleOpenChat}
                className="w-full text-left text-xs text-emerald-400/70 hover:text-emerald-300 transition-colors flex items-center gap-2"
              >
                <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={1.5}
                    d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z"
                  />
                </svg>
                Open Chat
              </button>

              <button
                onClick={handleDisconnect}
                className="w-full text-left text-xs text-emerald-500/60 hover:text-red-400 transition-colors"
              >
                Disconnect
              </button>
            </>
          ) : (
            <button
              onClick={handleConnect}
              className="w-full text-left text-xs text-emerald-400/70 hover:text-emerald-300 transition-colors flex items-center gap-2"
            >
              <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={1.5}
                  d="M13.828 10.172a4 4 0 00-5.656 0l-4 4a4 4 0 105.656 5.656l1.102-1.101m-.758-4.899a4 4 0 005.656 0l4-4a4 4 0 00-5.656-5.656l-1.1 1.1"
                />
              </svg>
              Connect
            </button>
          )}
        </div>
      )}
    </div>
  );
}
