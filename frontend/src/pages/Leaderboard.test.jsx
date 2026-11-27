import React, { act } from "react";
import { createRoot } from "react-dom/client";
import Leaderboard from "./Leaderboard";

jest.mock("react-router-dom", () => {
  const ReactModule = jest.requireActual("react");
  return { Link: ({ to, children, ...props }) => ReactModule.createElement("a", { ...props, href: to }, children) };
});
jest.mock("@/context/AppContext", () => ({ useApp: () => global.__app }));
jest.mock("@/components/PlayerAvatar", () => ({ PlayerAvatar: () => <span /> }));

global.IS_REACT_ACT_ENVIRONMENT = true;

const row = (rank, name, wins, games) => ({
  rank, user_id: `id-${name}`, username: name, online: false, win_rate: games ? Math.round((100 * wins) / games) : 0,
  progression: { level: rank + 1 }, stats: { wins, games_played: games, koth_wins: 2, grand_slam_wins: 1 },
});

let root;
let container;

async function render(data, meId = "id-dave") {
  global.__app = { me: { user_id: meId }, api: { get: jest.fn().mockResolvedValue({ data }) } };
  await act(async () => { root.render(<Leaderboard />); });
  await act(async () => { await Promise.resolve(); });
}

const tid = (id) => container.querySelector(`[data-testid="${id}"]`);

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

test("top three stand on the podium in 2-1-3 order and the rest are listed", async () => {
  await render([row(1, "alice", 9, 10), row(2, "bob", 7, 12), row(3, "carol", 5, 9), row(4, "dave", 3, 8), row(5, "erin", 1, 4)]);
  const podium = tid("leaderboard-podium");
  expect([...podium.children].map((c) => c.getAttribute("data-testid"))).toEqual(["leaderboard-row-2", "leaderboard-row-1", "leaderboard-row-3"]);
  expect(tid("leaderboard-row-1").textContent).toContain("Champion");
  expect(tid("leaderboard-row-1").textContent).toContain("9 wins");
  expect(tid("leaderboard-row-1").textContent).toContain("90% · 10 games");
  expect(tid("leaderboard-row-5").textContent).toContain("erin");
});

test("your own rank is shown in the header and highlighted in the list", async () => {
  await render([row(1, "alice", 9, 10), row(2, "bob", 7, 12), row(3, "carol", 5, 9), row(4, "dave", 3, 8)]);
  expect(tid("leaderboard-my-rank").textContent).toContain("#4");
  expect(tid("leaderboard-row-4").textContent).toContain("You");
  expect(tid("leaderboard-row-4").className).toContain("border-amber-300");
});

test("a short list shows only the podium; an empty one says so", async () => {
  await render([row(1, "dev", 0, 0), row(2, "firefox", 0, 0)], "id-firefox");
  expect(tid("leaderboard-row-1")).not.toBeNull();
  expect(tid("leaderboard-row-2").textContent).toContain("(you)");
  expect(tid("leaderboard-row-3")).toBeNull();
  await act(async () => { root.unmount(); });
  root = createRoot(container);
  await render([]);
  expect(tid("leaderboard-empty").textContent).toContain("No players ranked yet.");
  expect(tid("leaderboard-podium")).toBeNull();
});

test("every row shows lifetime medals on the wins board", async () => {
  const rows = [row(1, "alice", 9, 10), row(2, "bob", 7, 12), row(3, "carol", 5, 9), row(4, "dave", 3, 8)]
    .map((r, i) => ({ ...r, medals: [1520, 40, 0, 7][i] }));
  await render(rows);
  expect(global.__app.api.get).toHaveBeenCalledWith("/leaderboard");
  expect(tid("leaderboard-tab-wins").getAttribute("aria-selected")).toBe("true");
  expect(tid("leaderboard-medals-1").textContent).toBe("1,520");
  expect(tid("leaderboard-medals-3").textContent).toBe("0");
  expect(tid("leaderboard-medals-4").textContent).toBe("7");
});

