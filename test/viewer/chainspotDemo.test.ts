// Verifies the ChainSpot pancake acceptance fixture actually produces the canonical Rec H7/H8
// swap, records evidence geometry, and stays deterministic. If this drifts, the viewer
// acceptance screenshots are no longer meaningful.

import { describe, it, expect } from 'vitest';
import { buildPancakeRun, PANCAKE_DEFAULTS } from './support/chainspot/adapter.js';
import { SCENE } from './support/chainspot/scene.js';
import type { DataflowRelateEvent, TraceRun } from '../../src/runtime/index.js';

function withPatch(patch: Record<string, unknown>): object {
  const cfg = structuredClone(PANCAKE_DEFAULTS) as Record<string, any>;
  if ('p6.swap.minRibbonImprovementPx' in patch) cfg.p6.swap.minRibbonImprovementPx = patch['p6.swap.minRibbonImprovementPx'];
  if ('p6.swap.enabled' in patch) cfg.p6.swap.enabled = patch['p6.swap.enabled'];
  if ('p6.forwardGateAngleDeg' in patch) cfg.p6.forwardGateAngleDeg = patch['p6.forwardGateAngleDeg'];
  return cfg;
}

function relations(trace: TraceRun, relation: string): DataflowRelateEvent[] {
  return (trace.dataflow ?? []).filter(
    (e): e is DataflowRelateEvent => e.t === 'relate' && e.relation === relation
  );
}

describe('chainspot pancake fixture', () => {
  it('baseline swaps holes 7 and 8 with a real, above-threshold ribbon improvement', () => {
    const out = buildPancakeRun(SCENE, PANCAKE_DEFAULTS);
    expect(out.summary.swapsApplied).toBe(1);
    expect(out.summary.changedHoles).toBe('7,8');
    expect(out.summary.unresolved).toBe(0);

    const improvement = (out.trace.measures ?? []).find((m) => m.name === 'ribbonImprovementPx');
    expect(improvement).toBeDefined();
    expect(Number(improvement!.value)).toBeGreaterThanOrEqual(20);

    // P6.1 assigns two baskets; P6.2 reassigns both.
    expect(relations(out.trace, 'assigned')).toHaveLength(2);
    expect(relations(out.trace, 'reassigned')).toHaveLength(2);
  });

  it('records evidence geometry the raster can draw (ribbon segments + the swap decision)', () => {
    const out = buildPancakeRun(SCENE, PANCAKE_DEFAULTS);
    const ev = out.trace.evidence ?? [];
    expect(ev.length).toBeGreaterThan(0);

    const decision = ev.find((e) => e.label === 'Ribbon improvement');
    expect(decision).toBeDefined();
    expect(decision!.operator).toBe('gte');
    expect(decision!.decision).toBe('SWAP');
    expect(typeof decision!.threshold).toBe('number');

    // Every basket has both a current and a proposed ribbon-offset segment.
    const current = ev.filter((e) => e.role === 'current' && e.label?.startsWith('Ribbon offset'));
    const proposed = ev.filter((e) => e.role === 'proposed' && e.label?.startsWith('Ribbon offset'));
    expect(current).toHaveLength(SCENE.baskets.length);
    expect(proposed).toHaveLength(SCENE.baskets.length);
    // Proposed (correct-hole) offset is smaller than current (wrong-hole) offset — the swap makes sense.
    for (let i = 0; i < SCENE.baskets.length; i += 1) {
      expect(Number(proposed[i].value)).toBeLessThan(Number(current[i].value));
    }

    // Forward-gate evidence carries a real angle measurement and a threshold.
    const gate = ev.find((e) => e.label === 'Forward gate angle');
    expect(gate).toBeDefined();
    expect(gate!.unit).toBe('deg');
  });

  it('does not swap when the minimum improvement is set above the actual improvement', () => {
    const out = buildPancakeRun(SCENE, withPatch({ 'p6.swap.minRibbonImprovementPx': 400 }));
    expect(out.summary.swapsApplied).toBe(0);
    expect(out.summary.unresolved).toBe(2);
    expect(relations(out.trace, 'reassigned')).toHaveLength(0);
  });

  it('does not swap when swap adjudication is disabled', () => {
    const out = buildPancakeRun(SCENE, withPatch({ 'p6.swap.enabled': false }));
    expect(out.summary.swapsApplied).toBe(0);
    expect(relations(out.trace, 'reassigned')).toHaveLength(0);
  });

  it('is deterministic (identical trace JSON across builds)', () => {
    const a = buildPancakeRun(SCENE, PANCAKE_DEFAULTS);
    const b = buildPancakeRun(SCENE, PANCAKE_DEFAULTS);
    expect(JSON.stringify(a.trace)).toBe(JSON.stringify(b.trace));
    expect(JSON.stringify(a.summary)).toBe(JSON.stringify(b.summary));
  });
});
