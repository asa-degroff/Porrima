import type { ChatListItem as ChatListItemType } from "../types";

interface Props {
  chat: ChatListItemType;
  active: boolean;
  onSelect: () => void;
  onDelete: () => void;
}

export function ChatListItem({ chat, active, onSelect, onDelete }: Props) {
  return (
    <button
      onClick={onSelect}
      className={`w-full text-left px-3 py-2.5 rounded-xl transition-all group ${
        active
          ? "bg-white/15 border border-white/20"
          : "hover:bg-white/8 border border-transparent"
      }`}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium text-white/90 truncate">
            {chat.title}
          </p>
          {chat.preview && (
            <p className="text-xs text-white/40 truncate mt-0.5">
              {chat.preview}
            </p>
          )}
        </div>
        <button
          onClick={(e) => {
            e.stopPropagation();
            onDelete();
          }}
          className="opacity-0 group-hover:opacity-100 text-white/30 hover:text-red-400 transition-all p-0.5 shrink-0"
          title="Delete chat"
        >
          <svg
            xmlns="http://www.w3.org/2000/svg"
            width="14"
            height="14"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d="M3 6h18" />
            <path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6" />
            <path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2" />
          </svg>
        </button>
      </div>
    </button>
  );
}
