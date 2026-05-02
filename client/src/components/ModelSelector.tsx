import { useMemo } from "react";
import type { OllamaModel } from "../types";
import { ProviderIcon } from "./ProviderIcon";
import { Dropdown } from "./ui/Dropdown";
import { useDropdown } from "../hooks/useDropdown";

interface Props {
  models: OllamaModel[];
  selectedId: string;
  onChange: (modelId: string) => void;
  disabled?: boolean;
}

export function ModelSelector({ models, selectedId, onChange, disabled }: Props) {
  const dd = useDropdown();
  const selected = models.find((m) => m.id === selectedId);

  // Group models by provider — only show headers when multiple providers exist
  const { groups, hasMultipleProviders } = useMemo(() => {
    const ollamaModels = models.filter((m) => !m.provider || m.provider === "ollama");
    const llamacppModels = models.filter((m) => m.provider === "llamacpp");
    const multi = ollamaModels.length > 0 && llamacppModels.length > 0;
    const g: Array<{ label: string; provider: string; models: OllamaModel[] }> = [];
    if (ollamaModels.length > 0) g.push({ label: "Ollama", provider: "ollama", models: ollamaModels });
    if (llamacppModels.length > 0) g.push({ label: "llama.cpp", provider: "llamacpp", models: llamacppModels });
    return { groups: g, hasMultipleProviders: multi };
  }, [models]);

  return (
    <Dropdown
      state={dd}
      disabled={disabled}
      triggerClassName="flex items-center gap-1.5 bg-white/5 border border-white/15 rounded-lg px-2 md:px-3 py-1.5 text-sm text-white/80 outline-none hover:bg-white/10 transition-all disabled:opacity-40 cursor-pointer max-w-[120px] md:max-w-none"
      panelClassName="right-0 top-full mt-1 min-w-[200px] max-h-[320px] overflow-y-auto"
      trigger={
        <>
          <span className="truncate">{selected?.name || selectedId}</span>
          {selected && (
            <span className="hidden sm:inline">
              <ProviderIcon
                provider={selected.provider}
                className={selected.provider === "llamacpp" ? "text-[#ff8236] shrink-0" : "text-white/60 shrink-0"}
              />
            </span>
          )}
        </>
      }
    >
      {groups.map((group) => (
        <div key={group.provider}>
          {hasMultipleProviders && (
            <div className="px-3 py-1.5 text-[10px] uppercase tracking-wider text-white/30 font-medium border-b border-white/5">
              {group.label}
            </div>
          )}
          {group.models.map((m) => (
            <button
              key={`${m.provider || "ollama"}-${m.id}`}
              onClick={() => { onChange(m.id); dd.close(); }}
              className={`w-full text-left px-3 py-2 text-xs transition-all flex items-center gap-2 ${
                m.id === selectedId
                  ? "text-white"
                  : "text-white/60 hover:bg-white/10 hover:text-white/80"
              }`}
              style={{
                backgroundColor: m.id === selectedId ? `rgba(var(--theme-secondary), 0.15)` : 'transparent',
                color: m.id === selectedId ? `rgba(var(--theme-secondary-text))` : '',
              }}
            >
              <span className="truncate flex-1">{m.name}</span>
              {m.parameterSize && <span className="text-[10px] text-white/30 shrink-0">{m.parameterSize}</span>}
              <ProviderIcon
                provider={m.provider}
                className={m.provider === "llamacpp" ? "text-[#ff8236] shrink-0" : "text-white/40 shrink-0"}
              />
            </button>
          ))}
        </div>
      ))}
    </Dropdown>
  );
}
