import {
  CARD_ASPECT, MIN_CARD_WIDTH, cardBounds, computeHandLayout, computeTwoRowHandLayout, twoRowCardBounds, usesTwoRows,
} from "./handLayout";

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

// ---------- two-row hand on portrait phones ----------
// Realistic browser viewports (the address and tool bars take part of the screen) plus full screen sizes.
const PHONES = [
  ["320 x 568", 320, 568], ["360 x 640", 360, 640], ["375 x 635 (Safari)", 375, 635], ["390 x 664 (Safari)", 390, 664],
  ["412 x 780", 412, 780], ["430 x 740", 430, 740], ["375 x 812", 375, 812], ["390 x 844", 390, 844], ["430 x 932", 430, 932],
];

describe.each(PHONES)("two rows on a %s phone", (_, screenWidth, screenHeight) => {
  const width = screenWidth - 2 * DOCK_PADDING;
  test.each([13, 10, 7])("%i cards: balanced rows, on screen, every rank and suit uncovered", (count) => {
    expect(usesTwoRows({ screenWidth, count })).toBe(true);
    const two = computeTwoRowHandLayout({ width, viewportHeight: screenHeight, count });
    const [back, front] = two.rows;
    expect([back.count, front.count]).toEqual([Math.ceil(count / 2), Math.floor(count / 2)]); // 13 -> 7 + 6
    expect(back.layout.cardWidth).toBe(front.layout.cardWidth);        // same card size in both rows
    expect(two.cardWidth).toBeGreaterThanOrEqual(MIN_CARD_WIDTH);
    expect(two.fontSize).toBeGreaterThanOrEqual(11);
    const originX = DOCK_PADDING + (width - two.total) / 2;              // the hand is centred in the dock
    for (let i = 0; i < count; i += 1) {
      for (const state of ["rest", "hover", "selected"]) {
        const b = twoRowCardBounds(two, i, state);
        expect(originX + b.left).toBeGreaterThanOrEqual(0);
        expect(originX + b.right).toBeLessThanOrEqual(screenWidth);
        expect(b.top).toBeGreaterThanOrEqual(0);
        expect(b.bottom).toBeLessThanOrEqual(two.height);
      }
    }
    // Within a row, neighbours overlap but at least half of each card shows.
    for (const row of two.rows) if (row.count > 1) expect(row.layout.step / row.layout.cardWidth).toBeGreaterThanOrEqual(0.5);
    // The front row never reaches up into a back-row card's corner index (rank, suit and padding).
    const indexHeight = two.fontSize * 2.3;
    for (let j = 0; j < back.count; j += 1) {
      const b = twoRowCardBounds(two, j);
      for (let k = back.count; k < count; k += 1) {
        const f = twoRowCardBounds(two, k);
        if (f.left < b.right && f.right > b.left) expect(f.top).toBeGreaterThanOrEqual(b.top + indexHeight);
      }
    }
  });
});

test("only portrait phones with a large hand get two rows", () => {
  expect(usesTwoRows({ screenWidth: 375, count: 13 })).toBe(true);
  expect(usesTwoRows({ screenWidth: 639, count: 13 })).toBe(true);
  expect(usesTwoRows({ screenWidth: 640, count: 13 })).toBe(false);                    // tablets and up
  expect(usesTwoRows({ screenWidth: 1440, count: 13 })).toBe(false);                   // desktop
  expect(usesTwoRows({ screenWidth: 375, count: 6 })).toBe(false);                     // small hands: one row
  expect(usesTwoRows({ screenWidth: 375, count: 13, sideLayout: true })).toBe(false);  // landscape phone layout
});

test("a two-row hand never squeezes cards below today's single-row size on common phones", () => {
  for (const [, screenWidth, screenHeight] of PHONES.slice(1)) {
    const width = screenWidth - 2 * DOCK_PADDING;
    const one = computeHandLayout({ width, viewportHeight: screenHeight, count: 13 });
    const two = computeTwoRowHandLayout({ width, viewportHeight: screenHeight, count: 13 });
    expect(two.cardWidth).toBeGreaterThanOrEqual(one.cardWidth - 5);
    expect(two.rows[0].layout.step).toBeGreaterThan(one.step);  // and much more of each card shows
  }
});

test("the single-row layout is unchanged when no card width is fixed", () => {
  const base = computeHandLayout({ width: 756, viewportHeight: 1024, count: 13 });
  expect(computeHandLayout({ width: 756, viewportHeight: 1024, count: 13, cardWidth: undefined })).toEqual(base);
});
