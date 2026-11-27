import { useEffect, useRef, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { toast } from "sonner";
import { Menu, MessageCircle, History as HistoryIcon, LogOut, Home, Volume2, Flag, SunMoon, Eye, EyeOff } from "lucide-react";
import { MotionConfig } from "framer-motion";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { DealLayer, TenFlights, TrickWinBurst, Announcement } from "@/components/game/Effects";
import { SoundSettings } from "@/components/SoundSettings";
import { useTableEffects } from "@/hooks/useTableEffects";
import { sound } from "@/lib/sound";
import { useApp, useSocketEvent } from "@/context/AppContext";
import { errMsg, REASON_LABEL, TEAM_NAME, VICTORY_LABEL } from "@/lib/api";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Hud, SeatPanel, TrickSlots, FanHand } from "@/components/game/TableLayout";
import { useTheme } from "next-themes";
import { Banner, TrumpSelector, KothPrompt, GrandSlamPrompt, MatchOver } from "@/components/game/Overlays";
import { RoundResultScreen } from "@/components/game/RoundResultScreen";
import { ChatPanel, ReactionBar } from "@/components/Chat";
import { PlayingCard } from "@/components/PlayingCard";
import { VoicePanel } from "@/components/voice/VoicePanel";
import { useGameSync } from "@/hooks/useGameSync";
import { useTableDensity } from "@/hooks/useTableDensity";
import { isGameSnapshot, mergeGameSnapshot } from "@/lib/gameSnapshot";

export function useLastTrickFlash(st) {
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
  // The state that completes a trick already has an empty current trick, and the effect above only sets
  // `flash` after that first render. Show the finished trick in that render too, so its cards never vanish
  // for a frame (which made them start leaving and then pop back in).
  const justCompleted = !!st && prev.current !== undefined && st.tricks_played > prev.current && !!st.last_trick;
  return flash || (justCompleted ? st.last_trick : null);
}

export const CANCEL_MSG = "The match has ended because a player exited.";
export const OPTIMISTIC_TIMEOUT_MS = 6000;

// What the trick area shows. mine: your just-tapped card while the server has not confirmed it yet (still in
// your hand); it joins the current trick at once. Otherwise the current trick, or the finished trick while it
// is flashed, whose winner's card is highlighted.
export function tableTrick(st, optimistic, flash) {
  const mine = optimistic && st.phase === "playing" && st.hand.includes(optimistic) ? optimistic : null;
  const trickCards = mine ? [...st.trick, [st.my_seat, mine]] : st.trick.length ? st.trick : flash ? flash.cards : [];
  const winner = !mine && !st.trick.length && flash ? flash.winner : null;
  return { mine, trickCards, winner };
}

function PhaseLayer({ g, st, act, nameOf, dealing, center, serverOffsetMs = 0 }) {
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
    return st.gs_eligible === myTeam ? <GrandSlamPrompt partnerHand={st.partner_hand} autoKoth={st.auto_koth_pending === myTeam}
      onDecide={(d) => act({ action: "grand_slam", declare: d })} />
      : <Banner testId="waiting-grand-slam-banner">{TEAM_NAME[st.gs_eligible]} won the first seven tricks and is deciding on Grand Slam…</Banner>;
  if (st.phase === "round_over")
    return <RoundResultScreen key={st.round_no} result={st.result} round={st.round_no} scores={st.scores} target={st.target}
      mySeat={my} players={g.players} nextRoundAt={g.next_round_at} serverOffsetMs={serverOffsetMs}
      medals={g.round_medals} medalsEligible={g.medals_eligible} />;
  if (st.phase === "match_over") return <MatchOver st={st} players={g.players} mySeat={my} game={g} />;
  return null;
}

