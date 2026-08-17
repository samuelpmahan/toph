import { describe, expect, it } from 'vitest';
import { compareValidationMetrics, type ValidationMetrics } from '../../src/evaluation/compare.js';

const baseline: ValidationMetrics = {
  corresponded: 15,
  stages: [
    { stage: 'p1.tee.prefilter', reached: 15, kept: 14 },
    { stage: 'p1.tee.geometry', reached: 14, kept: 0 },
  ],
  outputDigest: 'same-output',
};

describe('compareValidationMetrics', () => {
  it('passes exact parity', () => {
    const result = compareValidationMetrics(baseline, baseline, { requireOutputParity: true });
    expect(result.pass).toBe(true);
    expect(result.regressions).toEqual([]);
    expect(result.improvements).toEqual([]);
    expect(result.deltas.every((entry) => entry.delta === 0)).toBe(true);
  });

  it('fails correspondence and stage regressions by default', () => {
    const result = compareValidationMetrics(baseline, {
      ...baseline, corresponded: 14,
      stages: [
        { stage: 'p1.tee.prefilter', reached: 14, kept: 13 },
        { stage: 'p1.tee.geometry', reached: 13, kept: 0 },
      ],
    });
    expect(result.pass).toBe(false);
    expect(result.regressions).toEqual(expect.arrayContaining([
      'corresponded lost 1 (allowed 0)',
      'p1.tee.prefilter kept lost 1 (allowed 0)',
    ]));
  });

  it('allows explicit tolerance while reporting improvements', () => {
    const result = compareValidationMetrics(baseline, {
      corresponded: 16,
      stages: [
        { stage: 'p1.tee.prefilter', reached: 16, kept: 15 },
        { stage: 'p1.tee.geometry', reached: 15, kept: 1 },
      ],
      outputDigest: 'candidate-output',
    }, { maxCorrespondenceRegression: 1, maxStageRegression: 1 });
    expect(result.pass).toBe(true);
    expect(result.regressions).toEqual([]);
    expect(result.improvements).toEqual(expect.arrayContaining([
      'corresponded gained 1',
      'p1.tee.prefilter kept gained 1',
      'p1.tee.geometry kept gained 1',
    ]));
  });

  it('fails required output parity for changed or missing digests', () => {
    expect(compareValidationMetrics(baseline, { ...baseline, outputDigest: 'changed' }, { requireOutputParity: true }).regressions).toContain('pipeline output digest differs');
    expect(compareValidationMetrics(baseline, { ...baseline, outputDigest: undefined }, { requireOutputParity: true }).regressions).toContain('output parity requested but a digest is missing');
  });

  it('reports missing stages as regressions and added stages as improvements', () => {
    const result = compareValidationMetrics(baseline, {
      corresponded: 15,
      stages: [
        { stage: 'p1.tee.prefilter', reached: 15, kept: 14 },
        { stage: 'p1.tee.appearance', reached: 14, kept: 10 },
      ],
    });
    expect(result.pass).toBe(false);
    expect(result.regressions).toContain('stage p1.tee.geometry is missing from candidate');
    expect(result.improvements).toContain('new stage p1.tee.appearance observed');
  });
});
