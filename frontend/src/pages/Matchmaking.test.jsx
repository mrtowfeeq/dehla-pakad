import React, { act } from "react";
import { createRoot } from "react-dom/client";
import Matchmaking from "./Matchmaking";

jest.mock("react-router-dom", () => ({ useNavigate: () => global.__navigate }));
jest.mock("sonner", () => ({ toast: { error: jest.fn() } }));
jest.mock("@/lib/api", () => ({ errMsg: (e) => e?.message || "Something went wrong" }));
jest.mock("@/context/AppContext", () => ({ useApp: () => global.__app }));

global.IS_REACT_ACT_ENVIRONMENT = true;

let root;
let container;

function setup({ status = { queued: false, waiting: 2 }, joinResult = { queued: true, position: 3, waiting: 3 } } = {}) {
  global.__navigate = jest.fn();
  // Like the server, the status endpoint reflects the queue after a join or leave.
  let current = status;
  global.__app = {
    api: {
      get: jest.fn(() => Promise.resolve({ data: current })),
      post: jest.fn((url) => {
        if (url === "/matchmaking/join") current = joinResult;
        if (url === "/matchmaking/leave") current = { queued: false, waiting: 0 };
        return Promise.resolve({ data: url === "/matchmaking/join" ? joinResult : { ok: true } });
      }),
    },
  };
}

async function render() {
  await act(async () => { root.render(<Matchmaking />); });
  await act(async () => { await Promise.resolve(); });
}

const q = (id) => container.querySelector(`[data-testid="${id}"]`);
const filledSeats = () => container.querySelectorAll('[data-testid^="queue-seat-"][data-filled="true"]').length;

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
});

test("before joining it shows the rules, an empty table and how many players are waiting", async () => {
  setup();
  await render();
  expect(q("matchmaking-rules").textContent).toContain("First to 7");
  expect(q("matchmaking-rules").textContent).toContain("30s turns");
  expect(filledSeats()).toBe(0);
  expect(q("queue-waiting-now").textContent).toBe("2 players waiting right now");
  expect(q("join-queue-btn")).not.toBeNull();
  expect(q("queue-status")).toBeNull();
});

test("picking a stake table joins that table's queue; locked or unaffordable tables can't be picked", async () => {
  setup({ joinResult: { queued: true, position: 1, waiting: 1, tier: "chai", stake: { name: "Chai Table", entry: 100, payout: 180 } } });
  const tiers = [
    { id: "chai", name: "Chai Table", entry: 100, payout: 180, min_level: 1, unlocked: true, affordable: true },
    { id: "royal", name: "Royal Table", entry: 2500, payout: 4500, min_level: 6, unlocked: false, affordable: false },
  ];
  const statusGet = global.__app.api.get;
  global.__app.api.get = jest.fn((url) => (url === "/wallet" ? Promise.resolve({ data: { tiers } }) : statusGet(url)));
  await render();
  expect(q("table-option-free").getAttribute("aria-checked")).toBe("true");
  expect(q("table-option-royal").disabled).toBe(true);
  await act(async () => { q("table-option-chai").click(); });
  expect(q("join-queue-btn").textContent).toContain("Join for 100 coins");
  await act(async () => { q("join-queue-btn").click(); });
  expect(global.__app.api.post).toHaveBeenCalledWith("/matchmaking/join", { tier: "chai" });
  expect(q("queue-stake").textContent).toContain("Chai Table");
});

test("joining fills seats from the server's queue count and shows position and a search timer", async () => {
  setup();
  await render();
  await act(async () => { q("join-queue-btn").click(); });
  expect(global.__app.api.post).toHaveBeenCalledWith("/matchmaking/join");
  expect(q("queue-status").textContent).toContain("3/4 players in queue");
  expect(filledSeats()).toBe(3);
  expect(q("queue-position").textContent).toBe("#3");
  expect(q("queue-elapsed").textContent).toBe("0:00");
  await act(async () => { jest.advanceTimersByTime(65000); });
  expect(q("queue-elapsed").textContent).toBe("1:05");
});

test("a match found navigates to the room", async () => {
  setup({ joinResult: { queued: false, room_code: "PUB123" } });
  await render();
  await act(async () => { q("join-queue-btn").click(); });
  expect(global.__navigate).toHaveBeenCalledWith("/room/PUB123");
});

test("leaving the queue returns to the idle table", async () => {
  setup({ status: { queued: true, position: 1, waiting: 1 } });
  await render();
  expect(q("queue-status").textContent).toContain("1/4");
  expect(filledSeats()).toBe(1);
  await act(async () => { q("leave-queue-btn").click(); });
  expect(global.__app.api.post).toHaveBeenCalledWith("/matchmaking/leave");
  expect(q("join-queue-btn")).not.toBeNull();
  expect(filledSeats()).toBe(0);
});
