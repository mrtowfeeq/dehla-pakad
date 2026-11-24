import { PlayerAvatar } from "@/components/PlayerAvatar";

export function AvatarPicker({ me, color, icon, onColor, onIcon, username }) {
  return (
    <div className="space-y-4" data-testid="avatar-picker">
      <div className="flex items-center gap-4">
        <PlayerAvatar user={{ avatar_color: color, avatar_icon: icon, username }} size={64} />
        <div className="text-sm text-muted-foreground">Pick a colour and an emblem.</div>
      </div>
      <div className="flex flex-wrap gap-2">
        {me.avatar_colors.map((c) => (
          <button type="button" key={c} onClick={() => onColor(c)} data-testid={`avatar-color-${c.slice(1)}`}
            className={`h-8 w-8 rounded-full transition-transform hover:scale-110 ${color === c ? "ring-2 ring-offset-2 ring-offset-background ring-foreground" : ""}`}
            style={{ background: c }} aria-label={`colour ${c}`} />
        ))}
      </div>
      <div className="flex flex-wrap gap-2">
        {me.avatar_icons.map((i) => (
          <button type="button" key={i} onClick={() => onIcon(i)} data-testid={`avatar-icon-${i}`}
            className={`rounded-full p-0.5 transition-transform hover:scale-110 ${icon === i ? "ring-2 ring-primary" : ""}`}>
            <PlayerAvatar user={{ avatar_color: color, avatar_icon: i }} size={36} />
          </button>
        ))}
      </div>
    </div>
  );
}
