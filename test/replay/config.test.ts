import { describe, expect, it } from 'vitest';
import { applyConfigPatch, diffConfig, diffSummaries } from '../../src/replay/index.js';

describe('applyConfigPatch', () => {
  it('is pure: the base object is never mutated', () => {
    const base = { p6: { swap: { enabled: true, minRibbonImprovementPx: 20 } } };
    const baseSnapshot = structuredClone(base);
    applyConfigPatch(base, { 'p6.swap.enabled': false });
    expect(base).toEqual(baseSnapshot);
  });

  it('returns a new object, not the same reference or a shallow copy', () => {
    const base = { p6: { swap: { enabled: true } } };
    const result = applyConfigPatch(base, { 'p6.swap.enabled': false }) as typeof base;
    expect(result).not.toBe(base);
    expect(result.p6).not.toBe(base.p6);
    expect(result.p6.swap).not.toBe(base.p6.swap);
  });

  it('sets nested dot-paths, creating missing intermediate objects', () => {
    const base = { p6: { forwardGateAngleDeg: 80 } };
    const result = applyConfigPatch(base, {
      'p6.swap.enabled': false,
      'p6.swap.minRibbonImprovementPx': 30,
    }) as { p6: { forwardGateAngleDeg: number; swap: { enabled: boolean; minRibbonImprovementPx: number } } };
    expect(result).toEqual({
      p6: { forwardGateAngleDeg: 80, swap: { enabled: false, minRibbonImprovementPx: 30 } },
    });
  });

  it('overwrites an existing leaf without disturbing sibling keys', () => {
    const base = { p6: { forwardGateAngleDeg: 80, swap: { enabled: true, minRibbonImprovementPx: 20 } } };
    const result = applyConfigPatch(base, { 'p6.forwardGateAngleDeg': 45 }) as typeof base;
    expect(result.p6.forwardGateAngleDeg).toBe(45);
    expect(result.p6.swap).toEqual({ enabled: true, minRibbonImprovementPx: 20 });
  });

  it('applies patches in order when multiple paths target related keys', () => {
    const base = {};
    const result = applyConfigPatch(base, { 'a.b': 1, 'a.c': 2 }) as { a: { b: number; c: number } };
    expect(result).toEqual({ a: { b: 1, c: 2 } });
  });
});

describe('diffConfig', () => {
  it('returns an empty array for identical configs', () => {
    const a = { p6: { swap: { enabled: true } } };
    const b = { p6: { swap: { enabled: true } } };
    expect(diffConfig(a, b)).toEqual([]);
  });

  it('reports every differing leaf by dot-path', () => {
    const a = { p6: { forwardGateAngleDeg: 80, swap: { enabled: true, minRibbonImprovementPx: 20 } } };
    const b = { p6: { forwardGateAngleDeg: 45, swap: { enabled: false, minRibbonImprovementPx: 20 } } };
    const diffs = diffConfig(a, b);
    expect(diffs).toEqual(
      expect.arrayContaining([
        { path: 'p6.forwardGateAngleDeg', a: 80, b: 45 },
        { path: 'p6.swap.enabled', a: true, b: false },
      ])
    );
    expect(diffs).toHaveLength(2);
  });
});

describe('diffSummaries', () => {
  it('reports changed keys only', () => {
    const a = { wallMs: 10, holes: 18, unresolved: 0 };
    const b = { wallMs: 12, holes: 18, unresolved: 1 };
    const diffs = diffSummaries(a, b);
    expect(diffs).toEqual(
      expect.arrayContaining([
        { key: 'wallMs', a: 10, b: 12 },
        { key: 'unresolved', a: 0, b: 1 },
      ])
    );
    expect(diffs).toHaveLength(2);
  });

  it('includes keys present in only one summary', () => {
    const a = { wallMs: 10 };
    const b = { wallMs: 10, holes: 18 };
    expect(diffSummaries(a, b)).toEqual([{ key: 'holes', a: undefined, b: 18 }]);
  });
});
