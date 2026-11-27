import { useEffect, useState } from "react";

const SEVERITY = {
  normal: { text: "text-emerald-200", track: "bg-emerald-950/80", fill: "bg-emerald-400" },
  warning: { text: "text-amber-200", track: "bg-amber-950/80", fill: "bg-amber-400" },
  critical: { text: "text-rose-200", track: "bg-rose-950/80", fill: "bg-rose-400" },
};

// placement "corner": badge centred on the panel's top border. "side": badge just outside the panel's
// right edge, vertically centred, for panels with no room above them (the partner's panel under the header).
const PLACEMENT = {
  corner: "-top-3.5 left-1/2 -translate-x-1/2",
  side: "left-full top-1/2 ml-1.5 -translate-y-1/2",
};

export function TurnTimer({ deadline, phase = "normal", graceDeadline, duration = 30, serverOffsetMs = 0, className = "", placement = "corner" }) {
  const [clientNow, setClientNow] = useState(() => Date.now());

  useEffect(() => {
    if (!Number.isFinite(Date.parse(deadline || ""))) return undefined;
    const tick = () => setClientNow(Date.now());
    tick();
    const interval = setInterval(tick, 250);
    return () => clearInterval(interval);
  }, [deadline, graceDeadline, phase]);

  const inGrace = phase === "grace";
  const deadlineMs = Date.parse((inGrace ? graceDeadline : deadline) || "");
  const safeDuration = Number.isFinite(duration) && duration > 0 ? duration : 30;
  if (!Number.isFinite(deadlineMs)) return null;

  const totalMs = (inGrace ? 5 : safeDuration) * 1000;
  const remainingMs = Math.min(totalMs, Math.max(0, deadlineMs - (clientNow + serverOffsetMs)));
  const remaining = Math.ceil(remainingMs / 1000);
  const severity = inGrace ? (remaining <= 2 ? "critical" : "warning") : remaining <= 5 ? "critical" : remaining <= 10 ? "warning" : "normal";
  const style = SEVERITY[severity];
  const progress = Math.max(0, Math.min(100, (remainingMs / totalMs) * 100));

  // Built into the seat panel (which must be position: relative) so it never covers the player:
  // a one-line badge sitting on the panel's top border (centred by default; `className`
  // can move it) and a thin countdown bar along the panel's bottom border.
  return (
    <>
      <div className={`pointer-events-none absolute ${PLACEMENT[placement] || PLACEMENT.corner} z-30 inline-flex h-4 items-center gap-1 whitespace-nowrap rounded-full border px-1.5 text-[9px] font-black leading-none shadow-[0_4px_10px_-3px_rgba(0,0,0,.9)] ${inGrace ? "border-amber-300/80 bg-[#2a1608]" : "border-white/20 bg-[#06120c]"} ${style.text} ${severity === "critical" ? "animate-pulse motion-reduce:animate-none" : ""} ${className}`}
        data-testid="turn-timer" data-phase={inGrace ? "grace" : "normal"} data-severity={severity} role="timer"
        aria-live={inGrace ? "assertive" : "off"} aria-label={inGrace ? `Active player is out of normal time. Automatic play in ${remaining} seconds` : `${remaining} seconds remaining`}
        title={inGrace ? `Out of time — auto-play in ${remaining}s` : undefined}>
        {inGrace && <>
          <span className="sr-only" data-testid="turn-timer-warning">OUT OF TIME · AUTO-PLAY</span>
          <span className="uppercase tracking-wide text-amber-100" aria-hidden="true">Auto</span>
        </>}
        <span className="font-mono tabular-nums" data-testid="turn-timer-seconds">{remaining}s</span>
      </div>
      <div className={`pointer-events-none absolute inset-x-3 -bottom-px z-30 h-[3px] overflow-hidden rounded-full ${style.track}`} role="progressbar"
        aria-label={inGrace ? "Automatic play grace time remaining" : "Turn time remaining"}
        aria-valuemin={0} aria-valuemax={inGrace ? 5 : safeDuration} aria-valuenow={remaining}>
        <div className={`h-full rounded-full transition-[width] duration-200 ${style.fill}`} style={{ width: `${progress}%` }} data-testid="turn-timer-progress" />
      </div>
    </>
  );
}
