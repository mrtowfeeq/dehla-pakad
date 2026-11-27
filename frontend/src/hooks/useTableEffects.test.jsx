import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { TEN_FLIGHT_MS, TEN_LAND_MS, TEN_STAGGER_MS, TRICK_ARRIVE_MS, TRICK_BURST_MS, useTableEffects } from "./useTableEffects";

jest.mock("@/lib/sound", () => ({ sound: { play: jest.fn(), chime: jest.fn(), stopAll: jest.fn() } }));
jest.mock("@/lib/api", () => ({
  cardRank: (c) => c.slice(0, -1),
  SUIT_NAME: { S: "Spades", H: "Hearts", D: "Diamonds", C: "Clubs" },
  TEAM_NAME: ["Team A", "Team B"],
}));

const { sound } = jest.requireMock("@/lib/sound");
global.IS_REACT_ACT_ENVIRONMENT = true;

let root;
let container;
let fx;

function Probe({ g }) {
  fx = useTableEffects(g);
  return null;
}

// A round in progress: 4 tricks played, deal finished, nobody has a ten yet.
const before = {
  my_seat: 0, dealer: 3, round_no: 2, deal_stage: 3, phase: "playing", trump: "S", hand: ["2C"],
  tricks_played: 4, trick: [[1, "3H"]], tens: [[], []], turn: 2, koth: null, gs_declared: null, rounds: [],
};
// The trick completes: the winner's team takes the listed cards.
const after = (winner, cards, tens) => ({
  ...before, tricks_played: 5, trick: [], turn: winner,
  last_trick: { winner, cards: cards.map((c, i) => [(1 + i) % 4, c]) }, tens,
});

async function step(state) {
  await act(async () => { root.render(<Probe g={{ status: "active", players: [], state }} />); });
}

beforeEach(() => {
  jest.useFakeTimers();
  sound.play.mockClear();
  sound.chime.mockClear();
  container = document.createElement("div");
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  jest.useRealTimers();
});

test("your team capturing a ten: bright chime, flight to your counter, landing ping, then cleanup", async () => {
  await step(before);
  await step(after(0, ["3H", "10H", "4H", "5H"], [["10H"], []]));
  expect(sound.chime).not.toHaveBeenCalled();

  await act(async () => { jest.advanceTimersByTime(900); });
  expect(sound.play).toHaveBeenCalledWith("ten");
  expect(sound.chime).toHaveBeenCalledWith("ten_gain", { delay: 120 });
  expect(fx.tenFlights).toEqual([{ id: "2-10H", card: "10H", team: 0, mine: true, order: 0 }]);

  await act(async () => { jest.advanceTimersByTime(TEN_LAND_MS); });
  expect(sound.chime).toHaveBeenCalledWith("ten_land", { gain: 1 });

  await act(async () => { jest.advanceTimersByTime(TEN_FLIGHT_MS - TEN_LAND_MS); });
  expect(fx.tenFlights).toEqual([]);
});

test("opponents capturing two tens: softer chime, staggered landings, third-ten sound after they land", async () => {
  await step({ ...before, tens: [[], ["10C"]] });
  await step(after(1, ["10S", "10D", "4H", "5H"], [[], ["10C", "10S", "10D"]]));

  await act(async () => { jest.advanceTimersByTime(900); });
  expect(sound.chime).toHaveBeenCalledWith("ten_loss", { delay: 120 });
  expect(fx.tenFlights.map((f) => [f.card, f.mine, f.order])).toEqual([["10S", false, 0], ["10D", false, 1]]);

  const landings = () => sound.chime.mock.calls.filter(([k]) => k === "ten_land").length;
  await act(async () => { jest.advanceTimersByTime(TEN_LAND_MS); });
  expect(landings()).toBe(1);
  expect(sound.chime).toHaveBeenLastCalledWith("ten_land", { gain: 0.6 });
  expect(sound.play).not.toHaveBeenCalledWith("third_ten");
  await act(async () => { jest.advanceTimersByTime(TEN_STAGGER_MS); });
  expect(landings()).toBe(2);
  await act(async () => { jest.advanceTimersByTime(150); });
  expect(sound.play).toHaveBeenCalledWith("third_ten");
});

