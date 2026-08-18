// Toph counterfactual replay. Node-only layer (mirrors src/run/index.ts): re-executes an
// application-owned pipeline under a config patch and persists each execution as an
// independent, immutable run. Toph stays application-generic here too — nothing in this
// module knows what a config key means, only that it is a dot-path into a JSON object.

import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type {
  CheckRecord,
  DataflowEvent,
  ElementRecord,
  MeasureRecord,
  TraceRun,
} from '../runtime/index.js';

// ---------------------------------------------------------------------------------------
// Config patches
// ---------------------------------------------------------------------------------------

/** Deep-clones `base` and applies each dot-path -> value in `patch`. Pure: never mutates `base`. */
export function applyConfigPatch(base: object, patch: Record<string, unknown>): object {
  const result = structuredClone(base) as Record<string, unknown>;
  for (const [path, value] of Object.entries(patch)) {
    setAtPath(result, path, value);
  }
  return result;
}

function setAtPath(root: Record<string, unknown>, path: string, value: unknown): void {
  const parts = path.split('.');
  let cursor: Record<string, unknown> = root;
  for (let i = 0; i < parts.length - 1; i += 1) {
    const key = parts[i];
    const next = cursor[key];
    if (next === null || typeof next !== 'object' || Array.isArray(next)) {
      cursor[key] = {};
    }
    cursor = cursor[key] as Record<string, unknown>;
  }
  cursor[parts[parts.length - 1]] = value;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function leafEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (Array.isArray(a) && Array.isArray(b)) return JSON.stringify(a) === JSON.stringify(b);
  return false;
}

export interface ConfigDiffEntry {
  path: string;
  a: unknown;
  b: unknown;
}

/** Deep, dot-path diff of two JSON-shaped config objects. */
export function diffConfig(a: object, b: object): ConfigDiffEntry[] {
  const diffs: ConfigDiffEntry[] = [];
  walkConfigDiff(a as Record<string, unknown>, b as Record<string, unknown>, '', diffs);
  return diffs;
}

function walkConfigDiff(
  a: unknown,
  b: unknown,
  prefix: string,
  diffs: ConfigDiffEntry[]
): void {
  if (isPlainObject(a) && isPlainObject(b)) {
    const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
    for (const key of keys) {
      walkConfigDiff(a[key], b[key], prefix === '' ? key : `${prefix}.${key}`, diffs);
    }
    return;
  }
  if (!leafEqual(a, b)) diffs.push({ path: prefix, a, b });
}

export interface SummaryDiffEntry {
  key: string;
  a: number | string | boolean | null | undefined;
  b: number | string | boolean | null | undefined;
}

/** Flat key comparison of two run summaries; reports every key whose value differs. */
export function diffSummaries(
  a: Record<string, number | string | boolean | null>,
  b: Record<string, number | string | boolean | null>
): SummaryDiffEntry[] {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  const diffs: SummaryDiffEntry[] = [];
  for (const key of keys) {
    if (a[key] !== b[key]) diffs.push({ key, a: a[key], b: b[key] });
  }
  return diffs;
}

// ---------------------------------------------------------------------------------------
// Parameter schema (structural match with ChainSpot's declaration; no cross-repo import)
// ---------------------------------------------------------------------------------------

export type ParamSpec =
  | { path: string; label: string; type: 'boolean'; default: boolean }
  | { path: string; label: string; type: 'number'; default: number; min?: number; max?: number; step?: number }
  | { path: string; label: string; type: 'enum'; default: string; options: readonly string[] };

// ---------------------------------------------------------------------------------------
// Adapter contract (Toph declares the shape; the application implements it)
// ---------------------------------------------------------------------------------------

export interface SourceIdentity {
  name: string;
  sha256?: string;
  widthPx?: number;
  heightPx?: number;
}

export interface AdapterRunOutput {
  trace: TraceRun;
  manifest?: unknown;
  labelmaps?: unknown[];
  assets?: Array<{
    asset: { id: number; name: string; kind: 'mask'; widthPx: number; heightPx: number };
    bytes: Uint8Array;
  }>;
  summary: Record<string, number | string | boolean | null>;
  final?: unknown;
}

export interface ReplayAdapter {
  pipelineId: string;
  codeVersion: Record<string, string>;
  source: SourceIdentity;
  defaults: object;
  paramSchema: readonly ParamSpec[];
  execute(effectiveConfig: object): Promise<AdapterRunOutput>;
}

// ---------------------------------------------------------------------------------------
// Run store
// ---------------------------------------------------------------------------------------

export interface RunRecord {
  version: 1;
  runId: string;
  pipelineId: string;
  parentRunId: string | null;
  patch: Record<string, unknown> | null;
  effectiveConfig: object;
  source: SourceIdentity;
  codeVersion: Record<string, string>;
  createdAt: string;
  summary: Record<string, number | string | boolean | null>;
  label?: string;
}

