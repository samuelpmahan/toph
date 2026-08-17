import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { finishTraceWithAssets, snapshotRaster, startTrace } from '../../src/runtime/index.js';
import { withTophRun } from '../../src/run/index.js';

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('withTophRun', () => {
  it('offers a filesystem-free finished bundle for browser or custom storage adapters', () => {
    startTrace({ pipeline: 'bundle' });
    snapshotRaster(3, 'mask', 'mask', new Uint8Array([9, 8]), 2, 1);
    const finished = finishTraceWithAssets();
    expect(finished.trace.pipeline).toBe('bundle');
    expect(finished.assetBytes[0].asset.id).toBe(3);
    expect([...finished.assetBytes[0].bytes]).toEqual([9, 8]);
  });

  it('persists trace metadata, supplied manifest, source map, and raster bytes', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'toph-run-'));
    dirs.push(dir);
    const run = await withTophRun(
      {
        dir,
        pipeline: 'fixture',
        manifest: { stages: [{ id: 1, name: 'stage' }] },
        sourceMap: [{ generatedFile: 'fixture.js', generatedLine: 1 }],
      },
      () => {
        snapshotRaster(7, 'bright mask', 'mask', new Uint8Array([1, 2, 3]), 3, 1);
        return 'done';
      }
    );

    expect(run.value).toBe('done');
    expect(run.result).toBe('done');
    expect(run.trace.pipeline).toBe('fixture');
    expect(JSON.parse(await readFile(join(dir, 'trace.json'), 'utf8')).pipeline).toBe('fixture');
    expect(JSON.parse(await readFile(join(dir, 'manifest.json'), 'utf8')).stages).toHaveLength(1);
    expect(JSON.parse(await readFile(join(dir, 'source-map.json'), 'utf8'))[0].generatedFile).toBe('fixture.js');
    expect(run.assetFiles).toEqual(['assets/0007-bright-mask.bin']);
    expect([...await readFile(join(dir, run.assetFiles[0]))]).toEqual([1, 2, 3]);
    expect(JSON.parse(await readFile(join(dir, 'assets/index.json'), 'utf8'))[0].widthPx).toBe(3);
  });

  it('writes the partial trace and rethrows callback failures', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'toph-run-error-'));
    dirs.push(dir);
    const failure = new Error('pipeline failed');
    await expect(withTophRun({ dir }, () => { throw failure; })).rejects.toBe(failure);
    const trace = JSON.parse(await readFile(join(dir, 'trace.json'), 'utf8'));
    expect(trace.version).toBe(1);
    expect(trace.stages).toEqual([]);
  });
});
