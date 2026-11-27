import { CARD_ASPECT, MIN_CARD_WIDTH, cardBounds, computeHandLayout } from "./handLayout";

// The hand dock is `w-full max-w-4xl mx-auto px-1.5`: up to 896px wide, centred, 6px padding each side.
const DOCK_MAX = 896;
const DOCK_PADDING = 6;

function place(screenWidth, screenHeight, count) {
  const dock = Math.min(screenWidth, DOCK_MAX);
  const width = dock - 2 * DOCK_PADDING;
  const layout = computeHandLayout({ width, viewportHeight: screenHeight, count });
  // The fan container is centred (mx-auto) inside the dock's content box.
  const originX = (screenWidth - dock) / 2 + DOCK_PADDING + (width - layout.total) / 2;
  return { layout, originX, width };
}

const VIEWPORTS = [
  ["320 mobile portrait", 320, 568],
  ["360 mobile portrait", 360, 740],
  ["375 mobile portrait", 375, 667],
  ["390 mobile portrait", 390, 844],
  ["430 mobile portrait", 430, 932],
  ["mobile landscape", 844, 390],
  ["small landscape", 568, 320],
  ["tablet portrait", 768, 1024],
  ["tablet landscape", 1024, 768],
  ["laptop", 1366, 768],
  ["desktop", 1920, 1080],
];
const COUNTS = Array.from({ length: 13 }, (_, i) => i + 1);

describe.each(VIEWPORTS)("%s (%ipx × %ipx)", (_, screenWidth, screenHeight) => {
  test.each(COUNTS)("%i cards stay on screen, unclipped, readable and evenly spaced", (count) => {
    const { layout, originX } = place(screenWidth, screenHeight, count);
    expect(layout.cardHeight / layout.cardWidth).toBeCloseTo(CARD_ASPECT, 6); // never stretched
    expect(layout.cardWidth).toBeGreaterThanOrEqual(MIN_CARD_WIDTH);
    for (let i = 0; i < count; i += 1) {
      for (const state of ["rest", "hover", "selected"]) {
        const b = cardBounds(layout, i, state);
        expect(originX + b.left).toBeGreaterThanOrEqual(0);           // never past the left edge
        expect(originX + b.right).toBeLessThanOrEqual(screenWidth);   // never past the right edge
        expect(b.top).toBeGreaterThanOrEqual(0);                      // a lifted card is not clipped
        expect(b.bottom).toBeLessThanOrEqual(layout.height);          // the arc stays inside the hand area
      }
    }
    if (count > 1) {
      // Even spacing: every neighbour is the same distance apart, and enough of each card shows to read
      // its rank and suit.
      expect(layout.step).toBeGreaterThan(0);
      expect(layout.step / layout.cardWidth).toBeGreaterThanOrEqual(0.3);
      expect(layout.total).toBeCloseTo(layout.cardWidth + layout.step * (count - 1), 6);
    }
    // Centred: the fan has equal space on both sides of the screen.
    const first = cardBounds(layout, 0);
    const last = cardBounds(layout, count - 1);
    expect(originX + first.left).toBeCloseTo(screenWidth - (originX + last.right), 0);
  });
});

test("a full 13-card hand on a 320px phone is still readable", () => {
  const { layout } = place(320, 568, 13);
  expect(layout.cardWidth).toBeGreaterThanOrEqual(MIN_CARD_WIDTH);
  expect(layout.step).toBeGreaterThanOrEqual(15);
  expect(layout.fontSize).toBeGreaterThanOrEqual(11);
});

test("landscape phones get shorter cards so the table keeps its room", () => {
  const landscape = place(844, 390, 13).layout;
  const widthOnly = computeHandLayout({ width: 844 - 12, count: 13 });
  expect(landscape.cardHeight).toBeLessThanOrEqual(390 * 0.2 + 0.001);
  expect(landscape.height).toBeLessThan(390 * 0.34);
  expect(widthOnly.cardHeight).toBeGreaterThan(landscape.cardHeight + 30); // the old width-only size
});

test("desktop keeps the original maximum card size and does not over-spread small hands", () => {
  const { layout } = place(1920, 1080, 3);
  expect(layout.cardWidth).toBe(96);
  expect(layout.step).toBeLessThanOrEqual(96 * 0.98);
  const mobile = place(430, 932, 3).layout;
  expect(mobile.cardWidth).toBe(76);
});

test("fewer cards re-flow to larger spacing, never wider than the screen", () => {
  const widths = COUNTS.map((count) => place(375, 667, count).layout.total);
  widths.forEach((total) => expect(total).toBeLessThanOrEqual(375 - 12));
});
