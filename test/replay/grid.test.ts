import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { openReplaySession, type RunRecord } from '../../src/replay/index.js';
import { makeFakeAdapter } from './support/fakeAdapter.js';

const dirs: string[] = [];
async function makeTempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'toph-replay-grid-'));
  dirs.push(dir);
  return dir;
}
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

function withoutVolatileFields(run: RunRecord) {
  const { runId, createdAt, parentRunId, ...rest } = run;
  return rest;
}

describe('grid()', () => {
  it('over a 2x3 axis set produces 6 children semantically identical to 6 manual replay() calls with the same patches', async () => {
    const adapterA = makeFakeAdapter();
    const dirA = await makeTempDir();
    const sessionA = await openReplaySession(dirA, adapterA);
    const baselineA = await sessionA.baseline();

    const axes = {
      'p6.swap.enabled': [true, false],
      'p6.forwardGateAngleDeg': [60, 80, 100],
    };
    const gridRuns = await sessionA.grid(baselineA.runId, axes);
    expect(gridRuns).toHaveLength(6);

    // Reconstruct the exact patches grid() must have used (cartesian product, same
    // nesting order grid() builds them in) and replay each manually against a second,
    // independent session driven off an identically-configured adapter.
    const expectedPatches: Array<Record<string, unknown>> = [];
    for (const enabled of axes['p6.swap.enabled']) {
      for (const angle of axes['p6.forwardGateAngleDeg']) {
        expectedPatches.push({ 'p6.swap.enabled': enabled, 'p6.forwardGateAngleDeg': angle });
      }
    }

    const adapterB = makeFakeAdapter();
    const dirB = await makeTempDir();
    const sessionB = await openReplaySession(dirB, adapterB);
    const baselineB = await sessionB.baseline();
    const manualRuns = [];
    for (const patch of expectedPatches) {
      manualRuns.push(await sessionB.replay(baselineB.runId, patch));
    }

    expect(gridRuns.map((r) => r.patch)).toEqual(expectedPatches);
    expect(gridRuns.map(withoutVolatileFields)).toEqual(manualRuns.map(withoutVolatileFields));

    // Every grid child is a proper child of the grid baseline.
    for (const run of gridRuns) expect(run.parentRunId).toBe(baselineA.runId);

    // All 6 runIds are distinct and all 6 configs were actually executed.
    expect(new Set(gridRuns.map((r) => r.runId)).size).toBe(6);
    expect(adapterA.calls).toHaveLength(1 + 6); // baseline + 6 grid children
  });

  it('grid patches with a single axis produce one child per value', async () => {
    const adapter = makeFakeAdapter();
    const dir = await makeTempDir();
    const session = await openReplaySession(dir, adapter);
    const baseline = await session.baseline();

    const runs = await session.grid(baseline.runId, { 'p6.forwardGateAngleDeg': [10, 20, 30] });
    expect(runs).toHaveLength(3);
    expect(runs.map((r) => (r.effectiveConfig as { p6: { forwardGateAngleDeg: number } }).p6.forwardGateAngleDeg)).toEqual([10, 20, 30]);
  });
});
