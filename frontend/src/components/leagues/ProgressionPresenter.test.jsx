import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { ProgressionPresenter, TIMING } from "./ProgressionPresenter";
import { LeagueBadge, leagueLabel } from "./League";

jest.mock("framer-motion", () => {
  const ReactModule = jest.requireActual("react");
  const element = (tag) => ReactModule.forwardRef(({ initial, animate, exit, transition, ...props }, ref) =>
    ReactModule.createElement(tag, { ...props, ref }));
  return { motion: { div: element("div"), span: element("span") }, AnimatePresence: ({ children }) => children };
});
jest.mock("@/lib/sound", () => ({ sound: { chime: jest.fn(), play: jest.fn() } }));
jest.mock("@/context/AppContext", () => ({
  useApp: () => global.__app,
  useSocketEvent: (fn) => { global.__socket = fn; },
}));

global.IS_REACT_ACT_ENVIRONMENT = true;

const medal = (round, change, extra = {}) => ({
  id: `g1:${round}:medal`, kind: "medal", created_at: `2026-11-27T10:0${round}:00.000Z`, acknowledged: false,
  data: { game_id: "g1", round, change, won: change > 0, victory_type: "koth", tricks: 2, tens: 1, trick_medals: change > 0 ? 2 : 0,
    ten_medals: change > 0 ? 3 : 0, bonus: change > 0 ? 4 : 0, penalty: change > 0 ? 0 : 4, requested: change > 0 ? change : -4,
    balance_before: 95, balance_after: 95 + change, ...extra },
});
const league = (round, direction, from, to, balance) => ({
  id: `g1:${round}:league`, kind: "league", created_at: `2026-11-27T10:0${round}:00.000Z`, acknowledged: false,
  data: { game_id: "g1", round, direction, from: { league: from, level: direction === "promotion" ? 5 : 1, rank: 0 }, to: { league: to, level: direction === "promotion" ? 1 : 5, rank: 1 }, balance_after: balance },
});
const level = (round, direction) => ({
  id: `g1:${round}:level`, kind: "level", created_at: `2026-11-27T10:0${round}:00.000Z`, acknowledged: false,
  data: { game_id: "g1", round, direction, from: { league: "silver", level: 2 }, to: { league: "silver", level: direction === "up" ? 3 : 1 }, balance_after: 185 },
});

let root;
let container;
const q = (id) => container.querySelector(`[data-testid="${id}"]`);

async function mount(pending = [], { reduced = false } = {}) {
  window.matchMedia = jest.fn(() => ({ matches: reduced, addEventListener: jest.fn(), removeEventListener: jest.fn() }));
  global.__app = {
    refreshMe: jest.fn(),
    api: { get: jest.fn().mockResolvedValue({ data: { events: pending } }), post: jest.fn().mockResolvedValue({ data: {} }) },
  };
  await act(async () => { root.render(<ProgressionPresenter />); });
  await act(async () => { await Promise.resolve(); });
}
const push = async (event) => { await act(async () => { global.__socket({ type: "progression_event", event }); }); };
const acked = () => global.__app.api.post.mock.calls.flatMap(([, body]) => body.ids);

beforeEach(() => {
  jest.useFakeTimers();
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  jest.useRealTimers();
  delete window.matchMedia;
});

test("pending events from the server play in order (medals, then the league change) and are acknowledged", async () => {
  await mount([league(1, "promotion", "bronze", "silver", 106), medal(1, 11)]);
  expect(global.__app.api.get).toHaveBeenCalledWith("/progression/events");
  expect(q("progression-medal").dataset.kind).toBe("earned");
  expect(q("progression-medal-change").textContent).toBe("+11");
  expect(q("progression-medal-reason").textContent).toContain("2 tricks +2");
  expect(q("progression-medal-reason").textContent).toContain("1 ten bonus +3");
  expect(q("progression-medal-reason").textContent).toContain("Koth win bonus +4");
  expect(q("progression-skip-all").textContent).toBe("Skip all (2)");
  await act(async () => { jest.advanceTimersByTime(TIMING.medal); });
  expect(acked()).toEqual(["g1:1:medal"]);
  expect(q("progression-league").dataset.direction).toBe("promotion");
  expect(q("progression-league").textContent).toContain("Silver League!");
  expect(q("progression-league-detail").textContent).toContain("Silver I");
  expect(q("progression-league-badge").dataset.league).toBe("silver");
  await act(async () => { q("progression-continue").click(); });
  expect(acked()).toEqual(["g1:1:medal", "g1:1:league"]);
  expect(global.__app.refreshMe).toHaveBeenCalled();
  expect(q("progression-league")).toBeNull();
});

