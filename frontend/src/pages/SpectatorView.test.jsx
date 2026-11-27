import React, { act } from "react";
import { createRoot } from "react-dom/client";
import SpectatorView from "./SpectatorView";

jest.mock("react-router-dom", () => {
  const ReactModule = jest.requireActual("react");
  return {
    Link: ({ to, children, ...props }) => ReactModule.createElement("a", { href: to, ...props }, children),
    useParams: () => global.__spectatorRoute,
  };
});
jest.mock("@/context/AppContext", () => ({
  useApp: () => global.__spectatorContext,
  useSocketEvent: (handler) => { global.__spectatorEventHandler = handler; },
}));
jest.mock("@/lib/api", () => ({ errMsg: (error) => error?.message || "Request failed", TEAM_NAME: ["Team A", "Team B"] }));
jest.mock("@/lib/sound", () => ({ sound: { prefs: { muted: true }, unlock: jest.fn(), update: jest.fn() } }));
jest.mock("@/components/PlayerAvatar", () => ({ PlayerAvatar: ({ user }) => <span>{user.username}</span> }));
jest.mock("@/components/game/TurnTimer", () => ({ TurnTimer: () => null }));
jest.mock("@/components/game/TableLayout", () => ({
  Hud: ({ st }) => <div data-testid="spectator-seq">{st.seq}</div>,
  TrickSlots: ({ cards, currentTrick }) => <div data-testid="spectator-trick">{currentTrick.map(([, card]) => card).join(",")}</div>,
}));
jest.mock("@/components/game/Overlays", () => ({ MatchOver: () => <div data-testid="spectator-results" /> }));
jest.mock("sonner", () => ({ toast: { error: jest.fn() } }));

global.IS_REACT_ACT_ENVIRONMENT = true;

function safeSnapshot(seq, trick = [[0, "AS"]]) {
  return {
    type: "spectator_state",
    game_id: "public-game-1",
    status: "active",
    is_public: true,
    spectator_count: 2,
    server_time: new Date().toISOString(),
    players: [0, 1, 2, 3].map((seat) => ({ seat, team: seat % 2, username: `player${seat}`, online: true })),
    state: {
      seq,
      phase: "playing",
      round_no: 1,
      target: 7,
      scores: [1, 0],
      tricks_won: [2, 1],
      tricks_played: 3,
      trick,
      current_suit: trick[0]?.[1]?.slice(-1) || null,
      last_trick: null,
      tricks: [],
      trump: "H",
      turn: 2,
      dealer: 0,
      tens: [[], []],
      koth: null,
      gs_declared: null,
    },
  };
}

let root;
let container;

beforeEach(() => {
  global.__spectatorRoute = { gameId: "public-game-1" };
  global.__spectatorEventHandler = null;
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  if (root) act(() => root.unmount());
  container.remove();
  delete global.__spectatorRoute;
  delete global.__spectatorContext;
  delete global.__spectatorEventHandler;
});

test("a newer safe WebSocket update wins over an older REST snapshot and spectators remain read only", async () => {
  let resolveRest;
  const api = { post: jest.fn(() => new Promise((resolve) => { resolveRest = resolve; })) };
  const send = jest.fn(() => true);
  global.__spectatorContext = { api, send, connected: true };

  await act(async () => {
    root.render(<SpectatorView />);
    await Promise.resolve();
  });
  expect(send).toHaveBeenCalledWith({ type: "spectator_join", game_id: "public-game-1", invite: undefined });

  await act(async () => {
    global.__spectatorEventHandler(safeSnapshot(2, [[0, "AS"], [1, "KH"]]));
  });
  expect(container.querySelector('[data-testid="spectator-seq"]').textContent).toBe("2");
  expect(container.querySelector('[data-testid="spectator-trick"]').textContent).toBe("AS,KH");
  expect(container.querySelector('[data-testid="trick-card-AS"]')).toBeNull();

  await act(async () => {
    resolveRest({ data: safeSnapshot(1, [[0, "QS"]]) });
    await Promise.resolve();
  });
  expect(container.querySelector('[data-testid="spectator-seq"]').textContent).toBe("2");
  expect(container.querySelector('[data-testid="spectator-trick"]').textContent).toBe("AS,KH");
  expect(container.textContent).toContain("Watching · Read only");

  act(() => root.unmount());
  root = null;
  expect(send).toHaveBeenLastCalledWith({ type: "spectator_leave", game_id: "public-game-1" });
});

test("denied spectator access displays a safe unavailable state", async () => {
  global.__spectatorContext = {
    api: { post: jest.fn().mockRejectedValue(new Error("Match unavailable or spectator access denied")) },
    send: jest.fn(() => true),
    connected: false,
  };

  await act(async () => {
    root.render(<SpectatorView />);
    await Promise.resolve();
    await Promise.resolve();
  });

  expect(container.querySelector('[data-testid="spectator-access-error"]')).not.toBeNull();
  expect(container.textContent).toContain("This match cannot be watched");
});

test("admin spectator view uses its protected state route and clearly remains read only", async () => {
  const api = { post: jest.fn().mockResolvedValue({ data: safeSnapshot(4) }) };
  const send = jest.fn(() => true);
  global.__spectatorContext = { api, send, connected: true };

  await act(async () => {
    root.render(<SpectatorView adminSpectator />);
    await Promise.resolve();
    await Promise.resolve();
  });

  expect(api.post).toHaveBeenCalledWith("/admin/games/public-game-1/spectator-state", {});
  expect(send).toHaveBeenCalledWith({ type: "admin_spectator_join", game_id: "public-game-1" });
  expect(container.textContent).toContain("ADMIN SPECTATING");
  expect(container.textContent).toContain("Watching · Read only");
  expect(container.querySelector('[data-testid="spectator-return-list"]').getAttribute("href")).toBe("/admin/lobbies");
});
