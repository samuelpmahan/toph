// Faithful-shape ChainSpot "pancake" course scene used as the Toph replay viewer acceptance
// fixture. This module is the SINGLE source of truth for course geometry: the trace adapter
// derives its measurements/evidence from these coordinates, and the source-image renderer
// draws the background from the same coordinates, so an overlay drawn on the raster lands on
// the pixels it claims to measure. Coordinates are source-image pixels (x right, y down).
//
// The scenario is the canonical Rec H7/H8 basket swap:
//  - Two adjacent greens (hole 7 left, hole 8 right); each basket physically sits by its
//    CORRECT green.
//  - p6.lowParAssignment uses a low-par lookup whose 7/8 rows are transposed, so it assigns
//    each basket to the WRONG hole (basket X -> hole 8, basket Y -> hole 7).
//  - p6.swapAdjudication measures how far each basket sits from each hole's tee->green fairway
//    "ribbon" centerline. Swapping restores basket X -> hole 7, basket Y -> hole 8 and reduces
//    total ribbon offset by well over the minimum-improvement threshold, so the swap fires.
// The ribbon offsets are real perpendicular distances to the drawn fairways, so the claimed
// improvement can be judged by eye against the picture.

export interface Pt {
  x: number;
  y: number;
}

export interface HoleScene {
  holeNumber: number;
  tee: Pt;
  green: Pt;
  greenRadius: number;
  par: number;
}

export interface BasketScene {
  /** Candidate ordinal as ChainSpot's detector numbered it (raw, not a hole number). */
  candidate: number;
  center: Pt;
  radius: number;
  /** The hole this basket actually belongs to (ground truth, for building the fixture). */
  trueHole: number;
  /** The hole p6.lowParAssignment initially (wrongly) assigns it to. */
  initialHole: number;
}

export interface Scene {
  widthPx: number;
  heightPx: number;
  holes: HoleScene[];
  baskets: BasketScene[];
}

// Two adjacent central greens with tees on crossed sides so the fairways form an X; the
// baskets sit by their true greens. Low-par assignment transposes 7 and 8.
export const SCENE: Scene = {
  widthPx: 1600,
  heightPx: 1000,
  holes: [
    // Holes 6 and 9 are decorative context, parked in the left/right edge columns so their tees and
    // greens never stack under the holes 7/8 that the swap is about.
    { holeNumber: 6, tee: { x: 150, y: 210 }, green: { x: 150, y: 780 }, greenRadius: 92, par: 3 },
    { holeNumber: 7, tee: { x: 300, y: 250 }, green: { x: 650, y: 560 }, greenRadius: 118, par: 4 },
    { holeNumber: 8, tee: { x: 1300, y: 250 }, green: { x: 970, y: 560 }, greenRadius: 118, par: 4 },
    { holeNumber: 9, tee: { x: 1470, y: 210 }, green: { x: 1470, y: 780 }, greenRadius: 92, par: 3 },
  ],
  baskets: [
    // Basket X sits just below green 7 -> truly hole 7, but low-par assigns it to hole 8.
    { candidate: 3, center: { x: 650, y: 612 }, radius: 30, trueHole: 7, initialHole: 8 },
    // Basket Y sits just below green 8 -> truly hole 8, but low-par assigns it to hole 7.
    { candidate: 4, center: { x: 970, y: 612 }, radius: 30, trueHole: 8, initialHole: 7 },
  ],
};

export function holeByNumber(scene: Scene, holeNumber: number): HoleScene {
  const hole = scene.holes.find((h) => h.holeNumber === holeNumber);
  if (hole === undefined) throw new Error(`scene has no hole ${holeNumber}`);
  return hole;
}

function sub(a: Pt, b: Pt): Pt {
  return { x: a.x - b.x, y: a.y - b.y };
}
function len(v: Pt): number {
  return Math.hypot(v.x, v.y);
}
function dot(a: Pt, b: Pt): number {
  return a.x * b.x + a.y * b.y;
}

/** Foot of the perpendicular from `p` onto the infinite line through a->b, plus the distance. */
export function perpendicularToRibbon(p: Pt, a: Pt, b: Pt): { foot: Pt; distance: number } {
  const ab = sub(b, a);
  const abLen2 = ab.x * ab.x + ab.y * ab.y || 1;
  const t = dot(sub(p, a), ab) / abLen2;
  const foot = { x: a.x + ab.x * t, y: a.y + ab.y * t };
  return { foot, distance: len(sub(p, foot)) };
}

/** Perpendicular offset (px) of a basket from a hole's tee->green fairway ribbon. Lower = better fit. */
export function ribbonOffsetPx(scene: Scene, basket: BasketScene, holeNumber: number): number {
  const hole = holeByNumber(scene, holeNumber);
  return perpendicularToRibbon(basket.center, hole.tee, hole.green).distance;
}

/** Forward-gate angle (deg): angle between the tee->green play direction and tee->basket. */
export function forwardGateAngleDeg(scene: Scene, basket: BasketScene, holeNumber: number): number {
  const hole = holeByNumber(scene, holeNumber);
  const play = sub(hole.green, hole.tee);
  const toBasket = sub(basket.center, hole.tee);
  const cos = dot(play, toBasket) / ((len(play) * len(toBasket)) || 1);
  return (Math.acos(Math.max(-1, Math.min(1, cos))) * 180) / Math.PI;
}

/** Straight-line distance (px) from a basket to a hole's green center. */
export function basketToGreenPx(scene: Scene, basket: BasketScene, holeNumber: number): number {
  const hole = holeByNumber(scene, holeNumber);
  return len(sub(basket.center, hole.green));
}

export function round1(n: number): number {
  return Math.round(n * 10) / 10;
}
