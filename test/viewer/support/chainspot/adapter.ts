// ChainSpot "pancake" replay adapter used as the Toph viewer acceptance fixture. It runs a
// faithful-shape disc-golf hole/tee/basket pipeline against SCENE (see scene.ts) and records a
// real Toph trace: entities, per-stage measures + checks, assigned/reassigned dataflow, a
// component labelmap for mask review, and -- crucially -- observational EVIDENCE geometry so the
// viewer can draw the literal pixels/geometry each measurement was computed from. Every measured
// value is derived from the same coordinates the source image is drawn from, so the evidence on
// the raster always agrees with the numbers beside it.
//
// The scenario is the canonical Rec H7/H8 basket swap: p6.lowParAssignment mis-assigns baskets
// (its low-par table has holes 7 and 8 transposed); p6.swapAdjudication measures each basket's
// offset from each hole's tee->green fairway ribbon and swaps them back when the total offset
// improves by at least the configured minimum.

import {
  finishTrace,
  recordDataflow,
  recordEvidence,
  recordMeasure,
  spawnEntities,
  startTrace,
  enterStage,
  enterElement,
  gte,
  lte,
  keep,
  type EvidenceShape,
  type TraceRun,
} from '../../../../src/runtime/index.js';
import type { AdapterRunOutput, ParamSpec, ReplayAdapter, SourceIdentity } from '../../../../src/replay/index.js';
import {
  SCENE,
  forwardGateAngleDeg,
  holeByNumber,
  perpendicularToRibbon,
  ribbonOffsetPx,
  round1,
  type BasketScene,
  type Scene,
} from './scene.js';

const KIND_HOLE = 1;
const KIND_TEE = 2;
const KIND_BASKET = 3;

const CHECK_BASKET_AREA = 1;
const CHECK_FORWARD_GATE = 2;
const CHECK_RIBBON_IMPROVEMENT = 3;

const MASK_ASSET_ID = 1;
const MIN_BASKET_AREA_PX = 900;

export interface PancakeConfig {
  p6: {
    swap: { enabled: boolean; minRibbonImprovementPx: number };
    forwardGateAngleDeg: number;
  };
}

export const PANCAKE_DEFAULTS: PancakeConfig = {
  p6: { swap: { enabled: true, minRibbonImprovementPx: 20 }, forwardGateAngleDeg: 80 },
};

export const PANCAKE_PARAM_SCHEMA: readonly ParamSpec[] = [
  { path: 'p6.swap.enabled', label: 'P6.2 swap adjudication enabled', type: 'boolean', default: true },
  { path: 'p6.swap.minRibbonImprovementPx', label: 'P6.2 minimum ribbon improvement (px)', type: 'number', default: 20, min: 0, max: 400, step: 5 },
  { path: 'p6.forwardGateAngleDeg', label: 'P6.1 forward gate angle (deg)', type: 'number', default: 80, min: 0, max: 180, step: 5 },
];

export const PANCAKE_MANIFEST = {
  pipelineId: 'chainspot.pancake',
  stages: [
    { id: 1, name: 'p1.rawObjectMask' },
    { id: 2, name: 'p2.holeNumbers' },
    { id: 3, name: 'p3.teePads' },
    { id: 4, name: 'p4.basketDetect' },
    { id: 5, name: 'p5.candidateLink' },
    { id: 6, name: 'p6.lowParAssignment' },
    { id: 7, name: 'p6.swapAdjudication' },
  ],
  entityKinds: [
    { id: KIND_HOLE, name: 'Hole' },
    { id: KIND_TEE, name: 'Tee' },
    { id: KIND_BASKET, name: 'Basket' },
  ],
  checks: [
    { id: CHECK_BASKET_AREA, code: 'basket.area.min', label: 'Basket area' },
    { id: CHECK_FORWARD_GATE, code: 'p6.1.forward.gate', label: 'Forward gate angle' },
    { id: CHECK_RIBBON_IMPROVEMENT, code: 'p6.2.ribbon.improvement', label: 'Ribbon improvement' },
  ],
  summaryLabels: {
    wallMs: 'Wall time (ms)',
    holes: 'Holes',
    baskets: 'Baskets',
    assignedByLowPar: 'Assigned by low-par (P6.1)',
    swapsApplied: 'Swaps applied (P6.2)',
    changedHoles: 'Holes changed by swap',
    unresolved: 'Unresolved (off-ribbon)',
  },
};

function getAtPath(root: object, path: string): unknown {
  return path.split('.').reduce<unknown>((cursor, key) => {
    if (cursor === null || typeof cursor !== 'object') return undefined;
    return (cursor as Record<string, unknown>)[key];
  }, root);
}

