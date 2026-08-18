import { describe, expect, it } from 'vitest';
import { firstDivergentStage, stagesEquivalentThrough } from '../../src/replay/index.js';
import type { TraceRun } from '../../src/runtime/index.js';

function trace(partial: Partial<TraceRun>): TraceRun {
  return { version: 1, stages: [], elements: [], checks: [], ...partial };
}

describe('firstDivergentStage', () => {
  it('returns null for two independently-built but structurally identical traces', () => {
    const build = (): TraceRun =>
      trace({
        stages: [
          { invocationId: 1, stageId: 10, seq: 0 },
          { invocationId: 2, stageId: 11, seq: 0 },
        ],
        elements: [
          { id: 1, stageInvocationId: 1, ordinal: 0, kept: true },
          { id: 2, stageInvocationId: 2, ordinal: 0, kept: false },
        ],
        checks: [{ stageInvocationId: 1, elementId: 1, checkId: 1, operator: 'gte', value: 5, threshold: 3, pass: true }],
        measures: [{ stageInvocationId: 2, name: 'candidates', value: 4 }],
      });
    expect(firstDivergentStage(build(), build())).toBeNull();
  });

  it('reports a divergence at the stageId/seq of the 3rd invocation when a check value differs there', () => {
    const shared = {
      stages: [
        { invocationId: 1, stageId: 10, seq: 0 },
        { invocationId: 2, stageId: 11, seq: 0 },
        { invocationId: 3, stageId: 12, seq: 0 },
      ],
    };
    const a = trace({
      ...shared,
      elements: [],
      checks: [
        { stageInvocationId: 1, elementId: 1, checkId: 1, operator: 'gte', value: 5, threshold: 3, pass: true },
        { stageInvocationId: 3, elementId: 3, checkId: 5, operator: 'gte', value: 20, threshold: 10, pass: true },
      ],
    });
    const b = trace({
      ...shared,
      elements: [],
      checks: [
        { stageInvocationId: 1, elementId: 1, checkId: 1, operator: 'gte', value: 5, threshold: 3, pass: true },
        { stageInvocationId: 3, elementId: 3, checkId: 5, operator: 'gte', value: 8, threshold: 10, pass: false },
      ],
    });

    const divergence = firstDivergentStage(a, b);
    expect(divergence).not.toBeNull();
    expect(divergence?.stageId).toBe(12);
    expect(divergence?.seq).toBe(0);
    expect(divergence?.reason).toMatch(/check/);
  });

  it('flags an extra invocation in one run at the first unmatched seq', () => {
    const a = trace({
      stages: [
        { invocationId: 1, stageId: 10, seq: 0 },
        { invocationId: 2, stageId: 11, seq: 0 },
        { invocationId: 3, stageId: 11, seq: 1 },
      ],
      elements: [],
      checks: [],
    });
    const b = trace({
      stages: [
        { invocationId: 1, stageId: 10, seq: 0 },
        { invocationId: 2, stageId: 11, seq: 0 },
      ],
      elements: [],
      checks: [],
    });

    const divergence = firstDivergentStage(a, b);
    expect(divergence).not.toBeNull();
    expect(divergence?.stageId).toBe(11);
    expect(divergence?.seq).toBe(1);
    expect(divergence?.reason).toMatch(/extra invocation/);
  });

  it('does not flag divergence from shifted raw entity/element ids alone when structure and values match', () => {
    const a = trace({
      stages: [{ invocationId: 1, stageId: 10, seq: 0 }],
      elements: [
        { id: 5, stageInvocationId: 1, ordinal: 0, kept: true },
        { id: 6, stageInvocationId: 1, ordinal: 1, kept: false },
      ],
      checks: [{ stageInvocationId: 1, elementId: 5, checkId: 1, operator: 'gte', value: 5, threshold: 3, pass: true }],
      entities: [
        { id: 100, kindId: 1, ordinal: 0, attrs: { x: 1 } },
        { id: 101, kindId: 1, ordinal: 1, attrs: { x: 2 } },
      ],
      dataflow: [{ t: 'select', stage: 1, kept: [100], rejected: [101], name: 'gate' }],
    });
    const b = trace({
      stages: [{ invocationId: 1, stageId: 10, seq: 0 }],
      elements: [
        // Same structure (ordinal/kept), but the raw ids are offset by a completely
        // different run's id allocation.
        { id: 55, stageInvocationId: 1, ordinal: 0, kept: true },
        { id: 56, stageInvocationId: 1, ordinal: 1, kept: false },
      ],
      checks: [{ stageInvocationId: 1, elementId: 55, checkId: 1, operator: 'gte', value: 5, threshold: 3, pass: true }],
      entities: [
        { id: 900, kindId: 1, ordinal: 0, attrs: { x: 1 } },
        { id: 901, kindId: 1, ordinal: 1, attrs: { x: 2 } },
      ],
      dataflow: [{ t: 'select', stage: 1, kept: [900], rejected: [901], name: 'gate' }],
    });

    expect(firstDivergentStage(a, b)).toBeNull();
  });

  it('stagesEquivalentThrough reports a reason for a single-invocation comparison', () => {
    const a = trace({
      stages: [{ invocationId: 1, stageId: 10, seq: 0 }],
      elements: [{ id: 1, stageInvocationId: 1, ordinal: 0, kept: true }],
      checks: [],
    });
    const b = trace({
      stages: [{ invocationId: 1, stageId: 10, seq: 0 }],
      elements: [{ id: 1, stageInvocationId: 1, ordinal: 0, kept: false }],
      checks: [],
    });
    const reason = stagesEquivalentThrough({ trace: a, invocationId: 1 }, { trace: b, invocationId: 1 });
    expect(reason).toMatch(/kept/);
  });
});
