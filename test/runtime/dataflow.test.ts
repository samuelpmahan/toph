import { beforeEach, describe, expect, it } from 'vitest';
import * as toph from '../../src/runtime/index.js';

beforeEach(() => {
  try { toph.finishTrace(); } catch { /* no active session */ }
});

describe('recordDataflow', () => {
  it('records the generic lineage and relationship algebra without wrapping collections', () => {
    toph.startTrace();
    const stage = toph.enterStage(10);
    const a = {}, b = {}, c = {}, d = {}, e = {};
    const [aId, bId, cId, dId, eId] = toph.spawnEntities(1, [a, b, c, d, e]);
    toph.recordDataflow({ t: 'map', stage, parents: [aId], children: [bId] });
    toph.recordDataflow({ t: 'split', stage, parent: bId, children: [cId, dId] });
    toph.recordDataflow({ t: 'merge', stage, parents: [cId, dId], child: eId, rep: cId });
    toph.recordDataflow({ t: 'reduce', stage, inputs: [aId, bId], result: 'winner', output: eId });
    toph.recordDataflow({ t: 'relate', stage, left: aId, right: eId, join: eId, relation: 'supports' });
    const run = toph.finishTrace();
    expect(run.dataflow).toEqual([
      { t: 'map', stage, parents: [aId], children: [bId] },
      { t: 'split', stage, parent: bId, children: [cId, dId] },
      { t: 'merge', stage, parents: [cId, dId], child: eId, rep: cId },
      { t: 'reduce', stage, inputs: [aId, bId], result: 'winner', output: eId },
      { t: 'relate', stage, left: aId, right: eId, join: eId, relation: 'supports' },
    ]);
  });

  it('allows a scalar-only reduce result without an entity output', () => {
    toph.startTrace();
    const stage = toph.enterStage(12);
    const [input] = toph.spawnEntities(1, [{}]);
    toph.recordDataflow({ t: 'reduce', stage, inputs: [input], result: 42 });
    expect(toph.finishTrace().dataflow).toEqual([
      { t: 'reduce', stage, inputs: [input], result: 42 },
    ]);
  });

  it('records rank, select, and suppress facts', () => {
    toph.startTrace();
    const stage = toph.enterStage(11);
    const ids = toph.spawnEntities(1, [{}, {}, {}]);
    toph.recordDataflow({ t: 'rank', stage, entity: ids[0], rank: 1, cutoff: 2 });
    toph.recordDataflow({ t: 'select', stage, kept: [ids[0]], rejected: [ids[1], ids[2]], name: 'topK' });
    toph.recordDataflow({ t: 'suppress', stage, entity: ids[2], by: ids[0] });
    expect(toph.finishTrace().dataflow).toEqual([
      { t: 'rank', stage, entity: ids[0], rank: 1, cutoff: 2 },
      { t: 'select', stage, kept: [ids[0]], rejected: [ids[1], ids[2]], name: 'topK' },
      { t: 'suppress', stage, entity: ids[2], by: ids[0] },
    ]);
  });

  it('rejects unknown entity and stage ids and omits dataflow on untouched traces', () => {
    toph.startTrace();
    expect(toph.finishTrace()).toEqual({ version: 1, stages: [], elements: [], checks: [] });
    toph.startTrace();
    const stage = toph.enterStage(1);
    expect(() => toph.recordDataflow({ t: 'map', stage, parents: [99], children: [99] })).toThrow();
    const [id] = toph.spawnEntities(1, [{}]);
    expect(() => toph.recordDataflow({ t: 'rank', stage: 99, entity: id, rank: 1 })).toThrow();
    toph.finishTrace();
  });
});