const lg = (id, level = 1) => ({ id, name: id[0].toUpperCase() + id.slice(1), level, level_label: ["I", "II", "III", "IV", "V"][level - 1] });
const medalPage = ({ page = 1, pages = 3, total = 45, rows, me }) => ({ by: "medals", page, page_size: 20, pages, total, rows, me });
const medalRow = (rank, name, medals, league) => ({ ...row(rank, name, 2, 4), medals, league });

async function openMedals(handler) {
  await render([]);
  global.__app.api.get.mockImplementation((url, config) => Promise.resolve({ data: config?.params?.by === "medals" ? handler(config.params) : [] }));
  await act(async () => { tid("leaderboard-tab-medals").click(); });
  await act(async () => { await Promise.resolve(); });
}

test("the medals board shows one server page with league badges, levels and your rank", async () => {
  const calls = [];
  await openMedals((params) => {
    calls.push(params);
    return medalPage({ page: params.page, rows: [medalRow(1, "ann", 5200, lg("legend")), medalRow(2, "bob", 1500, lg("diamond", 3))],
      me: { rank: 27, medals: 120, league: lg("silver"), page: 2 } });
  });
  expect(calls[0]).toEqual({ by: "medals", page: 1, page_size: 20 });
  expect(tid("medal-row-1").textContent).toContain("ann");
  expect(tid("medal-row-1-league").textContent).toBe("Legend I");
  expect(tid("medal-row-2-league").textContent).toBe("Diamond III");
  expect(tid("leaderboard-medals-1").textContent).toBe("5,200");
  expect(tid("medal-row-1").querySelector('[data-league="legend"]')).not.toBeNull();
  expect(tid("medal-board-my-rank").textContent).toBe("#27");
  expect(tid("medal-board-page").textContent).toBe("Page 1 of 3 · 45 players");
  expect(tid("medal-board-prev").disabled).toBe(true);
  await act(async () => { tid("medal-board-jump-me").click(); });
  await act(async () => { await Promise.resolve(); });
  expect(calls.at(-1)).toEqual({ by: "medals", page: 2, page_size: 20 });
  await act(async () => { tid("medal-board-next").click(); });
  await act(async () => { await Promise.resolve(); });
  expect(calls.at(-1).page).toBe(3);
});

test("league filters ask the server for that league from page one", async () => {
  const calls = [];
  await openMedals((params) => {
    calls.push(params);
    return medalPage({ page: params.page, pages: 1, total: 1, rows: [medalRow(5, "cat", 650, lg("platinum"))], me: { rank: 5, medals: 650, league: lg("platinum"), page: 1 } });
  });
  await act(async () => { tid("league-filter-platinum").click(); });
  await act(async () => { await Promise.resolve(); });
  expect(calls.at(-1)).toEqual({ by: "medals", page: 1, page_size: 20, league: "platinum" });
  expect(tid("league-filter-platinum").getAttribute("aria-pressed")).toBe("true");
  expect(tid("medal-row-5").textContent).toContain("cat");
  expect(tid("medal-board-next").disabled).toBe(true);
});

test("an empty medals board explains how medals are earned", async () => {
  await openMedals(() => medalPage({ pages: 1, total: 0, rows: [], me: { rank: 1, medals: 0, league: lg("bronze"), page: 1 } }));
  expect(tid("leaderboard-empty").textContent).toContain("matches without bots");
});

test("a link with ?board=medals opens the medal board", async () => {
  window.history.pushState({}, "", "/leaderboard?board=medals");
  try {
    await render(medalPage({ rows: [], me: null, total: 0, pages: 1 }));
    expect(tid("leaderboard-tab-medals").getAttribute("aria-selected")).toBe("true");
    expect(global.__app.api.get).toHaveBeenCalledWith("/leaderboard", { params: { by: "medals", page: 1, page_size: 20 } });
  } finally {
    window.history.pushState({}, "", "/");
  }
});