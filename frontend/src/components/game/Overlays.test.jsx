import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { FinalRoundSummary, GrandSlamPrompt, MatchOver } from "./Overlays";

jest.mock("react-router-dom", () => {
  const ReactModule = jest.requireActual("react");
  return {
    Link: ({ to, children, ...props }) => ReactModule.createElement("a", { ...props, href: to }, children),
  };
});
jest.mock("framer-motion", () => {
  const ReactModule = jest.requireActual("react");
  const element = (tag) => ReactModule.forwardRef(({ initial, animate, transition, ...props }, ref) =>
    ReactModule.createElement(tag, { ...props, ref }));
  return { motion: { div: element("div"), section: element("section"), span: element("span") } };
});
jest.mock("@/components/PlayingCard", () => ({ PlayingCard: ({ card, testId }) => <span data-testid={testId}>{card}</span> }));
jest.mock("@/components/PlayerAvatar", () => ({ PlayerAvatar: ({ user }) => <span>{user.username} avatar</span> }));
jest.mock("@/components/game/Effects", () => ({ Burst: () => null }));
jest.mock("@/lib/sound", () => ({ sound: { play: jest.fn(), chime: jest.fn() } }));
jest.mock("@/lib/api", () => ({
  SUIT_SYMBOL: { S: "♠", H: "♥", D: "♦", C: "♣" },
  SUIT_NAME: { S: "Spades", H: "Hearts", D: "Diamonds", C: "Clubs" },
  TEAM_NAME: ["Team A", "Team B"],
  VICTORY_LABEL: { normal: "Normal Win", koth: "Koth", grand_slam: "Grand Slam" },
  REASON_LABEL: { three_tens: "Captured three tens" },
  isRed: (suit) => suit === "H" || suit === "D",
}));

global.IS_REACT_ACT_ENVIRONMENT = true;

const players = [0, 1, 2, 3].map((seat) => ({
  seat,
  team: seat % 2,
  user_id: `u${seat}`,
  username: `Player ${seat + 1}`,
  avatar_color: "#123456",
  avatar_icon: "star",
}));

const state = {
  phase: "match_over",
  my_seat: 0,
  winner_team: 0,
  scores: [5, 4],
  target: 5,
  round_no: 3,
  trump: "H",
  tricks_won: [8, 5],
  rounds: [
    { round: 1, winner_team: 0, type: "normal", points: 1, reason: "three_tens", tricks_won: [7, 6] },
    { round: 2, winner_team: 1, type: "koth", points: 2, reason: "koth_fourth_ten", tricks_won: [5, 8] },
    { round: 3, winner_team: 0, type: "normal", points: 1, reason: "three_tens", tricks_won: [8, 5] },
  ],
  result: { winner_team: 0, type: "normal", points: 1, reason: "three_tens" },
  last_trick: { cards: [[0, "AH"], [1, "KH"], [2, "QH"], [3, "JH"]], winner: 0 },
  forfeited_by: null,
};

const game = {
  status: "finished",
  room_code: "ROOM7",
  is_public: false,
  created_at: "2026-11-25T10:00:00+00:00",
  finished_at: "2026-11-25T10:30:00+00:00",
  result_summary: {
    winner_team: 0,
    scores: [5, 4],
    target: 5,
    tricks_won: [20, 19],
    total_tricks: 39,
    rounds_played: 3,
    final_trump: "H",
    last_trick: state.last_trick,
    final_result: state.result,
    forfeited_by: null,
    started_at: "2026-11-25T10:00:00+00:00",
    finished_at: "2026-11-25T10:30:00+00:00",
    duration_seconds: 1800,
  },
};

let root;
let container;

