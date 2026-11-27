import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { toast } from "sonner";
import { Loader2, Swords, Users, Shuffle, Trophy, Timer, UserPlus, LayoutGrid, CheckCircle2, X, Lock } from "lucide-react";
import { useApp } from "@/context/AppContext";
import { errMsg } from "@/lib/api";
import { CoinIcon, formatCoins } from "@/components/coins/Coins";

// Free table plus the coin stake tables (from GET /wallet: entry, payout, level lock, affordability).
function TablePicker({ tiers, selected, onSelect }) {
  const options = [{ id: "free", name: "Free table", free: true, unlocked: true, affordable: true }, ...tiers];
  return (
    <div className="mx-auto mt-6 grid max-w-2xl grid-cols-2 gap-2 text-left sm:grid-cols-5" role="radiogroup" aria-label="Choose a table" data-testid="table-picker">
      {options.map((t) => {
        const usable = t.unlocked && t.affordable;
        const active = selected === t.id;
        return (
          <button key={t.id} type="button" role="radio" aria-checked={active} disabled={!usable}
            onClick={() => onSelect(t.id)} data-testid={`table-option-${t.id}`}
            className={`relative rounded-2xl border p-3 transition-colors ${active ? "border-amber-300 bg-amber-300/15 shadow-[0_0_24px_-10px_rgba(251,191,36,.7)]"
              : usable ? "border-white/10 bg-black/25 hover:border-white/25" : "border-white/5 bg-black/20 opacity-55"}`}>
            <div className={`break-words text-xs font-bold leading-tight text-white ${t.unlocked ? "" : "pr-9"}`}>{t.name}</div>
            {t.free ? (
              <div className="mt-1 text-[11px] text-white/55">No coins needed</div>
            ) : (
              <>
                <div className="mt-1 flex items-center gap-1 text-[11px] text-white/60"><CoinIcon size={11} />{formatCoins(t.entry)} entry</div>
                <div className="text-[11px] font-semibold text-emerald-300">Win {formatCoins(t.payout)}</div>
              </>
            )}
            {!t.unlocked && <span className="absolute right-2 top-2 inline-flex items-center gap-0.5 text-[9px] font-bold text-white/60"><Lock size={9} />Lv {t.min_level}</span>}
          </button>
        );
      })}
    </div>
  );
}

const RULE_CHIPS = [
  { label: "4 players", Icon: Users },
  { label: "Random partners", Icon: Shuffle },
  { label: "First to 7", Icon: Trophy },
  { label: "30s turns", Icon: Timer },
];

const STEPS = [
  { Icon: UserPlus, title: "Join the queue", text: "You are matched with the next three players." },
  { Icon: LayoutGrid, title: "Take your seat", text: "Teams are drawn at random, partners opposite." },
  { Icon: CheckCircle2, title: "Ready up", text: "Everyone confirms within 60 seconds, then the deal begins." },
];

function formatElapsed(seconds) {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}