interface SessionFile {
  version: 1;
  pipelineId: string;
  source: SourceIdentity;
  codeVersion: Record<string, string>;
  defaults: object;
  paramSchema: readonly ParamSpec[];
  runIds: string[];
}

export interface ReplaySession {
  baseline(): Promise<RunRecord>;
  replay(parentRunId: string, patch: Record<string, unknown>, label?: string): Promise<RunRecord>;
  grid(parentRunId: string, axes: Record<string, unknown[]>): Promise<RunRecord[]>;
  list(): RunRecord[];
  loadTrace(runId: string): Promise<TraceRun>;
  loadFinal(runId: string): Promise<unknown>;
  loadManifest(runId: string): Promise<unknown>;
  loadLabelmaps(runId: string): Promise<unknown[] | undefined>;
}

function safeAssetName(name: string): string {
  const safe = name.replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^-+|-+$/g, '');
  return safe || 'asset';
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await readFile(path);
    return true;
  } catch {
    return false;
  }
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await writeFile(path, JSON.stringify(value, null, 2) + '\n', 'utf8');
}

async function readJson<T>(path: string): Promise<T> {
  return JSON.parse(await readFile(path, 'utf8')) as T;
}

function cartesianProduct(axes: Record<string, unknown[]>): Array<Record<string, unknown>> {
  let combos: Array<Record<string, unknown>> = [{}];
  for (const key of Object.keys(axes)) {
    const next: Array<Record<string, unknown>> = [];
    for (const combo of combos) {
      for (const value of axes[key]) {
        next.push({ ...combo, [key]: value });
      }
    }
    combos = next;
  }
  return combos;
}

/**
 * Loads or initializes a replay session rooted at `dir`. Runs are append-only: nothing in
 * this API mutates an existing run directory, and loads return parsed copies.
 */
export async function openReplaySession(dir: string, adapter: ReplayAdapter): Promise<ReplaySession> {
  await mkdir(dir, { recursive: true });
  const runsDir = join(dir, 'runs');
  await mkdir(runsDir, { recursive: true });
  const sessionPath = join(dir, 'session.json');

  let sessionData: SessionFile;
  if (await fileExists(sessionPath)) {
    sessionData = await readJson<SessionFile>(sessionPath);
  } else {
    sessionData = {
      version: 1,
      pipelineId: adapter.pipelineId,
      source: structuredClone(adapter.source),
      codeVersion: structuredClone(adapter.codeVersion),
      defaults: structuredClone(adapter.defaults),
      paramSchema: structuredClone(adapter.paramSchema) as readonly ParamSpec[],
      runIds: [],
    };
    await writeJson(sessionPath, sessionData);
  }

  const runCache = new Map<string, RunRecord>();
  for (const runId of sessionData.runIds) {
    runCache.set(runId, await readJson<RunRecord>(join(runsDir, runId, 'run.json')));
  }

  async function persistRun(runRecord: RunRecord, output: AdapterRunOutput): Promise<void> {
    const runDir = join(runsDir, runRecord.runId);
    await mkdir(runDir, { recursive: true });

    await writeJson(join(runDir, 'trace.json'), output.trace);
    if (output.manifest !== undefined) await writeJson(join(runDir, 'manifest.json'), output.manifest);
    if (output.labelmaps !== undefined) await writeJson(join(runDir, 'labelmaps.json'), output.labelmaps);
    if (output.final !== undefined) await writeJson(join(runDir, 'final.json'), output.final);
    if (output.assets !== undefined && output.assets.length > 0) {
      const assetDir = join(runDir, 'assets');
      await mkdir(assetDir, { recursive: true });
      const assetIndex = output.assets.map(({ asset }) => {
        const file = `${String(asset.id).padStart(4, '0')}-${safeAssetName(asset.name)}.bin`;
        return { ...asset, file };
      });
      for (let i = 0; i < output.assets.length; i += 1) {
        await writeFile(join(assetDir, assetIndex[i].file), output.assets[i].bytes);
      }
      await writeJson(join(assetDir, 'index.json'), assetIndex);
    }

    // run.json last: it is the record that makes this run "exist" to the session.
    await writeJson(join(runDir, 'run.json'), runRecord);

    // Only after the run directory is fully written do we register it in the session.
    sessionData.runIds.push(runRecord.runId);
    await writeJson(sessionPath, sessionData);
    runCache.set(runRecord.runId, runRecord);
  }

  function requireCachedRun(runId: string): RunRecord {
    const run = runCache.get(runId);
    if (run === undefined) throw new Error(`toph/replay: unknown parent run id "${runId}"`);
    return run;
  }

  async function execute(
    parentRunId: string | null,
    patch: Record<string, unknown> | null,
    effectiveConfig: object,
    label?: string
  ): Promise<RunRecord> {
    const output = await adapter.execute(structuredClone(effectiveConfig));
    const runRecord: RunRecord = {
      version: 1,
      runId: randomUUID(),
      pipelineId: adapter.pipelineId,
      parentRunId,
      patch: patch === null ? null : structuredClone(patch),
      effectiveConfig: structuredClone(effectiveConfig),
      source: structuredClone(adapter.source),
      codeVersion: structuredClone(adapter.codeVersion),
      createdAt: new Date().toISOString(),
      summary: structuredClone(output.summary),
      ...(label !== undefined ? { label } : {}),
    };
    await persistRun(runRecord, output);
    return structuredClone(runRecord);
  }

  async function baseline(): Promise<RunRecord> {
    for (const runId of sessionData.runIds) {
      const existing = requireCachedRun(runId);
      if (existing.parentRunId === null) return structuredClone(existing);
    }
    return execute(null, null, sessionData.defaults);
  }

  async function replay(
    parentRunId: string,
    patch: Record<string, unknown>,
    label?: string
  ): Promise<RunRecord> {
    const parent = requireCachedRun(parentRunId);
    const effectiveConfig = applyConfigPatch(parent.effectiveConfig, patch);
    return execute(parentRunId, patch, effectiveConfig, label);
  }

  async function grid(parentRunId: string, axes: Record<string, unknown[]>): Promise<RunRecord[]> {
    const combinations = cartesianProduct(axes);
    const results: RunRecord[] = [];
    for (const patch of combinations) {
      results.push(await replay(parentRunId, patch));
    }
    return results;
  }

  function list(): RunRecord[] {
    return sessionData.runIds.map((runId) => structuredClone(requireCachedRun(runId)));
  }

  async function loadTrace(runId: string): Promise<TraceRun> {
    return readJson<TraceRun>(join(runsDir, runId, 'trace.json'));
  }

  async function loadFinal(runId: string): Promise<unknown> {
    return readJson<unknown>(join(runsDir, runId, 'final.json'));
  }

  async function loadManifest(runId: string): Promise<unknown> {
    return readJson<unknown>(join(runsDir, runId, 'manifest.json'));
  }

  async function loadLabelmaps(runId: string): Promise<unknown[] | undefined> {
    const path = join(runsDir, runId, 'labelmaps.json');
    if (!(await fileExists(path))) return undefined;
    return readJson<unknown[]>(path);
  }

  return { baseline, replay, grid, list, loadTrace, loadFinal, loadManifest, loadLabelmaps };
}