export default function GameTable() {
  const { gameId } = useParams();
  const { api, send, connected } = useApp();
  const navigate = useNavigate();
  const [g, setG] = useState(null);
  const [pending, setPending] = useState(false);
  // Card you just tapped, shown on the table at once while the server confirms it. The server stays the
  // authority: the card is dropped from here as soon as a state without it in your hand arrives, and goes
  // back to your hand on an error or if no confirmation comes within OPTIMISTIC_TIMEOUT_MS.
  const [optimistic, setOptimistic] = useState(null);
  const [chatOpen, setChatOpen] = useState(false);
  const [unread, setUnread] = useState(0);
  const [reactions, setReactions] = useState({});
  const [showLast, setShowLast] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [soundOpen, setSoundOpen] = useState(false);
  const [exitOpen, setExitOpen] = useState(false);
  const [exiting, setExiting] = useState(false);
  const wsRevision = useRef(0);
  const serverOffsetMs = useRef(0);
  const lastServerTimeMs = useRef(0);
  const cancelledGames = useRef(new Set());
  const st = g?.state;
  const flash = useLastTrickFlash(st);
  const { resolvedTheme, setTheme } = useTheme();
  const fx = useTableEffects(g, (pl) => (pl.online ? toast.success(`${pl.username} reconnected`) : toast(`${pl.username} disconnected — waiting for them to return`)), { localPlays: true });
  useGameSync(gameId, connected, send);
  const { density, narrow } = useTableDensity();

  useEffect(() => {
    let cancelled = false;
    const requestWsRevision = wsRevision.current;
    const requestStartedAt = Date.now();
    setG(null);
    api.get(`/games/${gameId}`).then((r) => {
      if (cancelled) return;
      const responseReceivedAt = Date.now();
      const snapshot = cancelledGames.current.has(gameId) && r.data?.status !== "cancelled"
        ? { ...r.data, status: "cancelled" }
        : r.data;
      if (!isGameSnapshot(snapshot, gameId)) throw new Error("Invalid game state response");
      const serverTime = Date.parse(snapshot.server_time || "");
      if (Number.isFinite(serverTime) && serverTime >= lastServerTimeMs.current) {
        lastServerTimeMs.current = serverTime;
        serverOffsetMs.current = serverTime - ((requestStartedAt + responseReceivedAt) / 2);
      }
      setG((current) => mergeGameSnapshot(current, snapshot, {
        source: "rest",
        requestWsRevision,
        currentWsRevision: wsRevision.current,
      }));
    }).catch((e) => {
      if (cancelled) return;
      toast.error(errMsg(e));
      navigate("/home");
    });
    return () => { cancelled = true; };
  }, [api, gameId, navigate]);
  useEffect(() => { sound.ambience(true); return () => { sound.ambience(false); sound.stopAll(); }; }, []);

  useSocketEvent((m) => {
    if (m.type === "match_cancelled" && m.game_id === gameId) {
      cancelledGames.current.add(gameId);
      wsRevision.current += 1;
      fx.stop(); setExitOpen(false); setPending(false); setOptimistic(null);
      setG((x) => x && { ...x, status: "cancelled" });
    }
    else if (m.type === "game_state" && m.game_id === gameId) {
      if (!isGameSnapshot(m, gameId)) return;
      const serverTime = Date.parse(m.server_time || "");
      if (Number.isFinite(serverTime) && serverTime >= lastServerTimeMs.current) {
        lastServerTimeMs.current = serverTime;
        serverOffsetMs.current = serverTime - Date.now();
      }
      wsRevision.current += 1;
      if (m.status === "cancelled") cancelledGames.current.add(gameId);
      const snapshot = cancelledGames.current.has(gameId) && m.status !== "cancelled"
        ? { ...m, status: "cancelled" }
        : m;
      setG((current) => mergeGameSnapshot(current, snapshot, { source: "websocket" }));
      setPending(false);
    }
    else if (m.type === "error") { setPending(false); setOptimistic(null); sound.play("invalid"); toast.error(m.message); }
    else if (m.type === "chat" && g && m.message.room_code === g.room_code && !chatOpen) setUnread((u) => u + 1);
    else if (m.type === "reaction" && g && m.room_code === g.room_code) {
      const id = Date.now();
      setReactions((r) => ({ ...r, [m.user_id]: { emoji: m.emoji, id } }));
      setTimeout(() => setReactions((r) => (r[m.user_id]?.id === id ? { ...r, [m.user_id]: null } : r)), 2200);
    }
  });

  // Confirmed (no longer in your hand) → stop showing the optimistic copy; unconfirmed for too long → give it back.
  useEffect(() => {
    if (optimistic && st && !st.hand.includes(optimistic)) setOptimistic(null);
  }, [st, optimistic]);
  useEffect(() => {
    if (!optimistic) return undefined;
    const t = setTimeout(() => { setOptimistic(null); setPending(false); }, OPTIMISTIC_TIMEOUT_MS);
    return () => clearTimeout(t);
  }, [optimistic]);

  if (!g || !st) return <div className="min-h-screen felt flex items-center justify-center text-white" data-testid="game-loading">Loading table…</div>;
  if (g.status === "cancelled") return <div className="min-h-screen felt flex items-center justify-center text-white" data-testid="match-cancelled-screen">{CANCEL_MSG}</div>;
  const exitMatch = async () => {
    setExiting(true);
    try { await api.post(`/games/${gameId}/exit`); } catch (e) { toast.error(errMsg(e)); setExiting(false); }
  };
  const act = (payload) => {
    if (!send({ type: "game_action", game_id: gameId, ...payload })) { toast.error("Reconnecting… try again in a moment"); return false; }
    setPending(true);
    return true;
  };
  const playCard = (card) => {
    if (!act({ action: "play", card })) return;
    setOptimistic(card);
    sound.play("place", { delay: 110, minGap: 0 });
  };
  const toggleSpectatorAccess = async () => {
    try {
      const { data } = await api.patch(`/rooms/${g.room_code}/spectator-access`, { enabled: !g.spectators_enabled });
      setG((current) => current && { ...current, spectators_enabled: data.enabled });
      toast.success(data.enabled ? "Private spectator access enabled" : "Spectator access revoked");
    } catch (error) { toast.error(errMsg(error)); }
  };
  const copySpectatorInvite = async () => {
    try {
      const { data } = await api.post(`/rooms/${g.room_code}/spectator-invite`);
      const inviteUrl = `${window.location.origin}/spectate/${encodeURIComponent(data.game_id)}#invite=${encodeURIComponent(data.invite)}`;
      await navigator.clipboard.writeText(inviteUrl);
      toast.success("Private spectator invitation copied");
    } catch (error) { toast.error(errMsg(error)); }
  };
  const nameOf = (seat) => g.players.find((p) => p.seat === seat)?.username;
  const myTurn = st.phase === "playing" && st.turn === st.my_seat;
  const { mine, trickCards, winner } = tableTrick(st, optimistic, flash);
  // Short screens (phones ≤ 700px high) slim the partner's panel; landscape phones (≤ 500px high) slim every
  // panel and move the bottom row ("You" panel and turn pill) beside the hand. Desktop is unchanged.
  const tiny = density === "tiny";
  const compactTop = density !== "regular";
  const seatAt = (rel, horizontal, compact = false, mini = false) => {
    const p = g.players.find((x) => (x.seat - st.my_seat + 4) % 4 === rel);
    return <SeatPanel player={p} st={st} mySeat={st.my_seat} reaction={reactions[p.user_id]} pending={fx.pending[p.seat] + (mine && p.seat === st.my_seat ? 1 : 0)}
      dealing={fx.dealing} highlight={winner !== null && winner === p.seat} horizontal={horizontal} compact={compact} mini={mini}
      turnDeadline={g.status === "active" ? g.turn_deadline : null} turnPhase={g.turn_phase}
      turnGraceDeadline={g.turn_grace_deadline} turnDuration={g.turn_duration} serverOffsetMs={serverOffsetMs.current}
      turnSeat={g.turn_seat} />;
  };
  const lastTrickButton = st.last_trick ? (
    <button onClick={() => setShowLast((v) => !v)} className="game-hud-btn shrink-0 h-8 px-2.5 rounded-full text-[11px] font-semibold inline-flex items-center gap-1" data-testid="last-trick-btn" aria-label="Last trick">
      <HistoryIcon size={13} /><span className={tiny ? "hidden" : "hidden sm:inline"}>Last trick</span>
    </button>
  ) : <span className="w-8 shrink-0" />;
  const turnIndicator = (
    <div className={`shrink-0 text-[11px] sm:text-xs font-semibold text-center ${narrow ? "" : "min-w-[72px]"}`} data-testid="turn-indicator">
      {st.phase === "playing" && (myTurn
        ? <span className="inline-block px-3 py-1 rounded-full border border-amber-100/70 bg-gradient-to-r from-amber-300 to-amber-500 font-bold text-slate-950 shadow-[0_0_18px_rgba(251,191,36,.55)]">Your turn</span>
        : <span className="inline-block px-3 py-1 rounded-full border border-white/15 bg-black/50 text-white/85 max-w-[120px] truncate align-middle">{nameOf(st.turn)}</span>)}
    </div>
  );

  return (
    <MotionConfig reducedMotion="user">
    {/* No "grain" texture here: it is a full-screen overlay-blended layer the browser had to recomposite on every
        animation frame, a real cost on phones for almost no visible difference over the dark table. */}
    <div className="game-shell fixed inset-0 overflow-hidden select-none flex flex-col" data-testid="game-table-container">
      <Hud st={st} connected={connected} roomCode={g.room_code} gameStatus={g.status} players={g.players} density={density} narrow={narrow}
        left={
          <DropdownMenu onOpenChange={(o) => sound.play(o ? "menu_open" : "menu_close")}>
            <DropdownMenuTrigger asChild>
              <button className="game-hud-btn shrink-0 h-9 w-9 rounded-full flex items-center justify-center" data-testid="game-menu-btn" data-sound="none" aria-label="Game menu"><Menu size={18} /></button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" className="w-60" data-testid="game-menu">
              <DropdownMenuItem onSelect={() => navigate("/home")} data-testid="menu-back-home"><Home size={15} className="mr-2" /> Back to dashboard (keep seat)</DropdownMenuItem>
              <DropdownMenuItem onSelect={() => setHistoryOpen(true)} data-testid="menu-round-history"><HistoryIcon size={15} className="mr-2" /> Round history</DropdownMenuItem>
              <DropdownMenuItem onSelect={() => setSoundOpen(true)} data-testid="menu-sound-settings"><Volume2 size={15} className="mr-2" /> Sound settings</DropdownMenuItem>
              <DropdownMenuItem onSelect={() => setTheme(resolvedTheme === "light" ? "dark" : "light")} data-testid="menu-theme-toggle"><SunMoon size={15} className="mr-2" /> Toggle light / dark</DropdownMenuItem>
              {g.status === "active" && g.can_manage_spectators && !g.is_public && <>
                <DropdownMenuSeparator />
                <DropdownMenuItem onSelect={toggleSpectatorAccess} data-testid="menu-toggle-spectators">
                  {g.spectators_enabled ? <EyeOff size={15} className="mr-2" /> : <Eye size={15} className="mr-2" />}
                  {g.spectators_enabled ? "Revoke spectator access" : "Enable spectator access"}
                </DropdownMenuItem>
                {g.spectators_enabled && <DropdownMenuItem onSelect={copySpectatorInvite} data-testid="menu-copy-spectator-invite"><Eye size={15} className="mr-2" /> Copy spectator invitation</DropdownMenuItem>}
              </>}
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
          <div className="flex items-center gap-2">
            {g.status === "active" && <VoicePanel gameId={gameId} eligible={g.status === "active"} />}
            <button onClick={() => { setChatOpen(true); setUnread(0); sound.play("menu_open"); }} data-sound="none" data-testid="open-chat-btn" aria-label="Open chat"
              className="game-hud-btn relative shrink-0 h-9 w-9 rounded-full flex items-center justify-center">
              <MessageCircle size={18} />
              {unread > 0 && <span className="absolute -top-1 -right-1 h-4 min-w-4 px-1 rounded-full border-2 border-[#0a1120] bg-rose-500 text-[10px] font-bold leading-[12px] text-white" data-testid="chat-unread-badge">{unread}</span>}
            </button>
          </div>
        } />

      <div className={`relative flex-1 min-h-0 px-1 sm:px-4 ${compactTop ? "pt-4 pb-1" : "py-1 sm:py-2"}`} data-testid="table-area" data-density={density}>
        <div className={`game-table-grid h-full w-full mx-auto max-w-5xl grid grid-cols-[auto_minmax(0,1fr)_auto] ${tiny ? "grid-rows-[auto_minmax(0,1fr)] gap-x-2 gap-y-1" : "grid-rows-[auto_minmax(0,1fr)_auto] gap-1 sm:gap-3"}`}>
          <div className="col-start-2 row-start-1 flex justify-center">{seatAt(2, compactTop, compactTop)}</div>
          <div className="col-start-1 row-start-2 flex items-center justify-center">{seatAt(3, tiny, tiny)}</div>
          <div className="col-start-3 row-start-2 flex items-center justify-center">{seatAt(1, tiny, tiny)}</div>
          <div className="col-start-2 row-start-2 relative flex items-center justify-center min-h-0 min-w-0">
            <div className="game-table-board relative z-10 flex h-full w-full min-h-0 items-center justify-center" data-testid="game-table-board">
              <div className="absolute inset-0 rounded-[36%] table-rail" />
              <TrickSlots cards={trickCards} currentTrick={mine ? trickCards : st.trick} mySeat={st.my_seat} winner={winner}>
                <DealLayer flying={fx.flying} mySeat={st.my_seat} dealing={fx.dealing} />
              </TrickSlots>
            </div>
            <PhaseLayer g={g} st={st} act={act} nameOf={nameOf} dealing={fx.dealing} center />
            {fx.dealing && <div className="absolute bottom-[8%] inset-x-0 text-center z-20 text-[10px] sm:text-xs text-white/75 tracking-[0.3em] uppercase" data-testid="dealing-banner">Dealing…</div>}
          </div>
          {!tiny && (
            // Equal side columns keep "You" exactly centred under the table, whatever the widths of the
            // last-trick button (left) and the turn pill (right).
            <div className="col-start-1 col-span-3 row-start-3 grid grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] items-center gap-2 sm:gap-4 min-w-0" data-testid="my-seat-row">
              <div className="flex min-w-0 justify-end">{lastTrickButton}</div>
              {seatAt(0, true)}
              <div className="flex min-w-0 justify-start">{turnIndicator}</div>
            </div>
          )}
        </div>
        {showLast && st.last_trick && (
          <div className="absolute left-2 sm:left-4 bottom-12 z-40 rounded-xl border border-amber-300/30 bg-[#0a1120]/95 p-2 flex gap-1 shadow-[0_14px_30px_-12px_rgba(0,0,0,.95)]" data-testid="last-trick-panel">
            {st.last_trick.cards.map(([s, c]) => (
              <div key={c} className="text-center"><PlayingCard card={c} size="sm" testId={`last-trick-card-${c}`} className={s === st.last_trick.winner ? "ring-2 ring-amber-400" : ""} /><div className="text-[9px] text-white/70 mt-0.5 max-w-[44px] truncate">{nameOf(s)}</div></div>
            ))}
          </div>
        )}
      </div>

      <FanHand cards={st.hand.filter((c) => !fx.hidden.has(c) && c !== mine)} legal={st.legal} myTurn={myTurn && !fx.dealing} pending={pending}
        onPlay={playCard} onInvalid={() => toast.error("You must follow the leading suit")}
        sideStart={tiny ? (narrow ? seatAt(0, true, true, true) : <>{lastTrickButton}{seatAt(0, true, true)}</>) : null}
        sideEnd={tiny ? (narrow ? <>{lastTrickButton}{turnIndicator}</> : turnIndicator) : null}
        sideReserve={tiny ? (narrow ? 140 : 200) : 0} />
      <TrickWinBurst win={fx.trickWin} />
      <TenFlights flights={fx.tenFlights} />
      <Announcement a={fx.announce} />
      <PhaseLayer g={g} st={st} act={act} nameOf={nameOf} dealing={fx.dealing} serverOffsetMs={serverOffsetMs.current} />

      <Sheet open={soundOpen} onOpenChange={(o) => { setSoundOpen(o); sound.play(o ? "menu_open" : "menu_close"); }}>
        <SheetContent side="left" className="w-[92vw] sm:max-w-sm" data-testid="sound-settings-drawer">
          <SheetHeader><SheetTitle className="font-display">Sound</SheetTitle></SheetHeader>
          <div className="mt-6"><SoundSettings /></div>
        </SheetContent>
      </Sheet>
      <Sheet open={historyOpen} onOpenChange={setHistoryOpen}>
        <SheetContent side="left" className="w-[92vw] sm:max-w-md" data-testid="round-history-drawer">
          <SheetHeader>
            <SheetTitle className="font-display">Round history</SheetTitle>
            <p className="text-sm text-muted-foreground">Completed rounds in this match</p>
          </SheetHeader>
          <div className="mt-5 max-h-[calc(100dvh-120px)] space-y-2 overflow-y-auto pr-1">
            {st.rounds.length === 0
              ? <p className="rounded-xl border border-border bg-card/60 p-4 text-sm text-muted-foreground" data-testid="round-history-empty">No completed rounds yet.</p>
              : st.rounds.map((round, index) => (
                <article key={`${round.round ?? index}-${round.reason}`} className="rounded-xl border border-border bg-card/60 p-3" data-testid={`round-history-item-${round.round ?? index + 1}`}>
                  <div className="flex items-start justify-between gap-3">
                    <div>
                      <p className="text-xs font-bold uppercase tracking-wider text-muted-foreground">Round {round.round ?? index + 1}</p>
                      <h3 className="mt-1 font-semibold">{TEAM_NAME[round.winner_team]} · {VICTORY_LABEL[round.type] || round.type}</h3>
                      <p className="mt-1 text-xs text-muted-foreground">{REASON_LABEL[round.reason] || round.reason}</p>
                    </div>
                    <span className="shrink-0 rounded-full bg-amber-400/15 px-2.5 py-1 font-mono text-sm font-bold text-amber-600 dark:text-amber-300">+{round.points}</span>
                  </div>
                  <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
                    <span>Tricks <b className="font-mono text-foreground">{round.tricks_won?.[0] ?? "—"}–{round.tricks_won?.[1] ?? "—"}</b></span>
                    <span>Tens <b className="font-mono text-foreground">{round.tens?.[0] ?? "—"}–{round.tens?.[1] ?? "—"}</b></span>
                  </div>
                </article>
              ))}
          </div>
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