// The matching table: four seats around the felt that fill as players join the queue. Seat 0 (bottom)
// is you once you are queued. Partners sit opposite: bottom/top are one team, left/right the other.
function QueueTable({ queued, found }) {
  const seats = [
    { pos: "left-1/2 bottom-0 -translate-x-1/2 translate-y-1/2", team: "sky", you: true },
    { pos: "right-0 top-1/2 translate-x-1/2 -translate-y-1/2", team: "amber" },
    { pos: "left-1/2 top-0 -translate-x-1/2 -translate-y-1/2", team: "sky" },
    { pos: "left-0 top-1/2 -translate-x-1/2 -translate-y-1/2", team: "amber" },
  ];
  return (
    <div className="relative mx-auto mt-10 h-44 w-64 sm:h-52 sm:w-80" data-testid="queue-table" aria-hidden="true">
      {queued && (
        <>
          <span className="absolute inset-0 animate-ping rounded-[42%] border-2 border-amber-300/30" style={{ animationDuration: "2.4s" }} />
          <span className="absolute -inset-4 animate-ping rounded-[44%] border border-amber-300/15" style={{ animationDuration: "2.4s", animationDelay: "0.8s" }} />
        </>
      )}
      <div className="felt absolute inset-0 rounded-[42%] border-[7px] border-[#6b3f1d] shadow-[inset_0_0_30px_rgba(0,0,0,.6),0_24px_50px_-20px_rgba(0,0,0,.95)]" />
      <div className="absolute inset-0 flex items-center justify-center">
        {[0, 1, 2, 3].map((i) => (
          <div key={i} className="absolute h-14 w-10 rounded-md border border-amber-300/40 bg-gradient-to-br from-indigo-900 via-blue-950 to-slate-950 shadow-[0_6px_14px_rgba(0,0,0,.6)] transition-transform duration-700"
            style={{ transform: `rotate(${(i - 1.5) * 14}deg) translateX(${(i - 1.5) * 16}px)` }}>
            <div className="m-1 h-[calc(100%-8px)] rounded-[3px] border border-amber-300/25 bg-[repeating-linear-gradient(45deg,rgba(251,191,36,.12)_0_2px,transparent_2px_6px)]" />
          </div>
        ))}
      </div>
      {seats.map((seat, i) => {
        const filled = queued && i < found;
        const ring = seat.team === "sky" ? "ring-sky-300 bg-sky-400/25" : "ring-amber-300 bg-amber-400/25";
        return (
          <div key={i} className={`absolute ${seat.pos}`} data-testid={`queue-seat-${i}`} data-filled={filled ? "true" : "false"}>
            <div className={`flex h-11 w-11 items-center justify-center rounded-full border-2 border-[#0b1222] ring-2 transition-all duration-500 sm:h-12 sm:w-12 ${filled ? `${ring} shadow-[0_0_18px_rgba(251,191,36,.35)]` : "bg-black/50 ring-white/15"}`}>
              {filled ? <Users size={18} className="text-white" /> : <span className={`h-2 w-2 rounded-full bg-white/25 ${queued ? "animate-pulse" : ""}`} />}
            </div>
            {seat.you && queued && (
              <span className="absolute left-1/2 top-full mt-1 -translate-x-1/2 whitespace-nowrap rounded-full bg-amber-300 px-1.5 py-px text-[9px] font-black uppercase tracking-wider text-slate-950">You</span>
            )}
          </div>
        );
      })}
    </div>
  );
}