function angleDeg(fromX: number, fromY: number, toX: number, toY: number): number {
  return (Math.atan2(toY - fromY, toX - fromX) * 180) / Math.PI;
}

/** [value, runLength] RLE labelmap where each drawn mask disc/pad becomes its own component. */
function buildLabelmap(scene: Scene, holeIds: number[], basketIds: number[]): unknown {
  const w = scene.widthPx;
  const h = scene.heightPx;
  // Component label -> entity id. label 1..N in the order we test pixels below.
  const components: Array<{ entityId: number; test: (x: number, y: number) => boolean }> = [];
  scene.baskets.forEach((b, i) => {
    const r2 = b.radius * b.radius;
    components.push({ entityId: basketIds[i], test: (x, y) => (x - b.center.x) ** 2 + (y - b.center.y) ** 2 <= r2 });
  });
  scene.holes.forEach((hole, i) => {
    const r2 = hole.greenRadius * hole.greenRadius;
    components.push({ entityId: holeIds[i], test: (x, y) => (x - hole.green.x) ** 2 + (y - hole.green.y) ** 2 <= r2 });
  });
  const entityIds = components.map((c) => c.entityId);

  const runs: Array<[number, number]> = [];
  let runValue = -1;
  let runLen = 0;
  const pushRun = (value: number): void => {
    if (value === runValue) {
      runLen += 1;
      return;
    }
    if (runLen > 0) runs.push([runValue, runLen]);
    runValue = value;
    runLen = 1;
  };
  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      let label = 0;
      for (let c = 0; c < components.length; c += 1) {
        if (components[c].test(x, y)) {
          label = c + 1;
          break;
        }
      }
      pushRun(label);
    }
  }
  if (runLen > 0) runs.push([runValue, runLen]);

  return { assetId: MASK_ASSET_ID, widthPx: w, heightPx: h, encoding: 'rle', space: 'source', entityIds, runs };
}

