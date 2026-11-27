import { tableDensity, tableLayout } from "./useTableDensity";

test("only narrow landscape phones get the narrow variant", () => {
  expect(tableLayout(390, 844)).toEqual({ density: "tiny", narrow: false });
  expect(tableLayout(320, 568)).toEqual({ density: "tiny", narrow: true });
  expect(tableLayout(568, 320)).toEqual({ density: "short", narrow: false });
  expect(tableLayout(900, 1440)).toEqual({ density: "regular", narrow: false });
});

test.each([
  [568, 320, "short"],       // 320 × 568 portrait phone
  [667, 375, "short"],
  [780, 360, "regular"],     // tall phone keeps the full layout
  [932, 430, "regular"],
  [390, 844, "tiny"],        // 844 × 390 landscape phone
  [320, 568, "tiny"],
  [1024, 768, "regular"],    // tablet portrait
  [768, 1024, "short"],      // tablet landscape / 1024×768: compact header so the felt has room
  [657, 1366, "short"],      // short laptop window
  [720, 1280, "short"],
  [800, 1280, "short"],
  [860, 1280, "regular"],
  [900, 1440, "regular"],
  [400, 1280, "short"],      // very short desktop window: never the landscape-phone layout
  [1080, 1920, "regular"],
])("height %i, width %i → %s", (height, width, expected) => {
  expect(tableDensity(height, width)).toBe(expected);
});

test("unknown sizes fall back to the regular layout", () => {
  expect(tableDensity(undefined, 400)).toBe("regular");
  expect(tableDensity(0, 400)).toBe("regular");
});