export default function Matchmaking() {
  const { api } = useApp();
  const navigate = useNavigate();
  const [status, setStatus] = useState({ queued: false, waiting: 0 });
  const [searchingSince, setSearchingSince] = useState(null);
  const [now, setNow] = useState(() => Date.now());
  const queuedRef = useRef(false);
  const [tiers, setTiers] = useState([]);
  const [selected, setSelected] = useState(() => new URLSearchParams(window.location.search).get("tier") || "free");
  useEffect(() => {
    api.get("/wallet").then((r) => setTiers(Array.isArray(r.data?.tiers) ? r.data.tiers : [])).catch(() => {});
  }, [api]);

  const apply = (d) => {
    queuedRef.current = d.queued;
    setStatus(d);
    setSearchingSince((since) => (d.queued ? since ?? Date.now() : null));
    if (d.room_code) navigate(`/room/${d.room_code}`);
  };

  useEffect(() => {
    api.get("/matchmaking/status").then((r) => apply(r.data)).catch(() => {});
    const t = setInterval(() => {
      if (queuedRef.current) api.get("/matchmaking/status").then((r) => apply(r.data)).catch(() => {});
    }, 3000);
    return () => {
      clearInterval(t);
      if (queuedRef.current) api.post("/matchmaking/leave").catch(() => {});
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!searchingSince) return undefined;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [searchingSince]);

  const join = async () => {
    try {
      const res = selected === "free" ? await api.post("/matchmaking/join") : await api.post("/matchmaking/join", { tier: selected });
      apply(res.data);
    } catch (e) { toast.error(errMsg(e)); }
  };
  const stake = status.stake || tiers.find((t) => t.id === selected) || null;
  const queuedStake = status.queued ? status.stake : null;
  const leave = async () => {
    await api.post("/matchmaking/leave");
    apply({ queued: false, waiting: Math.max(0, status.waiting - 1) });
  };

  const found = Math.min(4, Math.max(status.queued ? 1 : 0, status.waiting || 0));
  const elapsed = searchingSince ? Math.max(0, Math.floor((now - searchingSince) / 1000)) : 0;
  const othersWaiting = Math.max(0, status.waiting || 0);

  return (
    <div className="mx-auto max-w-3xl py-2 sm:py-6" data-testid="matchmaking-page">
      <section className="relative overflow-hidden rounded-3xl border border-amber-300/25 bg-gradient-to-b from-[#0f2a20] via-[#0a1a14] to-[#070f0c] px-5 pb-8 pt-7 text-center shadow-[0_30px_70px_-30px_rgba(0,0,0,.95)] sm:px-10 sm:pt-9">
        <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(ellipse_at_50%_0%,rgba(251,191,36,.16),transparent_60%)]" aria-hidden="true" />
        <div className="relative">
          <p className="eyebrow !text-amber-200/70">Public matchmaking</p>
          <h1 className="mt-2 font-display text-4xl text-amber-50 sm:text-5xl">Find a table</h1>
          <p className="mx-auto mt-3 max-w-lg text-sm text-emerald-50/70 sm:text-base">
            We seat four players, split them into random teams with partners opposite each other, and start once everyone is ready.
          </p>
          <div className="mt-4 flex flex-wrap justify-center gap-2" data-testid="matchmaking-rules">
            {RULE_CHIPS.map(({ label, Icon }) => (
              <span key={label} className="inline-flex items-center gap-1.5 rounded-full border border-white/15 bg-black/30 px-2.5 py-1 text-[11px] font-semibold uppercase tracking-wider text-white/80">
                <Icon size={12} className="text-amber-300" aria-hidden="true" />{label}
              </span>
            ))}
          </div>

          {!status.queued && <TablePicker tiers={tiers} selected={selected} onSelect={setSelected} />}

          <QueueTable queued={status.queued} found={found} />

          {status.queued ? (
            <div className="mx-auto mt-12 max-w-sm rounded-2xl border border-amber-300/30 bg-black/35 p-4 shadow-[inset_0_1px_0_rgba(255,255,255,.06)]" data-testid="queue-panel">
              <div className="flex items-center justify-center gap-2 font-semibold text-amber-200" data-testid="queue-status" aria-live="polite">
                <Loader2 className="animate-spin" size={18} aria-hidden="true" /> Searching… {found}/4 players in queue
              </div>
              {queuedStake && (
                <div className="mt-2 flex items-center justify-center gap-1.5 text-xs text-white/70" data-testid="queue-stake">
                  {queuedStake.name} · <CoinIcon size={12} /> {formatCoins(queuedStake.entry)} entry · win {formatCoins(queuedStake.payout)}
                </div>
              )}
              <div className="mt-3 h-1.5 overflow-hidden rounded-full bg-white/10" role="progressbar" aria-label="Players found" aria-valuemin={0} aria-valuemax={4} aria-valuenow={found}>
                <div className="h-full rounded-full bg-gradient-to-r from-amber-300 to-amber-500 transition-[width] duration-500" style={{ width: `${(found / 4) * 100}%` }} />
              </div>
              <div className="mt-3 grid grid-cols-2 gap-2 text-left">
                <div className="rounded-xl bg-white/5 px-3 py-2">
                  <div className="text-[10px] uppercase tracking-wider text-white/45">Queue position</div>
                  <div className="font-mono text-lg font-bold text-white" data-testid="queue-position">{status.position ? `#${status.position}` : "—"}</div>
                </div>
                <div className="rounded-xl bg-white/5 px-3 py-2">
                  <div className="text-[10px] uppercase tracking-wider text-white/45">Searching for</div>
                  <div className="font-mono text-lg font-bold text-white" data-testid="queue-elapsed">{formatElapsed(elapsed)}</div>
                </div>
              </div>
              <button className="btn-ghost mt-4 w-full !border-white/15 !bg-white/5 text-white" onClick={leave} data-testid="leave-queue-btn">
                <X size={16} aria-hidden="true" /> Leave queue
              </button>
            </div>
          ) : (
            <div className="mt-12">
              <button className="btn-gold px-10 py-3.5 text-base shadow-[0_12px_30px_-10px_rgba(251,191,36,.6)]" onClick={join} data-testid="join-queue-btn">
                <Swords size={18} aria-hidden="true" /> {selected !== "free" && stake ? `Join for ${formatCoins(stake.entry)} coins` : "Join queue"}
              </button>
              <p className="mt-3 text-xs text-white/50" data-testid="queue-waiting-now">
                {othersWaiting ? `${othersWaiting} player${othersWaiting === 1 ? "" : "s"} waiting right now` : "Be the first at the table"}
              </p>
            </div>
          )}
        </div>
      </section>

      <section className="mt-6 grid gap-3 sm:grid-cols-3" aria-label="How matchmaking works">
        {STEPS.map(({ Icon, title, text }, i) => (
          <div key={title} className="relative rounded-2xl border border-white/10 bg-gradient-to-b from-white/[0.05] to-transparent p-4">
            <div className="flex items-center gap-2">
              <span className="flex h-7 w-7 items-center justify-center rounded-full bg-amber-300/15 font-mono text-xs font-bold text-amber-200">{i + 1}</span>
              <Icon size={16} className="text-amber-300" aria-hidden="true" />
              <span className="font-semibold">{title}</span>
            </div>
            <p className="mt-2 text-sm text-muted-foreground">{text}</p>
          </div>
        ))}
      </section>
    </div>
  );
}
