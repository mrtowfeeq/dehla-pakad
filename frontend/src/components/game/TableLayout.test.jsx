import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { PlayingCard } from "@/components/PlayingCard";
import { Hud, SeatPanel, TrickSlots } from "./TableLayout";
import { timerSeatFor } from "@/lib/turnSeat";

jest.mock("react-router-dom", () => {
  const ReactModule = jest.requireActual("react");
  return { Link: ({ to, children, ...props }) => ReactModule.createElement("a", { ...props, href: to }, children) };
});
jest.mock("@/lib/api", () => ({
  SUIT_SYMBOL: { S: "♠", H: "♥", D: "♦", C: "♣" },
  SUIT_NAME: { S: "Spades", H: "Hearts", D: "Diamonds", C: "Clubs" },
  TEAM_NAME: ["Team A", "Team B"],
  isRed: (suit) => suit === "H" || suit === "D",
  cardSuit: (card) => card.slice(-1),
  cardRank: (card) => card.slice(0, -1),
}));
jest.mock("@/lib/sound", () => ({ sound: { play: jest.fn() } }));

global.IS_REACT_ACT_ENVIRONMENT = true;

const makeState = (tricksWon) => ({
  my_seat: 0,
  tricks_played: 5,
  trick: [],
  dealer: 2,
  trump: "S",
  turn: 1,
  trump_selector: null,
  phase: "playing",
  round_no: 3,
  scores: [9, 2],
  target: 10,
  tricks_won: tricksWon,
  hand_counts: [13, 13, 13, 13],
  tens: [[], []],
  koth: null,
  gs_declared: null,
});

const players = [0, 1, 2, 3].map((seat) => ({
  seat,
  username: `Player ${seat + 1}`,
}));

let root;
let container;

async function render(state) {
  await act(async () => {
    root.render(<Hud st={state} players={players} roomCode="ROOM7" gameStatus="active" connected />);
  });
}

async function renderTableState(trick) {
  await act(async () => {
    const state = makeState([5, 3]);
    state.trick = trick;
    root.render(
      <>
        <Hud st={state} players={players} roomCode="ROOM7" gameStatus="active" connected />
        <TrickSlots cards={trick} currentTrick={state.trick} mySeat={0} winner={null} />
      </>,
    );
  });
}

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

test("team trick counters show authoritative current-round values separately from match scores", async () => {
  await render(makeState([5, 3]));

  expect(container.querySelector('[data-testid="tricks-team-a"]').textContent).toBe("5");
  expect(container.querySelector('[data-testid="tricks-team-b"]').textContent).toBe("3");
  expect(container.querySelector('[data-testid="score-team-a"]').textContent).toBe("9/10");
  expect(container.querySelector('[data-testid="score-team-b"]').textContent).toBe("2/10");

  // A reconnect snapshot with the same server values renders the same totals;
  // the view does not derive or increment counters locally.
  await render(makeState([5, 3]));
  expect(container.querySelector('[data-testid="tricks-team-a"]').textContent).toBe("5");
  expect(container.querySelector('[data-testid="tricks-team-b"]').textContent).toBe("3");

  await render(makeState([6, 3]));
  expect(container.querySelector('[data-testid="tricks-team-a"]').textContent).toBe("6");
  expect(container.querySelector('[data-testid="tricks-team-b"]').textContent).toBe("3");
});

test("current suit shows only the backend-led symbol and remains separate from trump", async () => {
  const suits = [
    ["AH", "♥"],
    ["AD", "♦"],
    ["AC", "♣"],
    ["AS", "♠"],
  ];

  for (const [card, symbol] of suits) {
    await renderTableState([[2, card]]);
    const indicator = container.querySelector('[data-testid="current-suit-indicator"]');
    expect(indicator.textContent).toBe(symbol);
    expect(indicator.querySelector('[data-testid="current-suit-symbol"]').textContent).toBe(symbol);
    expect(indicator.className).toContain("col-start-2 row-start-2");
    expect(indicator.className).not.toMatch(/border|bg-|shadow/);
    expect(container.querySelector('[data-testid="trick-card-2"]').className).toContain("trick-card-size");
    expect(container.querySelector('[data-testid="trick-card-slot-2"]').className).toContain("trick-card-slot");
    expect(container.querySelector('[data-testid="current-suit-name"]')).toBeNull();
    expect(container.querySelector('[data-testid="current-trick-card-count"]')).toBeNull();
  }

  await renderTableState([[2, "KH"]]);
  // The test state sets Spades as trump while the active trick is led with Hearts.
  expect(container.querySelector('[data-testid="trump-indicator-badge"]').textContent).toContain("♠Spades");
  expect(container.querySelector('[data-testid="current-suit-indicator"]').textContent).toBe("♥");
});

