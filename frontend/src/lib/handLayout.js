// Geometry for the player's fanned hand. Pure, so it can be tested for any viewport and card count.
//
// Each card is rotated about its bottom-centre and dropped slightly along an arc. The layout sizes the
// cards from BOTH the available width and the screen height, then reserves exactly the room the
// rotated edge cards and a lifted (hovered/selected) card need, so nothing crosses the screen edges
// or gets clipped.

export const CARD_ASPECT = 1.4;              // height / width of a playing card
export const MIN_CARD_WIDTH = 40;            // smallest width that keeps rank and suit readable
export const MIN_EDGE_GAP = 16;              // clear space beside the outermost card (rounded screen corners)
export const EDGE_GAP_SHARE = 0.04;          // ... or 4% of the hand width when that is larger
export const MAX_STEP_SHARE = 0.6;           // cards never spread further apart than 60% of a card
export const BOTTOM_GAP = 16;                // room under the cards for the arc drop and screen corners
export const SELECTED_LIFT = 22;             // how far a selected card rises
export const HOVER_LIFT = 18;                // how far a hovered card rises
const TOP_GAP = 4;
export const DEFAULT_HEIGHT_SHARE = 0.2;     // a card never takes more than 20% of the screen height

const rad = (deg) => (deg * Math.PI) / 180;

/** Landscape phones (very short screens) give the hand a slightly smaller share of the height. */
export function heightShareFor(viewportHeight) {
  return Number.isFinite(viewportHeight) && viewportHeight <= 500 ? 0.17 : DEFAULT_HEIGHT_SHARE;
}

/** Largest card width the design allows at this screen size (unchanged from the original design). */
export function maxCardWidth(width) {
  return width < 640 ? 76 : 96;
}

/**
 * @param {{width: number, viewportHeight?: number, count: number, heightShare?: number}} input
 *   width: the hand area's content width in CSS px; viewportHeight: screen height in CSS px;
 *   heightShare: the largest share of the screen height one card may take.
 */
export function computeHandLayout({ width, viewportHeight = Infinity, count, heightShare = heightShareFor(viewportHeight), cardWidth: fixedWidth }) {
  const n = Math.max(1, Math.floor(count) || 1);
  const available = Math.max(0, width);
  const edgeGap = Math.max(MIN_EDGE_GAP, available * EDGE_GAP_SHARE);
  const maxRotation = Math.min(2.2, 22 / n);                 // degrees between neighbouring cards
  const arcStep = Math.min(1.6, 16 / n);                      // px each card drops per step from the middle
  const mid = (n - 1) / 2;
  const edgeAngle = rad(maxRotation * mid);
  // Horizontal overhang of an edge card's outer top corner beyond its unrotated box, per px of width.
  const overhangPerWidth = Math.max(0, CARD_ASPECT * Math.sin(edgeAngle) - (1 - Math.cos(edgeAngle)) / 2);
  const preferredVisible = available < 480 ? 0.5 : 0.56;      // share of each card left uncovered when sizing

  const byWidth = (available - 2 * edgeGap) / (1 + (n - 1) * preferredVisible + 2 * overhangPerWidth);
  const byHeight = Number.isFinite(viewportHeight) && viewportHeight > 0
    ? Math.max(56, viewportHeight * heightShare) / CARD_ASPECT
    : Infinity;
  // fixedWidth: the two-row phone hand gives both rows the same card size (see computeTwoRowHandLayout).
  const cardWidth = fixedWidth ?? Math.max(MIN_CARD_WIDTH, Math.min(maxCardWidth(available), byWidth, byHeight));
  const cardHeight = cardWidth * CARD_ASPECT;

  const overhang = overhangPerWidth * cardWidth;
  const spread = available - 2 * edgeGap - 2 * overhang;      // room for the unrotated fan
  // Small hands stay compact and centred instead of stretching edge to edge.
  const step = n > 1 ? Math.max(0, Math.min(cardWidth * MAX_STEP_SHARE, (spread - cardWidth) / (n - 1))) : 0;
  const total = cardWidth + step * (n - 1);

  // Rotation about the bottom-centre raises one top corner and lowers one bottom corner by this much.
  const rotationShift = (cardWidth / 2) * Math.sin(edgeAngle);
  // A hovered card keeps its rotation, so its inner top corner rises a little more than the lift.
  const lift = Math.max(SELECTED_LIFT, HOVER_LIFT + rotationShift);
  // Edge cards drop along the arc and their outer bottom corner dips further when rotated.
  const bottom = Math.max(BOTTOM_GAP, mid * arcStep + rotationShift + 2);
  const height = bottom + cardHeight + lift + TOP_GAP;

  return {
    count: n, cardWidth, cardHeight, step, total, height, edgeGap,
    bottom, maxRotation, arcStep, mid,
    fontSize: Math.max(11, cardWidth * 0.21),
  };
}

