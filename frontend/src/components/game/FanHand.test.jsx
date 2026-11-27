import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { FanHand } from "./TableLayout";
import { computeHandLayout } from "@/lib/handLayout";

jest.mock("framer-motion", () => {
  const ReactModule = jest.requireActual("react");
  const strip = ({ initial, animate, exit, whileHover, transition, ...props }) => props;
  return {
    motion: { button: ReactModule.forwardRef((props, ref) => ReactModule.createElement("button", { ...strip(props), ref })) },
    AnimatePresence: ({ children }) => children,
  };
});
jest.mock("react-router-dom", () => ({ Link: ({ children }) => children }));
jest.mock("@/components/PlayingCard", () => ({ PlayingCard: ({ card }) => <span>{card}</span> }));
jest.mock("@/components/PlayerAvatar", () => ({ PlayerAvatar: () => null }));
jest.mock("@/components/game/TurnTimer", () => ({ TurnTimer: () => null }));
jest.mock("@/lib/sound", () => ({ sound: { play: jest.fn() } }));
jest.mock("@/lib/api", () => ({
  SUIT_SYMBOL: { S: "♠", H: "♥", D: "♦", C: "♣" }, SUIT_NAME: {}, TEAM_NAME: ["Team A", "Team B"],
  isRed: () => false, cardSuit: (c) => c.slice(-1),
}));

global.IS_REACT_ACT_ENVIRONMENT = true;

const THIRTEEN = ["AS", "KS", "QS", "JS", "10S", "9H", "8H", "7H", "6D", "5D", "4D", "3C", "2C"];
let observers;
let root;
let container;
let contentWidth;
const originalInnerHeight = window.innerHeight;

class FakeResizeObserver {
  constructor(callback) { this.callback = callback; observers.push(this); }
  observe() {}
  disconnect() {}
  resize(width) { this.callback([{ contentRect: { width } }]); }
}

beforeEach(() => {
  observers = [];
  global.ResizeObserver = FakeResizeObserver;
  contentWidth = 308; // a 320px phone minus the dock's 6px side padding
  // jsdom applies no Tailwind CSS, so the dock's padding reads as 0: report the content width directly.
  jest.spyOn(HTMLElement.prototype, "clientWidth", "get").mockImplementation(() => contentWidth);
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  jest.restoreAllMocks();
  Object.defineProperty(window, "innerHeight", { configurable: true, value: originalInnerHeight });
  delete global.ResizeObserver;
});

async function renderHand(cards, props = {}) {
  await act(async () => {
    root.render(<FanHand cards={cards} legal={cards} myTurn onPlay={jest.fn()} pending={false} {...props} />);
  });
}

const fan = () => container.querySelector('[data-testid="player-hand-fan"]');
const card = (c) => container.querySelector(`[data-testid="hand-card-${c}"]`);

function positions(cards) {
  return cards.map((c) => ({ left: parseFloat(card(c).style.left), width: parseFloat(card(c).style.width) }));
}

test("measures the real width before painting and fits 13 cards on a 320px phone", async () => {
  Object.defineProperty(window, "innerHeight", { configurable: true, value: 568 });
  await renderHand(THIRTEEN);
  expect(fan().style.visibility).toBe(""); // measured synchronously, never painted with a guessed width
  const expected = computeHandLayout({ width: 308, viewportHeight: 568, count: 13 });
  expect(parseFloat(fan().style.width)).toBeCloseTo(expected.total, 3);
  expect(parseFloat(fan().style.width)).toBeLessThanOrEqual(308);
  const placed = positions(THIRTEEN);
  const steps = placed.slice(1).map((p, i) => p.left - placed[i].left);
  steps.forEach((step) => expect(step).toBeCloseTo(steps[0], 6)); // evenly spaced
  expect(placed[12].left + placed[12].width).toBeCloseTo(expected.total, 3);
  expect(parseFloat(card("AS").style.height) / placed[0].width).toBeCloseTo(1.4, 6);
});

test.each([
  ["375px phone", 363, 667], ["430px phone", 418, 932], ["tablet", 756, 1024], ["desktop", 884, 1080], ["landscape phone", 832, 390],
])("re-flows for a %s when the size changes", async (_, width, height) => {
  Object.defineProperty(window, "innerHeight", { configurable: true, value: height });
  await renderHand(THIRTEEN);
  await act(async () => {
    window.dispatchEvent(new Event("resize"));
    observers.forEach((o) => o.resize(width));
  });
  const expected = computeHandLayout({ width, viewportHeight: height, count: 13 });
  expect(fan().getAttribute("data-card-width")).toBe(String(Math.round(expected.cardWidth)));
  expect(parseFloat(fan().style.width)).toBeLessThanOrEqual(width);
  expect(parseFloat(fan().style.height)).toBeCloseTo(expected.height, 3);
});

test("playing cards re-centres the remaining hand with the same spacing rule", async () => {
  await renderHand(THIRTEEN);
  const fullWidth = parseFloat(fan().style.width);
  await renderHand(THIRTEEN.slice(0, 5));
  const expected = computeHandLayout({ width: 308, viewportHeight: window.innerHeight, count: 5 });
  expect(parseFloat(fan().style.width)).toBeCloseTo(expected.total, 3);
  expect(parseFloat(fan().style.width)).toBeLessThanOrEqual(fullWidth + 0.001 + 308);
});

test("side content on landscape phones is reserved outside the measured hand width", async () => {
  contentWidth = 844 - 2 * 200; // the dock's side padding is the reserve
  Object.defineProperty(window, "innerHeight", { configurable: true, value: 390 });
  await renderHand(THIRTEEN, { sideStart: <span>You</span>, sideEnd: <span>Your turn</span>, sideReserve: 200 });
  const dock = container.querySelector('[data-testid="player-hand-container"]');
  expect(dock.style.paddingLeft).toBe("200px");
  expect(dock.style.paddingRight).toBe("200px");
  expect(container.querySelector('[data-testid="hand-side-start"]').textContent).toBe("You");
  expect(container.querySelector('[data-testid="hand-side-end"]').textContent).toBe("Your turn");
  expect(parseFloat(fan().style.width)).toBeLessThanOrEqual(444);
  const layout = computeHandLayout({ width: 444, viewportHeight: 390, count: 13 });
  expect(layout.cardHeight).toBeLessThanOrEqual(390 * 0.17 + 0.001);
});

test("card selection behaviour is unchanged: mouse plays at once; touch selects first, a second tap plays", async () => {
  const onPlay = jest.fn();
  await renderHand(THIRTEEN, { onPlay });
  await act(async () => { card("AS").click(); }); // no pointerdown recorded: treated as a mouse click
  expect(onPlay).toHaveBeenCalledWith("AS");

  onPlay.mockClear();
  const target = card("10S");
  // A non-mouse pointer (jsdom's synthetic pointerdown has no "mouse" pointerType) selects first.
  await act(async () => { target.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true })); });
  await act(async () => { target.click(); });
  expect(onPlay).not.toHaveBeenCalled();
  expect(target.getAttribute("data-selected")).toBe("true");
  await act(async () => { target.click(); });
  expect(onPlay).toHaveBeenCalledWith("10S");
});