// ---------------------------------------------------------------------------------------
// Trace diff: first divergent stage invocation
// ---------------------------------------------------------------------------------------

export interface StageDivergence {
  stageId: number;
  seq: number;
  reason: string;
}

interface InvocationElementFact {
  ordinal: number;
  kept: boolean;
}

interface InvocationCheckFact {
  checkId: number;
  operator: CheckRecord['operator'];
  value: number | boolean;
  threshold: number | boolean;
  pass: boolean;
}

interface InvocationMeasureFact {
  name: string;
  value: number | string | boolean | null;
}

/** Structural signature of a dataflow event: cardinalities and result values, never raw ids. */
type InvocationDataflowFact = Record<string, unknown>;

function dataflowFact(event: DataflowEvent): InvocationDataflowFact {
  switch (event.t) {
    case 'map':
      return { t: event.t, parents: event.parents.length, children: event.children.length };
    case 'split':
      return { t: event.t, children: event.children.length };
    case 'merge':
      return { t: event.t, parents: event.parents.length, hasRep: event.rep !== undefined };
    case 'reduce':
      return { t: event.t, inputs: event.inputs.length, result: event.result, hasOutput: event.output !== undefined };
    case 'rank':
      return { t: event.t, rank: event.rank, cutoff: event.cutoff };
    case 'select':
      return {
        t: event.t,
        kept: event.kept.length,
        rejected: event.rejected.length,
        name: event.name,
        basis: event.basis,
      };
    case 'suppress':
      return { t: event.t, hasBy: event.by !== undefined };
    case 'relate':
      return { t: event.t, relation: event.relation, hasJoin: event.join !== undefined };
  }
}

function elementFacts(trace: TraceRun, invocationId: number): InvocationElementFact[] {
  return trace.elements
    .filter((el: ElementRecord) => el.stageInvocationId === invocationId)
    .sort((a, b) => a.ordinal - b.ordinal)
    .map((el) => ({ ordinal: el.ordinal, kept: el.kept }));
}

function checkFacts(trace: TraceRun, invocationId: number): InvocationCheckFact[] {
  return trace.checks
    .filter((c: CheckRecord) => c.stageInvocationId === invocationId)
    .map((c) => ({ checkId: c.checkId, operator: c.operator, value: c.value, threshold: c.threshold, pass: c.pass }));
}

