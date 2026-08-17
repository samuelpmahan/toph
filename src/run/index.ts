import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  finishTraceWithAssets,
  startTrace,
  type TraceRun,
} from '../runtime/index.js';

export interface WithTophRunOptions {
  dir: string;
  pipeline?: string;
  manifest?: unknown;
  sourceMap?: unknown;
}

export interface TophRunResult<T> {
  value: T;
  result: T;
  dir: string;
  trace: TraceRun;
  tracePath: string;
  manifestPath: string;
  assetFiles: string[];
}

function safeAssetName(name: string): string {
  const safe = name.replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^-+|-+$/g, '');
  return safe || 'asset';
}

/** Runs a trace and persists a self-contained Node run directory. */
export async function withTophRun<T>(
  options: WithTophRunOptions,
  callback: () => T | Promise<T>
): Promise<TophRunResult<T>> {
  if (!options.dir) throw new Error('toph: withTophRun() requires a non-empty dir');
  await mkdir(options.dir, { recursive: true });
  startTrace({ pipeline: options.pipeline });

  let value!: T;
  let failure: unknown;
  let didFail = false;
  try {
    value = await callback();
  } catch (error) {
    didFail = true;
    failure = error;
  }

  const finished = finishTraceWithAssets();
  const tracePath = join(options.dir, 'trace.json');
  const manifestPath = join(options.dir, 'manifest.json');
  const manifest = options.manifest ?? { stages: [], checks: [], assets: [], entityKinds: [] };
  await writeFile(tracePath, JSON.stringify(finished.trace, null, 2) + '\n', 'utf8');
  await writeFile(manifestPath, JSON.stringify(manifest, null, 2) + '\n', 'utf8');
  if (options.sourceMap !== undefined) {
    await writeFile(join(options.dir, 'source-map.json'), JSON.stringify(options.sourceMap, null, 2) + '\n', 'utf8');
  }

  const assetFiles: string[] = [];
  if (finished.assetBytes.length > 0) {
    const assetDir = join(options.dir, 'assets');
    await mkdir(assetDir, { recursive: true });
    const assetIndex = finished.assetBytes.map(({ asset }) => {
      const file = `${String(asset.id).padStart(4, '0')}-${safeAssetName(asset.name)}.bin`;
      assetFiles.push(join('assets', file));
      return { ...asset, file };
    });
    for (let i = 0; i < finished.assetBytes.length; i += 1) {
      await writeFile(join(assetDir, assetIndex[i].file), finished.assetBytes[i].bytes);
    }
    await writeFile(join(assetDir, 'index.json'), JSON.stringify(assetIndex, null, 2) + '\n', 'utf8');
  }

  if (didFail) throw failure;
  return { value, result: value, dir: options.dir, trace: finished.trace, tracePath, manifestPath, assetFiles };
}
