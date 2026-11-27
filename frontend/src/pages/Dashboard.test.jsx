import React, { act } from "react";
import { createRoot } from "react-dom/client";
import Dashboard from "./Dashboard";

jest.mock("react-router-dom", () => {
  const ReactModule = jest.requireActual("react");
  return {
    Link: ({ to, children, ...props }) => ReactModule.createElement("a", { ...props, href: to }, children),
    useNavigate: () => global.__navigate,
  };
});
jest.mock("sonner", () => ({ toast: { error: jest.fn() } }));
jest.mock("@/lib/api", () => ({ errMsg: (e) => e?.message || "Something went wrong" }));
jest.mock("@/context/AppContext", () => ({ useApp: () => global.__app, useSocketEvent: () => {} }));
jest.mock("@/components/PlayerAvatar", () => ({ PlayerAvatar: () => <span data-testid="avatar" /> }));
jest.mock("@/components/PlayingCard", () => ({ PlayingCard: ({ card }) => <span data-testid={`deco-${card}`} /> }));

global.IS_REACT_ACT_ENVIRONMENT = true;

const baseMe = {
  username: "firefox",
  stats: { games_played: 8, wins: 6, losses: 2, normal_wins: 9, koth_wins: 3, grand_slam_wins: 1 },
  progression: { level: 3, xp_in_level: 120, xp_to_next_level: 500, progress_percent: 24, current_win_streak: 4 },
};

let root;
let container;

async function render(me = baseMe) {
  global.__app = {
    me,
    refreshMe: jest.fn(),
    api: { get: jest.fn().mockResolvedValue({ data: [] }), post: jest.fn().mockResolvedValue({ data: { code: "ABC123" } }) },
  };
  global.__navigate = jest.fn();
  await act(async () => { root.render(<Dashboard />); });
}

const q = (id) => container.querySelector(`[data-testid="${id}"]`);

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

test("player card shows level, XP progress, win rate and streak from the server's progression", async () => {
  await render();
  expect(q("dashboard-username").textContent).toBe("firefox");
  expect(q("dashboard-level").textContent).toBe("Lv 3");
  expect(q("dashboard-xp").textContent).toContain("120 / 500 XP");
  expect(q("dashboard-xp").querySelector('[role="progressbar"]').getAttribute("aria-valuenow")).toBe("24");
  expect(q("dashboard-win-rate").textContent).toBe("75% win rate");
  expect(q("dashboard-streak").textContent).toBe("4-win streak");
  ["10S", "10H", "10D", "10C"].forEach((card) => expect(q(`deco-${card}`)).not.toBeNull());
});

test("a new player sees no invented numbers", async () => {
  await render({ ...baseMe, stats: { games_played: 0, wins: 0, losses: 0, normal_wins: 0, koth_wins: 0, grand_slam_wins: 0 }, progression: undefined });
  expect(q("dashboard-level").textContent).toBe("Lv 1");
  expect(q("dashboard-win-rate").textContent).toBe("No games yet");
  expect(q("dashboard-streak").textContent).toBe("No active streak");
});

test("keeps every game mode, the record and the join-by-code flow", async () => {
  await render();
  expect(q("dashboard-quick-match").getAttribute("href")).toBe("/play");
  expect(q("create-room-btn").getAttribute("href")).toBe("/rooms/new");
  expect(q("dashboard-spectate-link").getAttribute("href")).toBe("/spectate");
  expect(q("stat-games").textContent).toBe("8");
  expect(q("stat-grand-slam").textContent).toBe("1");
  expect(q("join-room-btn").disabled).toBe(true);

  const input = q("join-code-input");
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set;
    setter.call(input, "abc123");
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  expect(input.value).toBe("ABC123");
  expect(q("join-room-btn").disabled).toBe(false);
  await act(async () => { q("join-room-btn").click(); });
  expect(global.__app.api.post).toHaveBeenCalledWith("/rooms/ABC123/join");
  expect(global.__navigate).toHaveBeenCalledWith("/room/ABC123");
});

test("the rejoin banner appears when a match is in progress", async () => {
  await render({ ...baseMe, active_game_id: "game-1" });
  expect(q("rejoin-banner").textContent).toContain("You have a match in progress");
  await act(async () => { q("rejoin-btn").click(); });
  expect(global.__navigate).toHaveBeenCalledWith("/game/game-1");
});

test("the dashboard shows lifetime medals and the latest change with its breakdown", async () => {
  const latest = { game_id: "g1", round: 2, victory_type: "koth", won: true, tricks: 3, tens: 2, trick_medals: 3, ten_medals: 6, bonus: 4, penalty: 0, requested: 13, change: 13, balance_after: 1250 };
  global.__app = {
    me: { ...baseMe, medals: 1250 },
    refreshMe: jest.fn(),
    api: { get: jest.fn((url) => Promise.resolve({ data: url === "/medals" ? { medals: 1250, history: [latest] } : [] })), post: jest.fn() },
  };
  global.__navigate = jest.fn();
  await act(async () => { root.render(<Dashboard />); });
  await act(async () => { await Promise.resolve(); });
  expect(global.__app.api.get).toHaveBeenCalledWith("/medals");
  expect(q("dashboard-medals-chip").textContent).toBe("1,250 medals");
  expect(q("dashboard-medals-total").textContent).toBe("1,250");
  expect(q("dashboard-medals-latest").textContent).toContain("Last change · Koth win");
  expect(q("dashboard-medals-latest-net").textContent).toBe("+13");
  expect(q("dashboard-medals-latest").textContent).toContain("3 tricks +3 · 2 tens bonus +6 · Koth win bonus +4");
  expect(q("dashboard-medals-leaderboard").getAttribute("href")).toBe("/leaderboard?board=medals");
});

test("a player without medals sees zero and how to earn them", async () => {
  await render();
  expect(q("dashboard-medals-chip").textContent).toBe("0 medals");
  expect(q("dashboard-medals-total").textContent).toBe("0");
  expect(q("dashboard-medals-latest").textContent).toContain("matches without bots");
});

test("the medal card shows your league, level and progress to the next level", async () => {
  await render({ ...baseMe, medals: 250, league: { id: "silver", name: "Silver", level: 4, level_label: "IV" },
    league_progress: { level_progress_percent: 75, medals_to_next_level: 10, is_top_level: false, next_league: { id: "gold", name: "Gold", min: 300 } } });
  expect(q("dashboard-league").textContent).toBe("Silver IV");
  expect(q("dashboard-league-badge").dataset.league).toBe("silver");
  expect(q("dashboard-level-progress").textContent).toContain("10 medals to the next level");
  expect(q("dashboard-level-progress").textContent).toContain("Gold at 300");
});