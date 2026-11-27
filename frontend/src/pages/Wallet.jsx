import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { toast } from "sonner";
import { CalendarCheck, Check, Gift, History as HistoryIcon, Lock, Sparkles, Swords } from "lucide-react";
import { useApp, useSocketEvent } from "@/context/AppContext";
import { errMsg } from "@/lib/api";
import { COIN_REASON_LABEL, CoinIcon, formatCoins } from "@/components/coins/Coins";

function Panel({ icon: Icon, title, tone = "bg-amber-300/15 text-amber-200", children, testid, className = "" }) {
  return (
    <section className={`rounded-3xl border border-white/10 bg-gradient-to-b from-white/[0.05] to-white/[0.01] p-5 ${className}`} data-testid={testid}>
      <div className="mb-4 flex items-center gap-2.5">
        <span className={`flex h-9 w-9 items-center justify-center rounded-xl ${tone}`} aria-hidden="true"><Icon size={17} /></span>
        <h2 className="font-display text-lg text-amber-50">{title}</h2>
      </div>
      {children}
    </section>
  );
}

function timeUntil(iso) {
  const ms = Date.parse(iso) - Date.now();
  if (!Number.isFinite(ms) || ms <= 0) return "now";
  const h = Math.floor(ms / 3600000);
  const m = Math.ceil((ms % 3600000) / 60000);
  return h ? `${h}h ${m}m` : `${m}m`;
}