test("current suit remains the led suit as cards are added, then resets for an empty trick", async () => {
  await renderTableState([]);
  expect(container.querySelector('[data-testid="current-suit-indicator"]')).toBeNull();

  await renderTableState([[1, "KH"]]);
  expect(container.querySelector('[data-testid="current-suit-indicator"]').textContent).toBe("♥");

  await renderTableState([[1, "KH"], [2, "9D"], [3, "2C"]]);
  expect(container.querySelector('[data-testid="current-suit-indicator"]').textContent).toBe("♥");

  await renderTableState([]);
  expect(container.querySelector('[data-testid="current-suit-indicator"]')).toBeNull();
});

test("played cards stay in the seat-relative positions around the current suit", async () => {
  await renderTableState([[0, "AS"], [1, "KH"], [2, "QD"], [3, "JC"]]);

  const expectedSlots = [
    ["col-start-2", "row-start-3"],
    ["col-start-3", "row-start-2"],
    ["col-start-2", "row-start-1"],
    ["col-start-1", "row-start-2"],
  ];
  expectedSlots.forEach((slotClasses, seat) => {
    const card = container.querySelector(`[data-testid="trick-card-${seat}"]`);
    slotClasses.forEach((slotClass) => expect(card.parentElement.className).toContain(slotClass));
    expect(card.parentElement.style.zIndex).toBe("");
    expect(card.parentElement.className).not.toContain("z-[");
  });

  expect(container.querySelector('[data-testid="current-suit-indicator"]').textContent).toBe("♠");
});

test("trick card faces render readable matching red and black corner suits", async () => {
  await act(async () => {
    root.render(
      <>
        <PlayingCard card="AH" size="trick" testId="hearts-card" />
        <PlayingCard card="AS" size="trick" testId="spades-card" />
        <PlayingCard card="AH" size="fluid" testId="hand-hearts-card" />
      </>,
    );
  });

  const hearts = container.querySelector('[data-testid="hearts-card"]');
  const spades = container.querySelector('[data-testid="spades-card"]');
  const handHearts = container.querySelector('[data-testid="hand-hearts-card"]');
  expect(hearts.className).toContain("playing-card-face");
  expect(hearts.className).toContain("text-rose-600");
  expect(spades.className).toContain("text-slate-900");
  const cornerLabels = (card) => [...card.children].filter((child) => child.className.includes("font-bold")).map((corner) => corner.textContent);
  expect(cornerLabels(hearts)).toEqual(["A♥", "A"]);
  expect(cornerLabels(spades)).toEqual(["A♠", "A"]);
  expect(cornerLabels(hearts)).toEqual(cornerLabels(handHearts));
  expect(hearts.querySelector(".trick-card-symbol").textContent).toBe("♥");
  expect(spades.querySelector(".trick-card-symbol").textContent).toBe("♠");
});

test("human game-table avatars and names open their public profile", async () => {
  const player = { seat: 1, team: 1, user_id: "player-1", username: "Player Two", online: true, is_bot: false };
  await act(async () => {
    root.render(<SeatPanel player={player} st={makeState([4, 3])} mySeat={0}
      turnDeadline="2099-01-01T00:00:30.000Z" turnDuration={30} serverOffsetMs={0} />);
  });

  expect(container.querySelector('[data-testid="seat-profile-link-1"]').getAttribute("href")).toBe("/profile/Player%20Two");
  expect(container.querySelector('[data-testid="seat-username-link-1"]').textContent).toBe("Player Two");
  expect(container.querySelector('[data-testid="turn-timer"]')).not.toBeNull();
});

const hudState = () => ({ ...makeState([3, 2]), tens: [["10S"], ["10D", "10C"]], koth: 1, dealer: 2, phase: "playing", turn: 1 });

async function renderHud(density, connected = true) {
  await act(async () => {
    root.render(<Hud st={hudState()} players={players} roomCode="ROOM7" gameStatus="active" connected={connected} density={density} />);
  });
}

