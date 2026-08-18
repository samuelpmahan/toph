import { encodePng } from './png.js';
import type { Scene, Pt } from './scene.js';

export function renderCourseImage(scene: Scene): Uint8Array {
  const width = scene.widthPx;
  const height = scene.heightPx;

  // Allocate RGBA buffer (row-major, 4 bytes per pixel)
  const rgba = new Uint8Array(width * height * 4);

  // Layer 1: Rough (muted olive/brown mottle background)
  fillRough(rgba, width, height);

  // Layer 2: Fairways (capsules from tee to green)
  for (const hole of scene.holes) {
    drawFairway(rgba, width, height, hole.tee, hole.green);
  }

  // Layer 3: Greens (filled discs)
  for (const hole of scene.holes) {
    drawGreen(rgba, width, height, hole.green, hole.greenRadius);
  }

  // Layer 4: Green rims (darker ring at edge)
  for (const hole of scene.holes) {
    drawGreenRim(rgba, width, height, hole.green, hole.greenRadius);
  }

  // Layer 5: Tee pads (tan rectangles)
  for (const hole of scene.holes) {
    drawTeePad(rgba, width, height, hole.tee);
  }

  // Layer 6: Basket dots (barely-darker circles, optional)
  for (const basket of scene.baskets) {
    drawBasketDot(rgba, width, height, basket.center);
  }

  return encodePng(width, height, rgba);
}

/** Deterministic integer hash of (x, y) coordinates. */
function hashXY(x: number, y: number): number {
  return ((x * 73856093) ^ (y * 19349663)) >>> 0;
}

/** Fill entire image with rough (muted olive/brown) base with deterministic jitter. */
function fillRough(rgba: Uint8Array, width: number, height: number): void {
  const baseR = 74,
    baseG = 86,
    baseB = 54;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const idx = (y * width + x) * 4;
      const hash = hashXY(x, y);
      // Map low 8 bits of hash to +/- 14 brightness jitter
      const jitter = ((hash & 0xff) - 128) * (14 / 128);
      rgba[idx + 0] = Math.max(0, Math.min(255, baseR + jitter));
      rgba[idx + 1] = Math.max(0, Math.min(255, baseG + jitter));
      rgba[idx + 2] = Math.max(0, Math.min(255, baseB + jitter));
      rgba[idx + 3] = 255;
    }
  }
}

/** Perpendicular distance from point p to line segment from a to b. */
function pointToSegmentDistance(p: Pt, a: Pt, b: Pt): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len2 = dx * dx + dy * dy;

  if (len2 === 0) {
    // a and b are the same point
    return Math.hypot(p.x - a.x, p.y - a.y);
  }

  // Clamp projection onto segment to [0, 1]
  const t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2));
  const closestX = a.x + t * dx;
  const closestY = a.y + t * dy;

  return Math.hypot(p.x - closestX, p.y - closestY);
}

/** Draw fairway (70px wide capsule) from tee to green in muted grass green. */
function drawFairway(
  rgba: Uint8Array,
  width: number,
  height: number,
  tee: Pt,
  green: Pt
): void {
  const fairwayR = 104,
    fairwayG = 132,
    fairwayB = 74;
  const radius = 35; // Half of 70px width

  // Bounding box of fairway region
  const minX = Math.max(0, Math.floor(Math.min(tee.x, green.x) - radius));
  const maxX = Math.min(width, Math.ceil(Math.max(tee.x, green.x) + radius));
  const minY = Math.max(0, Math.floor(Math.min(tee.y, green.y) - radius));
  const maxY = Math.min(height, Math.ceil(Math.max(tee.y, green.y) + radius));

  for (let y = minY; y < maxY; y++) {
    for (let x = minX; x < maxX; x++) {
      const dist = pointToSegmentDistance({ x, y }, tee, green);
      if (dist <= radius) {
        const idx = (y * width + x) * 4;
        const hash = hashXY(x, y);
        // Subtler jitter for fairway
        const jitter = ((hash & 0xff) - 128) * (7 / 128);

        rgba[idx + 0] = Math.max(0, Math.min(255, fairwayR + jitter));
        rgba[idx + 1] = Math.max(0, Math.min(255, fairwayG + jitter));
        rgba[idx + 2] = Math.max(0, Math.min(255, fairwayB + jitter));
        rgba[idx + 3] = 255;
      }
    }
  }
}

