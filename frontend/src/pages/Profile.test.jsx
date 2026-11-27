import React, { act } from "react";
import { createRoot } from "react-dom/client";
import Profile from "./Profile";

jest.mock("react-router-dom", () => {
  const ReactModule = jest.requireActual("react");
  return {
    Link: ({ to, children, ...props }) => ReactModule.createElement("a", { ...props, href: to }, children),
    useParams: () => global.__profileRoute,
  };
});
jest.mock("@/context/AppContext", () => ({ useApp: () => global.__profileContext }));
jest.mock("@/lib/api", () => ({ errMsg: (error) => error?.message || "Request failed" }));
jest.mock("@/components/PlayerAvatar", () => ({ PlayerAvatar: ({ user }) => <span data-testid="profile-avatar">{user.display_name || user.username}</span> }));
jest.mock("@/components/ui/progress", () => ({ Progress: ({ value }) => <div data-testid="progress-bar" data-value={value} /> }));
jest.mock("@/pages/History", () => ({ MatchRow: ({ m }) => <div data-testid={"recent-match-" + m.id}>{m.id}</div> }));
jest.mock("sonner", () => ({ toast: { success: jest.fn(), error: jest.fn() } }));

global.IS_REACT_ACT_ENVIRONMENT = true;

const sampleProfile = {
  user_id: "clerk-user-1",
  username: "CardPlayer",
  display_name: "Card Champion",
  bio: "I enjoy a thoughtful game.",
  avatar_color: "#38bdf8",
  avatar_icon: "crown",
  online: true,
  is_me: true,
  is_friend: false,
  pending_request: false,
  created_at: "2025-02-03T00:00:00+00:00",
  stats: { games_played: 20, wins: 12, losses: 8, draws: 0 },
  progression: { level: 4, xp: 2200, xp_in_level: 200, xp_to_next_level: 500, progress_percent: 40, current_win_streak: 3, best_win_streak: 5 },
  profile_stats: { total_team_tricks_won: 124, average_match_duration_seconds: 720, current_win_streak: 3, best_win_streak: 5 },
  achievements: [
    { id: "first_victory", name: "First Victory", description: "Win your first match.", icon: "trophy", target: 1, progress: 1, unlocked: true, unlocked_at: "2025-02-04T00:00:00+00:00" },
    { id: "getting_started", name: "Getting Started", description: "Complete 10 matches.", icon: "sparkles", target: 10, progress: 8, unlocked: false, unlocked_at: null },
  ],
  recent_matches: [{ id: "match-1" }],
};

let root;
let container;

async function renderProfile(profile = sampleProfile) {
  global.__profileContext = {
    connected: true,
    api: {
      get: jest.fn().mockResolvedValue({ data: profile }),
      post: jest.fn().mockResolvedValue({ data: { ok: true } }),
    },
  };
  await act(async () => {
    root.render(<Profile />);
    await Promise.resolve();
  });
}

beforeEach(() => {
  global.__profileRoute = { username: "CardPlayer" };
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  delete global.__profileContext;
  delete global.__profileRoute;
});

test("profile page displays identity, level, XP, career stats, badges, and recent results", async () => {
  await renderProfile();

  expect(container.querySelector('[data-testid="profile-display-name"]').textContent).toBe("Card Champion");
  expect(container.querySelector('[data-testid="profile-username"]').textContent).toContain("@CardPlayer");
  expect(container.querySelector('[data-testid="profile-bio"]').textContent).toContain("thoughtful game");
  expect(container.querySelector('[data-testid="profile-level"]').textContent).toContain("Level 4");
  expect(container.querySelector('[data-testid="progress-bar"]').getAttribute("data-value")).toBe("40");
  expect(container.querySelector('[data-testid="profile-stat-win-rate"]').textContent).toBe("60%");
  expect(container.querySelector('[data-testid="profile-stat-team-tricks-won"]').textContent).toBe("124");
  expect(container.querySelector('[data-testid="profile-stat-avg-match-time"]').textContent).toBe("12m");
  expect(container.querySelector('[data-testid="achievement-first_victory"]').getAttribute("data-unlocked")).toBe("true");
  expect(container.querySelector('[data-testid="achievement-getting_started"]').textContent).toContain("8/10");
  expect(container.querySelector('[data-testid="recent-match-match-1"]')).not.toBeNull();
  expect(container.querySelector('[data-testid="edit-profile-btn"]').getAttribute("href")).toBe("/settings");
});