function measureFacts(trace: TraceRun, invocationId: number): InvocationMeasureFact[] {
  return (trace.measures ?? [])
    .filter((m: MeasureRecord) => m.stageInvocationId === invocationId)
    .map((m) => ({ name: m.name, value: m.value }));
}

function dataflowFacts(trace: TraceRun, invocationId: number): InvocationDataflowFact[] {
  return (trace.dataflow ?? []).filter((d: DataflowEvent) => d.stage === invocationId).map(dataflowFact);
}

function jsonEqual(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * Compares the invocation-local facts (element kept-flags, checks, measures, dataflow
 * structure) of two stage invocations that are already known to share a stageId. Returns
 * a human-useful reason string when they differ, or null when equivalent. Entity/element
 * ids are never compared by raw value — only structural facts (counts, ordinals, values).
 */
export function stagesEquivalentThrough(
  a: { trace: TraceRun; invocationId: number },
  b: { trace: TraceRun; invocationId: number }
): string | null {
  const elementsA = elementFacts(a.trace, a.invocationId);
  const elementsB = elementFacts(b.trace, b.invocationId);
  if (elementsA.length !== elementsB.length) {
    return `element count differs: ${elementsA.length} vs ${elementsB.length}`;
  }
  for (let i = 0; i < elementsA.length; i += 1) {
    if (elementsA[i].kept !== elementsB[i].kept) {
      return `element ordinal ${elementsA[i].ordinal} kept flag differs: ${elementsA[i].kept} vs ${elementsB[i].kept}`;
    }
  }

  const checksA = checkFacts(a.trace, a.invocationId);
  const checksB = checkFacts(b.trace, b.invocationId);
  if (checksA.length !== checksB.length) {
    return `check count differs: ${checksA.length} vs ${checksB.length}`;
  }
  for (let i = 0; i < checksA.length; i += 1) {
    if (!jsonEqual(checksA[i], checksB[i])) {
      return `check[${i}] differs: ${JSON.stringify(checksA[i])} vs ${JSON.stringify(checksB[i])}`;
    }
  }

  const measuresA = measureFacts(a.trace, a.invocationId);
  const measuresB = measureFacts(b.trace, b.invocationId);
  if (measuresA.length !== measuresB.length) {
    return `measure count differs: ${measuresA.length} vs ${measuresB.length}`;
  }
  for (let i = 0; i < measuresA.length; i += 1) {
    if (!jsonEqual(measuresA[i], measuresB[i])) {
      return `measure[${i}] differs: ${JSON.stringify(measuresA[i])} vs ${JSON.stringify(measuresB[i])}`;
    }
  }

  const dataflowA = dataflowFacts(a.trace, a.invocationId);
  const dataflowB = dataflowFacts(b.trace, b.invocationId);
  if (dataflowA.length !== dataflowB.length) {
    return `dataflow event count differs: ${dataflowA.length} vs ${dataflowB.length}`;
  }
  for (let i = 0; i < dataflowA.length; i += 1) {
    if (!jsonEqual(dataflowA[i], dataflowB[i])) {
      return `dataflow event[${i}] differs: ${JSON.stringify(dataflowA[i])} vs ${JSON.stringify(dataflowB[i])}`;
    }
  }

  return null;
}

/**
 * Finds the first point at which two traces diverge, correlating stage invocations
 * pairwise in the order they occurred. Returns null when the traces are equivalent
 * through every invocation both share. Stage identity is stageId + invocation sequence,
 * never a name; raw entity/element ids are never compared across runs since they are
 * per-run-local.
 */
export function firstDivergentStage(a: TraceRun, b: TraceRun): StageDivergence | null {
  const stagesA = a.stages;
  const stagesB = b.stages;
  const length = Math.min(stagesA.length, stagesB.length);

  for (let i = 0; i < length; i += 1) {
    const invA = stagesA[i];
    const invB = stagesB[i];
    if (invA.stageId !== invB.stageId) {
      return {
        stageId: invA.stageId,
        seq: invA.seq,
        reason: `stageId differs at invocation ${i}: ${invA.stageId} vs ${invB.stageId}`,
      };
    }
    const reason = stagesEquivalentThrough(
      { trace: a, invocationId: invA.invocationId },
      { trace: b, invocationId: invB.invocationId }
    );
    if (reason !== null) {
      return { stageId: invA.stageId, seq: invA.seq, reason };
    }
  }

  if (stagesA.length !== stagesB.length) {
    const extra = stagesA.length > stagesB.length ? stagesA[length] : stagesB[length];
    return {
      stageId: extra.stageId,
      seq: extra.seq,
      reason: `extra invocation in ${stagesA.length > stagesB.length ? 'run A' : 'run B'} at index ${length} (stageId ${extra.stageId}, seq ${extra.seq})`,
    };
  }

  return null;
}