test("a won trick bursts on the winner's seat with a chime as its cards arrive, then clears", async () => {
  await step(before);
  await step(after(2, ["3H", "9H", "4H", "5H"], [[], []])); // my partner (seat 2) wins
  await act(async () => { jest.advanceTimersByTime(TRICK_ARRIVE_MS - 1); });
  expect(fx.trickWin).toBeNull();
  expect(sound.chime).not.toHaveBeenCalledWith("trick_gain");
  await act(async () => { jest.advanceTimersByTime(1); });
  expect(fx.trickWin).toEqual({ id: "2-5", seat: 2, mine: true });
  expect(sound.chime).toHaveBeenCalledWith("trick_gain");
  await act(async () => { jest.advanceTimersByTime(TRICK_BURST_MS); });
  expect(fx.trickWin).toBeNull();
});

test("a trick won by the opponents gets the softer chime", async () => {
  await step(before);
  await step(after(3, ["3H", "9H", "4H", "5H"], [[], []]));
  await act(async () => { jest.advanceTimersByTime(TRICK_ARRIVE_MS); });
  expect(fx.trickWin).toEqual({ id: "2-5", seat: 3, mine: false });
  expect(sound.chime).toHaveBeenCalledWith("trick_loss");
});

test.each([[0, "victory"], [1, "defeat"]])("the match ending with team %i winning plays the %s music after the round sound", async (winner, music) => {
  await step(before);
  await step({ ...before, phase: "match_over", winner_team: winner, rounds: [{ winner_team: winner, type: "normal" }] });
  await act(async () => { jest.advanceTimersByTime(1500); });
  expect(sound.play).toHaveBeenCalledWith("normal_win");
  expect(sound.chime).not.toHaveBeenCalledWith(music);
  await act(async () => { jest.advanceTimersByTime(1800); });
  expect(sound.chime).toHaveBeenCalledWith(music);
  // The old recorded jingles are no longer used.
  expect(sound.play).not.toHaveBeenCalledWith("victory");
  expect(sound.play).not.toHaveBeenCalledWith("defeat");
});

test("with instant play your own card's place sound is not repeated when the server confirms it", async () => {
  function LocalProbe({ g }) { fx = useTableEffects(g, undefined, { localPlays: true }); return null; }
  const draw = async (state) => { await act(async () => { root.render(<LocalProbe g={{ status: "active", players: [], state }} />); }); };
  const mid = { ...before, trick: [[2, "3H"], [3, "4H"]], turn: 0 };
  await draw(mid);
  sound.play.mockClear();
  await draw({ ...mid, trick: [[2, "3H"], [3, "4H"], [0, "9H"]], turn: 1 });
  await act(async () => { jest.advanceTimersByTime(500); });
  expect(sound.play).not.toHaveBeenCalledWith("place", expect.anything());
  // Without instant play the confirmed card still makes its sound.
  sound.play.mockClear();
  await step(mid);
  await step({ ...mid, trick: [[2, "3H"], [3, "4H"], [0, "9H"]], turn: 1 });
  await act(async () => { jest.advanceTimersByTime(500); });
  expect(sound.play).toHaveBeenCalledWith("place", expect.anything());
});

test("a trick without tens plays no ten effects", async () => {
  await step(before);
  await step(after(0, ["3H", "9H", "4H", "5H"], [[], []]));
  await act(async () => { jest.advanceTimersByTime(4000); });
  expect(sound.chime.mock.calls.map(([k]) => k).filter((k) => k.startsWith("ten_"))).toEqual([]);
  expect(sound.play).not.toHaveBeenCalledWith("ten");
  expect(fx.tenFlights).toEqual([]);
});
