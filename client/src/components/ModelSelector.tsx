import type { OllamaModel } from "../types";

interface Props {
  models: OllamaModel[];
  selectedId: string;
  onChange: (modelId: string) => void;
  disabled?: boolean;
}

export function ModelSelector({ models, selectedId, onChange, disabled }: Props) {
  return (
    <select
      value={selectedId}
      onChange={(e) => onChange(e.target.value)}
      disabled={disabled}
      className="bg-white/5 border border-white/15 rounded-lg px-3 py-1.5 text-sm text-white/80 outline-none hover:bg-white/10 focus:ring-2 focus:ring-blue-400/30 transition-all disabled:opacity-40 cursor-pointer appearance-none"
      style={{ backgroundImage: "none" }}
    >
      {models.map((m) => (
        <option key={m.id} value={m.id} className="bg-slate-900 text-white">
          {m.name}
        </option>
      ))}
    </select>
  );
}