test.each(["regular", "short", "tiny"])("%s header keeps every essential value exactly once", async (density) => {
  await renderHud(density);
  const one = (id) => {
    const nodes = container.querySelectorAll(`[data-testid="${id}"]`);
    expect(nodes).toHaveLength(1);
    return nodes[0];
  };
  expect(one("match-scoreboard").getAttribute("data-density")).toBe(density);
  expect(one("score-team-a").textContent).toBe("9/10");
  expect(one("score-team-b").textContent).toBe("2/10");
  expect(one("tricks-team-a").textContent).toBe("3");
  expect(one("tricks-team-b").textContent).toBe("2");
  // Each side shows its own count; the total out of four sits in the middle.
  expect(one("tens-count-team-a").textContent).toBe("1 ten");
  expect(one("tens-count-team-b").textContent).toBe("2 tens");
  expect(one("tens-total-count").textContent).toBe("3/4");
  expect(one("tens-total").getAttribute("title")).toBe("3 of 4 tens captured · Team A 1, Team B 2");
  // Markers: Team A's from the left, Team B's from the right.
  expect([...one("tens-total").querySelectorAll("[aria-hidden] > span")].map((s) => s.className.match(/bg-(sky|amber)-300|bg-white\/15/)[0]))
    .toEqual(["bg-sky-300", "bg-white/15", "bg-amber-300", "bg-amber-300"]);
  expect(one("captured-ten-10D")).toBeTruthy();
  expect(one("trump-indicator-badge").textContent).toContain("♠");
  expect(one("connection-status").textContent).toBe("Live");
  expect(one("koth-active-badge").textContent).toContain("Team B");
  expect(one("round-info").textContent).toMatch(/3/); // round number
  expect(one("round-info").textContent).toMatch(/5\/13/); // current trick
});

test("denser headers leave out only details the table already shows", async () => {
  await renderHud("regular");
  const regular = container.querySelector('[data-testid="round-info"]').textContent;
  expect(regular).toContain("Dealer");
  expect(regular).toContain("Turn");
  // "Phase" is only worth a segment outside ordinary play.
  expect(regular).not.toContain("Phase");
  await act(async () => {
    root.render(<Hud st={{ ...hudState(), phase: "koth_decision", koth_decision: 1 }} players={players} roomCode="ROOM7" gameStatus="active" connected density="regular" />);
  });
  expect(container.querySelector('[data-testid="round-info"]').textContent).toContain("PhaseKoth decision");
  expect(container.querySelector('[data-testid="room-id"]')).not.toBeNull();

  await renderHud("short");
  const short = container.querySelector('[data-testid="round-info"]').textContent;
  expect(short).not.toContain("Dealer"); // shown by the "D" badge on the dealer's seat
  expect(short).not.toContain("To act"); // shown by the active seat's glow and the turn pill
  expect(container.querySelector('[data-testid="room-id"]')).not.toBeNull();

  await renderHud("tiny");
  expect(container.querySelector('[data-testid="team-inline-a"]')).not.toBeNull();
  expect(container.querySelector('[data-testid="round-info"] [title]').getAttribute("title")).toContain("ROOM7");
});

test("narrow landscape header stays terse but keeps every value readable or announced", async () => {
  await act(async () => {
    root.render(<Hud st={hudState()} players={players} roomCode="ROOM7" gameStatus="active" connected={false} density="tiny" narrow />);
  });
  const teamA = container.querySelector('[data-testid="team-inline-a"]');
  expect(teamA.getAttribute("title")).toBe("Team A · YOU");
  expect(teamA.textContent).toContain("A·YOU");
  expect(container.querySelector('[data-testid="score-team-b"]').textContent).toBe("2/10");
  // Trick counts keep their accessible label even when the visible label is dropped.
  expect(container.querySelector('[data-testid="team-trick-counter-a"]').getAttribute("aria-label")).toBe("Team A won 3 tricks this round");
  // Captured tens are shown as the cards themselves; "0/4" text appears only when a team has none.
  expect(container.querySelectorAll('[data-testid^="captured-ten-"]')).toHaveLength(3);
  const status = container.querySelector('[data-testid="connection-status"]');
  expect(status.getAttribute("title")).toBe("Reconnecting");
  expect(status.textContent).toBe("Reconnecting");
});

test("the reconnecting state stays visible in every header", async () => {
  for (const density of ["regular", "short", "tiny"]) {
    await renderHud(density, false);
    expect(container.querySelector('[data-testid="connection-status"]').textContent).toBe("Reconnecting");
  }
});

