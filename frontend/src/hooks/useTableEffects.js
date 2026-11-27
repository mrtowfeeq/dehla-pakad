import { useEffect, useRef, useState } from "react";
import { sound } from "@/lib/sound";
import { cardRank, SUIT_NAME, TEAM_NAME } from "@/lib/api";

const STAGES = [5, 4, 4];
// Captured-ten animation timing, shared with TenFlight so the landing sound matches the landing.
export const TEN_LAND_MS = 1300;     // pop (450ms) + arc (850ms) until the ten reaches the tens counter
export const TEN_FLIGHT_MS = 2300;   // whole effect including the landing burst and "+1 ten" label
export const TEN_STAGGER_MS = 220;   // gap between several tens captured in the same trick
// Trick-won effect: the finished trick stays in the centre for 1.5s (GameTable's last-trick flash), then
// its cards slide to the winner (~0.45s). The burst and chime fire as they arrive at the winner's seat.
export const TRICK_ARRIVE_MS = 1900;
export const TRICK_BURST_MS = 1000;
export const prefersReducedMotion = () => !!window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;

// Turns authoritative server state transitions into synchronized sounds + client-side animations.
// localPlays: the table already played the "place" sound when you tapped your card (instant play), so the
// sound is not repeated when the server confirms it.
export function useTableEffects(g, onPresence, { localPlays = false } = {}) {
  const st = g?.state;
  const prev = useRef(null);
  const prevPlayers = useRef(null);
  const timers = useRef([]);
  const queueEnd = useRef(0);
  const [flying, setFlying] = useState([]);
  const [pending, setPending] = useState([0, 0, 0, 0]);
  const [hidden, setHidden] = useState(() => new Set());
  const [dealing, setDealing] = useState(false);
  const [tenFlights, setTenFlights] = useState([]);
  const [trickWin, setTrickWin] = useState(null);
  const [announce, setAnnounce] = useState(null);

  const later = (fn, ms) => { timers.current.push(setTimeout(fn, Math.max(0, ms))); };
  const afterDeal = () => Math.max(0, queueEnd.current - performance.now());
  const say = (a) => { const id = Date.now() + Math.random(); setAnnounce({ ...a, id }); later(() => setAnnounce((x) => (x?.id === id ? null : x)), a.ms || 2400); };

  useEffect(() => () => { timers.current.forEach(clearTimeout); sound.stopAll(); }, []);

  const scheduleDeal = (packets, myNew, mySeat, perCard, perPacket, intro) => {
    const rm = prefersReducedMotion();
    const now = performance.now();
    let t = afterDeal() + (rm ? 0 : intro);
    const mine = [...myNew];
    setHidden((h) => new Set([...h, ...myNew]));
    setPending((p) => { const q = [...p]; packets.forEach(({ seat, n }) => { q[seat] += n; }); return q; });
    setDealing(true);
    if (rm) later(() => sound.play("deal_rapid"), t);
    packets.forEach(({ seat, n }) => {
      for (let i = 0; i < n; i++) {
        later(() => {
          const id = `${Date.now()}-${Math.random()}`;
          if (!rm) { setFlying((f) => [...f, { id, seat }]); sound.play("deal", { minGap: 18, gain: 0.85 }); }
          later(() => {
            if (!rm) setFlying((f) => f.filter((x) => x.id !== id));
            setPending((p) => { const q = [...p]; q[seat] = Math.max(0, q[seat] - 1); return q; });
            if (seat === mySeat && mine.length) {
              const c = mine.shift();
              setHidden((h) => { const s = new Set(h); s.delete(c); return s; });
            }
          }, rm ? 0 : 330);
        }, t);
        t += rm ? 0 : perCard;
      }
      t += rm ? 0 : perPacket;
    });
    queueEnd.current = now + t + 360;
    later(() => { if (performance.now() >= queueEnd.current - 10) setDealing(false); }, t + 380);
  };

  useEffect(() => {
    if (!g) return;
    const old = prevPlayers.current;
    prevPlayers.current = g.players;
    if (!old || g.status !== "active") return;
    g.players.forEach((pl) => {
      const o = old.find((x) => x.seat === pl.seat);
      if (o && o.online !== pl.online && !pl.is_bot) {
        sound.play(pl.online ? "reconnect" : "disconnect");
        onPresence?.(pl);
      }
    });
  }, [g]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!st) return;
    const p = prev.current;
    prev.current = st;
    if (g.status !== "active" && st.phase !== "match_over") return;
    const my = st.my_seat;
    const myTeam = my % 2;
    const order = [0, 1, 2, 3].map((i) => (st.dealer + 1 + i) % 4);
    const sameRound = p && p.round_no === st.round_no;

    // Dealing follows the real 5 + 4 + 4 sequence, one card at a time from the dealer's right.
    const fromStage = sameRound ? p.deal_stage : p ? 0 : st.phase === "trump_select" ? 0 : st.deal_stage;
    if (st.deal_stage > fromStage) {
      const packets = [];
      for (let s = fromStage; s < st.deal_stage; s++) order.forEach((seat) => packets.push({ seat, n: STAGES[s] }));
      const known = sameRound ? new Set(p.hand) : new Set();
      const fresh = fromStage === 0;
      if (fresh && !prefersReducedMotion()) {
        later(() => sound.play("shuffle"), afterDeal());
        later(() => sound.play("cut"), afterDeal() + 1150);
        later(() => sound.play("deck_place"), afterDeal() + 1500);
      } else if (!fresh) {
        later(() => sound.play("deal_rapid", { gain: 0.6 }), afterDeal() + 150);
      }
      scheduleDeal(packets, st.hand.filter((c) => !known.has(c)), my, fresh ? 85 : 48, fresh ? 150 : 100, fresh ? 1750 : 420);
      if (st.phase === "trump_select" && st.trump_selector === my) later(() => sound.play("turn"), afterDeal() + 100);
    }
    if (!p) return;

    if (!p.trump && st.trump && sameRound) {
      sound.play("trump");
      sound.play("flip", { delay: 140 });
      say({ title: `Trump · ${SUIT_NAME[st.trump]}`, kind: "trump", suit: st.trump, ms: 1800 });
    }

    if (sameRound) {
      const completed = st.tricks_played > p.tricks_played;
      const plays = completed && st.last_trick ? st.last_trick.cards.slice(p.trick.length) : st.trick.slice(p.trick.length);
      plays.forEach(([seat]) => {
        const rel = (seat - my + 4) % 4;
        if (rel === 0) { if (!localPlays) sound.play("place", { delay: 170, minGap: 0 }); }
        else if (rel === 2) { sound.play("slide", { gain: 0.6, rate: 1.05 }); sound.play("place", { delay: 230, rate: 1.06, minGap: 0 }); }
        else { sound.play("slide", { gain: 0.6, rate: 0.94 }); sound.play("place", { delay: 230, rate: 0.92, minGap: 0 }); }
      });
      if (completed && st.last_trick) {
        const wTeam = st.last_trick.winner % 2;
        later(() => sound.play(wTeam === myTeam ? "trick_won" : "trick_lost"), 650);
        later(() => sound.play("collect"), 1350);
        const trickWin = { id: `${st.round_no}-${st.tricks_played}`, seat: st.last_trick.winner, mine: wTeam === myTeam };
        later(() => {
          setTrickWin(trickWin);
          sound.chime(trickWin.mine ? "trick_gain" : "trick_loss");
        }, TRICK_ARRIVE_MS);
        later(() => setTrickWin((w) => (w?.id === trickWin.id ? null : w)), TRICK_ARRIVE_MS + TRICK_BURST_MS);
        const tens = st.last_trick.cards.filter(([, c]) => cardRank(c) === "10").map(([, c]) => c);
        if (tens.length) {
          // Each captured ten pops in the centre, arcs to the winning team's tens counter and lands there
          // (see TenFlight). Several tens in one trick follow each other TEN_STAGGER_MS apart.
          const mine = wTeam === myTeam;
          later(() => {
            sound.play("ten");
            sound.chime(mine ? "ten_gain" : "ten_loss", { delay: 120 });
            setTenFlights((f) => [...f, ...tens.map((c, i) => ({ id: `${st.round_no}-${c}`, card: c, team: wTeam, mine, order: i }))]);
          }, 900);
          tens.forEach((_, i) => later(() => sound.chime("ten_land", { gain: mine ? 1 : 0.6 }), 900 + TEN_LAND_MS + i * TEN_STAGGER_MS));
          later(() => setTenFlights((f) => f.filter((x) => !tens.includes(x.card))), 900 + TEN_FLIGHT_MS + (tens.length - 1) * TEN_STAGGER_MS);
          const total = st.tens[0].length + st.tens[1].length;
          const afterLanding = 900 + TEN_LAND_MS + (tens.length - 1) * TEN_STAGGER_MS + 150;
          if (total === 4 && p.tens[0].length + p.tens[1].length < 4) later(() => sound.play("fourth_ten"), afterLanding);
          else if (p.tens[wTeam].length < 3 && st.tens[wTeam].length >= 3) later(() => sound.play("third_ten"), afterLanding);
        }
      }
      if (st.phase === "playing" && st.turn === my && (p.turn !== my || p.phase !== "playing")) {
        later(() => sound.play("turn"), (completed ? 1600 : 250) + afterDeal());
      }
    }

    if (st.phase === "koth_decision" && p.phase !== "koth_decision") later(() => sound.play("koth_available"), 1100);
    if (st.koth !== null && p.koth === null) {
      later(() => sound.play("koth_declared"), 150);
      say({ title: "Koth declared", sub: `${TEAM_NAME[st.koth]} · the fourth ten decides`, kind: "koth" });
    }
    if (st.phase === "gs_decision" && p.phase !== "gs_decision") later(() => sound.play("gs_available"), 1100);
    if (st.gs_declared !== null && p.gs_declared === null) {
      later(() => sound.play("gs_declared"), 150);
      say({ title: "Grand Slam · 13 Mann", sub: `${TEAM_NAME[st.gs_declared]} must win every remaining trick`, kind: "gs", ms: 2800 });
    }

    if (st.rounds.length > p.rounds.length) {
      const r = st.rounds[st.rounds.length - 1];
      const won = r.winner_team === myTeam;
      const key = r.type === "normal" ? "normal_win" : r.type === "koth" ? (won ? "koth_won" : "koth_lost") : won ? "gs_won" : "gs_lost";
      later(() => sound.play(key), 1500);
      if (st.phase === "match_over") later(() => sound.chime(st.winner_team === myTeam ? "victory" : "defeat"), 3300);
    } else if (st.phase === "match_over" && p.phase !== "match_over") {
      sound.chime(st.winner_team === myTeam ? "victory" : "defeat");
    }
  }, [st]); // eslint-disable-line react-hooks/exhaustive-deps

  const stop = () => { timers.current.forEach(clearTimeout); timers.current = []; sound.stopAll(); setFlying([]); setTenFlights([]); setTrickWin(null); };
  return { flying, pending, hidden, dealing, tenFlights, trickWin, announce, stop };
}