/** Pose of card i: its left offset, rotation (deg) and vertical offset (px, positive = down). */
export function cardPose(layout, i, state = "rest") {
  const off = i - layout.mid;
  const left = i * layout.step;
  if (state === "selected") return { left, rotate: 0, y: -SELECTED_LIFT };
  const rotate = off * layout.maxRotation;
  if (state === "hover") return { left, rotate, y: -HOVER_LIFT };
  return { left, rotate, y: Math.abs(off) * layout.arcStep };
}

/**
 * Axis-aligned bounds of card i inside the hand container (origin top-left, y downwards), after its
 * rotation about the bottom-centre. Used by tests to prove nothing leaves the screen or gets clipped.
 */
export function cardBounds(layout, i, state = "rest") {
  const { left, rotate, y } = cardPose(layout, i, state);
  const a = rad(rotate);
  const w = layout.cardWidth;
  const h = layout.cardHeight;
  const pivotX = left + w / 2;
  const pivotY = layout.height - layout.bottom + y;           // bottom-centre of the card
  const corners = [[-w / 2, 0], [w / 2, 0], [-w / 2, -h], [w / 2, -h]].map(([x, yy]) => [
    pivotX + x * Math.cos(a) - yy * Math.sin(a),
    pivotY + x * Math.sin(a) + yy * Math.cos(a),
  ]);
  const xs = corners.map((c) => c[0]);
  const ys = corners.map((c) => c[1]);
  return { left: Math.min(...xs), right: Math.max(...xs), top: Math.min(...ys), bottom: Math.max(...ys) };
}

// ---------- two-row hand (portrait phones only) ----------
// A full hand on a narrow phone is split into two fanned rows: the first ceil(n/2) cards in a back (upper)
// row and the rest in a front (lower) row, e.g. 7 + 6. The front row covers only the lower part of the
// back row, so every rank and suit stays visible, and each row keeps the fan's own spacing rules.
export const TWO_ROW_MAX_SCREEN = 640;          // below the sm breakpoint; tablets and desktops keep one row
export const TWO_ROW_MIN_CARDS = 7;             // smaller hands fit comfortably in one row
// A card's height as a share of the screen height: small enough that the taller hand leaves the table its
// room (played cards keep their size on common phones), so cards end up about as wide as in one row.
export const TWO_ROW_CARD_HEIGHT_SHARE = 0.09;
export const ROW_REVEAL = 0.46;                 // share of a back-row card left uncovered above the front row
// ... and never less than the corner index needs: padding 0.3em + rank and suit lines (2em) + a margin
// for the rows' arc and rotation.
const INDEX_EM = 2.3;
const INDEX_MARGIN = 5;

/** Two rows only on portrait phones (the landscape layout has side panels instead) with a large hand. */
export function usesTwoRows({ screenWidth, count, sideLayout = false }) {
  return !sideLayout && Number.isFinite(screenWidth) && screenWidth > 0 && screenWidth < TWO_ROW_MAX_SCREEN
    && count >= TWO_ROW_MIN_CARDS;
}

/** Which row card i is in, and its index within that row. */
export function rowOf(twoRow, i) {
  const [back, front] = twoRow.rows;
  return i < back.count ? { row: back, rowIndex: 0, j: i } : { row: front, rowIndex: 1, j: i - back.count };
}

/**
 * @param {{width: number, viewportHeight?: number, count: number}} input  as for computeHandLayout
 * Returns both rows' layouts (same card size), each row's horizontal offset (rows are centred) and how far
 * its cards sit above the bottom of the hand, plus the whole hand's width and height.
 */
export function computeTwoRowHandLayout({ width, viewportHeight = Infinity, count }) {
  const n = Math.max(2, Math.floor(count) || 2);
  const backCount = Math.ceil(n / 2);
  const back = computeHandLayout({ width, viewportHeight, count: backCount, heightShare: TWO_ROW_CARD_HEIGHT_SHARE });
  const front = computeHandLayout({ width, viewportHeight, count: n - backCount, cardWidth: back.cardWidth });
  const rowOffset = Math.max(back.cardHeight * ROW_REVEAL, back.fontSize * INDEX_EM + INDEX_MARGIN);
  const total = Math.max(back.total, front.total);
  return {
    twoRows: true, count: n, total,
    height: Math.max(rowOffset + back.height, front.height),
    cardWidth: back.cardWidth, cardHeight: back.cardHeight, fontSize: back.fontSize, rowOffset,
    rows: [
      { layout: back, start: 0, count: backCount, offsetX: (total - back.total) / 2, offsetY: rowOffset },
      { layout: front, start: backCount, count: n - backCount, offsetX: (total - front.total) / 2, offsetY: 0 },
    ],
  };
}

/** Bounds of card i inside the two-row hand container (origin top-left, y downwards); for tests. */
export function twoRowCardBounds(twoRow, i, state = "rest") {
  const { row, j } = rowOf(twoRow, i);
  const b = cardBounds(row.layout, j, state);
  const top = twoRow.height - row.offsetY - row.layout.height;  // the row's own box inside the container
  return { left: b.left + row.offsetX, right: b.right + row.offsetX, top: b.top + top, bottom: b.bottom + top };
}
