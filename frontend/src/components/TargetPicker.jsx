import { useState } from "react";

const PRESETS = [5, 7, 10, 15, 21];

export function TargetPicker({ value, onChange, disabled }) {
  const [custom, setCustom] = useState(PRESETS.includes(value) ? "" : String(value));
  return (
    <div className="flex flex-wrap items-center gap-2" data-testid="target-picker">
      {PRESETS.map((p) => (
        <button key={p} type="button" disabled={disabled} onClick={() => { setCustom(""); onChange(p); }}
          data-testid={`target-option-${p}`}
          className={`h-11 w-14 rounded-xl font-mono font-bold border transition-colors disabled:opacity-60 ${value === p ? "bg-primary text-primary-foreground border-primary" : "border-border hover:border-primary/60"}`}>
          {p}
        </button>
      ))}
      <input type="number" min={1} max={99} disabled={disabled} placeholder="Custom" value={custom}
        data-testid="target-custom-input"
        onChange={(e) => { setCustom(e.target.value); const n = parseInt(e.target.value, 10); if (n >= 1 && n <= 99) onChange(n); }}
        className={`h-11 w-28 rounded-xl bg-background border px-3 font-mono outline-none focus:ring-2 focus:ring-ring ${!PRESETS.includes(value) ? "border-primary" : "border-input"}`} />
    </div>
  );
}
