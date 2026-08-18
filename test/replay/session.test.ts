import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { openReplaySession, type RunRecord } from '../../src/replay/index.js';
import { makeFakeAdapter } from './support/fakeAdapter.js';
import type { TraceRun } from '../../src/runtime/index.js';

const dirs: string[] = [];
async function makeTempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'toph-replay-'));
  dirs.push(dir);
  return dir;
}
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('openReplaySession: baseline + replay', () => {
  it('baseline() creates a run with parentRunId null and patch null, using adapter defaults', async () => {
    const adapter = makeFakeAdapter();
    const dir = await makeTempDir();
    const session = await openReplaySession(dir, adapter);

    const run = await session.baseline();
    expect(run.parentRunId).toBeNull();
    expect(run.patch).toBeNull();
    expect(run.effectiveConfig).toEqual(adapter.defaults);
    expect(run.source).toEqual(adapter.source);
    expect(run.codeVersion).toEqual(adapter.codeVersion);
    expect(run.pipelineId).toBe(adapter.pipelineId);
    expect(adapter.calls).toEqual([adapter.defaults]);
  });

  it('baseline() is idempotent: a second call returns the same run without re-executing', async () => {
    const adapter = makeFakeAdapter();
    const dir = await makeTempDir();
    const session = await openReplaySession(dir, adapter);

    const first = await session.baseline();
    const second = await session.baseline();
    expect(second).toEqual(first);
    expect(adapter.calls).toHaveLength(1);
  });

  it('baseline() is idempotent across a fresh session opened on the same dir', async () => {
    const adapter = makeFakeAdapter();
    const dir = await makeTempDir();
    const first = await (await openReplaySession(dir, adapter)).baseline();

    const adapter2 = makeFakeAdapter();
    const reopened = await openReplaySession(dir, adapter2);
    const second = await reopened.baseline();
    expect(second).toEqual(first);
    expect(adapter2.calls).toHaveLength(0);
  });

  it('replay(parent, patch) computes effectiveConfig from the parent, records patch/parentRunId, and calls the adapter with the materialized config', async () => {
    const adapter = makeFakeAdapter();
    const dir = await makeTempDir();
    const session = await openReplaySession(dir, adapter);

    const baseline = await session.baseline();
    const patch = { 'p6.swap.enabled': false };
    const child = await session.replay(baseline.runId, patch, 'swap off');

    expect(child.parentRunId).toBe(baseline.runId);
    expect(child.patch).toEqual(patch);
    expect(child.label).toBe('swap off');
    expect(child.effectiveConfig).toEqual({
      p6: { swap: { enabled: false, minRibbonImprovementPx: 20 }, forwardGateAngleDeg: 80 },
    });
    expect(child.source).toEqual(adapter.source);
    expect(child.codeVersion).toEqual(adapter.codeVersion);
    expect(adapter.calls[1]).toEqual(child.effectiveConfig);
  });

  it('replay() chains: a grandchild patch applies on top of the materialized parent config', async () => {
    const adapter = makeFakeAdapter();
    const dir = await makeTempDir();
    const session = await openReplaySession(dir, adapter);

    const baseline = await session.baseline();
    const child = await session.replay(baseline.runId, { 'p6.swap.enabled': false });
    const grandchild = await session.replay(child.runId, { 'p6.forwardGateAngleDeg': 45 });

    expect(grandchild.effectiveConfig).toEqual({
      p6: { swap: { enabled: false, minRibbonImprovementPx: 20 }, forwardGateAngleDeg: 45 },
    });
    expect(grandchild.parentRunId).toBe(child.runId);
  });
});

describe('child trace independence', () => {
  it('mutating adapter output after replay() resolves does not alter the persisted trace', async () => {
    const trace: TraceRun = {
      version: 1,
      stages: [{ invocationId: 1, stageId: 10, seq: 0 }],
      elements: [{ id: 1, stageInvocationId: 1, ordinal: 0, kept: true }],
      checks: [],
    };
    const adapter = makeFakeAdapter({ buildTrace: () => trace, buildSummary: () => ({ holes: 5 }) });
    const dir = await makeTempDir();
    const session = await openReplaySession(dir, adapter);

    const baseline = await session.baseline();

    // Mutate the objects the adapter handed back (both the shared fixture and the
    // returned RunRecord) after the fact.
    trace.elements[0].kept = false;
    trace.stages.push({ invocationId: 2, stageId: 99, seq: 0 });
    (baseline.summary as Record<string, unknown>).holes = 999;
    (baseline.effectiveConfig as Record<string, unknown>).p6 = 'tampered';

    const reloaded = await session.loadTrace(baseline.runId);
    expect(reloaded.elements[0].kept).toBe(true);
    expect(reloaded.stages).toHaveLength(1);

    const rawRun = JSON.parse(
      await readFile(join(dir, 'runs', baseline.runId, 'run.json'), 'utf8')
    ) as RunRecord;
    expect(rawRun.summary.holes).toBe(5);
    expect((rawRun.effectiveConfig as Record<string, unknown>).p6).not.toBe('tampered');
  });
});

