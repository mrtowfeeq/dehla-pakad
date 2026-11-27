import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { RoundResultScreen, tenOwnership } from "./RoundResultScreen";

jest.mock("framer-motion", () => {
  const ReactModule = jest.requireActual("react");
  const element = (tag) => ReactModule.forwardRef(({ initial, animate, transition, ...props }, ref) =>
    ReactModule.createElement(tag, { ...props, ref }));
  return { motion: { div: element("div"), section: element("section"), span: element("span") } };
});
jest.mock("@/components/PlayingCard", () => ({ PlayingCard: ({ card }) => <span data-card={card}>{card}</span> }));
jest.mock("@/components/game/Effects", () => ({ Burst: () => <span data-testid="burst" /> }));
jest.mock("@/lib/sound", () => ({ sound: { play: jest.fn() } }));
jest.mock("@/lib/api", () => ({
  TEAM_NAME: ["Team A", "Team B"],
  VICTORY_LABEL: { normal: "Normal Win", koth: "Koth", grand_slam: "Grand Slam · 13 Mann" },
  REASON_LABEL: {
    three_tens: "Captured three tens", equal_tens: "Tens split 2–2, won 7 tricks",
    two_tens_seven_tricks: "Two tens and 7 tricks, opponents hold a ten", koth_fourth_ten: "Captured the fourth ten",
    automatic_koth: "Automatic Koth — 3rd & 4th ten in one trick", grand_slam: "Won all 13 tricks",
    grand_slam_failed: "Grand Slam attempt failed", koth_declined: "Koth declined — three tens",
  },
}));

const { sound } = jest.requireMock("@/lib/sound");
global.IS_REACT_ACT_ENVIRONMENT = true;

const players = [0, 1, 2, 3].map((seat) => ({ seat, team: seat % 2, user_id: `u${seat}`, username: `player${seat}`, display_name: `Player ${seat + 1}` }));
const NOW = Date.parse("2026-11-26T12:00:00.000Z");
const at = (ms) => new Date(NOW + ms).toISOString();

const normal = {
  winner_team: 0, type: "normal", points: 1, reason: "two_tens_seven_tricks", next_dealer: 1,
  tricks_won: [7, 4], tens: [2, 1], captured_tens: [["10S", "10H"], ["10D"]],
};

let root;
let container;

async function render(props) {
  await act(async () => {
    root.render(<RoundResultScreen round={3} scores={[4, 2]} target={7} mySeat={0} players={players}
      nextRoundAt={at(11500)} serverOffsetMs={0} result={normal} {...props} />);
  });
}

const q = (id) => container.querySelector(`[data-testid="${id}"]`);

beforeEach(() => {
  jest.useFakeTimers();
  jest.setSystemTime(NOW);
  sound.play.mockClear();
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  jest.useRealTimers();
});

test("every ten appears exactly once, under the team that captured it or as not captured", async () => {
  await render();
  for (const [card, owner] of [["10S", "0"], ["10H", "0"], ["10D", "1"], ["10C", "none"]]) {
    const nodes = container.querySelectorAll(`[data-testid="round-ten-${card}"]`);
    expect(nodes).toHaveLength(1);
    expect(nodes[0].getAttribute("data-owner")).toBe(owner);
  }
  expect(q("round-team-cards-0").textContent).toBe("10S10H");
  expect(q("round-team-cards-1").textContent).toBe("10D");
  expect(q("round-result-uncaptured").textContent).toContain("10C");
});

test("shows tricks and ten totals per team and highlights the winner", async () => {
  await render();
  expect(q("round-team-tricks-0").textContent).toBe("7");
  expect(q("round-team-tricks-1").textContent).toBe("4");
  expect(q("round-team-tens-0").textContent).toBe("2");
  expect(q("round-team-tens-1").textContent).toBe("1");
  expect(q("round-team-panel-0").getAttribute("data-winner")).toBe("true");
  expect(q("round-team-panel-1").getAttribute("data-winner")).toBe("false");
  expect(q("round-team-winner-0")).not.toBeNull();
  expect(q("round-team-winner-1")).toBeNull();
});

test("shows the exact reason, points, match score, round number and next dealer", async () => {
  await render();
  expect(q("round-result-headline").textContent).toBe("Victory");
  expect(q("round-result-type").textContent).toBe("Team A · Normal Win");
  expect(q("round-result-reason").textContent).toBe("Two tens and 7 tricks, opponents hold a ten");
  expect(q("round-result-points").textContent).toBe("+1");
  expect(q("round-result-score").textContent).toBe("4 – 2");
  expect(q("round-result-round").textContent).toBe("Round 3 complete");
  expect(q("round-result-next-dealer").textContent).toBe("Player 2");
  expect(q("burst")).not.toBeNull();
});

test.each([
  [{ type: "koth", points: 2, reason: "koth_fourth_ten" }, "Team A · Koth", "Captured the fourth ten"],
  [{ type: "koth", points: 2, reason: "automatic_koth" }, "Team A · Koth", "Automatic Koth — 3rd & 4th ten in one trick"],
  [{ type: "grand_slam", points: 3, reason: "grand_slam" }, "Team A · Grand Slam · 13 Mann", "Won all 13 tricks"],
  [{ type: "normal", points: 1, reason: "equal_tens", captured_tens: [["10S", "10H"], ["10D", "10C"]], tens: [2, 2] },
    "Team A · Normal Win", "Tens split 2–2, won 7 tricks"],
])("labels %o", async (overrides, typeText, reasonText) => {
  await render({ result: { ...normal, ...overrides } });
  expect(q("round-result-type").textContent).toBe(typeText);
  expect(q("round-result-reason").textContent).toBe(reasonText);
  expect(q("round-result-points").textContent).toBe(`+${overrides.points}`);
});

