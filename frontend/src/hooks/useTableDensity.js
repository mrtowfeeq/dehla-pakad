import { useEffect, useState } from "react";

// How much vertical room the game table has. The header, the four seats, the trick area and the hand
// all stack vertically, so short screens (landscape phones, small phones) need a denser layout or the
// table collapses and the seats spill onto the hand.
export const SHORT_MAX_HEIGHT = 700;
export const TINY_MAX_HEIGHT = 500;
export const DESKTOP_MIN_WIDTH = 1024;  // tablets in landscape and desktops never get the landscape-phone layout
// Wide but short windows (1366×768 / 1280×720 laptops, 1024×768 tablets) would leave the felt under ~100px
// tall with the full header, so they use the compact "short" header and partner panel as well.
export const DESKTOP_SHORT_MAX_HEIGHT = 800;

export function tableDensity(height, width = 0) {
  if (!Number.isFinite(height) || height <= 0) return "regular";
  if (width >= DESKTOP_MIN_WIDTH) return height <= DESKTOP_SHORT_MAX_HEIGHT ? "short" : "regular";
  if (height <= TINY_MAX_HEIGHT) return "tiny";
  if (height <= SHORT_MAX_HEIGHT) return "short";
  return "regular";
}

export function currentSize() {
  if (typeof window === "undefined") return [Infinity, 0];
  return [window.visualViewport?.height || window.innerHeight || Infinity,
    window.visualViewport?.width || window.innerWidth || 0];
}

// Landscape phones narrower than this get slimmer side panels beside the hand and a terser header.
export const NARROW_LANDSCAPE_WIDTH = 760;

export function tableLayout(height, width) {
  const density = tableDensity(height, width);
  return { density, narrow: density === "tiny" && width < NARROW_LANDSCAPE_WIDTH };
}

export function useTableDensity() {
  const [layout, setLayout] = useState(() => tableLayout(...currentSize()));
  useEffect(() => {
    const update = () => {
      const next = tableLayout(...currentSize());
      setLayout((prev) => (prev.density === next.density && prev.narrow === next.narrow ? prev : next));
    };
    update();
    window.addEventListener("resize", update);
    window.visualViewport?.addEventListener("resize", update);
    return () => {
      window.removeEventListener("resize", update);
      window.visualViewport?.removeEventListener("resize", update);
    };
  }, []);
  return layout;
}
