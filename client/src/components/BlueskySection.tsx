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
      <div className="px-3 pt-3 pb-1 shrink-0">
        <div className="flex items-center justify-between mb-1.5">
          <button
            onClick={toggleExpanded}
            className="flex items-center gap-1.5 px-1 mb-1.5 group cursor-pointer"
          >
            <span className="text-white/30 group-hover:text-white/50 transition-colors">
              <svg
                className={`w-3 h-3 transition-transform ${isExpanded ? 'rotate-90' : ''}`}
                fill="none"
                stroke="currentColor"
                viewBox="0 0 24 24"
              >
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 18l6-6-6-6" />
              </svg>
            </span>
            <span className="text-[10px] font-semibold tracking-wider uppercase text-white/30 group-hover:text-white/50 transition-colors">
              Bluesky
            </span>
            {!isExpanded && isAuthenticated && unreadCount > 0 && (
              <span className="text-[10px] text-white/20 ml-auto">{unreadCount}</span>
            )}
          </button>
          {isExpanded && (
            <button
              onClick={onOpenSettings}
              className="text-white/30 hover:text-white/60 transition-colors p-1 rounded-lg hover:bg-white/5"
              title="Settings"
            >
              <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z" />
                <circle cx="12" cy="12" r="3" />
              </svg>
            </button>
          )}
        </div>

        {isExpanded && (
          <div className="flex-1 overflow-y-auto pb-1">
            <div className="space-y-0.5 pl-3 pr-2">
              {loading ? (
                <div className="text-center text-white/20 text-xs py-3 px-2">Loading...</div>
              ) : isAuthenticated ? (
                <>
                  <div className="flex items-center gap-2 px-2 py-1.5 rounded-xl bg-emerald-500/15 border border-emerald-400/25">
                    <span className="w-2 h-2 rounded-full bg-emerald-400 animate-pulse" />
                    <span className="text-emerald-300 text-sm truncate" title={handle || ''}>
                      @{handle}
                    </span>
                  </div>

                  {unreadCount > 0 && (
                    <button
                      onClick={handleOpenChat}
                      className="w-full flex items-center justify-between px-2 py-1.5 rounded-xl bg-white/[0.03] border border-white/10 hover:bg-white/[0.06] transition-colors"
                    >
                      <div className="flex items-center gap-2">
                        <svg className="w-4 h-4 text-emerald-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path
                            strokeLinecap="round"
                            strokeLinejoin="round"
                            strokeWidth={1.5}
                            d="M15 17h5l-1.405-1.405A2.032 2.032 0 0118 14.158V11a6.002 6.002 0 00-4-5.659V5a2 2 0 10-4 0v.341C7.67 6.165 6 8.388 6 11v3.159c0 .538-.214 1.055-.595 1.436L4 17h5m6 0v1a3 3 0 11-6 0v-1m6 0H9"
                          />
                        </svg>
                        <span className="text-white/70 text-sm">{unreadCount} notification{unreadCount !== 1 ? 's' : ''}</span>
                      </div>
                      <span className="text-[10px] text-white/20">{unreadCount}</span>
                    </button>
                  )}

                  <button
                    onClick={handleOpenChat}
                    className="w-full flex items-center gap-2 px-2 py-1.5 rounded-xl bg-white/[0.03] border border-white/10 hover:bg-white/[0.06] transition-colors"
                  >
                    <svg className="w-4 h-4 text-emerald-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        strokeWidth={1.5}
                        d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z"
                      />
                    </svg>
                    <span className="text-white/70 text-sm">Open Chat</span>
                  </button>

                  <button
                    onClick={handleDisconnect}
                    className="w-full flex items-center gap-2 px-2 py-1.5 rounded-xl bg-white/[0.03] border border-white/10 hover:bg-red-500/10 hover:border-red-400/30 transition-colors"
                  >
                    <svg className="w-4 h-4 text-white/40" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        strokeWidth={1.5}
                        d="M17 16l4-4m0 0l-4-4m4 4H7m6 4v1a3 3 0 01-3 3H6a3 3 0 01-3-3V7a3 3 0 013-3h4a3 3 0 013 3v1"
                      />
                    </svg>
                    <span className="text-white/50 text-sm">Disconnect</span>
                  </button>
                </>
              ) : (
                <button
                  onClick={handleConnect}
                  className="w-full flex items-center gap-2 px-2 py-1.5 rounded-xl bg-emerald-500/15 border border-emerald-400/25 hover:bg-emerald-500/25 transition-colors"
                >
                  <svg className="w-4 h-4 text-emerald-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      strokeWidth={1.5}
                      d="M13.828 10.172a4 4 0 00-5.656 0l-4 4a4 4 0 105.656 5.656l1.102-1.101m-.758-4.899a4 4 0 005.656 0l4-4a4 4 0 00-5.656-5.656l-1.1 1.1"
                    />
                  </svg>
                  <span className="text-emerald-300 text-sm">Connect</span>
                </button>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
