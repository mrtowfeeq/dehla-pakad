import React, { act } from "react";
import { createRoot } from "react-dom/client";
import Lobby from "./Lobby";

const mockNavigate = jest.fn();
jest.mock("react-router-dom", () => {
  const ReactModule = jest.requireActual("react");
  return {
    Link: ({ to, children, ...props }) => ReactModule.createElement("a", { ...props, href: to }, children),
    useNavigate: () => mockNavigate,
    useParams: () => ({ code: "ABC123" }),
  };
});
jest.mock("sonner", () => ({ toast: Object.assign(jest.fn(), { success: jest.fn(), error: jest.fn() }) }));
global.__handlers = new Set();
jest.mock("@/context/AppContext", () => {
  const ReactModule = jest.requireActual("react");
  return {
    useApp: () => global.__app,
    useSocketEvent: (fn) => {
      ReactModule.useEffect(() => { global.__handlers.add(fn); return () => global.__handlers.delete(fn); });
    },
  };
});
const emit = (msg) => [...global.__handlers].forEach((h) => h(msg));
jest.mock("@/lib/api", () => ({ errMsg: () => "error", TEAM_NAME: ["Team A", "Team B"] }));
jest.mock("@/components/PlayerAvatar", () => ({ PlayerAvatar: () => <span /> }));
jest.mock("@/components/TargetPicker", () => ({ TargetPicker: () => <div data-testid="target-picker" /> }));
jest.mock("@/components/Chat", () => ({ ChatPanel: () => <div data-testid="public-chat" />, PrivateLobbyChatPanel: () => <div data-testid="private-chat" /> }));
jest.mock("@/components/voice/VoicePanel", () => ({ VoicePanel: () => <div data-testid="voice-panel" /> }));
jest.mock("@/lib/sound", () => ({ sound: { play: jest.fn(), chime: jest.fn() } }));

global.IS_REACT_ACT_ENVIRONMENT = true;

const player = (id, extra = {}) => ({ user_id: id, username: id, ...extra });
const baseRoom = (over = {}) => ({
  code: "ABC123", is_public: false, status: "lobby", host_id: "me", target: 7, turn_duration: 30, dealer_seat: 1,
  spectators_enabled: false,
  seats: [player("me"), player("bot1", { is_bot: true }), null, player("pal")],
  ready: { me: true, bot1: true },
  ...over,
});

let root;
let container;
const tid = (id) => container.querySelector(`[data-testid="${id}"]`);

