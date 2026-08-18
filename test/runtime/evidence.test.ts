// The observational evidence API must round-trip geometry into the trace and must never affect
// what the pipeline decided (no elements/checks/kept flags change), and it must validate its
// stage/entity references.
import { describe, it, expect } from 'vitest';
import {
  startTrace, finishTrace, enterStage, spawnEntities, recordEvidence,
} from '../../src/runtime/index.js';

describe('recordEvidence', () => {
  it('round-trips shapes and metadata onto the trace without touching decisions', () => {
    startTrace({ pipeline: 'demo' });
    const [holeId] = spawnEntities(1, [{ x: 10, y: 20, holeNumber: 7 }]);
    const inv = enterStage(1);
    recordEvidence({
      stageInvocationId: inv,
      entityId: holeId,
      label: 'Ribbon improvement',
      value: 236, unit: 'px', operator: 'gte', threshold: 20, decision: 'SWAP', role: 'measured',
      shapes: [
        { t: 'segment', x1: 0, y1: 0, x2: 10, y2: 20, label: '236 px' },
        { t: 'polyline', pts: [[0, 0], [5, 5], [10, 20]] },
      ],
    });
    const trace = finishTrace();
    expect(trace.evidence).toHaveLength(1);
    const ev = trace.evidence![0];
    expect(ev).toMatchObject({ label: 'Ribbon improvement', value: 236, operator: 'gte', threshold: 20, decision: 'SWAP' });
    expect(ev.shapes[0]).toMatchObject({ t: 'segment', x2: 10, y2: 20 });
    // observational only: no elements, checks, or kept flags were created
    expect(trace.elements).toHaveLength(0);
    expect(trace.checks).toHaveLength(0);
  });

  it('deep-copies polyline points so later caller mutation cannot corrupt the trace', () => {
    startTrace({ pipeline: 'demo' });
    const inv = enterStage(1);
    const pts: Array<[number, number]> = [[1, 1], [2, 2]];
    recordEvidence({ stageInvocationId: inv, shapes: [{ t: 'polyline', pts }] });
    pts[0][0] = 999;
    const trace = finishTrace();
    const shape = trace.evidence![0].shapes[0];
    expect(shape.t === 'polyline' && shape.pts[0][0]).toBe(1);
  });

  it('rejects evidence for an unknown stage invocation', () => {
    startTrace({ pipeline: 'demo' });
    enterStage(1);
    expect(() => recordEvidence({ stageInvocationId: 999, shapes: [] })).toThrow(/unknown stage/i);
    finishTrace();
  });

  it('rejects evidence referencing an unknown entity', () => {
    startTrace({ pipeline: 'demo' });
    const inv = enterStage(1);
    expect(() => recordEvidence({ stageInvocationId: inv, entityId: 424242, shapes: [] })).toThrow(/unknown entity/i);
    finishTrace();
  });
});
