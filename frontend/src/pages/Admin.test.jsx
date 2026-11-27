import React, { act } from "react";
import { createRoot } from "react-dom/client";
import Admin from "./Admin";
import AdminOverview from "./AdminOverview";
import AdminLobbies from "./AdminLobbies";
import AdminSystemHealth from "./AdminSystemHealth";
import AdminPlayers from "./AdminPlayers";
import AdminPlayerDetail from "./AdminPlayerDetail";

jest.mock("react-router-dom", () => {
  const ReactModule = jest.requireActual("react");
  return {
    Navigate: ({ to }) => ReactModule.createElement("div", { "data-testid": "navigate", "data-to": to }),
    NavLink: ({ to, children, className, end: _end, ...props }) => ReactModule.createElement("a", {
      href: to, className: typeof className === "function" ? className({ isActive: false }) : className, ...props,
    }, children),
    Link: ({ to, children, ...props }) => ReactModule.createElement("a", { href: to, ...props }, children),
    useLocation: () => global.__adminLocation,
  };
});
jest.mock("@/context/AppContext", () => ({ useApp: () => global.__adminContext }));
jest.mock("@/lib/api", () => ({ errMsg: (error) => error?.message || "Request failed" }));
jest.mock("@/components/PlayerAvatar", () => ({ PlayerAvatar: ({ user }) => <span>{user.display_name || user.username}</span> }));
jest.mock("sonner", () => ({ toast: { error: jest.fn(), success: jest.fn() } }));

global.IS_REACT_ACT_ENVIRONMENT = true;

let root;
let container;

beforeEach(() => {
  global.__adminLocation = { pathname: "/admin" };
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  if (root) act(() => root.unmount());
  container.remove();
  delete global.__adminContext;
  delete global.__adminLocation;
});

test("admin route renders the overview for a server-provided staff role and redirects ordinary players", async () => {
  global.__adminContext = { me: { role: "moderator" }, api: { get: jest.fn().mockResolvedValue({ data: { metrics: {}, charts: {}, recent_activity: [] } }) } };
  await act(async () => { root.render(<Admin />); await Promise.resolve(); await Promise.resolve(); });
  expect(container.querySelector('[data-testid="admin-page"]')).not.toBeNull();
  expect(container.textContent).toContain("Live lobbies");
  expect(container.querySelector('a[href="/admin/access"]')).toBeNull();
  expect(container.querySelector('a[href="/admin/system-health"]')).toBeNull();

  global.__adminContext = { me: { role: "member" } };
  await act(async () => root.render(<Admin />));
  expect(container.querySelector('[data-testid="navigate"]').getAttribute("data-to")).toBe("/home");
});

test("system health shows verified operational diagnostics and supports manual refresh", async () => {
  const health = {
    status: "healthy", environment: "preview", last_verified_at: "2026-11-25T12:00:00Z", uptime_seconds: 125,
    database: { status: "healthy", name: "dehla_pakad_dev" },
    index_initialization: { status: "healthy", attempted: 2, failures: [], completed_at: "2026-11-25T11:59:00Z" },
    indexes: { status: "healthy", declared_count: 1, verified_count: 1, missing_count: 0, incompatible_count: 0, unknown_count: 0,
      items: [{ collection: "spectator_sessions", declared: { name: "expires_ttl", key_pattern: [["expires_at", 1]], unique: false, expire_after_seconds: 0 },
        verification: { status: "healthy", verified: true, actual: { name: "expires_ttl", key_pattern: [["expires_at", 1]] }, issues: [] } }] },
    spectator_ttl: { status: "healthy", declared: { name: "expires_ttl", expire_after_seconds: 0 }, verification: { verified: true } },
    websocket: { status: "healthy", implementation: "in_process_hub", connected_clients: 4 },
  };
  const api = { get: jest.fn().mockResolvedValue({ data: health }) };
  global.__adminContext = { api };
  await act(async () => {
    root.render(<AdminSystemHealth />);
    await Promise.resolve();
    await Promise.resolve();
  });

  expect(api.get).toHaveBeenCalledWith("/admin/system-health");
  expect(container.querySelector('[data-testid="admin-health-database"]').textContent).toContain("dehla_pakad_dev");
  expect(container.querySelector('[data-testid="admin-health-websocket"]').textContent).toContain("4");
  expect(container.querySelector('[data-testid="admin-health-spectator-ttl"]').textContent).toContain("At expires_at");
  expect(container.querySelector('[data-testid="admin-health-indexes"]').textContent).toContain("Verified: 1");

  await act(async () => {
    container.querySelector('[data-testid="admin-health-refresh"]').dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await Promise.resolve();
    await Promise.resolve();
  });
  expect(api.get).toHaveBeenCalledTimes(2);
});

test("non-admin staff cannot open the detailed system health page", async () => {
  global.__adminLocation = { pathname: "/admin/system-health" };
  global.__adminContext = { me: { role: "support" }, api: { get: jest.fn() } };
  await act(async () => root.render(<Admin />));
  expect(container.querySelector('[data-testid="navigate"]').getAttribute("data-to")).toBe("/admin");
  expect(global.__adminContext.api.get).not.toHaveBeenCalled();
});