async function renderResult(overrides = {}) {
  await act(async () => {
    root.render(
      <MatchOver st={{ ...state, ...overrides.state }} players={players} mySeat={overrides.mySeat ?? 0}
        game={{ ...game, ...overrides.game }} />,
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

test("final round summary shows the type badge, points with the scoring team, and the reason", async () => {
  await act(async () => {
    root.render(<FinalRoundSummary finalRound={{ winner_team: 0, type: "normal", points: 1, reason: "three_tens" }} reason="three_tens" />);
  });
  const q = (id) => container.querySelector(`[data-testid="${id}"]`);
  expect(q("victory-type").textContent).toContain("Final round");
  expect(q("victory-type-badge").textContent).toContain("Normal Win");
  expect(q("victory-type-points").textContent).toBe("+1 to Team A");
  expect(q("victory-type-reason-title").textContent).toBe("Three tens captured");
  expect(q("victory-type-reason-detail").textContent).toBe("Team A took three of the four tens while the opponents held the other.");
});

test.each([
  ["koth_fourth_ten", "koth", "Fourth ten captured", "After Koth was declared, Team B captured the deciding fourth ten."],
  ["automatic_koth", "koth", "Automatic Koth", "Team B captured the third and fourth tens together."],
  ["grand_slam", "grand_slam", "13 Mann completed", "Team B won all thirteen tricks."],
  ["equal_tens", "normal", "Tens split 2–2", "Each team held two tens; Team B won at least seven tricks."],
  ["two_tens_seven_tricks", "normal", "Two tens and seven tricks", "Team B held two tens and seven tricks while the opponents had a ten."],
  ["koth_declined", "normal", "Koth declined", "Team B held three tens and chose the normal win."],
])("reason %s gets a clear title and explanation", async (reason, type, title, detail) => {
  await act(async () => {
    root.render(<FinalRoundSummary finalRound={{ winner_team: 1, type, points: 1, reason }} reason={reason} />);
  });
  expect(container.querySelector('[data-testid="victory-type-reason-title"]').textContent).toBe(title);
  expect(container.querySelector('[data-testid="victory-type-reason-detail"]').textContent).toBe(detail);
});

test("an unknown reason falls back to its label without inventing an explanation", async () => {
  await act(async () => {
    root.render(<FinalRoundSummary finalRound={{ winner_team: 0, type: "normal", points: 1, reason: "future_reason" }} reason="future_reason" />);
  });
  expect(container.querySelector('[data-testid="victory-type-reason-title"]').textContent).toBe("future_reason");
  expect(container.querySelector('[data-testid="victory-type-reason-detail"]')).toBeNull();
});

test("a failed Grand Slam names the team that attempted it", async () => {
  await act(async () => {
    root.render(<FinalRoundSummary finalRound={{ winner_team: 1, type: "grand_slam", points: 3, reason: "grand_slam_failed" }} reason="grand_slam_failed" />);
  });
  const q = (id) => container.querySelector(`[data-testid="${id}"]`);
  expect(q("victory-type-badge").textContent).toContain("Grand Slam");
  expect(q("victory-type").getAttribute("data-tone")).toBe("grand_slam");
  expect(q("victory-type-points").textContent).toBe("+3 to Team B");
  expect(q("victory-type-reason-title").textContent).toBe("Grand Slam attempt failed");
  expect(q("victory-type-reason-detail").textContent).toBe("Team A declared 13 Mann but lost a trick, so Team B receives the Grand Slam.");
});

test("forfeits and missing round data have their own clear states", async () => {
  await act(async () => {
    root.render(<FinalRoundSummary forfeiter={{ username: "quitter", display_name: "Quitter Q" }} finalRound={{ type: "normal", points: 1 }} />);
  });
  const plaque = () => container.querySelector('[data-testid="victory-type"]');
  expect(plaque().getAttribute("data-tone")).toBe("forfeit");
  expect(container.querySelector('[data-testid="victory-type-badge"]').textContent).toBe("Forfeit");
  expect(container.querySelector('[data-testid="victory-type-reason-title"]').textContent).toBe("Quitter Q forfeited the match");
  expect(container.querySelector('[data-testid="victory-type-points"]')).toBeNull(); // a forfeit awards no round points
  await act(async () => { root.render(<FinalRoundSummary />); });
  expect(container.querySelector('[data-testid="victory-type-reason-title"]').textContent).toBe("Final result confirmed by the game server");
});

test("grand slam prompt explains that declining after a trick-7 automatic Koth takes the Koth", async () => {
  const onDecide = jest.fn();
  await act(async () => { root.render(<GrandSlamPrompt partnerHand={["AS", "KS"]} onDecide={onDecide} />); });
  expect(container.querySelector('[data-testid="grand-slam-auto-koth-note"]')).toBeNull();
  expect(container.querySelector('[data-testid="grand-slam-decline-btn"]').textContent).toBe("Decline");

  await act(async () => { root.render(<GrandSlamPrompt partnerHand={["AS", "KS"]} onDecide={onDecide} autoKoth />); });
  expect(container.querySelector('[data-testid="grand-slam-auto-koth-note"]').textContent).toContain("Koth (2 points)");
  const decline = container.querySelector('[data-testid="grand-slam-decline-btn"]');
  expect(decline.textContent).toBe("Take Koth");
  await act(async () => { decline.click(); });
  expect(onDecide).toHaveBeenCalledWith(false);
  expect(container.querySelector('[data-testid="partner-card-AS"]')).not.toBeNull();
});

test("winning and losing players receive the correct perspective from the backend winner", async () => {
  await renderResult({ mySeat: 0 });
  expect(container.querySelector('[data-testid="victory-winning-team"]').textContent).toBe("Team A wins the match");
  expect(container.querySelector('[data-testid="victory-screen"]').textContent).toContain("Victory");

  await renderResult({ mySeat: 1 });
  expect(container.querySelector('[data-testid="victory-screen"]').textContent).toContain("Defeat");
  expect(container.querySelector('[data-testid="victory-winning-team"]').textContent).toBe("Team A wins the match");
});

test("a stake table pours the winnings in and counts them up; losers see the entry go; free tables show no coin line", async () => {
  jest.useFakeTimers();
  try {
    const { sound } = require("@/lib/sound");
    sound.chime.mockClear();
    const stake = { tier: "chai", name: "Chai Table", entry: 100, payout: 180, ref: "R" };
    await renderResult({ mySeat: 0, game: { stake } });
    const line = container.querySelector('[data-testid="match-coin-result"]');
    const amount = () => container.querySelector('[data-testid="match-coin-amount"]').textContent;
    expect(line.dataset.won).toBe("true");
    expect(line.getAttribute("aria-label")).toBe("+180 coins, Chai Table");
    expect(line.textContent).toContain("Chai Table");
    expect(amount()).toBe("+0 coins");
    expect(container.querySelectorAll('[data-testid="payout-coin"]')).toHaveLength(12);
    expect(sound.chime.mock.calls.filter(([k]) => k === "coin_drop")).toHaveLength(12);
    await act(async () => { jest.advanceTimersByTime(1500); });
    expect(amount()).not.toBe("+0 coins");
    await act(async () => { jest.advanceTimersByTime(1000); });
    expect(amount()).toBe("+180 coins");
    await renderResult({ mySeat: 1, game: { stake } });
    expect(amount()).toBe("−100 coins");
    expect(container.querySelector('[data-testid="payout-coin"]')).toBeNull();
    expect(container.querySelector('[data-testid="payout-lost-coin"]')).not.toBeNull();
    await renderResult({ mySeat: 0 });
    expect(container.querySelector('[data-testid="match-coin-result"]')).toBeNull();
  } finally {
    jest.useRealTimers();
  }
});

test("scoreboard uses persisted match totals and shows every player's identity", async () => {
  await renderResult();

  expect(container.querySelector('[data-testid="match-team-0"]').textContent).toContain("5/5");
  expect(container.querySelector('[data-testid="match-team-0"]').textContent).toContain("20");
  expect(container.querySelector('[data-testid="match-team-1"]').textContent).toContain("4/5");
  expect(container.querySelector('[data-testid="match-team-1"]').textContent).toContain("19");
  expect(container.querySelector('[data-testid="match-total-tricks"]').textContent).toContain("39");
  for (const player of players) expect(container.textContent).toContain(player.username);
  expect(container.querySelector('[data-testid="match-duration"]').textContent).toContain("30m");
  expect(container.querySelector('[data-testid="match-final-trump"]').textContent).toContain("Hearts");
  expect(container.querySelector('[data-testid="match-round-results"]')).not.toBeNull();
  expect(container.querySelector('[data-testid="match-last-trick"]')).not.toBeNull();
});

test("missing winner data is not incorrectly presented as a draw", async () => {
  await renderResult({ state: { winner_team: null, result: null }, game: { result_summary: { ...game.result_summary, winner_team: null } } });

  expect(container.querySelector('[data-testid="victory-screen"]').textContent).toContain("Result unavailable");
  expect(container.querySelector('[data-testid="victory-winning-team"]').textContent).toBe("Match result unavailable");
  expect(container.querySelector('[data-testid="victory-screen"]').textContent).not.toContain("Match drawn");
});

test("result actions point to supported flows and layout includes responsive breakpoints", async () => {
  await renderResult();

  expect(container.querySelector('[data-testid="victory-play-again-btn"]').getAttribute("href")).toBe("/play");
  expect(container.querySelector('[data-testid="victory-history-btn"]').getAttribute("href")).toBe("/history");
  expect(container.querySelector('[data-testid="victory-home-btn"]').getAttribute("href")).toBe("/home");
  expect(container.querySelector('[data-testid="victory-share-btn"]')).not.toBeNull();
  expect(container.querySelector('[data-testid="match-scoreboard"] .sm\\:grid-cols-2')).not.toBeNull();
  expect(container.querySelector('[data-testid="victory-screen"]').className).toContain("overflow-y-auto");
});

const medalRow = (user_id, seat, won, change, balance_after = null, extra = {}) => ({
  user_id, seat, team: seat % 2, won, tricks: 3, tens: 1, trick_medals: won ? 3 : 0, ten_medals: won ? 3 : 0,
  bonus: won ? 4 : 0, penalty: won ? 0 : 4, requested: won ? 10 : -4, change, balance_after, ...extra,
});
const matchMedals = {
  eligible: true, totals: { u0: 9, u1: -5, u2: 11, u3: -4 },
  rounds: [
    { round: 1, winner_team: 0, type: "koth", players: [medalRow("u0", 0, true, 10, 30), medalRow("u1", 1, false, -4), medalRow("u2", 2, true, 10), medalRow("u3", 3, false, -4)] },
    { round: 2, winner_team: 1, type: "normal", players: [medalRow("u0", 0, false, -1, 29), medalRow("u1", 1, true, -1), medalRow("u2", 2, false, 1), medalRow("u3", 3, true, 0)] },
  ],
};

test("the match over screen shows your net medal change, each round and every player's net", async () => {
  await renderResult({ mySeat: 0, game: { medals_eligible: true, match_medals: matchMedals } });
  const q = (id) => container.querySelector(`[data-testid="${id}"]`);
  expect(q("match-medals-net").textContent).toBe("+9");
  expect(q("match-medals-balance").textContent).toBe("29");
  expect(q("match-medals-round-1").textContent).toBe("R1 +10");
  expect(q("match-medals-round-2").textContent).toBe("R2 −1");
  expect(q("match-medals-round-2").getAttribute("title")).toBe("Round 2 · Normal loss: Normal loss penalty −4 · only 1 taken (medals never go below 0)");
  expect([0, 1, 2, 3].map((s) => q(`match-medals-player-${s}`).textContent)).toEqual(["+9", "−5", "+11", "−4"]);
  expect(q("match-medals-summary").textContent).toContain("Player 1 (you)");
});

test("bot matches say no medals; spectators and matches without medal data show nothing", async () => {
  const q = (id) => container.querySelector(`[data-testid="${id}"]`);
  await renderResult({ game: { medals_eligible: false, match_medals: null } });
  expect(q("match-medals-unavailable").textContent).toContain("No medals in matches with bots");
  expect(q("match-medals-summary")).toBeNull();
  await renderResult({ game: { medals_eligible: true, match_medals: null } });
  expect(q("match-medals-summary")).toBeNull();
  expect(q("match-medals-unavailable")).toBeNull();
  await act(async () => {
    root.render(<MatchOver st={state} players={players} mySeat={null} game={{ ...game, medals_eligible: true, match_medals: matchMedals }} spectator />);
  });
  expect(q("match-medals-summary")).toBeNull();
});