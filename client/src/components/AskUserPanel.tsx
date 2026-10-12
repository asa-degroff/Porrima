import type { PendingAsk } from "../types";

interface Props {
  ask: PendingAsk;
  disabled?: boolean;
  /** Send the chosen option as the answer. */
  onSelect: (option: string) => void;
  /** Focus the free-form editor (the always-available custom answer path). */
  onCustomAnswer: () => void;
}

/**
 * Answer picker for a pending ask_user pause. Rendered inside the composer
 * surface while the agent waits: the question (normally only visible in the
 * collapsed tool card) plus its preset choices as selectable rows, styled
 * after the ui/Dropdown panel pattern.
 *
 * Free-form input is first-class here (mirrors the opencode question-tool
 * convention): the "Type your own answer" row focuses the editor, and the
 * composer below stays live while the picker is up. The tool schema tells
 * the model not to add its own "Other" catch-all — this UI owns that path.
 */
export function AskUserPanel({ ask, disabled, onSelect, onCustomAnswer }: Props) {
  const options = ask.options ?? [];

  return (
    <div
      role="group"
      aria-label="Agent question"
      className="mb-2 rounded-xl border border-amber-400/25 bg-amber-400/[0.06] depth-raised animate-dropdown-enter"
    >
      <div className="px-3 pt-2.5 pb-1.5 text-sm text-white/85 leading-relaxed whitespace-pre-wrap break-words">
        {ask.question}
      </div>
      {options.length > 0 && (
        <div className="px-2 pb-2 flex flex-col gap-1">
          {options.map((option, i) => (
            <button
              key={`${option}-${i}`}
              onClick={() => onSelect(option)}
              disabled={disabled}
              data-haptic="manual"
              className="w-full text-left px-3 py-2 rounded-lg text-sm text-white/80 bg-white/5 border border-white/10 hover:bg-white/10 hover:text-white/95 transition-all disabled:opacity-40 disabled:cursor-not-allowed pressable"
            >
              {option}
            </button>
          ))}
          <button
            onClick={onCustomAnswer}
            disabled={disabled}
            className="w-full text-left px-3 py-1.5 rounded-lg text-xs text-white/45 hover:text-white/75 hover:bg-white/5 border border-dashed border-white/15 transition-all disabled:opacity-40 pressable"
          >
            Type your own answer…
          </button>
        </div>
      )}
    </div>
  );
}
