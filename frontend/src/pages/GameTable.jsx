import { useEffect, useRef, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { toast } from "sonner";
import { ArrowLeft, MessageCircle, Wifi, WifiOff, History as HistoryIcon } from "lucide-react";
import { useApp, useSocketEvent } from "@/context/AppContext";
import { errMsg, TEAM_NAME } from "@/lib/api";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Seat, TrickArea } from "@/components/game/TableParts";
import { Hand, Scoreboard, TrumpBadge } from "@/components/game/HandAndHud";
import { Banner, TrumpSelector, KothPrompt, GrandSlamPrompt, RoundResult, MatchOver } from "@/components/game/Overlays";
import { ChatPanel, ReactionBar } from "@/components/Chat";
import { PlayingCard } from "@/components/PlayingCard";
import { ThemeToggle } from "@/components/ThemeToggle";

function useLastTrickFlash(st) {
  const [flash, setFlash] = useState(null);
  const prev = useRef(st?.tricks_played);
  useEffect(() => {
    if (!st) return;
    if (prev.current !== undefined && st.tricks_played > prev.current && st.last_trick) {
      setFlash(st.last_trick);
      const t = setTimeout(() => setFlash(null), 1500);
      prev.current = st.tricks_played;
      return () => clearTimeout(t);
    }
    prev.current = st.tricks_played;
  }, [st?.tricks_played]); // eslint-disable-line react-hooks/exhaustive-deps
  return flash;
}

function PhaseLayer({ g, st, act, nameOf }) {
  const my = st.my_seat;
  const myTeam = my % 2;
  if (st.phase === "trump_select")
    return st.trump_selector === my ? <TrumpSelector onPick={(s) => act({ action: "select_trump", suit: s })} />
      : <Banner testId="waiting-trump-banner">{nameOf(st.trump_selector)} is choosing trump…</Banner>;
  if (st.phase === "koth_decision")
    return st.koth_decision === myTeam ? <KothPrompt onDecide={(d) => act({ action: "koth", declare: d })} />
      : <Banner testId="waiting-koth-banner">{TEAM_NAME[st.koth_decision]} captured three tens and is deciding on Koth…</Banner>;
  if (st.phase === "gs_decision")
    return st.gs_eligible === myTeam ? <GrandSlamPrompt partnerHand={st.partner_hand} onDecide={(d) => act({ action: "grand_slam", declare: d })} />
      : <Banner testId="waiting-grand-slam-banner">{TEAM_NAME[st.gs_eligible]} won the first seven tricks and is deciding on Grand Slam…</Banner>;
  if (st.phase === "round_over") return <RoundResult key={st.round_no} result={st.result} mySeat={my} players={g.players} />;
  if (st.phase === "match_over") return <MatchOver st={st} players={g.players} mySeat={my} />;
  return null;
}