test("player directory loads server-paginated player records without sensitive fields", async () => {
  const api = { get: jest.fn().mockResolvedValue({ data: {
    items: [{ user_id: "user_123", username: "Asha", display_name: "Asha K", created_at: "2025-02-01T00:00:00Z",
      account_status: "active", level: 3, xp: 1250, games_played: 8, wins: 5, losses: 3, last_active_at: "2025-03-01T00:00:00Z" }],
    total: 1, offset: 0, limit: 25, sort: "registered_desc",
  } }) };
  global.__adminContext = { api };
  await act(async () => {
    root.render(<AdminPlayers />);
    await Promise.resolve();
    await Promise.resolve();
  });

  expect(api.get).toHaveBeenCalledWith(expect.stringContaining("/admin/players?offset=0&limit=25"));
  expect(container.querySelector('[data-testid="admin-player-user_123"]')).not.toBeNull();
  expect(container.textContent).toContain("Asha K");
  expect(container.textContent).toContain("3 · 1250");
  expect(container.textContent).toContain("8 · 5/3");
  expect(container.querySelector('a[href="/admin/players/user_123"]')).not.toBeNull();
});

test("player detail shows authoritative history and role-appropriate moderation controls", async () => {
  const profile = {
    player: { user_id: "player_1", username: "Asha", display_name: "Asha", created_at: "2025-01-01T00:00:00Z", account_status: "active" },
    statistics: { games_played: 2, wins: 1, losses: 1, draws: 0, win_percent: 50, average_match_duration_seconds: 600 },
    progression: { level: 2, xp: 650, xp_in_level: 150, xp_to_next_level: 500, progress_percent: 30 },
    achievements: [{ id: "first_victory", name: "First Victory", description: "Win your first match.", progress: 1, target: 1, unlocked: true }],
    match_history: [{ id: "match-1", outcome: "win", scores: [7, 4], player_team: 0, players: [{ display_name: "Asha" }], is_public: true, finished_at: "2025-03-01T00:00:00Z" }],
    moderation_history: [{ id: "event-1", action: "suspended", actor_name: "Admin", previous_status: "active", new_status: "suspended", reason: "Prior warning", timestamp: "2025-02-01T00:00:00Z" }],
    recent_activity: [], internal_notes: [{ id: "note-1", author_name: "Moderator", content: "Internal follow-up", created_at: "2025-02-02T00:00:00Z", env: "preview" }],
  };
  const api = { get: jest.fn().mockResolvedValue({ data: profile }), post: jest.fn() };
  global.__adminContext = { me: { user_id: "staff_1", role: "moderator" }, api };
  await act(async () => {
    root.render(<AdminPlayerDetail playerId="player_1" />);
    await Promise.resolve();
    await Promise.resolve();
  });

  expect(api.get).toHaveBeenCalledWith("/admin/players/player_1");
  expect(container.querySelector('[data-testid="admin-player-games"]').textContent).toContain("2");
  expect(container.querySelector('[data-testid="admin-player-match-match-1"]')).not.toBeNull();
  expect(container.querySelector('[data-testid="moderation-event-event-1"]')).not.toBeNull();
  expect(container.querySelector('[data-testid="admin-player-note-note-1"]')).not.toBeNull();
  expect(container.querySelector('[data-testid="admin-player-suspend-form"]')).not.toBeNull();
  expect(container.textContent).not.toContain("Permanent ban");
});

test("overview displays real API metrics, time series, and recent activity", async () => {
  global.__adminContext = { api: { get: jest.fn().mockResolvedValue({ data: {
    metrics: { registered_players: 18, online_players: 4, active_private_lobbies: 2, match_completion_rate_14d: 87.5 },
    charts: { registrations: [{ day: "2026-11-24", count: 3 }], completed_matches: [{ day: "2026-11-24", count: 2 }] },
    recent_activity: [{ kind: "match", timestamp: "2026-11-24T12:00:00Z", summary: "Match completed · One vs Two · 7–4" }],
  } }) } };
  await act(async () => {
    root.render(<AdminOverview />);
    await Promise.resolve();
    await Promise.resolve();
  });
  expect(container.querySelector('[data-testid="admin-metric-registered_players"]').textContent).toContain("18");
  expect(container.querySelector('[data-testid="admin-metric-active_private_lobbies"]').textContent).toContain("2");
  expect(container.querySelector('[data-testid="admin-registration-chart"]')).not.toBeNull();
  expect(container.textContent).toContain("87.5%");
  expect(container.textContent).toContain("Match completed · One vs Two · 7–4");
});

test("live lobby table includes private room details and an admin spectator link", async () => {
  const api = { get: jest.fn().mockResolvedValue({ data: {
    items: [{ code: null, room_type: "private", owner: "Room Host", players: [
      { seat: 0, username: "host", display_name: "Room Host", team: 0, online: true },
      { seat: 1, username: "guest", display_name: "Guest", team: 1, online: false },
    ], occupied_seats: 2, seat_limit: 4, status: "playing", created_at: "2026-11-24T10:00:00Z",
    match_started_at: "2026-11-24T10:10:00Z", match_duration_seconds: 600, spectator_count: 1,
    disconnected_players: true, current_state: { phase: "playing", round: 2, current_player: "Guest", scores: [1, 0], tricks_won: [4, 2] },
    game_id: "active-game-id", watch_allowed: true, settings: { target: 7 },
    }], total: 1, offset: 0, limit: 30, truncated: false, can_spectate: true,
  } }) };
  global.__adminContext = { api };
  await act(async () => {
    root.render(<AdminLobbies />);
    await Promise.resolve();
    await Promise.resolve();
  });
  expect(api.get).toHaveBeenCalledWith(expect.stringContaining("/admin/lobbies?"));
  expect(container.querySelector('[data-testid="admin-lobby-active-game-id"]').textContent).toContain("Private room");
  expect(container.querySelector('[data-testid="admin-lobby-active-game-id"]').textContent).not.toContain("PRIV42");
  expect(container.querySelector('[data-testid="admin-watch-active-game-id"]').getAttribute("href")).toBe("/admin/spectate/active-game-id");
  expect(container.textContent).toContain("Guest");
});