test("lifetime medals come from the profile and show in the header and career statistics", async () => {
  await renderProfile({ ...sampleProfile, medals: 1234 });
  expect(container.querySelector('[data-testid="profile-medals"]').textContent.trim()).toBe("1,234 medals");
  expect(container.querySelector('[data-testid="profile-stat-medals"]').textContent).toBe("1,234");
  act(() => root.unmount());
  root = createRoot(container);
  await renderProfile({ ...sampleProfile, medals: undefined });
  expect(container.querySelector('[data-testid="profile-medals"]').textContent.trim()).toBe("0 medals");
});
test("your own profile lists your private medal changes with the full breakdown; other profiles never ask for them", async () => {
  const history = [
    { game_id: "g2", round: 4, victory_type: "grand_slam", won: false, tricks: 5, tens: 1, trick_medals: 0, ten_medals: 0, bonus: 0, penalty: 13, requested: -13, change: -2, balance_after: 0, ts: "2026-11-27T10:05:00Z" },
    { game_id: "g1", round: 2, victory_type: "koth", won: true, tricks: 3, tens: 2, trick_medals: 3, ten_medals: 6, bonus: 4, penalty: 0, requested: 13, change: 13, balance_after: 2, ts: "2026-11-27T10:00:00Z" },
  ];
  global.__profileContext = {
    connected: true,
    api: {
      get: jest.fn((url) => Promise.resolve({ data: url === "/medals" ? { medals: 0, history } : { ...sampleProfile, medals: 0 } })),
      post: jest.fn(),
    },
  };
  await act(async () => { root.render(<Profile />); await Promise.resolve(); });
  await act(async () => { await Promise.resolve(); });
  const loss = container.querySelector('[data-testid="medal-change-g2-4"]').textContent;
  expect(loss).toContain("Grand Slam loss · round 4");
  expect(loss).toContain("Grand Slam loss penalty −13 · only 2 taken (medals never go below 0)");
  expect(loss).toContain("−2");
  expect(loss).toContain("balance 0");
  const win = container.querySelector('[data-testid="medal-change-g1-2"]').textContent;
  expect(win).toContain("Koth win · round 2");
  expect(win).toContain("3 tricks +3 · 2 tens bonus +6 · Koth win bonus +4");
  expect(win).toContain("+13");

  act(() => root.unmount());
  root = createRoot(container);
  global.__profileContext.api.get = jest.fn(() => Promise.resolve({ data: { ...sampleProfile, is_me: false, medals: 50 } }));
  await act(async () => { root.render(<Profile />); await Promise.resolve(); });
  expect(global.__profileContext.api.get).not.toHaveBeenCalledWith("/medals");
  expect(container.querySelector('[data-testid="profile-medal-history"]')).toBeNull();
  expect(container.querySelector('[data-testid="profile-medals"]').textContent.trim()).toBe("50 medals");
});
test("your profile shows your league, level and league progress, highest league and promotion history", async () => {
  const progress = {
    medals: 250, league: "silver", league_name: "Silver", level: 4, level_label: "IV", level_progress_percent: 75, medals_to_next_level: 10,
    next_level_min: 260, is_top_level: false, next_league: { id: "gold", name: "Gold", min: 300 }, medals_to_next_league: 50,
    league_progress_percent: 75, highest_league: { id: "gold", name: "Gold", rank: 2 }, legend_rule: null,
  };
  const transitions = [{ id: "g9:4:league", kind: "league", data: { direction: "demotion", from: { league: "gold", level: 1 }, to: { league: "silver", level: 5 }, balance_after: 296 } }];
  global.__profileContext = {
    connected: true,
    api: {
      get: jest.fn((url) => Promise.resolve({ data: url === "/progression" ? { progress, transitions } : url === "/medals" ? { history: [] }
        : { ...sampleProfile, medals: 250, league: { id: "silver", name: "Silver", level: 4, level_label: "IV" } } })),
      post: jest.fn(),
    },
  };
  await act(async () => { root.render(<Profile />); await Promise.resolve(); });
  await act(async () => { await Promise.resolve(); });
  const q = (id) => container.querySelector(`[data-testid="${id}"]`);
  expect(q("profile-league-name").textContent).toBe("Silver IV");
  expect(q("profile-league-medals").textContent).toBe("250");
  expect(q("profile-league-badge").dataset.league).toBe("silver");
  expect(q("profile-level-progress").textContent).toContain("Next level · Silver V");
  expect(q("profile-level-progress").textContent).toContain("10 to go");
  expect(q("profile-level-progress").querySelector('[role="progressbar"]').getAttribute("aria-valuenow")).toBe("75");
  expect(q("profile-league-progress").textContent).toContain("Next league · Gold at 300");
  expect(q("profile-league-progress").textContent).toContain("50 to go");
  expect(q("profile-highest-league").textContent).toContain("Gold");
  expect(q("profile-transition-g9:4:league").textContent).toContain("Moved down");
  expect(q("profile-transition-g9:4:league").textContent).toContain("Gold I → Silver V");
  expect(q("profile-legend-rule")).toBeNull();
});