/** Draw green as a filled disc in brighter grass green. */
function drawGreen(
  rgba: Uint8Array,
  width: number,
  height: number,
  center: Pt,
  radius: number
): void {
  const greenR = 120,
    greenG = 158,
    greenB = 86;

  const minX = Math.max(0, Math.floor(center.x - radius));
  const maxX = Math.min(width, Math.ceil(center.x + radius));
  const minY = Math.max(0, Math.floor(center.y - radius));
  const maxY = Math.min(height, Math.ceil(center.y + radius));

  for (let y = minY; y < maxY; y++) {
    for (let x = minX; x < maxX; x++) {
      const dx = x - center.x;
      const dy = y - center.y;
      const dist2 = dx * dx + dy * dy;

      if (dist2 <= radius * radius) {
        const idx = (y * width + x) * 4;
        rgba[idx + 0] = greenR;
        rgba[idx + 1] = greenG;
        rgba[idx + 2] = greenB;
        rgba[idx + 3] = 255;
      }
    }
  }
}

/** Draw green rim (3px darker ring at edge). */
function drawGreenRim(
  rgba: Uint8Array,
  width: number,
  height: number,
  center: Pt,
  radius: number
): void {
  const rimR = 100,
    rimG = 130,
    rimB = 70; // darker
  const rimWidth = 3;

  const minX = Math.max(0, Math.floor(center.x - radius));
  const maxX = Math.min(width, Math.ceil(center.x + radius));
  const minY = Math.max(0, Math.floor(center.y - radius));
  const maxY = Math.min(height, Math.ceil(center.y + radius));

  const innerRadius = radius - rimWidth;

  for (let y = minY; y < maxY; y++) {
    for (let x = minX; x < maxX; x++) {
      const dx = x - center.x;
      const dy = y - center.y;
      const dist2 = dx * dx + dy * dy;

      if (dist2 >= innerRadius * innerRadius && dist2 <= radius * radius) {
        const idx = (y * width + x) * 4;
        rgba[idx + 0] = rimR;
        rgba[idx + 1] = rimG;
        rgba[idx + 2] = rimB;
        rgba[idx + 3] = 255;
      }
    }
  }
}

/** Draw tee pad as a ~34x24 tan rectangle centered on tee. */
function drawTeePad(rgba: Uint8Array, width: number, height: number, tee: Pt): void {
  const teeR = 150,
    teeG = 146,
    teeB = 120;
  const padWidth = 34,
    padHeight = 24;
  const halfW = padWidth / 2;
  const halfH = padHeight / 2;

  const x0 = Math.max(0, Math.floor(tee.x - halfW));
  const x1 = Math.min(width, Math.ceil(tee.x + halfW));
  const y0 = Math.max(0, Math.floor(tee.y - halfH));
  const y1 = Math.min(height, Math.ceil(tee.y + halfH));

  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const idx = (y * width + x) * 4;
      rgba[idx + 0] = teeR;
      rgba[idx + 1] = teeG;
      rgba[idx + 2] = teeB;
      rgba[idx + 3] = 255;
    }
  }
}

/** Draw basket as a barely-darker 6px dot. */
function drawBasketDot(
  rgba: Uint8Array,
  width: number,
  height: number,
  center: Pt
): void {
  const dotR = 100,
    dotG = 130,
    dotB = 70; // barely darker than green
  const dotRadius = 6;

  const minX = Math.max(0, Math.floor(center.x - dotRadius));
  const maxX = Math.min(width, Math.ceil(center.x + dotRadius));
  const minY = Math.max(0, Math.floor(center.y - dotRadius));
  const maxY = Math.min(height, Math.ceil(center.y + dotRadius));

  for (let y = minY; y < maxY; y++) {
    for (let x = minX; x < maxX; x++) {
      const dx = x - center.x;
      const dy = y - center.y;
      const dist2 = dx * dx + dy * dy;

      if (dist2 <= dotRadius * dotRadius) {
        const idx = (y * width + x) * 4;
        rgba[idx + 0] = dotR;
        rgba[idx + 1] = dotG;
        rgba[idx + 2] = dotB;
        rgba[idx + 3] = 255;
      }
    }
  }
}
