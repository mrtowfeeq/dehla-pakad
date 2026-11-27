import React, { act } from "react";
import { createRoot } from "react-dom/client";
import History, { dayLabel, formatDuration } from "./History";

jest.mock("react-router-dom", () => {
  const ReactModule = jest.requireActual("react");
  return { Link: ({ to, children, ...props }) => ReactModule.createElement("a", { ...props, href: to }, children) };
});
jest.mock("@/context/AppContext", () => ({ useApp: () => global.__app }));
jest.mock("@/components/PlayerAvatar", () => ({ PlayerAvatar: () => <span /> }));
jest.mock("@/lib/api", () => ({
  TEAM_NAME: ["Team A", "Team B"],
  VICTORY_LABEL: { normal: "Normal Win", koth: "Koth", grand_slam: "Grand Slam · 13 Mann" },
}));

global.IS_REACT_ACT_ENVIRONMENT = true;

const players = (botOpponents = true) => [
  { seat: 0, team: 0, user_id: "me", username: "me" },
  { seat: 1, team: 1, user_id: "b1", username: "Bot Arjun", is_bot: botOpponents },
  { seat: 2, team: 0, user_id: "p2", username: "partner", display_name: "Partner P" },
  { seat: 3, team: 1, user_id: "b3", username: "Bot Kabir", is_bot: botOpponents },
];
const today = new Date().toISOString();
const matches = [
  {
    id: "m1", players: players(), winner_team: 0, scores: [5, 3], target: 5, is_public: false, has_bots: true,
    finished_at: today, duration_seconds: 754, forfeited_by: null,
    rounds: [
      { round: 1, winner_team: 0, type: "koth", points: 2 },
      { round: 2, winner_team: 1, type: "grand_slam", points: 3 },
      { round: 3, winner_team: 0, type: "normal", points: 1 },
      { round: 4, winner_team: 0, type: "koth", points: 2 },
    ],
  },
  {
    id: "m2", players: players(false), winner_team: 1, scores: [0, 7], target: 7, is_public: true, has_bots: false,
    finished_at: "2020-01-05T12:00:00Z", duration_seconds: 0, forfeited_by: 0, rounds: [],
  },
];

let root;
let container;

async function render(data = matches) {
  global.__app = { me: { user_id: "me" }, api: { get: jest.fn().mockResolvedValue({ data }) } };
  await act(async () => { root.render(<History />); });
  await act(async () => { await Promise.resolve(); });
}

const q = (sel) => container.querySelector(sel);
const tid = (id) => q(`[data-testid="${id}"]`);

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

test("each match shows its outcome, score from your side, how it ended and its tags", async () => {
  await render();
  const win = tid("match-row-m1");
  expect(win.getAttribute("data-outcome")).toBe("won");
  expect(win.querySelector('[data-testid="match-outcome"]').textContent).toBe("Victory");
  expect(win.querySelector('[data-testid="match-score"]').textContent).toBe("5–3");
  expect(win.textContent).toContain("Koth +2");
  expect(win.textContent).toContain("Practice");
  expect(win.textContent).toContain("13m");
  const loss = tid("match-row-m2");
  expect(loss.getAttribute("data-outcome")).toBe("lost");
  expect(loss.textContent).toContain("Forfeit");
  expect(loss.querySelector('[data-testid="match-meta"]').textContent).toBe("Public · to 7 · 0 rounds · Forfeit");
});

test("expanding a match shows both teams and a round timeline with the running score", async () => {
  await render();
  await act(async () => { tid("match-row-m1").querySelector("button").click(); });
  const rounds = tid("match-rounds-m1");
  expect(rounds.querySelectorAll("li")).toHaveLength(4);
  expect([...rounds.querySelectorAll("li")].map((li) => li.lastChild.textContent)).toEqual(["2–0", "2–3", "3–3", "5–3"]);
  expect(tid("match-details-m1").textContent).toContain("Team A · You · Winner");
  expect(tid("history-player-profile-2").getAttribute("href")).toBe("/profile/partner");
});