/** Builds one deterministic pancake run trace + outputs from a scene and effective config. */
export function buildPancakeRun(scene: Scene, effectiveConfig: object): AdapterRunOutput {
  const swapEnabled = Boolean(getAtPath(effectiveConfig, 'p6.swap.enabled'));
  const minImprovementPx = Number(getAtPath(effectiveConfig, 'p6.swap.minRibbonImprovementPx'));
  const gateDeg = Number(getAtPath(effectiveConfig, 'p6.forwardGateAngleDeg'));

  startTrace({ pipeline: 'chainspot.pancake' });
  try {
    // Entities. Holes are marked at their green (the target/basket area); tees at the tee pad.
    const holeRefs = scene.holes.map((hole) => ({
      x: hole.green.x,
      y: hole.green.y,
      holeNumber: hole.holeNumber,
      par: hole.par,
      greenRadiusPx: hole.greenRadius,
    }));
    const teeRefs = scene.holes.map((hole) => ({ x: hole.tee.x, y: hole.tee.y, holeNumber: hole.holeNumber }));
    const basketRefs = scene.baskets.map((b) => ({ x: b.center.x, y: b.center.y, candidate: b.candidate, radiusPx: b.radius }));

    const holeIds = spawnEntities(KIND_HOLE, holeRefs);
    const teeIds = spawnEntities(KIND_TEE, teeRefs);
    const basketIds = spawnEntities(KIND_BASKET, basketRefs);
    const holeIdByNumber = new Map(scene.holes.map((hole, i) => [hole.holeNumber, holeIds[i]]));

    // p1.rawObjectMask: the mask/components everything downstream is measured on.
    const inv1 = enterStage(1);
    let maskPx = 0;
    for (const b of scene.baskets) maskPx += Math.round(Math.PI * b.radius * b.radius);
    for (const hole of scene.holes) maskPx += Math.round(Math.PI * hole.greenRadius * hole.greenRadius);
    recordMeasure(inv1, 'maskForegroundPx', maskPx, 'px');
    scene.baskets.forEach((b, i) => {
      recordEvidence({
        stageInvocationId: inv1,
        entityId: basketIds[i],
        label: 'Basket mask component',
        measure: 'componentAreaPx',
        value: Math.round(Math.PI * b.radius * b.radius),
        unit: 'px',
        role: 'measured',
        shapes: [{ t: 'component', assetId: MASK_ASSET_ID, label: i + 1 }],
      });
    });

    // p2.holeNumbers: how many holes were numbered.
    const inv2 = enterStage(2);
    recordMeasure(inv2, 'holes', scene.holes.length);

    // p3.teePads: locate each tee pad (drawn as a bbox on the raster).
    const inv3 = enterStage(3);
    scene.holes.forEach((hole, i) => {
      recordEvidence({
        stageInvocationId: inv3,
        entityId: teeIds[i],
        label: `Tee pad (hole ${hole.holeNumber})`,
        role: 'measured',
        shapes: [{ t: 'bbox', x: hole.tee.x - 17, y: hole.tee.y - 12, w: 34, h: 24, label: 'tee pad' }],
      });
    });

    // p4.basketDetect: detect baskets, checking each blob's area against a minimum.
    const inv4 = enterStage(4);
    scene.baskets.forEach((b, i) => {
      const areaPx = Math.round(Math.PI * b.radius * b.radius);
      const el = enterElement(inv4, basketRefs[i]);
      const pass = gte(el, CHECK_BASKET_AREA, areaPx, MIN_BASKET_AREA_PX);
      if (pass) keep(el);
      recordMeasure(inv4, 'basketAreaPx', areaPx, 'px');
      recordEvidence({
        stageInvocationId: inv4,
        entityId: basketIds[i],
        label: 'Basket area',
        checkId: CHECK_BASKET_AREA,
        value: areaPx,
        unit: 'px',
        operator: 'gte',
        threshold: MIN_BASKET_AREA_PX,
        decision: pass ? 'DETECTED' : 'REJECTED',
        role: 'measured',
        shapes: [
          { t: 'circle', x: b.center.x, y: b.center.y, r: b.radius },
          { t: 'bbox', x: b.center.x - b.radius, y: b.center.y - b.radius, w: b.radius * 2, h: b.radius * 2 },
        ],
      });
    });

    // p5.candidateLink: candidates linked to numbered holes.
    const inv5 = enterStage(5);
    recordMeasure(inv5, 'candidates', scene.baskets.length);

    // p6.lowParAssignment (P6.1): initial assignment from the low-par table (7/8 transposed).
    const inv6 = enterStage(6);
    scene.baskets.forEach((b, i) => {
      const holeId = holeIdByNumber.get(b.initialHole)!;
      recordDataflow({ t: 'relate', stage: inv6, left: basketIds[i], right: holeId, relation: 'assigned' });
      const hole = holeByNumber(scene, b.initialHole);
      const angle = round1(forwardGateAngleDeg(scene, b, b.initialHole));
      const el = enterElement(inv6, basketRefs[i]);
      const pass = lte(el, CHECK_FORWARD_GATE, angle, gateDeg);
      recordMeasure(inv6, 'forwardGateAngleDeg', angle, 'deg');
      recordEvidence({
        stageInvocationId: inv6,
        entityId: basketIds[i],
        label: 'Forward gate angle',
        checkId: CHECK_FORWARD_GATE,
        value: angle,
        unit: 'deg',
        operator: 'lte',
        threshold: gateDeg,
        decision: pass ? 'PASS' : 'FAIL',
        role: 'current',
        shapes: [
          {
            t: 'angle',
            x: hole.tee.x,
            y: hole.tee.y,
            fromDeg: angleDeg(hole.tee.x, hole.tee.y, hole.green.x, hole.green.y),
            toDeg: angleDeg(hole.tee.x, hole.tee.y, b.center.x, b.center.y),
            radius: 120,
            label: `${angle}°`,
          },
          { t: 'segment', x1: b.center.x, y1: b.center.y, x2: hole.green.x, y2: hole.green.y, label: 'assigned (P6.1)' },
        ],
      });
    });

    // p6.swapAdjudication (P6.2): measure ribbon offsets; swap when total improvement clears the bar.
    const inv7 = enterStage(7);
    const currentCost = scene.baskets.reduce((sum, b) => sum + ribbonOffsetPx(scene, b, b.initialHole), 0);
    const swappedCost = scene.baskets.reduce((sum, b) => sum + ribbonOffsetPx(scene, b, b.trueHole), 0);
    const improvement = currentCost - swappedCost;
    const doSwap = swapEnabled && improvement >= minImprovementPx;

    recordMeasure(inv7, 'ribbonCurrentPx', round1(currentCost), 'px');
    recordMeasure(inv7, 'ribbonSwappedPx', round1(swappedCost), 'px');
    recordMeasure(inv7, 'ribbonImprovementPx', round1(improvement), 'px');

    // Per-basket ribbon evidence: the exact nearest-offset segment to the current vs proposed
    // hole's fairway ribbon, plus that ribbon centerline.
    scene.baskets.forEach((b, i) => {
      const cur = holeByNumber(scene, b.initialHole);
      const prop = holeByNumber(scene, b.trueHole);
      const curFoot = perpendicularToRibbon(b.center, cur.tee, cur.green);
      const propFoot = perpendicularToRibbon(b.center, prop.tee, prop.green);
      recordEvidence({
        stageInvocationId: inv7,
        entityId: basketIds[i],
        label: `Ribbon offset — current (hole ${b.initialHole})`,
        value: round1(curFoot.distance),
        unit: 'px',
        role: 'current',
        shapes: [
          { t: 'polyline', pts: [[cur.tee.x, cur.tee.y], [cur.green.x, cur.green.y]], label: `hole ${b.initialHole} ribbon` },
          { t: 'segment', x1: b.center.x, y1: b.center.y, x2: round1(curFoot.foot.x), y2: round1(curFoot.foot.y), label: `${round1(curFoot.distance)} px` },
        ],
      });
      recordEvidence({
        stageInvocationId: inv7,
        entityId: basketIds[i],
        label: `Ribbon offset — proposed (hole ${b.trueHole})`,
        value: round1(propFoot.distance),
        unit: 'px',
        role: 'proposed',
        shapes: [
          { t: 'polyline', pts: [[prop.tee.x, prop.tee.y], [prop.green.x, prop.green.y]], label: `hole ${b.trueHole} ribbon` },
          { t: 'segment', x1: b.center.x, y1: b.center.y, x2: round1(propFoot.foot.x), y2: round1(propFoot.foot.y), label: `${round1(propFoot.distance)} px` },
        ],
      });
    });

    // The headline decision: total ribbon improvement vs the minimum, and the resulting swap.
    const decisionEl = enterElement(inv7, basketRefs[0]);
    const decisionPass = gte(decisionEl, CHECK_RIBBON_IMPROVEMENT, round1(improvement), minImprovementPx);
    const swapShapes: EvidenceShape[] = [];
    scene.baskets.forEach((b) => {
      const prop = holeByNumber(scene, b.trueHole);
      swapShapes.push({ t: 'segment', x1: b.center.x, y1: b.center.y, x2: prop.green.x, y2: prop.green.y, label: 'reassigned' });
    });
    recordEvidence({
      stageInvocationId: inv7,
      entityId: basketIds[0],
      label: 'Ribbon improvement',
      checkId: CHECK_RIBBON_IMPROVEMENT,
      value: round1(improvement),
      unit: 'px',
      operator: 'gte',
      threshold: minImprovementPx,
      decision: doSwap ? 'SWAP' : decisionPass ? 'SWAP' : 'KEEP',
      role: 'measured',
      shapes: swapShapes,
    });

    if (doSwap) {
      scene.baskets.forEach((b, i) => {
        const holeId = holeIdByNumber.get(b.trueHole)!;
        recordDataflow({ t: 'relate', stage: inv7, left: basketIds[i], right: holeId, relation: 'reassigned' });
      });
    }

    const trace: TraceRun = finishTrace();
    const labelmaps = [buildLabelmap(scene, holeIds, basketIds)];

    const unresolved = scene.baskets.filter((b: BasketScene) => {
      const finalHole = doSwap ? b.trueHole : b.initialHole;
      return ribbonOffsetPx(scene, b, finalHole) > 120;
    }).length;
    const changedHoles = doSwap ? scene.baskets.map((b) => b.trueHole).sort((a, z) => a - z).join(',') : '';

    const summary: Record<string, number | string | boolean | null> = {
      wallMs: 6009,
      holes: scene.holes.length,
      baskets: scene.baskets.length,
      assignedByLowPar: scene.baskets.length,
      swapsApplied: doSwap ? 1 : 0,
      changedHoles,
      unresolved,
    };

    return { trace, manifest: PANCAKE_MANIFEST, labelmaps, summary };
  } catch (error) {
    // Ensure the global trace session never leaks to the next run if building throws.
    try {
      finishTrace();
    } catch {
      /* no active session */
    }
    throw error;
  }
}

export function makeChainspotPancakeAdapter(scene: Scene = SCENE): ReplayAdapter {
  const source: SourceIdentity = {
    name: 'TheRec-stitched.png',
    widthPx: scene.widthPx,
    heightPx: scene.heightPx,
  };
  return {
    pipelineId: 'chainspot.pancake',
    codeVersion: { app: 'chainspot@demo', toph: 'toph@demo' },
    source,
    defaults: structuredClone(PANCAKE_DEFAULTS),
    paramSchema: PANCAKE_PARAM_SCHEMA,
    async execute(effectiveConfig: object): Promise<AdapterRunOutput> {
      return buildPancakeRun(scene, effectiveConfig);
    },
  };
}
