import { useState, useEffect, useRef } from "react";

interface Props {
  isOnline: boolean;
  queueProcessing: boolean;
  queuedCount?: number;
}

export function OfflineIndicator({ isOnline, queueProcessing, queuedCount = 0 }: Props) {
  const [showOnline, setShowOnline] = useState(false);
  const wasOfflineRef = useRef(false);

  useEffect(() => {
    if (!isOnline) {
      wasOfflineRef.current = true;
    } else if (wasOfflineRef.current && !queueProcessing) {
      setShowOnline(true);
      const timer = setTimeout(() => setShowOnline(false), 3000);
      return () => clearTimeout(timer);
    }
  }, [isOnline, queueProcessing]);

  if (queueProcessing) {
    return (
      <span className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-[11px] font-medium bg-amber-500/20 text-amber-300 border border-amber-400/20 animate-pulse">
        <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
          <path d="M12 2v4M12 18v4M4.93 4.93l2.83 2.83M16.24 16.24l2.83 2.83M2 12h4M18 12h4M4.93 19.07l2.83-2.83M16.24 7.76l2.83-2.83" />
        </svg>
        Syncing...
      </span>
    );
  }

  if (!isOnline) {
    return (
      <span className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-[11px] font-medium bg-red-500/20 text-red-300 border border-red-400/20">
        <span className="w-1.5 h-1.5 rounded-full bg-red-400" />
        Offline{queuedCount > 0 ? ` · ${queuedCount} queued` : ""}
      </span>
    );
  }

  if (showOnline) {
    return (
      <span className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-[11px] font-medium bg-green-500/20 text-green-300 border border-green-400/20">
        <span className="w-1.5 h-1.5 rounded-full bg-green-400" />
        Back online
      </span>
    );
  }

  return null;
}
