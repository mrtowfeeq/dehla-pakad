import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { tableTrick, useLastTrickFlash } from "./GameTable";

// GameTable pulls in the router, app context, sockets and Clerk; only its small helpers are tested here.
jest.mock("react-router-dom", () => ({ useNavigate: () => () => {}, useParams: () => ({}) }));
jest.mock("@/components/ui/dropdown-menu", () => ({ DropdownMenu: () => null, DropdownMenuContent: () => null, DropdownMenuItem: () => null, DropdownMenuSeparator: () => null, DropdownMenuTrigger: () => null }));
jest.mock("@/components/ui/alert-dialog", () => ({ AlertDialog: () => null, AlertDialogAction: () => null, AlertDialogCancel: () => null, AlertDialogContent: () => null, AlertDialogDescription: () => null, AlertDialogFooter: () => null, AlertDialogHeader: () => null, AlertDialogTitle: () => null }));
jest.mock("@/components/ui/sheet", () => ({ Sheet: () => null, SheetContent: () => null, SheetHeader: () => null, SheetTitle: () => null }));
jest.mock("@/context/AppContext", () => ({ useApp: () => ({}), useSocketEvent: () => {} }));
jest.mock("@/lib/api", () => ({ errMsg: () => "", REASON_LABEL: {}, TEAM_NAME: ["Team A", "Team B"], VICTORY_LABEL: {} }));
jest.mock("@/components/voice/VoicePanel", () => ({ VoicePanel: () => null }));
jest.mock("@/components/Chat", () => ({ ChatPanel: () => null, ReactionBar: () => null }));
jest.mock("@/components/game/TableLayout", () => ({ Hud: () => null, SeatPanel: () => null, TrickSlots: () => null, FanHand: () => null }));
jest.mock("@/components/game/Effects", () => ({ DealLayer: () => null, TenFlights: () => null, TrickWinBurst: () => null, Announcement: () => null }));
jest.mock("@/components/game/Overlays", () => ({ Banner: () => null, TrumpSelector: () => null, KothPrompt: () => null, GrandSlamPrompt: () => null, MatchOver: () => null }));
jest.mock("@/components/game/RoundResultScreen", () => ({ RoundResultScreen: () => null }));
jest.mock("@/components/PlayingCard", () => ({ PlayingCard: () => null }));
jest.mock("@/components/SoundSettings", () => ({ SoundSettings: () => null }));
jest.mock("@/hooks/useTableEffects", () => ({ useTableEffects: () => ({}) }));
jest.mock("@/hooks/useGameSync", () => ({ useGameSync: () => {} }));
jest.mock("@/hooks/useTableDensity", () => ({ useTableDensity: () => ({ density: "regular", narrow: false }) }));
jest.mock("@/lib/sound", () => ({ sound: { play: jest.fn() } }));

global.IS_REACT_ACT_ENVIRONMENT = true;

const st = (over = {}) => ({ my_seat: 0, phase: "playing", hand: ["AS", "KH", "9D"], trick: [[3, "QS"]], tricks_played: 4, last_trick: null, ...over });

describe("tableTrick (instant card play)", () => {
  test("your tapped card joins the current trick straight away, before the server confirms it", () => {
    const r = tableTrick(st(), "AS", null);
    expect(r.mine).toBe("AS");
    expect(r.trickCards).toEqual([[3, "QS"], [0, "AS"]]);
    expect(r.winner).toBeNull();
  });

  test("once the server's state no longer has it in your hand, the server's trick is shown as is", () => {
    const confirmed = st({ hand: ["KH", "9D"], trick: [[3, "QS"], [0, "AS"]] });
    expect(tableTrick(confirmed, "AS", null)).toEqual({ mine: null, trickCards: [[3, "QS"], [0, "AS"]], winner: null });
  });

  test("leading while the previous trick is still flashed shows only your card, with no winner highlight", () => {
    const flash = { cards: [[0, "2S"], [1, "3S"], [2, "4S"], [3, "5S"]], winner: 3 };
    const r = tableTrick(st({ trick: [] }), "AS", flash);
    expect(r.trickCards).toEqual([[0, "AS"]]);
    expect(r.winner).toBeNull();
  });

  test("without a tapped card the finished trick is flashed with its winner", () => {
    const flash = { cards: [[0, "2S"], [1, "3S"], [2, "4S"], [3, "5S"]], winner: 3 };
    expect(tableTrick(st({ trick: [] }), null, flash)).toEqual({ mine: null, trickCards: flash.cards, winner: 3 });
  });

  test("outside play (e.g. trump selection) a tapped card is never shown", () => {
    expect(tableTrick(st({ phase: "trump_select" }), "AS", null).mine).toBeNull();
  });
});

describe("useLastTrickFlash", () => {
  let root;
  let container;
  const seen = [];
  function Probe({ state }) {
    seen.push(useLastTrickFlash(state));
    return null;
  }

  beforeEach(() => {
    jest.useFakeTimers();
    seen.length = 0;
    container = document.createElement("div");
    root = createRoot(container);
  });
  afterEach(() => {
    act(() => root.unmount());
    jest.useRealTimers();
  });

  test("the finished trick is shown from the very first render after it completes, then cleared", async () => {
    const lastTrick = { cards: [[0, "2S"], [1, "3S"], [2, "4S"], [3, "5S"]], winner: 3 };
    await act(async () => { root.render(<Probe state={st({ tricks_played: 4 })} />); });
    seen.length = 0;
    await act(async () => { root.render(<Probe state={st({ tricks_played: 5, trick: [], last_trick: lastTrick })} />); });
    // Every render after the trick completes shows it — no empty frame between.
    expect(seen.length).toBeGreaterThan(0);
    seen.forEach((f) => expect(f).toEqual(lastTrick));
    await act(async () => { jest.advanceTimersByTime(1500); });
    expect(seen[seen.length - 1]).toBeNull();
  });
});