test("duplicate socket messages, reconnect refetches and acknowledged events never replay an animation", async () => {
  const e = medal(2, 5);
  await mount([]);
  await push(e);
  await push(e);
  await push({ ...medal(3, 4), acknowledged: true });
  expect(container.querySelectorAll('[data-testid="progression-medal"]')).toHaveLength(1);
  expect(q("progression-skip-all")).toBeNull(); // only one event queued
  global.__app.api.get.mockResolvedValue({ data: { events: [e] } }); // a reconnect returns the same pending event
  await act(async () => { global.__socket({ type: "hello" }); });
  await act(async () => { await Promise.resolve(); });
  expect(q("progression-skip-all")).toBeNull();
  await act(async () => { q("progression-dismiss").click(); });
  expect(acked()).toEqual(["g1:2:medal"]);
  await push(e); // the same event again after it was presented
  expect(q("progression-medal")).toBeNull();
});

test("a deduction counts down in red, shows the penalty and the amount actually taken, never below zero", async () => {
  await mount([medal(4, -2, { balance_before: 2, balance_after: 0, won: false, penalty: 4 })]);
  expect(q("progression-medal").dataset.kind).toBe("deducted");
  expect(q("progression-medal-change").textContent).toBe("−2");
  expect(q("progression-medal-reason").textContent).toContain("Koth loss penalty −4");
  expect(q("progression-medal-reason").textContent).toContain("2 taken · medals never go below 0");
  await act(async () => { jest.advanceTimersByTime(1200); });
  expect(q("progression-medal-counter").textContent).toBe("0");
  expect(container.querySelector('[data-testid="progression-flying-medal"]')).toBeNull();
});

test("level up and level down show the old and new level; demotion is a calm card", async () => {
  await mount([level(5, "up"), { ...level(6, "down"), created_at: "2026-11-27T10:07:00.000Z" }, { ...league(8, "demotion", "silver", "bronze", 99), created_at: "2026-11-27T10:09:00.000Z" }]);
  expect(q("progression-level").dataset.direction).toBe("up");
  expect(q("progression-level").textContent).toContain("Level up!");
  expect(q("progression-level-change").textContent).toBe("Silver IISilver III");
  await act(async () => { jest.advanceTimersByTime(TIMING.level); });
  expect(q("progression-level").dataset.direction).toBe("down");
  await act(async () => { jest.advanceTimersByTime(TIMING.level); });
  expect(q("progression-league").dataset.direction).toBe("demotion");
  expect(q("progression-league").textContent).toContain("You moved to Bronze");
  expect(q("progression-league").textContent).toContain("your highest league is kept");
  expect(q("progression-league-rays")).toBeNull();
});

test("skip all acknowledges every queued event at once", async () => {
  await mount([medal(1, 11), league(1, "promotion", "bronze", "silver", 106), { ...medal(2, 3), created_at: "2026-11-27T10:05:00.000Z" }]);
  await act(async () => { q("progression-skip-all").click(); });
  expect(acked().sort()).toEqual(["g1:1:league", "g1:1:medal", "g1:2:medal"]);
  expect(q("progression-medal")).toBeNull();
});

test("reduced motion shows the same information without flying medals, rays or count-ups", async () => {
  await mount([medal(1, 11), league(1, "promotion", "bronze", "silver", 106)], { reduced: true });
  expect(container.querySelector('[data-testid="progression-flying-medal"]')).toBeNull();
  expect(q("progression-medal-counter").textContent).toBe("106"); // final value straight away
  await act(async () => { jest.advanceTimersByTime(TIMING.medal); });
  expect(q("progression-league")).not.toBeNull();
  expect(q("progression-league-rays")).toBeNull();
});

test("full motion flies medals into the counter for earned medals and celebrates a promotion", async () => {
  await mount([medal(1, 11), league(1, "promotion", "bronze", "silver", 106)]);
  expect(container.querySelectorAll('[data-testid="progression-flying-medal"]').length).toBeGreaterThan(1);
  await act(async () => { jest.advanceTimersByTime(TIMING.medal); });
  expect(q("progression-league-rays")).not.toBeNull();
});

test("league labels and badges", () => {
  expect(leagueLabel({ id: "gold", name: "Gold", level: 3, level_label: "III" })).toBe("Gold III");
  expect(leagueLabel({ league: "master", level: 5 })).toBe("Master V");
  const host = document.createElement("div");
  const r = createRoot(host);
  act(() => r.render(<LeagueBadge league={{ id: "diamond", level: 2 }} size={40} testId="b" />));
  expect(host.querySelector('[data-testid="b"]').getAttribute("aria-label")).toBe("Diamond II league");
  expect(host.textContent).toBe("II");
  act(() => r.unmount());
});