test("Legend shows the top level and its rule; other players' profiles show only the public league", async () => {
  const legend = { medals: 16000, league: "legend", league_name: "Legend", level: 5, level_label: "V", level_progress_percent: 100, medals_to_next_level: null,
    next_level_min: null, is_top_level: true, next_league: null, medals_to_next_league: null, league_progress_percent: 100,
    highest_league: { id: "legend", name: "Legend", rank: 6 }, legend_rule: "Legend has no upper limit: each level is 2,500 medals wide, and Legend V (15,000+) is the highest level." };
  global.__profileContext = {
    connected: true,
    api: {
      get: jest.fn((url) => Promise.resolve({ data: url === "/progression" ? { progress: legend, transitions: [] } : url === "/medals" ? { history: [] }
        : { ...sampleProfile, medals: 16000, league: { id: "legend", name: "Legend", level: 5, level_label: "V" } } })),
      post: jest.fn(),
    },
  };
  await act(async () => { root.render(<Profile />); await Promise.resolve(); });
  await act(async () => { await Promise.resolve(); });
  const q = (id) => container.querySelector(`[data-testid="${id}"]`);
  expect(q("profile-level-progress").textContent).toContain("Highest level reached");
  expect(q("profile-league-progress").textContent).toContain("Top league");
  expect(q("profile-legend-rule").textContent).toContain("2,500 medals wide");

  act(() => root.unmount());
  root = createRoot(container);
  global.__profileContext.api.get = jest.fn(() => Promise.resolve({ data: { ...sampleProfile, is_me: false, medals: 650, league: { id: "platinum", name: "Platinum", level: 1, level_label: "I" } } }));
  await act(async () => { root.render(<Profile />); await Promise.resolve(); });
  expect(q("profile-league-name").textContent).toBe("Platinum I");
  expect(global.__profileContext.api.get).not.toHaveBeenCalledWith("/progression");
  expect(q("profile-level-progress")).toBeNull();
  expect(q("profile-highest-league")).toBeNull();
  expect(q("profile-league-history")).toBeNull();
});
test("public profile provides safe friend action and responsive statistics layout", async () => {
  await renderProfile({ ...sampleProfile, is_me: false, online: false, is_friend: false, pending_request: false });

  expect(container.querySelector('[data-testid="profile-add-friend-btn"]')).not.toBeNull();
  expect(container.querySelector('[data-testid="edit-profile-btn"]')).toBeNull();
  expect(container.querySelector('[data-testid="profile-statistics"] .sm\\:grid-cols-4')).not.toBeNull();
  expect(container.querySelector('[data-testid="profile-header"]').textContent).toContain("Offline");
  expect(container.textContent).not.toContain("@clerk");
});