test("the losing side sees defeat without particles", async () => {
  await render({ mySeat: 1 });
  expect(q("round-result-headline").textContent).toBe("Defeat");
  expect(q("burst")).toBeNull();
});

test("countdown follows the server deadline and a reconnect sees the same remaining time", async () => {
  await render();
  expect(q("round-result-seconds").textContent).toBe("12s"); // still inside the last-trick animation
  await act(async () => { jest.advanceTimersByTime(1600); });
  expect(q("round-result-seconds").textContent).toBe("10s");
  expect(q("round-result-progress").style.width).toBe("99%");

  // A reconnecting player mounts six seconds later with the same deadline.
  act(() => root.unmount());
  root = createRoot(container);
  jest.setSystemTime(NOW + 7600);
  await render();
  expect(q("round-result-seconds").textContent).toBe("4s");
  expect(q("round-result-progress").style.width).toBe("39%");
  await act(async () => { jest.advanceTimersByTime(1000); });
  expect(q("round-result-seconds").textContent).toBe("3s");
  expect(sound.play).toHaveBeenCalledWith("tick", { gain: 0.6 });
});

test("server clock offset is applied to the countdown", async () => {
  await render({ nextRoundAt: at(5000), serverOffsetMs: 2000 }); // server is two seconds ahead
  expect(q("round-result-seconds").textContent).toBe("3s");
});

test("rounds recorded before the card snapshot show counts only, never guessed cards", async () => {
  const legacy = { ...normal };
  delete legacy.captured_tens;
  expect(tenOwnership(legacy)).toBeNull();
  await render({ result: legacy });
  expect(container.querySelector('[data-testid^="round-ten-"]')).toBeNull();
  expect(q("round-result-tens-unavailable")).not.toBeNull();
  expect(q("round-team-tens-0").textContent).toBe("2");
});

test("without a deadline the screen still renders and says the next round starts soon", async () => {
  await render({ nextRoundAt: null });
  expect(q("round-result-seconds").textContent).toBe("soon");
  expect(q("round-result-progress")).toBeNull();
});

const win = (user_id, seat, tricks, tens, change, balance_after = null) => ({
  user_id, seat, team: seat % 2, won: true, tricks, tens, trick_medals: tricks, ten_medals: tens * 3, bonus: 4, penalty: 0,
  requested: tricks + tens * 3 + 4, change, balance_after,
});
const loss = (user_id, seat, tricks, tens, change, balance_after = null) => ({
  user_id, seat, team: seat % 2, won: false, tricks, tens, trick_medals: 0, ten_medals: 0, bonus: 0, penalty: 4,
  requested: -4, change, balance_after,
});
// Koth round: Player 1 (seat 0) 4 tricks + 1 ten + 4 = 11; Player 3 (seat 2) 3 + 3 + 4 = 10;
// Player 2 (seat 1) loses 4; Player 4 (seat 3) only had 1 medal left.
const roundMedals = (viewer) => ({
  round: 3, winner_team: 0, type: "koth", victory_medals: 4, players: [
    win("u0", 0, 4, 1, 11, viewer === 0 ? 120 : null),
    loss("u1", 1, 4, 1, -4, viewer === 1 ? 6 : null),
    win("u2", 2, 3, 1, 10, viewer === 2 ? 40 : null),
    loss("u3", 3, 2, 0, -1, viewer === 3 ? 0 : null),
  ],
});

test("winners see their trick medals, ten bonus, Koth bonus, net change and their new balance", async () => {
  await render({ medals: roundMedals(0), medalsEligible: true });
  expect(q("round-medals-seat-0").textContent).toContain("Player 1");
  expect(q("round-medals-seat-0").textContent).toContain("You");
  expect(q("round-medals-parts-0").textContent).toBe("+4 tricks · +3 ten · +4 Koth");
  expect(q("round-medals-seat-0").getAttribute("title")).toBe("4 tricks +4 · 1 ten bonus +3 · Koth win bonus +4");
  expect(q("round-medals-value-0").textContent).toBe("+11");
  expect(q("round-medals-value-2").textContent).toBe("+10");
  expect(q("round-medals-balance").textContent).toBe("You +11 · balance 120");
  expect(q("round-medals-seat-1")).toBeNull();
});

test("the losing team sees the Koth penalty and what was actually taken, never below zero", async () => {
  await render({ mySeat: 3, medals: roundMedals(3), medalsEligible: true });
  expect(q("round-medals-losers").textContent).toContain("Koth loss penalty −4 each");
  expect(q("round-medals-loser-1").textContent).toContain("−4");
  expect(q("round-medals-loser-3").textContent).toContain("Player 4 (you)");
  expect(q("round-medals-loser-3").textContent).toContain("−1");
  expect(q("round-medals-loser-3").textContent).toContain("only 1 to take");
  expect(q("round-medals-balance").textContent).toBe("You −1 · balance 0");
  // Losers never get trick or ten medals.
  expect(q("round-medals-loser-1").getAttribute("title")).toBe("Koth loss penalty −4");
});

test("bot matches explain that medals need a human-only match; spectators and old rounds show nothing", async () => {
  await render({ medals: null, medalsEligible: false });
  expect(q("round-medals-unavailable").textContent).toContain("without bots");
  expect(q("round-medals")).toBeNull();
  await render({ medals: roundMedals(0), medalsEligible: true, spectator: true });
  expect(q("round-medals")).toBeNull();
  await render({ medals: null, medalsEligible: true, spectator: false });
  expect(q("round-medals")).toBeNull();
  expect(q("round-medals-unavailable")).toBeNull();
});