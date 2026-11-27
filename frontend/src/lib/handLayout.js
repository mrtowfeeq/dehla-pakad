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
export function computeHandLayout({ width, viewportHeight = Infinity, count, heightShare = heightShareFor(viewportHeight) }) {
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
  const cardWidth = Math.max(MIN_CARD_WIDTH, Math.min(maxCardWidth(available), byWidth, byHeight));
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
