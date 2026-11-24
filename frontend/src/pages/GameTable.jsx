import { useEffect, useRef, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { toast } from "sonner";
import { Menu, MessageCircle, History as HistoryIcon, LogOut, Home, Volume2, Flag, SunMoon } from "lucide-react";
import { MotionConfig } from "framer-motion";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { DealLayer, TenFlights, Announcement } from "@/components/game/Effects";
import { SoundSettings } from "@/components/SoundSettings";
import { useTableEffects } from "@/hooks/useTableEffects";
import { sound } from "@/lib/sound";
import { useApp, useSocketEvent } from "@/context/AppContext";
import { errMsg, TEAM_NAME } from "@/lib/api";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Hud, SeatPanel, TrickSlots, FanHand } from "@/components/game/TableLayout";
import { useTheme } from "next-themes";
import { Banner, TrumpSelector, KothPrompt, GrandSlamPrompt, RoundResult, MatchOver } from "@/components/game/Overlays";
import { ChatPanel, ReactionBar } from "@/components/Chat";
import { PlayingCard } from "@/components/PlayingCard";

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

export const CANCEL_MSG = "The match has ended because a player exited.";

function PhaseLayer({ g, st, act, nameOf, dealing, center }) {
  const my = st.my_seat;
  const myTeam = my % 2;
  if (dealing && st.phase === "trump_select") return null;
  const inCenter = st.phase === "trump_select" || (st.phase === "koth_decision" && st.koth_decision !== myTeam) || (st.phase === "gs_decision" && st.gs_eligible !== myTeam);
  if (!!center !== inCenter) return null;
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
  const [soundOpen, setSoundOpen] = useState(false);
  const [exitOpen, setExitOpen] = useState(false);
  const [exiting, setExiting] = useState(false);
  const st = g?.state;
  const flash = useLastTrickFlash(st);
  const { resolvedTheme, setTheme } = useTheme();
  const fx = useTableEffects(g, (pl) => (pl.online ? toast.success(`${pl.username} reconnected`) : toast(`${pl.username} disconnected — waiting for them to return`)));

  useEffect(() => {
    api.get(`/games/${gameId}`).then((r) => {
      if (r.data.status === "cancelled") { toast(CANCEL_MSG); return navigate("/home", { replace: true }); }
      setG(r.data);
    }).catch((e) => { toast.error(errMsg(e)); navigate("/home"); });
  }, [gameId]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { sound.ambience(true); return () => { sound.ambience(false); sound.stopAll(); }; }, []);
  useEffect(() => { if (connected) send({ type: "sync_game", game_id: gameId }); }, [connected, gameId, send]);

  useSocketEvent((m) => {
    if (m.type === "match_cancelled" && m.game_id === gameId) { fx.stop(); setExitOpen(false); setG((x) => x && { ...x, status: "cancelled" }); }
    else if (m.type === "game_state" && m.game_id === gameId) { if (m.status !== "cancelled") setG(m); setPending(false); }
    else if (m.type === "error") { setPending(false); sound.play("invalid"); toast.error(m.message); }
    else if (m.type === "chat" && g && m.message.room_code === g.room_code && !chatOpen) setUnread((u) => u + 1);
    else if (m.type === "reaction" && g && m.room_code === g.room_code) {
      const id = Date.now();
      setReactions((r) => ({ ...r, [m.user_id]: { emoji: m.emoji, id } }));
      setTimeout(() => setReactions((r) => (r[m.user_id]?.id === id ? { ...r, [m.user_id]: null } : r)), 2200);
    }
  });

  if (!g || !st) return <div className="min-h-screen felt flex items-center justify-center text-white" data-testid="game-loading">Loading table…</div>;
  if (g.status === "cancelled") return <div className="min-h-screen felt flex items-center justify-center text-white" data-testid="match-cancelled-screen">{CANCEL_MSG}</div>;
  const exitMatch = async () => {
    setExiting(true);
    try { await api.post(`/games/${gameId}/exit`); } catch (e) { toast.error(errMsg(e)); setExiting(false); }
  };
  const act = (payload) => {
    if (!send({ type: "game_action", game_id: gameId, ...payload })) return toast.error("Reconnecting… try again in a moment");
    setPending(true);
  };
  const nameOf = (seat) => g.players.find((p) => p.seat === seat)?.username;
  const myTurn = st.phase === "playing" && st.turn === st.my_seat;
  const trickCards = st.trick.length ? st.trick : flash ? flash.cards : [];
  const winner = !st.trick.length && flash ? flash.winner : null;
  const seatAt = (rel, horizontal) => {
    const p = g.players.find((x) => (x.seat - st.my_seat + 4) % 4 === rel);
    return <SeatPanel player={p} st={st} mySeat={st.my_seat} reaction={reactions[p.user_id]} pending={fx.pending[p.seat]}
      dealing={fx.dealing} highlight={winner !== null && winner === p.seat} horizontal={horizontal} />;
  };

  return (
    <MotionConfig reducedMotion="user">
    <div className="fixed inset-0 felt grain overflow-hidden select-none flex flex-col" data-testid="game-table-container">
      <Hud st={st} connected={connected}
        left={
          <DropdownMenu onOpenChange={(o) => sound.play(o ? "menu_open" : "menu_close")}>
            <DropdownMenuTrigger asChild>
              <button className="shrink-0 h-9 w-9 rounded-full bg-black/50 text-white flex items-center justify-center hover:bg-black/70" data-testid="game-menu-btn" data-sound="none" aria-label="Game menu"><Menu size={18} /></button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" className="w-60" data-testid="game-menu">
              <DropdownMenuItem onSelect={() => navigate("/home")} data-testid="menu-back-home"><Home size={15} className="mr-2" /> Back to dashboard (keep seat)</DropdownMenuItem>
              <DropdownMenuItem onSelect={() => setSoundOpen(true)} data-testid="menu-sound-settings"><Volume2 size={15} className="mr-2" /> Sound settings</DropdownMenuItem>
              <DropdownMenuItem onSelect={() => setTheme(resolvedTheme === "light" ? "dark" : "light")} data-testid="menu-theme-toggle"><SunMoon size={15} className="mr-2" /> Toggle light / dark</DropdownMenuItem>
              {st.phase !== "match_over" && (
                <>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem onSelect={() => { if (window.confirm("Forfeit this match? Your team will lose.")) act({ action: "forfeit" }); }} data-testid="menu-forfeit"><Flag size={15} className="mr-2" /> Forfeit (your team loses)</DropdownMenuItem>
                  <DropdownMenuItem onSelect={() => setExitOpen(true)} className="text-rose-500 focus:text-rose-500 font-semibold" data-testid="menu-exit-match"><LogOut size={15} className="mr-2" /> Exit Match</DropdownMenuItem>
                </>
              )}
            </DropdownMenuContent>
          </DropdownMenu>
        }
        right={
          <button onClick={() => { setChatOpen(true); setUnread(0); sound.play("menu_open"); }} data-sound="none" data-testid="open-chat-btn" aria-label="Open chat"
            className="relative shrink-0 h-9 w-9 rounded-full bg-black/50 text-white flex items-center justify-center hover:bg-black/70">
            <MessageCircle size={18} />
            {unread > 0 && <span className="absolute -top-1 -right-1 h-4 min-w-4 px-1 rounded-full bg-rose-500 text-[10px] font-bold" data-testid="chat-unread-badge">{unread}</span>}
          </button>
        } />

      <div className="relative flex-1 min-h-0 px-1 sm:px-4 py-1 sm:py-2" data-testid="table-area">
        <div className="h-full mx-auto max-w-5xl grid grid-cols-[auto_minmax(0,1fr)_auto] grid-rows-[auto_minmax(0,1fr)_auto] gap-1 sm:gap-3">
          <div className="col-start-2 row-start-1 flex justify-center">{seatAt(2)}</div>
          <div className="col-start-1 row-start-2 flex items-center">{seatAt(3)}</div>
          <div className="col-start-3 row-start-2 flex items-center">{seatAt(1)}</div>
          <div className="col-start-2 row-start-2 relative flex items-center justify-center min-h-0 min-w-0">
            <div className="absolute inset-0 sm:inset-x-4 rounded-[36%] table-rail" />
            <div className="relative z-10">
              <TrickSlots cards={trickCards} mySeat={st.my_seat} winner={winner}>
                <DealLayer flying={fx.flying} mySeat={st.my_seat} dealing={fx.dealing} />
              </TrickSlots>
            </div>
            <PhaseLayer g={g} st={st} act={act} nameOf={nameOf} dealing={fx.dealing} center />
            {fx.dealing && <div className="absolute bottom-[8%] inset-x-0 text-center z-20 text-[10px] sm:text-xs text-white/75 tracking-[0.3em] uppercase" data-testid="dealing-banner">Dealing…</div>}
          </div>
          <div className="col-start-1 col-span-3 row-start-3 flex items-center justify-center gap-2 sm:gap-4 min-w-0">
            {st.last_trick ? (
              <button onClick={() => setShowLast((v) => !v)} className="shrink-0 h-8 px-2.5 rounded-full bg-black/40 text-[11px] text-white/75 hover:text-white inline-flex items-center gap-1" data-testid="last-trick-btn">
                <HistoryIcon size={13} /><span className="hidden sm:inline">Last trick</span>
              </button>
            ) : <span className="w-8 shrink-0" />}
            {seatAt(0, true)}
            <div className="shrink-0 text-[11px] sm:text-xs font-semibold min-w-[72px] text-center" data-testid="turn-indicator">
              {st.phase === "playing" && (myTurn
                ? <span className="inline-block px-3 py-1 rounded-full bg-amber-400 text-slate-950 shadow-[0_0_18px_rgba(251,191,36,.55)]">Your turn</span>
                : <span className="inline-block px-3 py-1 rounded-full bg-black/45 text-white/85 max-w-[120px] truncate align-middle">{nameOf(st.turn)}</span>)}
            </div>
          </div>
        </div>
        {showLast && st.last_trick && (
          <div className="absolute left-2 sm:left-4 bottom-12 z-40 rounded-xl bg-black/75 backdrop-blur p-2 flex gap-1" data-testid="last-trick-panel">
            {st.last_trick.cards.map(([s, c]) => (
              <div key={c} className="text-center"><PlayingCard card={c} size="sm" testId={`last-trick-card-${c}`} className={s === st.last_trick.winner ? "ring-2 ring-amber-400" : ""} /><div className="text-[9px] text-white/70 mt-0.5 max-w-[44px] truncate">{nameOf(s)}</div></div>
            ))}
          </div>
        )}
      </div>

      <FanHand cards={st.hand.filter((c) => !fx.hidden.has(c))} legal={st.legal} myTurn={myTurn && !fx.dealing} pending={pending}
        onPlay={(c) => act({ action: "play", card: c })} onInvalid={() => toast.error("You must follow the leading suit")} />
      <TenFlights flights={fx.tenFlights} />
      <Announcement a={fx.announce} />
      <PhaseLayer g={g} st={st} act={act} nameOf={nameOf} dealing={fx.dealing} />

      <Sheet open={soundOpen} onOpenChange={(o) => { setSoundOpen(o); sound.play(o ? "menu_open" : "menu_close"); }}>
        <SheetContent side="left" className="w-[92vw] sm:max-w-sm" data-testid="sound-settings-drawer">
          <SheetHeader><SheetTitle className="font-display">Sound</SheetTitle></SheetHeader>
          <div className="mt-6"><SoundSettings /></div>
        </SheetContent>
      </Sheet>
      <AlertDialog open={exitOpen} onOpenChange={setExitOpen}>
        <AlertDialogContent data-testid="exit-match-dialog">
          <AlertDialogHeader>
            <AlertDialogTitle>Exit match?</AlertDialogTitle>
            <AlertDialogDescription data-testid="exit-match-dialog-text">Are you sure you want to leave this match? Leaving will cancel the entire match for all players.</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel data-testid="exit-match-cancel-btn">Cancel</AlertDialogCancel>
            <AlertDialogAction data-testid="exit-match-confirm-btn" disabled={exiting} onClick={(e) => { e.preventDefault(); exitMatch(); }}
              className="bg-rose-600 hover:bg-rose-500 text-white">{exiting ? "Exiting…" : "Exit Match"}</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <Sheet open={chatOpen} onOpenChange={(o) => { setChatOpen(o); sound.play(o ? "menu_open" : "menu_close"); if (o) setUnread(0); }}>
        <SheetContent side="right" className="w-[92vw] sm:max-w-sm flex flex-col" data-testid="chat-drawer">
          <SheetHeader><SheetTitle className="font-display">Table chat</SheetTitle></SheetHeader>
          <ReactionBar roomCode={g.room_code} />
          <ChatPanel roomCode={g.room_code} className="flex-1 mt-2" compact />
        </SheetContent>
      </Sheet>
    </div>
    </MotionConfig>
  );
}