async function render(room, meId = "me") {
  global.__app = {
    me: { user_id: meId },
    api: { get: jest.fn((url) => Promise.resolve({ data: url === "/friends" ? [] : room })), post: jest.fn().mockResolvedValue({}), patch: jest.fn().mockResolvedValue({}), delete: jest.fn().mockResolvedValue({}) },
  };
  await act(async () => { root.render(<Lobby />); });
  await act(async () => { await Promise.resolve(); });
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

test("host sees seats, counters, teams, invite code and host controls", async () => {
  await render(baseRoom());
  expect(tid("room-invite-code").textContent).toBe("ABC123");
  expect(tid("lobby-status").textContent).toBe("Waiting for 1 more player");
  expect(tid("lobby-target").textContent).toBe("7");
  expect(tid("lobby-seat-0-ready").textContent).toBe("READY");
  // Your own ready toggle sits on your seat card; the side panel only shows a hint.
  expect(tid("ready-toggle-btn").contains(tid("lobby-seat-0-ready"))).toBe(true);
  expect(tid("lobby-ready-hint").textContent).toContain("You're ready");
  expect(tid("lobby-seat-3-ready").textContent).toBe("Not ready");
  expect(tid("lobby-seat-2")).not.toBeNull();
  expect(tid("dealer-chip").parentElement.parentElement.querySelector('[data-testid="lobby-seat-1"]')).not.toBeNull();
  expect(tid("lobby-teams").textContent).toContain("Open seat");
  expect(tid("remove-bot-1")).not.toBeNull();
  expect(tid("bots-practice-note")).not.toBeNull();
  expect(tid("lobby-waiting-text").textContent).toBe("Waiting for 1 more player(s)…");
  expect(tid("start-game-btn").disabled).toBe(true);
  expect(tid("private-chat")).not.toBeNull();
  // Voice sits on the table, in the corner opposite the chat icon.
  expect(tid("voice-panel").closest(".relative.rounded-3xl").contains(tid("lobby-chat-toggle"))).toBe(true);
});

test("chat opens from the table icon and counts unread messages while closed", async () => {
  await render(baseRoom());
  const win = tid("lobby-chat-window");
  expect(win.classList.contains("hidden")).toBe(true);
  expect(win.querySelector('[data-testid="private-chat"]')).not.toBeNull();
  const chatMsg = (user_id, id) => ({ type: "private_lobby_chat_message", message: { id, user_id, room_code: "ABC123", channel: "private_lobby" } });
  await act(async () => { emit(chatMsg("pal", 1)); emit(chatMsg("pal", 2)); emit(chatMsg("me", 3)); });
  expect(tid("lobby-chat-unread").textContent).toBe("2");
  await act(async () => { tid("lobby-chat-toggle").click(); });
  expect(win.classList.contains("hidden")).toBe(false);
  expect(tid("lobby-chat-toggle").getAttribute("aria-expanded")).toBe("true");
  expect(tid("lobby-chat-unread")).toBeNull();
  await act(async () => { emit(chatMsg("pal", 4)); });
  expect(tid("lobby-chat-unread")).toBeNull();
  await act(async () => { window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" })); });
  expect(win.classList.contains("hidden")).toBe(true);
  await act(async () => { emit({ type: "chat", message: { id: 5, user_id: "pal", room_code: "ABC123" } }); });
  expect(tid("lobby-chat-unread")).toBeNull();
});

test("a stake room shows the stake, explains that ready accepts the entry, and hides the bot buttons", async () => {
  const stake = { id: "chai", name: "Chai Table", entry: 100, payout: 180 };
  await render(baseRoom({ stake, seats: [player("me"), null, null, player("pal")], ready: {} }));
  expect(tid("lobby-stake").textContent).toContain("Chai Table");
  expect(tid("lobby-stake").textContent).toContain("180");
  expect(tid("lobby-ready-hint").textContent).toContain("accept the 100-coin entry");
  expect(tid("add-bot-btn")).toBeNull();
  expect(tid("stake-option-free").getAttribute("aria-pressed")).toBe("false");
});

test("when a stake match starts, every player's entry flies into the table pot during the countdown", async () => {
  jest.useFakeTimers();
  try {
    const stake = { id: "chai", name: "Chai Table", entry: 100, payout: 180 };
    const seats = [player("me"), player("b"), player("c"), player("d")];
    await render(baseRoom({ stake, seats, ready: { me: true, b: true, c: true, d: true } }));
    expect(tid("pot-collect")).toBeNull();
    await act(async () => { emit({ type: "game_started", room_code: "ABC123", game_id: "G1" }); });
    // The countdown is a slim banner so the table stays visible.
    expect(tid("match-start-countdown").textContent).toContain("Collecting entries");
    expect(tid("pot-amount").textContent).toBe("0");
    const { sound } = require("@/lib/sound");
    expect(sound.chime.mock.calls.filter(([k]) => k === "coin_drop")).toHaveLength(12);
    expect(sound.chime).toHaveBeenCalledWith("pot_full", expect.anything());
    await act(async () => { jest.advanceTimersByTime(1500); });
    expect(tid("pot-amount").textContent).toBe("400");
    expect(tid("pot-payout").textContent).toBe("Winners get 180 each");
    await act(async () => { jest.advanceTimersByTime(1000); });
    expect(mockNavigate).toHaveBeenCalledWith("/game/G1");
  } finally {
    jest.useRealTimers();
  }
});

test("a free match keeps the full-screen countdown and collects no coins", async () => {
  jest.useFakeTimers();
  try {
    await render(baseRoom({ seats: [player("me"), player("b"), player("c"), player("d")] }));
    await act(async () => { emit({ type: "game_started", room_code: "ABC123", game_id: "G2" }); });
    expect(tid("match-start-countdown").className).toContain("inset-0");
    expect(tid("pot-collect")).toBeNull();
  } finally {
    jest.useRealTimers();
  }
});

test("the host changes the coin stake from the table rules", async () => {
  await render(baseRoom({ seats: [player("me"), null, null, player("pal")], ready: {} }));
  await act(async () => { tid("stake-option-free").click(); });
  expect(global.__app.api.patch).not.toHaveBeenCalled(); // already free
  expect(tid("lobby-stake")).toBeNull();
});

test("human seats show lifetime medals; bots and empty seats show none", async () => {
  await render(baseRoom({ seats: [player("me", { medals: 1250 }), player("bot1", { is_bot: true }), null, player("pal")] }));
  expect(tid("lobby-seat-0-medals").textContent).toBe("1,250");
  expect(tid("lobby-seat-3-medals").textContent).toBe("0");
  expect(tid("lobby-seat-1-medals")).toBeNull();
  expect(tid("lobby-seat-2-medals")).toBeNull();
});
test("host swaps two seats by tapping them", async () => {
  await render(baseRoom());
  await act(async () => { tid("lobby-seat-0").click(); });
  await act(async () => { tid("lobby-seat-3").click(); });
  expect(global.__app.api.post).toHaveBeenCalledWith("/rooms/ABC123/seats", { seats: ["pal", "bot1", null, "me"] });
});

test("a guest sees read-only match settings and can toggle ready", async () => {
  await render(baseRoom({ host_id: "pal", spectators_enabled: true }));
  expect(tid("start-game-btn")).toBeNull();
  expect(tid("lobby-turn-duration")).toBeNull();
  expect(tid("lobby-turn-duration-readonly").textContent).toBe("30 seconds");
  expect(tid("lobby-spectator-status").textContent).toContain("By invitation");
  expect(tid("lobby-seat-0").disabled).toBe(true);
  await act(async () => { tid("ready-toggle-btn").click(); });
  expect(global.__app.api.post).toHaveBeenCalledWith("/rooms/ABC123/ready", { ready: false });
  expect(global.__app.api.post).not.toHaveBeenCalledWith("/rooms/ABC123/seats", expect.anything());
});

test("a full, ready public table needs no host and has no invite code", async () => {
  const seats = [player("me"), player("b"), player("c"), player("d")];
  await render(baseRoom({ is_public: true, host_id: null, seats, ready: { me: true, b: true, c: true, d: true } }));
  expect(tid("copy-invite-code-btn")).toBeNull();
  expect(tid("lobby-status").textContent).toBe("Everyone is ready — dealing soon");
  expect(tid("lobby-waiting-text")).toBeNull();
  expect(tid("public-chat")).not.toBeNull();
});