describe('run store round-trip', () => {
  it('writes session.json, run.json, trace.json, final.json, labelmaps.json, and assets, all reloadable', async () => {
    const trace: TraceRun = { version: 1, stages: [], elements: [], checks: [] };
    const adapter = makeFakeAdapter({
      buildTrace: () => trace,
      buildSummary: () => ({ wallMs: 1 }),
    });
    adapter.execute = async (effectiveConfig: object) => {
      adapter.calls.push(structuredClone(effectiveConfig));
      return {
        trace,
        summary: { wallMs: 1 },
        manifest: { stages: [] },
        labelmaps: [{ id: 'lm1' }],
        final: { winner: 'basket-3' },
        assets: [
          {
            asset: { id: 1, name: 'p6 mask', kind: 'mask', widthPx: 2, heightPx: 1 },
            bytes: new Uint8Array([1, 2]),
          },
        ],
      };
    };

    const dir = await makeTempDir();
    const session = await openReplaySession(dir, adapter);
    const run = await session.baseline();

    const runDir = join(dir, 'runs', run.runId);
    const sessionOnDisk = JSON.parse(await readFile(join(dir, 'session.json'), 'utf8'));
    expect(sessionOnDisk.runIds).toEqual([run.runId]);
    expect(sessionOnDisk.pipelineId).toBe(adapter.pipelineId);
    expect(sessionOnDisk.paramSchema).toEqual(adapter.paramSchema);

    const runOnDisk = JSON.parse(await readFile(join(runDir, 'run.json'), 'utf8'));
    expect(runOnDisk.runId).toBe(run.runId);

    expect(await session.loadTrace(run.runId)).toEqual(trace);
    expect(await session.loadFinal(run.runId)).toEqual({ winner: 'basket-3' });
    expect(await session.loadManifest(run.runId)).toEqual({ stages: [] });
    expect(await session.loadLabelmaps(run.runId)).toEqual([{ id: 'lm1' }]);

    const assetIndex = JSON.parse(await readFile(join(runDir, 'assets', 'index.json'), 'utf8'));
    expect(assetIndex).toEqual([{ id: 1, name: 'p6 mask', kind: 'mask', widthPx: 2, heightPx: 1, file: '0001-p6-mask.bin' }]);
    const assetBytes = await readFile(join(runDir, 'assets', '0001-p6-mask.bin'));
    expect([...assetBytes]).toEqual([1, 2]);
  });

  it('list() returns every run written so far, freshly cloned', async () => {
    const adapter = makeFakeAdapter();
    const dir = await makeTempDir();
    const session = await openReplaySession(dir, adapter);

    const baseline = await session.baseline();
    const child = await session.replay(baseline.runId, { 'p6.swap.enabled': false });

    const runs = session.list();
    expect(runs.map((r) => r.runId).sort()).toEqual([baseline.runId, child.runId].sort());

    // Mutating the returned list must not affect the session's internal state.
    (runs[0] as { summary: unknown }).summary = 'tampered';
    const runsAgain = session.list();
    expect(runsAgain.every((r) => (r.summary as unknown) !== 'tampered')).toBe(true);
  });

  it('runs are immutable: no API exposes a way to modify an existing run directory', async () => {
    const adapter = makeFakeAdapter();
    const dir = await makeTempDir();
    const session = await openReplaySession(dir, adapter);
    const run = await session.baseline();

    const keys = Object.keys(session);
    expect(keys).toEqual(expect.arrayContaining(['baseline', 'replay', 'grid', 'list', 'loadTrace', 'loadFinal']));
    expect(keys.some((k) => /update|mutate|delete|write|save/i.test(k))).toBe(false);

    // Replaying again against the same parent creates a new sibling run, not an edit.
    const again = await session.replay(run.runId, { 'p6.swap.enabled': false });
    const alsoAgain = await session.replay(run.runId, { 'p6.swap.enabled': false });
    expect(again.runId).not.toBe(alsoAgain.runId);
  });

  it('replay() against an unknown parent run id throws', async () => {
    const adapter = makeFakeAdapter();
    const dir = await makeTempDir();
    const session = await openReplaySession(dir, adapter);
    await expect(session.replay('does-not-exist', {})).rejects.toThrow();
  });
});