test("compact seat panel keeps name, team, cards, dealer badge and online state", async () => {
  const player = { seat: 2, team: 0, user_id: "p2", username: "Partner", display_name: "Partner P", online: true, is_bot: false };
  const st = { ...makeState([4, 3]), dealer: 2, turn: 2, hand_counts: [13, 13, 9, 13] };
  await act(async () => {
    root.render(<SeatPanel player={player} st={st} mySeat={0} compact turnDeadline="2099-01-01T00:00:30.000Z" turnDuration={30} serverOffsetMs={0} turnSeat={2} />);
  });
  const seat = container.querySelector('[data-testid="player-seat-2"]');
  expect(seat.getAttribute("data-compact")).toBe("true");
  expect(seat.textContent).toContain("Partner P");
  expect(seat.textContent).toContain("Partner · A");
  expect(container.querySelector('[data-testid="seat-card-count-2"]').textContent).toBe("9 cards");
  expect(container.querySelector('[data-testid="dealer-badge-2"]')).not.toBeNull();
  expect(container.querySelector('[data-testid="online-badge-2"]')).not.toBeNull();
  expect(container.querySelector('[data-testid="turn-timer"]')).not.toBeNull();
});

test("mini seat panel keeps the name, card count, dealer and online badges with full details in the tooltip", async () => {
  const player = { seat: 0, team: 0, user_id: "me", username: "me", online: true, is_bot: false };
  const st = { ...makeState([4, 3]), dealer: 0, hand_counts: [5, 5, 5, 5] };
  await act(async () => {
    root.render(<SeatPanel player={player} st={st} mySeat={0} mini />);
  });
  const seat = container.querySelector('[data-testid="player-seat-0"]');
  expect(seat.getAttribute("data-mini")).toBe("true");
  expect(seat.getAttribute("title")).toBe("You · Team A · 5 cards");
  expect(seat.textContent).toContain("You");
  expect(container.querySelector('[data-testid="seat-card-count-0"]').textContent).toBe("5 cards");
  expect(container.querySelector('[data-testid="dealer-badge-0"]')).not.toBeNull();
  expect(container.querySelector('[data-testid="online-badge-0"]')).not.toBeNull();
});

test("timer seat follows the server's turn_seat and falls back to the acting seat", () => {
  const playing = makeState([0, 0]);
  expect(timerSeatFor(playing, undefined)).toBe(1);
  expect(timerSeatFor({ ...playing, phase: "trump_select", trump_selector: 3 }, undefined)).toBe(3);
  // A bot (seat 2) won the trick but its human partner (seat 0) owns the decision timer.
  const koth = { ...playing, phase: "koth_decision", turn: 2, koth_decision: 0 };
  expect(timerSeatFor(koth, undefined)).toBe(2);
  expect(timerSeatFor(koth, 0)).toBe(0);
  expect(timerSeatFor({ ...playing, phase: "round_over", turn: null }, 1)).toBeNull();
});

test("decision countdown renders on the human teammate, not on the bot that won the trick", async () => {
  const st = { ...makeState([7, 0]), phase: "gs_decision", turn: 2, gs_eligible: 0, my_seat: 1 };
  const human = { seat: 0, team: 0, user_id: "player-0", username: "Human", online: true, is_bot: false };
  const bot = { seat: 2, team: 0, user_id: "bot-2", username: "Bot Meera", online: true, is_bot: true };
  const timerProps = { turnDeadline: "2099-01-01T00:00:30.000Z", turnDuration: 30, serverOffsetMs: 0, turnSeat: 0 };
  await act(async () => {
    root.render(
      <>
        <SeatPanel player={human} st={st} mySeat={1} {...timerProps} />
        <SeatPanel player={bot} st={st} mySeat={1} {...timerProps} />
      </>,
    );
  });
  const timerIn = (seat) => container.querySelector(`[data-testid="player-seat-${seat}"] [data-testid="turn-timer"]`);
  expect(timerIn(0)).not.toBeNull();
  expect(timerIn(2)).toBeNull();
  // The panel showing the timer is raised above the table board (z-10) so its border badge is never
  // painted under the table's edge; other panels stay at the default layer.
  const panel = (seat) => container.querySelector(`[data-testid="player-seat-${seat}"]`);
  expect(panel(0).className).toMatch(/(^|\s)z-20(\s|$)/);
  expect(panel(2).className).not.toMatch(/(^|\s)z-20(\s|$)/);
  // Seats relative to me: seat 0 sits to my left here (rel 3), so its badge is centred on the top border.
  expect(timerIn(0).className).toContain("left-1/2");
  expect(timerIn(0).className).not.toContain("left-full");
});