export default function Wallet() {
  const { api, me } = useApp();
  const [state, setState] = useState(null);
  const [history, setHistory] = useState(null);
  const [busy, setBusy] = useState(null);

  const load = useCallback(async () => {
    try {
      const [{ data: w }, { data: h }] = await Promise.all([api.get("/wallet"), api.get("/wallet/history")]);
      setState(w);
      setHistory(h.entries || []);
    } catch (e) { toast.error(errMsg(e)); }
  }, [api]);
  useEffect(() => { load(); }, [load]);
  // Any coin change elsewhere (a table payout, another tab) refreshes the page.
  useSocketEvent((m) => { if (m.type === "wallet") load(); });

  const claim = async (kind) => {
    setBusy(kind);
    try {
      const { data } = await api.post(`/wallet/${kind}`);
      toast.success(kind === "daily" ? `Day ${data.streak} reward: +${formatCoins(data.amount)} coins` : `+${formatCoins(data.amount)} free coins`);
      await load();
    } catch (e) { toast.error(errMsg(e)); } finally { setBusy(null); }
  };

  const coins = state?.coins ?? me?.coins;
  const daily = state?.daily;
  const topup = state?.topup;
  return (
    <div className="space-y-6" data-testid="wallet-page">
      <section className="relative overflow-hidden rounded-3xl border border-amber-300/25 bg-gradient-to-br from-[#1b2a4a] via-[#111a30] to-[#0a1120] p-5 shadow-[0_24px_60px_-30px_rgba(0,0,0,.95)] sm:p-7">
        <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(ellipse_at_80%_0%,rgba(251,191,36,.2),transparent_60%)]" aria-hidden="true" />
        <div className="relative flex flex-wrap items-center gap-4">
          <CoinIcon size={56} />
          <div className="min-w-0 flex-1">
            <p className="eyebrow !text-amber-200/70">Your coins</p>
            <div className="font-display text-4xl text-amber-100 sm:text-5xl" data-testid="wallet-balance">{formatCoins(coins)}</div>
            <p className="mt-1 text-xs text-white/55">Game coins for table entries. Earned by playing — they can't be bought or cashed out.</p>
          </div>
          <Link to="/play" className="btn-gold basis-full justify-center sm:basis-auto" data-testid="wallet-play-btn"><Swords size={16} aria-hidden="true" /> Play for coins</Link>
        </div>
      </section>

      <div className="grid gap-6 lg:grid-cols-2">
        <Panel icon={CalendarCheck} title="Daily reward" testid="wallet-daily">
          {!daily ? <p className="text-sm text-white/50">Loading…</p> : (
            <>
              <ol className="grid grid-cols-7 gap-1.5" aria-label="Seven-day reward track">
                {daily.rewards.map((amount, i) => {
                  const day = i + 1;
                  const done = daily.claimed_today ? day <= ((daily.streak - 1) % 7) + 1 : day < daily.next_day;
                  const next = !daily.claimed_today && day === daily.next_day;
                  return (
                    <li key={day} data-testid={`daily-day-${day}`} data-state={done ? "claimed" : next ? "next" : "upcoming"}
                      className={`flex flex-col items-center gap-1 rounded-xl border px-0.5 py-2 text-center ${next ? "border-amber-300 bg-amber-300/15 shadow-[0_0_18px_-6px_rgba(251,191,36,.7)]"
                        : done ? "border-emerald-300/30 bg-emerald-400/10" : "border-white/10 bg-black/20"}`}>
                      <span className="text-[9px] font-bold uppercase tracking-wider text-white/45">Day {day}</span>
                      {done ? <Check size={16} className="text-emerald-300" aria-label="Claimed" /> : <CoinIcon size={16} />}
                      <span className="font-mono text-[10px] font-bold text-amber-100">{amount}</span>
                    </li>
                  );
                })}
              </ol>
              <div className="mt-4 flex flex-wrap items-center justify-between gap-3">
                <p className="text-xs text-white/55">
                  {daily.claimed_today ? `Claimed today · ${daily.streak}-day streak. Come back tomorrow for ${formatCoins(daily.next_reward)}.`
                    : `Day ${daily.next_day}: ${formatCoins(daily.next_reward)} coins. Miss a day and the track restarts.`}
                </p>
                <button className="btn-gold !py-2" disabled={daily.claimed_today || busy === "daily"} onClick={() => claim("daily")} data-testid="wallet-claim-daily">
                  {daily.claimed_today ? <><Check size={15} /> Claimed</> : <><Gift size={15} /> Claim {formatCoins(daily.next_reward)}</>}
                </button>
              </div>
            </>
          )}
        </Panel>

        <Panel icon={Sparkles} title="Free coins" tone="bg-emerald-400/15 text-emerald-200" testid="wallet-topup">
          {!topup ? <p className="text-sm text-white/50">Loading…</p> : (
            <div className="flex flex-wrap items-center justify-between gap-3">
              <p className="max-w-xs text-sm text-white/65">
                {topup.eligible ? `Running low? Take ${formatCoins(topup.amount)} free coins.`
                  : topup.available_at ? `Your next free coins are ready in ${timeUntil(topup.available_at)}.`
                    : `If your balance drops below ${formatCoins(topup.threshold)}, you can claim ${formatCoins(topup.amount)} free coins every 4 hours.`}
              </p>
              <button className="btn-ghost" disabled={!topup.eligible || busy === "topup"} onClick={() => claim("topup")} data-testid="wallet-claim-topup">
                <Gift size={15} /> Claim {formatCoins(topup.amount)}
              </button>
            </div>
          )}
        </Panel>
      </div>

      <Panel icon={Swords} title="Stake tables" tone="bg-sky-400/15 text-sky-200" testid="wallet-tiers">
        <p className="-mt-2 mb-4 text-xs text-white/50">All four players pay the entry. The two winning partners share the pot, after a {state?.table_fee_percent ?? 10}% table fee.</p>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          {(state?.tiers || []).map((t) => (
            <div key={t.id} data-testid={`wallet-tier-${t.id}`} className={`rounded-2xl border p-4 ${t.unlocked ? "border-amber-300/30 bg-amber-300/[0.06]" : "border-white/10 bg-black/20"}`}>
              <div className="flex items-center justify-between gap-2">
                <span className="font-display text-base text-amber-50">{t.name}</span>
                {!t.unlocked && <span className="inline-flex items-center gap-1 text-[10px] font-bold text-white/50"><Lock size={11} /> Lv {t.min_level}</span>}
              </div>
              <dl className="mt-2 space-y-1 text-xs">
                <div className="flex justify-between"><dt className="text-white/50">Entry</dt><dd className="inline-flex items-center gap-1 font-mono font-bold text-white"><CoinIcon size={12} />{formatCoins(t.entry)}</dd></div>
                <div className="flex justify-between"><dt className="text-white/50">Each winner gets</dt><dd className="inline-flex items-center gap-1 font-mono font-bold text-emerald-300"><CoinIcon size={12} />{formatCoins(t.payout)}</dd></div>
              </dl>
              <Link to={`/play?tier=${t.id}`} aria-disabled={!t.unlocked || !t.affordable}
                className={`mt-3 w-full justify-center !py-1.5 text-sm ${t.unlocked && t.affordable ? "btn-gold" : "btn-ghost pointer-events-none opacity-50"}`}
                data-testid={`wallet-tier-play-${t.id}`}>
                {!t.unlocked ? `Unlocks at level ${t.min_level}` : t.affordable ? "Find a table" : "Not enough coins"}
              </Link>
            </div>
          ))}
        </div>
      </Panel>

      <Panel icon={HistoryIcon} title="Coin history" tone="bg-indigo-400/15 text-indigo-200" testid="wallet-history">
        {history === null ? <p className="text-sm text-white/50">Loading…</p> : history.length === 0 ? <p className="text-sm text-white/50">No coin activity yet.</p> : (
          <ul className="divide-y divide-white/5">
            {history.map((e) => (
              <li key={e.key} className="flex items-center justify-between gap-3 py-2.5 text-sm" data-testid={`wallet-entry-${e.key}`}>
                <div className="min-w-0">
                  <div className="font-semibold text-white/85">{COIN_REASON_LABEL[e.reason] || e.reason}</div>
                  <div className="text-[11px] text-white/40">{new Date(e.ts).toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}</div>
                </div>
                <div className="text-right">
                  <div className={`font-mono font-bold ${e.amount >= 0 ? "text-emerald-300" : "text-rose-300"}`}>{e.amount >= 0 ? "+" : "−"}{formatCoins(Math.abs(e.amount))}</div>
                  <div className="font-mono text-[10px] text-white/40">{formatCoins(e.balance_after)}</div>
                </div>
              </li>
            ))}
          </ul>
        )}
      </Panel>
    </div>
  );
}
