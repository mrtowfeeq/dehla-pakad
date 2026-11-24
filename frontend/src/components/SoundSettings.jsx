import { useEffect, useState } from "react";
import { Volume2, VolumeX } from "lucide-react";
import { Slider } from "@/components/ui/slider";
import { Switch } from "@/components/ui/switch";
import { sound } from "@/lib/sound";

export function useSoundPrefs() {
  const [p, setP] = useState(sound.prefs);
  useEffect(() => { setP(sound.prefs); return sound.subscribe(setP); }, []);
  return p;
}

const ROWS = [
  ["master", "Master volume"],
  ["card", "Card sounds"],
  ["game", "Game events"],
  ["ambience", "Background ambience"],
];

export function SoundSettings({ dark }) {
  const p = useSoundPrefs();
  const label = dark ? "text-white/80" : "text-foreground";
  return (
    <div className="space-y-5" data-testid="sound-settings-panel">
      <button type="button" data-testid="sound-mute-toggle" data-sound="none"
        onClick={() => { sound.unlock(); sound.update({ muted: !p.muted }); if (p.muted) setTimeout(() => sound.play("toggle"), 60); }}
        className={`w-full inline-flex items-center justify-center gap-2 rounded-xl px-4 py-2.5 font-semibold border transition-colors ${p.muted ? "border-rose-500/60 text-rose-400" : "border-emerald-500/50 text-emerald-400"}`}>
        {p.muted ? <VolumeX size={18} /> : <Volume2 size={18} />} {p.muted ? "Sound muted — tap to unmute" : "Sound on — tap to mute"}
      </button>
      {ROWS.map(([k, l]) => (
        <div key={k} className={p.muted ? "opacity-50" : ""}>
          <div className={`flex justify-between text-sm mb-2 ${label}`}>
            <span>{l}</span><span className="font-mono text-xs" data-testid={`sound-${k}-value`}>{Math.round(p[k] * 100)}%</span>
          </div>
          <Slider data-testid={`sound-${k}-slider`} value={[Math.round(p[k] * 100)]} max={100} step={5}
            onValueChange={([v]) => sound.update({ [k]: v / 100 })}
            onValueCommit={() => sound.play(k === "card" || k === "master" ? "place" : k === "ambience" ? "amb_chips" : "success", { category: k === "ambience" ? "ambience" : undefined })} />
        </div>
      ))}
      <label className={`flex items-center justify-between text-sm ${label}`}>
        <span>Table ambience (room tone & soft table sounds)</span>
        <Switch data-testid="sound-ambience-switch" checked={p.ambienceOn}
          onCheckedChange={(v) => { sound.unlock(); sound.update({ ambienceOn: v }); sound.play("toggle"); }} />
      </label>
      <p className={`text-[11px] ${dark ? "text-white/45" : "text-muted-foreground"}`}>Sounds start after your first tap or click (browser rule). Saved on this device for your account.</p>
    </div>
  );
}