test("a human-only match shows your net medals, each round's breakdown, penalties and balance; bot matches never show medals", async () => {
  const w = (user_id, seat, tricks, tens, bonus, change, balance_after = null) => ({ user_id, seat, team: seat % 2, won: true, tricks, tens,
    trick_medals: tricks, ten_medals: tens * 3, bonus, penalty: 0, requested: tricks + tens * 3 + bonus, change, balance_after });
  const l = (user_id, seat, tricks, tens, penalty, change, balance_after = null) => ({ user_id, seat, team: seat % 2, won: false, tricks, tens,
    trick_medals: 0, ten_medals: 0, bonus: 0, penalty, requested: -penalty, change, balance_after });
  const human = {
    id: "m3", players: players(false), winner_team: 0, scores: [3, 3], target: 3, is_public: false, has_bots: false,
    finished_at: today, duration_seconds: 600, forfeited_by: null,
    rounds: [{ round: 1, winner_team: 0, type: "koth", points: 2 }, { round: 2, winner_team: 1, type: "grand_slam", points: 3 }, { round: 3, winner_team: 0, type: "normal", points: 1 }],
    medals: {
      eligible: true, totals: { me: 2, b1: 13, p2: -1, b3: 14 },
      rounds: [
        { round: 1, winner_team: 0, type: "koth", players: [w("me", 0, 2, 3, 4, 15, 15), l("b1", 1, 4, 1, 4, -4), w("p2", 2, 2, 0, 4, 6), l("b3", 3, 0, 0, 4, 0)] },
        { round: 2, winner_team: 1, type: "grand_slam", players: [l("me", 0, 6, 1, 13, -13, 2), w("b1", 1, 1, 0, 13, 14), l("p2", 2, 6, 0, 13, -6), w("b3", 3, 0, 0, 13, 13)] },
        { round: 3, winner_team: 0, type: "normal", players: [w("me", 0, 0, 0, 1, 1, 3), l("b1", 1, 3, 0, 1, -1), w("p2", 2, 0, 0, 1, 1), l("b3", 3, 0, 0, 1, 1 - 1)] },
      ],
    },
  };
  await render([human, matches[0]]);
  expect(tid("match-row-m3").querySelector('[data-testid="match-medals"]').textContent).toBe("+2 medals");
  expect(tid("match-row-m1").querySelector('[data-testid="match-medals"]')).toBeNull();
  await act(async () => { tid("match-row-m3").querySelector("button").click(); });
  expect(tid("round-medals-1").textContent).toBe("+15");
  expect(tid("round-medals-detail-1").textContent).toBe("You earned: 2 tricks +2 · 3 tens bonus +9 · Koth win bonus +4 → +15 · balance 15");
  expect(tid("round-medals-2").textContent).toBe("−13");
  expect(tid("round-medals-detail-2").textContent).toBe("Your team lost: Grand Slam loss penalty −13 → −13 · balance 2");
  expect(tid("round-medals-detail-3").textContent).toBe("You earned: Normal win bonus +1 → +1 · balance 3");
  expect([0, 1, 2, 3].map((s) => tid(`history-player-medals-${s}`).textContent)).toEqual(["+2", "+13", "−1", "+14"]);
  await act(async () => { tid("match-row-m1").querySelector("button").click(); });
  expect(tid("match-details-m1").querySelector('[data-testid^="round-medals-"]')).toBeNull();
});

test("a deduction that hit zero says only part of the penalty was taken", async () => {
  const human = {
    id: "m4", players: players(false), winner_team: 1, scores: [0, 2], target: 2, is_public: false, has_bots: false,
    finished_at: today, duration_seconds: 300, forfeited_by: null,
    rounds: [{ round: 1, winner_team: 1, type: "koth", points: 2 }],
    medals: { eligible: true, totals: { me: -1 }, rounds: [{ round: 1, winner_team: 1, type: "koth", players: [
      { user_id: "me", seat: 0, team: 0, won: false, tricks: 3, tens: 0, trick_medals: 0, ten_medals: 0, bonus: 0, penalty: 4, requested: -4, change: -1, balance_after: 0 },
    ] }] },
  };
  await render([human]);
  await act(async () => { tid("match-row-m4").querySelector("button").click(); });
  expect(tid("match-row-m4").querySelector('[data-testid="match-medals"]').textContent).toBe("−1 medal");
  expect(tid("round-medals-detail-1").textContent).toBe("Your team lost: Koth loss penalty −4 · only 1 taken (medals never go below 0) → −1 · balance 0");
});
test("summary, day grouping and filters reflect the listed matches", async () => {
  await render();
  expect(tid("history-summary").textContent).toBe("2Played1Won50%Win rate");
  expect(q('section[aria-label="Today"]')).not.toBeNull();
  await act(async () => { tid("history-filter-practice").click(); });
  expect(tid("match-row-m1")).not.toBeNull();
  expect(tid("match-row-m2")).toBeNull();
  expect(tid("history-summary").textContent).toBe("1Played1Won100%Win rate");
  await act(async () => { tid("history-filter-competitive").click(); });
  expect(tid("match-row-m2")).not.toBeNull();
  expect(tid("match-row-m1")).toBeNull();
});

test("empty history invites the player to a table", async () => {
  await render([]);
  expect(tid("history-empty").textContent).toContain("No completed matches yet");
  expect(tid("history-empty-play").getAttribute("href")).toBe("/play");
  expect(tid("history-summary").textContent).toContain("—Win rate");
});

test("duration and day labels", () => {
  expect(formatDuration(754)).toBe("13m");
  expect(formatDuration(3900)).toBe("1h 5m");
  expect(formatDuration(0)).toBeNull();
  const now = new Date(2026, 10, 26, 15);
  expect(dayLabel(new Date(2026, 10, 26, 9).toISOString(), now)).toBe("Today");
  expect(dayLabel(new Date(2026, 10, 25, 23).toISOString(), now)).toBe("Yesterday");
  expect(dayLabel("not a date", now)).toBe("Earlier");
});
