import React, { act } from "react";
import { createRoot } from "react-dom/client";
import Wallet from "./Wallet";

jest.mock("react-router-dom", () => {
  const ReactModule = jest.requireActual("react");
  return { Link: ({ to, children, ...props }) => ReactModule.createElement("a", { ...props, href: to }, children) };
});
jest.mock("sonner", () => ({ toast: { success: jest.fn(), error: jest.fn() } }));
jest.mock("@/lib/api", () => ({ errMsg: (e) => e?.message || "error" }));
jest.mock("@/context/AppContext", () => ({ useApp: () => global.__app, useSocketEvent: () => {} }));

const { toast } = jest.requireMock("sonner");
global.IS_REACT_ACT_ENVIRONMENT = true;

const tiers = [
  { id: "chai", name: "Chai Table", entry: 100, payout: 180, min_level: 1, unlocked: true, affordable: true },
  { id: "royal", name: "Royal Table", entry: 2500, payout: 4500, min_level: 6, unlocked: false, affordable: false },
];
const walletState = (over = {}) => ({
  coins: 1250, table_fee_percent: 10, tiers,
  daily: { claimed_today: false, streak: 2, next_reward: 150, next_day: 3, rewards: [50, 100, 150, 200, 250, 300, 350] },
  topup: { eligible: false, amount: 200, threshold: 100, available_at: null },
  ...over,
});

let root;
let container;
const tid = (id) => container.querySelector(`[data-testid="${id}"]`);

async function render(state = walletState(), history = []) {
  global.__app = {
    me: { coins: state.coins },
    api: {
      get: jest.fn((url) => Promise.resolve({ data: url === "/wallet" ? state : { entries: history } })),
      post: jest.fn(() => Promise.resolve({ data: { amount: 150, streak: 3, coins: 1400 } })),
    },
  };
  await act(async () => { root.render(<Wallet />); });
  await act(async () => { await Promise.resolve(); });
}

beforeEach(() => {
  toast.success.mockClear();
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

test("shows the balance with Indian digit grouping and the seven-day track", async () => {
  await render(walletState({ coins: 125000 }));
  expect(tid("wallet-balance").textContent).toBe("1,25,000");
  expect(["daily-day-1", "daily-day-2", "daily-day-3", "daily-day-4"].map((id) => tid(id).dataset.state))
    .toEqual(["claimed", "claimed", "next", "upcoming"]);
  expect(tid("wallet-claim-daily").textContent).toContain("Claim 150");
});

test("claiming the daily reward posts once and reports the reward", async () => {
  await render();
  await act(async () => { tid("wallet-claim-daily").click(); });
  expect(global.__app.api.post).toHaveBeenCalledWith("/wallet/daily");
  expect(toast.success).toHaveBeenCalledWith("Day 3 reward: +150 coins");
});

test("after claiming today the button is disabled", async () => {
  await render(walletState({ daily: { claimed_today: true, streak: 3, next_reward: 200, next_day: 3, rewards: [50, 100, 150, 200, 250, 300, 350] } }));
  expect(tid("wallet-claim-daily").disabled).toBe(true);
  expect(tid("daily-day-3").dataset.state).toBe("claimed");
});

test("free coins are offered only when eligible", async () => {
  await render();
  expect(tid("wallet-claim-topup").disabled).toBe(true);
  act(() => root.unmount());
  root = createRoot(container);
  await render(walletState({ coins: 40, topup: { eligible: true, amount: 200, threshold: 100, available_at: null } }));
  expect(tid("wallet-claim-topup").disabled).toBe(false);
  await act(async () => { tid("wallet-claim-topup").click(); });
  expect(global.__app.api.post).toHaveBeenCalledWith("/wallet/topup");
});

test("stake tables show entry, payout and level locks, and link to matchmaking", async () => {
  await render();
  expect(tid("wallet-tier-chai").textContent).toContain("100");
  expect(tid("wallet-tier-chai").textContent).toContain("180");
  expect(tid("wallet-tier-play-chai").getAttribute("href")).toBe("/play?tier=chai");
  expect(tid("wallet-tier-play-royal").textContent).toBe("Unlocks at level 6");
});

test("coin history lists entries with readable labels and signed amounts", async () => {
  await render(walletState(), [
    { key: "stake_win:G1", reason: "stake_win", amount: 180, balance_after: 1250, ts: "2026-11-27T10:00:00Z" },
    { key: "stake_entry:G1", reason: "stake_entry", amount: -100, balance_after: 1070, ts: "2026-11-27T09:40:00Z" },
  ]);
  expect(tid("wallet-entry-stake_win:G1").textContent).toContain("Table win");
  expect(tid("wallet-entry-stake_win:G1").textContent).toContain("+180");
  expect(tid("wallet-entry-stake_entry:G1").textContent).toContain("−100");
});