export default function GameTable() {
  const { gameId } = useParams();
  const { api, send, connected } = useApp();
  const navigate = useNavigate();
  const [g, setG] = useState(null);
  const [pending, setPending] = useState(false);
  const [chatOpen, setChatOpen] = useState(false);
  const [unread, setUnread] = useState(0);
  const [reactions, setReactions] = useState({});
  const [showLast, setShowLast] = useState(false);
  const st = g?.state;
  const flash = useLastTrickFlash(st);

  useEffect(() => {
    api.get(`/games/${gameId}`).then((r) => setG(r.data)).catch((e) => { toast.error(errMsg(e)); navigate("/home"); });
  }, [gameId]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { if (connected) send({ type: "sync_game", game_id: gameId }); }, [connected, gameId, send]);

  useSocketEvent((m) => {
    if (m.type === "game_state" && m.game_id === gameId) { setG(m); setPending(false); }
    else if (m.type === "error") { setPending(false); toast.error(m.message); }
    else if (m.type === "chat" && g && m.message.room_code === g.room_code && !chatOpen) setUnread((u) => u + 1);
    else if (m.type === "reaction" && g && m.room_code === g.room_code) {
      const id = Date.now();
      setReactions((r) => ({ ...r, [m.user_id]: { emoji: m.emoji, id } }));
      setTimeout(() => setReactions((r) => (r[m.user_id]?.id === id ? { ...r, [m.user_id]: null } : r)), 2200);
    }
  });

  if (!g || !st) return <div className="min-h-screen felt flex items-center justify-center text-white" data-testid="game-loading">Loading table…</div>;
  const act = (payload) => {
    if (!send({ type: "game_action", game_id: gameId, ...payload })) return toast.error("Reconnecting… try again in a moment");
    setPending(true);
  };
  const nameOf = (seat) => g.players.find((p) => p.seat === seat)?.username;
  const myTurn = st.phase === "playing" && st.turn === st.my_seat;
  const trickCards = st.trick.length ? st.trick : flash ? flash.cards : [];
  const winner = !st.trick.length && flash ? flash.winner : null;

  return (
    <div className="fixed inset-0 felt grain overflow-hidden select-none" data-testid="game-table-container">
      <div className="absolute top-0 inset-x-0 z-40 p-2 sm:p-4 flex items-start justify-between gap-2">
        <div className="flex items-start gap-2">
          <button onClick={() => navigate("/home")} className="h-9 w-9 rounded-full bg-black/50 text-white flex items-center justify-center hover:bg-black/70" data-testid="leave-table-btn" aria-label="Leave table"><ArrowLeft size={18} /></button>
          <Scoreboard st={st} mySeat={st.my_seat} />
        </div>
        <div className="flex flex-col items-end gap-2">
          <TrumpBadge trump={st.trump} />
          <div className="flex items-center gap-2">
            <span data-testid="connection-status" className={`h-9 px-3 rounded-full bg-black/50 text-xs font-semibold flex items-center gap-1.5 ${connected ? "text-emerald-300" : "text-amber-300"}`}>
              {connected ? <Wifi size={14} /> : <WifiOff size={14} className="animate-pulse" />}<span className="hidden sm:inline">{connected ? "Live" : "Reconnecting"}</span>
            </span>
            <ThemeToggle className="bg-black/50 text-white border-white/10" />
            <button onClick={() => { setChatOpen(true); setUnread(0); }} data-testid="open-chat-btn" aria-label="Open chat"
              className="relative h-9 w-9 rounded-full bg-black/50 text-white flex items-center justify-center hover:bg-black/70">
              <MessageCircle size={18} />
              {unread > 0 && <span className="absolute -top-1 -right-1 h-4 min-w-4 px-1 rounded-full bg-rose-500 text-[10px] font-bold" data-testid="chat-unread-badge">{unread}</span>}
            </button>
          </div>
          <div className="text-[11px] text-white/70 text-right font-mono whitespace-nowrap" data-testid="round-info">
            Round {st.round_no} · Trick {Math.min(st.tricks_played + (st.trick.length ? 1 : 0), 13)}/13
            {st.koth !== null && <div className="text-amber-300 font-sans font-bold" data-testid="koth-active-badge">KOTH · {TEAM_NAME[st.koth]}</div>}
            {st.gs_declared !== null && <div className="text-rose-300 font-sans font-bold" data-testid="grand-slam-active-badge">GRAND SLAM · {TEAM_NAME[st.gs_declared]}</div>}
          </div>
        </div>
      </div>

      <div className="absolute inset-x-[6%] top-[16%] bottom-[26%] rounded-[50%] border-[6px] border-amber-900/30 shadow-[inset_0_0_80px_rgba(0,0,0,.45)]" />
      {g.players.map((p) => <Seat key={p.seat} player={p} st={st} mySeat={st.my_seat} reaction={reactions[p.user_id]} />)}
      <TrickArea cards={trickCards} mySeat={st.my_seat} winner={winner} />

      {st.phase === "playing" && (
        <div className="absolute left-1/2 -translate-x-1/2 bottom-[96px] sm:bottom-[166px] z-30 text-xs font-semibold" data-testid="turn-indicator">
          {myTurn ? <span className="px-3 py-1 rounded-full bg-amber-400 text-slate-950">Your turn{st.trick.length ? "" : " — lead any card"}</span>
            : <span className="px-3 py-1 rounded-full bg-black/55 text-white/85">{nameOf(st.turn)}'s turn</span>}
        </div>
      )}
      {st.last_trick && (
        <button onClick={() => setShowLast((v) => !v)} className="absolute left-2 sm:left-4 bottom-[100px] sm:bottom-[170px] z-30 text-[11px] text-white/70 hover:text-white inline-flex items-center gap-1" data-testid="last-trick-btn">
          <HistoryIcon size={13} /> Last trick
        </button>
      )}
      {showLast && st.last_trick && (
        <div className="absolute left-2 sm:left-4 bottom-[124px] sm:bottom-[194px] z-40 rounded-xl bg-black/70 p-2 flex gap-1" data-testid="last-trick-panel">
          {st.last_trick.cards.map(([s, c]) => (
            <div key={c} className="text-center"><PlayingCard card={c} size="sm" testId={`last-trick-card-${c}`} className={s === st.last_trick.winner ? "ring-2 ring-amber-400" : ""} /><div className="text-[9px] text-white/70 mt-0.5 max-w-[44px] truncate">{nameOf(s)}</div></div>
          ))}
        </div>
      )}

      <Hand cards={st.hand} legal={st.legal} myTurn={myTurn} pending={pending} onPlay={(c) => act({ action: "play", card: c })} />
      <PhaseLayer g={g} st={st} act={act} nameOf={nameOf} />

      <Sheet open={chatOpen} onOpenChange={(o) => { setChatOpen(o); if (o) setUnread(0); }}>
        <SheetContent side="right" className="w-[92vw] sm:max-w-sm flex flex-col" data-testid="chat-drawer">
          <SheetHeader><SheetTitle className="font-display">Table chat</SheetTitle></SheetHeader>
          <ReactionBar roomCode={g.room_code} />
          <ChatPanel roomCode={g.room_code} className="flex-1 mt-2" compact />
          {st.phase !== "match_over" && (
            <button data-testid="forfeit-match-btn" className="mt-3 text-xs text-muted-foreground hover:text-destructive self-start"
              onClick={() => { if (window.confirm("Forfeit this match? Your team will lose.")) { act({ action: "forfeit" }); setChatOpen(false); } }}>
              Forfeit match
            </button>
          )}
        </SheetContent>
      </Sheet>
    </div>
  );
}
