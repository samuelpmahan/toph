// Toph runtime (Phase 2).
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

//
// This module is what `import * as __toph from "toph"` resolves to (package.json's
// "." export points here). It implements the exact function names/signatures that
// src/compiler/codegen.ts's generated trace-mode code calls -- see
// IMPLEMENTATION-DECISIONS.md section 6 for the generated-code shape this must satisfy
// and test/compiler/support/fakeRuntime.ts for the test-only stand-in Phase 1 used to
// prove the compiler's own output correct (this is the real thing that stand-in
// approximated).
//
// Scope (IMPLEMENTATION-DECISIONS.md section 5, DESIGN.md Part 2 section 10): this is
// deliberately a small subset of DESIGN.md's full trace schema -- only what Phase 1's
// generated output can actually populate. In particular:
//   - "entities" here are NOT DESIGN.md's stable cross-call entities (Entity.id
//     surviving a component -> candidate -> ... derivation chain). They are per-stage-
//     invocation *ordinals* -- "first element evaluated in this filter invocation,
//     second, ..." -- scoped to one enterStage()/enterElement() cycle, because nothing
//     downstream consumes cross-invocation identity yet. Real entity identity is
//     Phase 5's job (IMPLEMENTATION-DECISIONS.md section 5).
//   - Rejection is not a stored fact. Per DESIGN.md section 10 ("deliberately absent,
//     viewer-computed"), an element's `kept` flag simply never flips to `true` if it
//     was rejected; *why* -- which check failed, or none ran at all -- is recoverable
//     from the ordered `checks` array by any caller that wants it, not precomputed
//     here.
//   - No rasters, no ground truth, no relations/decisions beyond what a `check` event
//     already implies. No pipeline/graph framework: this module never runs or
//     schedules anything, it only records calls made by code that runs itself.
//
// Session model: a single process-global "active trace session" (IMPLEMENTATION-
// DECISIONS.md section 6) -- generated code never threads a session parameter, so
// enterStage/enterElement/the six comparators/keep all resolve against whatever
// session startTrace() last activated. This matches DESIGN.md Q11's declared scope
// ("one image, one trace, written at end of run"; no concurrent-trace support).

/** The six comparison operators the compiler can emit a check call for. */
export type CheckOperator = 'gte' | 'lte' | 'gt' | 'lt' | 'eq' | 'neq';

/** One execution of a named stage. `seq` is 0-indexed and counts per distinct `stageId` --
 * the same logical stage (e.g. a `.filter()` inside a loop, or called more than once)
 * gets a fresh `invocationId` every time but a stable, increasing `seq` so repeated runs
 * of the same stage are distinguishable and orderable. */
export interface StageInvocationRecord {
	invocationId: number;
	stageId: number;
	seq: number;
}

/** One element evaluated within a stage invocation. `ordinal` is 0-indexed and scoped to
 * `stageInvocationId` (first element seen by that invocation is 0, next is 1, ...).
 * `kept` starts `false` and flips to `true` on a `keep()` call for this element's id --
 * it is never set any other way, so an element that was rejected (or never finished
 * evaluation) simply stays `false`. */
export interface ElementRecord {
	id: number;
	stageInvocationId: number;
	ordinal: number;
	kept: boolean;
}

/** One executed comparison. Pushed in call order -- this ordering is itself evidence of
 * which checks ran, in what sequence, and (via a missing subsequent record for the same
 * elementId) which one short-circuited the rest.
 *
 * `value`/`threshold` are `number | boolean` because `eq`/`neq` (unlike the other four
 * comparators) are meaningful on booleans -- see makeCheck's doc comment. */
export interface CheckRecord {
	stageInvocationId: number;
	elementId: number;
	checkId: number;
	operator: CheckOperator;
	value: number | boolean;
	threshold: number | boolean;
	pass: boolean;
}

/** The one currently-supported `@toph snapshot` asset kind. */
export type AssetKind = 'mask';

/** Metadata for one `@toph snapshot`-captured raster asset. Metadata only -- the actual
 * pixel bytes are never part of TraceRun (see getRasterBytes's doc comment for why) and
 * must be retrieved separately, while the session that snapshotted them is still
 * active. */
export interface AssetRecord {
	id: number;
	name: string;
	kind: AssetKind;
	widthPx: number;
	heightPx: number;
}

/** One entity spawned by a `@toph entities <kind>` site. `ordinal` is 0-indexed and
 * scoped to that one spawnEntities()/spawnDerivedEntities() call (its index within the
 * spawned array). `attrs` holds the spawned object's own enumerable primitive-valued
 * properties only (see spawnEntities's doc comment). There is deliberately no `kept`
 * flag here (unlike ElementRecord) -- an entity can flow into more than one later
 * filter stage over its lifetime, so "was it kept" is a per-stage question answered by
 * the `checks` array, not a single fact owned by the entity itself.
 *
 * `parentId` is optional and set ONLY by spawnDerivedEntities -- an ordinary
 * spawnEntities() entity (the "plain array" `@toph entities` shape) never has one, the
 * same "omit rather than record a sentinel" convention TraceRun.pipeline/assets/entities
 * already use. When present, it is the id of the entity `entityIdByRef` recognized as
 * this entity's SOURCE object at spawn time (see spawnDerivedEntities's doc comment) --
 * a single link, not a lineage chain: an entity derived from a derived entity would need
 * its OWN parentId lookup at ITS OWN spawn time to go any further back, this field never
 * grows into an array or gets walked automatically. */
export interface EntityRecord {
	id: number;
	kindId: number;
	ordinal: number;
	attrs: Record<string, number | string | boolean>;
	parentId?: number;
}

/** The full accumulated output of one trace session. Always a plain, JSON-serializable
 * object -- no class instances, Maps, or Sets anywhere in this shape.
 *
 * `assets`/`entities` are optional and simply omitted (not present as empty arrays)
 * when a session never calls snapshotRaster()/spawnEntities() -- exactly like
 * `pipeline` is omitted when not provided. This keeps finishTrace()'s return value
 * byte-for-byte identical to Phase 1-4 behavior for every session that doesn't use
 * these new calls, rather than growing every existing TraceRun by two always-present
 * empty arrays. */
export interface TraceRun {
	version: 1;
	pipeline?: string;
	stages: StageInvocationRecord[];
	elements: ElementRecord[];
	checks: CheckRecord[];
	assets?: AssetRecord[];
	entities?: EntityRecord[];
	dataflow?: DataflowEvent[];
}

export interface StartTraceOptions {
	pipeline?: string;
}

/** Internal session bookkeeping. Never exposed directly -- finishTrace() copies the
 * plain-array fields out into a TraceRun and discards the Maps used for O(1) lookups. */
interface Session {
	pipeline?: string;
	stages: StageInvocationRecord[];
	elements: ElementRecord[];
	checks: CheckRecord[];
	nextStageInvocationId: number;
	nextElementId: number;
	/** stageId -> how many invocations of it have been seen so far (next seq value). */
	seqByStageId: Map<number, number>;
	/** stageInvocationId -> next ordinal to hand out within that invocation. Also
	 * doubles as "is this a stage invocation id that actually came from enterStage() in
	 * this session" for enterElement()'s validation. */
	nextOrdinalByStageInvocation: Map<number, number>;
	/** elementId -> its record, so keep() and the comparators (given only an elementId)
	 * can find/mutate the same object that lives in `elements`, in O(1). This ALSO holds
	 * entries for reused entity ids (see enterElement's ref-lookup path) that are
	 * deliberately never pushed into `elements` itself -- elementsById is purely an
	 * internal by-id lookup index, not a mirror of the public `elements` array. */
	elementsById: Map<number, ElementRecord>;

	/** Public metadata for every `@toph snapshot`-captured asset this session has seen. */
	assets: AssetRecord[];
	/** Public records for every entity `@toph entities` has spawned this session. */
	entities: EntityRecord[];
	dataflow: DataflowEvent[];
	/** assetId -> a private COPY of the bytes passed to snapshotRaster (never the
	 * caller's original array reference) -- retrievable via getRasterBytes() only while
	 * this session is active; never serialized into TraceRun (see getRasterBytes). */
	rasterBytesById: Map<number, Uint8Array | Uint8ClampedArray>;
	nextEntityId: number;
	/** object reference -> the entity id spawnEntities() allocated for it, so a LATER
	 * enterElement(stageInvocationId, ref) call passing the SAME object reference can
	 * recover the SAME entity id instead of allocating a fresh ordinal one. */
	entityIdByRef: WeakMap<object, number>;
}

let active: Session | null = null;

function requireSession(fnName: string): Session {
	if (active === null) {
		throw new Error(
			`toph: ${fnName}() was called with no active trace session. ` +
				'Call startTrace() before running instrumented code (and finishTrace() when done).'
		);
	}
	return active;
}

/**
 * Starts a new trace session and makes it "the active session" that enterStage,
 * enterElement, the six comparators, and keep all resolve against.
 *
 * Calling this while a session is already active throws rather than silently replacing
 * it: a second startTrace() with no intervening finishTrace() almost always means the
 * harness forgot to close out a previous run (or two traced pipelines are running
 * concurrently, which this module does not support -- see the module doc comment).
 * Silently swapping sessions would either quietly discard the first run's data or
 * splice two runs' events together under one TraceRun; both are worse than failing
 * loudly here, consistent with this project's stated philosophy of never approximating
 * silently.
 */
export function startTrace(opts: StartTraceOptions = {}): void {
	if (active !== null) {
		throw new Error(
			'toph: startTrace() was called while a trace session is already active. ' +
				'Call finishTrace() to end the current session before starting a new one.'
		);
	}
	active = {
		pipeline: opts.pipeline,
		stages: [],
		elements: [],
		checks: [],
		nextStageInvocationId: 1,
		nextElementId: 1,
		seqByStageId: new Map(),
		nextOrdinalByStageInvocation: new Map(),
		elementsById: new Map(),
		assets: [],
		entities: [],
		dataflow: [],
		rasterBytesById: new Map(),
		nextEntityId: 1,
		entityIdByRef: new WeakMap(),
	};
}

/**
 * Deactivates the current session and returns its accumulated data as a plain,
 * JSON-serializable TraceRun. After this call the module has no active session again --
 * a subsequent enterStage/enterElement/comparator/keep call throws until the next
 * startTrace().
 */
export function finishTrace(): TraceRun {
	const session = requireSession('finishTrace');
	const run: TraceRun = {
		version: 1,
		stages: session.stages,
		elements: session.elements,
		checks: session.checks,
	};
	if (session.pipeline !== undefined) run.pipeline = session.pipeline;
	if (session.assets.length > 0) run.assets = session.assets;
	if (session.entities.length > 0) run.entities = session.entities;
	if (session.dataflow.length > 0) run.dataflow = session.dataflow;
	active = null;
	return run;
}

/** Records the start of one execution of stage `stageId` and returns a fresh
 * stage-invocation id, distinct on every call -- including repeated calls with the same
 * `stageId` (the same logical stage running more than once). */
export function enterStage(stageId: number): number {
	const session = requireSession('enterStage');
	const invocationId = session.nextStageInvocationId++;
	const seq = session.seqByStageId.get(stageId) ?? 0;
	session.seqByStageId.set(stageId, seq + 1);
	session.stages.push({ invocationId, stageId, seq });
	session.nextOrdinalByStageInvocation.set(invocationId, 0);
	return invocationId;
}

/** Records one element entering evaluation within stage invocation
 * `stageInvocationId` and returns a fresh element id. The element's ordinal is scoped
 * to that stage invocation (0 for the first element seen by that invocation, 1 for the
 * next, ...), not global across the whole session.
 *
 * `ref` is an optional second parameter (added for entity identity -- see spawnEntities)
 * -- existing generated code from Phase 1-4 that calls enterElement(stageInvocationId)
 * with a single argument behaves identically to before; `ref` being `undefined` takes
 * the exact same normal fresh-ordinal path it always has.
 *
 * When `ref` IS provided and was previously spawned as an entity (via spawnEntities) in
 * the CURRENT session, enterElement returns that SAME entity id instead of allocating a
 * fresh one -- no new ordinal is consumed and no new record is pushed into the public
 * `elements` array (only entity-spawn sites contribute to `elements` in the ordinary
 * way; a reused entity's identity already lives in `entities`). This is what lets a
 * later `@toph filter`'s checks reference the SAME entity id a `@toph entities` site
 * spawned for that exact object, rather than an unrelated fresh ordinal.
 *
 * When `ref` is provided but was never spawned (the common case -- most filter sites'
 * elements have no upstream `@toph entities` spawn at all), this falls back to the
 * normal fresh-ID allocation path unchanged. */
export function enterElement(stageInvocationId: number, ref?: object): number {
	const session = requireSession('enterElement');
	const ordinal = session.nextOrdinalByStageInvocation.get(stageInvocationId);
	if (ordinal === undefined) {
		throw new Error(
			`toph: enterElement() was called with stage invocation id ${stageInvocationId}, ` +
				'which was not produced by enterStage() in the current trace session.'
		);
	}

	if (ref !== undefined && ref !== null && typeof ref === 'object') {
		const entityId = session.entityIdByRef.get(ref);
		if (entityId !== undefined) {
			// Internal by-id bookkeeping only (needed so the comparators/keep() below can
			// resolve `stageInvocationId` for this call and record checks against it) --
			// deliberately NOT pushed into session.elements, and does not consume/advance
			// this invocation's ordinal counter.
			session.elementsById.set(entityId, { id: entityId, stageInvocationId, ordinal, kept: false });
			return entityId;
		}
	}

	session.nextOrdinalByStageInvocation.set(stageInvocationId, ordinal + 1);

	const id = session.nextElementId++;
	const record: ElementRecord = { id, stageInvocationId, ordinal, kept: false };
	session.elements.push(record);
	session.elementsById.set(id, record);
	return id;
}

function lookupElement(session: Session, fnName: string, elementId: number): ElementRecord {
	const record = session.elementsById.get(elementId);
	if (record === undefined) {
		throw new Error(
			`toph: ${fnName}() was called with element id ${elementId}, ` +
				'which was not produced by enterElement() in the current trace session.'
		);
	}
	return record;
}

function makeCheck<T extends number | boolean>(operator: CheckOperator, compare: (value: T, threshold: T) => boolean) {
	return (elementId: number, checkId: number, value: T, threshold: T): boolean => {
		const session = requireSession(operator);
		const element = lookupElement(session, operator, elementId);
		// Literal native comparison first (exactly `value <op> threshold`, including
		// JS's own edge-case semantics -- e.g. any comparison against NaN is false,
		// NaN !== NaN is true), THEN record the event, in that order, per
		// IMPLEMENTATION-DECISIONS.md section 6.
		const pass = compare(value, threshold);
		session.checks.push({
			stageInvocationId: element.stageInvocationId,
			elementId,
			checkId,
			operator,
			value,
			threshold,
			pass,
		});
		return pass;
	};
}

export const gte = makeCheck<number>('gte', (value, threshold) => value >= threshold);
export const lte = makeCheck<number>('lte', (value, threshold) => value <= threshold);
export const gt = makeCheck<number>('gt', (value, threshold) => value > threshold);
export const lt = makeCheck<number>('lt', (value, threshold) => value < threshold);
// eq/neq are typed over `number | boolean` (unlike the other four) because `===`/`!==`
// are sound, meaningful comparisons on booleans -- `>=`/`<=`/`>`/`<` are not, so those
// stay number-only.
export const eq = makeCheck<number | boolean>('eq', (value, threshold) => value === threshold);
export const neq = makeCheck<number | boolean>('neq', (value, threshold) => value !== threshold);

/** Marks an element as a survivor of its filter stage. This is the only explicit
 * "outcome" call generated code makes -- rejection is never recorded directly, it is
 * simply the absence of a keep() call for that element id (see the module doc
 * comment). */
export function keep(elementId: number): void {
	const session = requireSession('keep');
	const element = lookupElement(session, 'keep', elementId);
	element.kept = true;
}

function copyPrimitiveAttrs(value: unknown): Record<string, number | string | boolean> {
	const attrs: Record<string, number | string | boolean> = {};
	if (value === null || typeof value !== 'object') return attrs;
	for (const [key, propValue] of Object.entries(value as Record<string, unknown>)) {
		if (typeof propValue === 'number' || typeof propValue === 'string' || typeof propValue === 'boolean') {
			attrs[key] = propValue;
		}
		// Anything else (nested objects, arrays, functions, undefined, null, symbols) is
		// silently skipped, per this function's contract.
	}
	return attrs;
}

/** Builds and registers exactly one entity record: allocates a fresh entity id; if `el`
 * is a non-null object, registers it in `session.entityIdByRef` from that exact object
 * reference to this entity id (so a LATER enterElement(stageInvocationId, ref) call --
 * or a LATER spawnDerivedEntities() parent lookup -- passing the SAME reference recovers
 * the SAME id); copies `el`'s own enumerable primitive-valued (number/string/boolean)
 * properties into an `attrs` record, silently skipping anything else (nested
 * objects/arrays/functions); attaches `parentId` iff one was passed; and pushes the
 * finished record into `session.entities`. Returns the finished record (its `id` is what
 * callers collect). Shared by spawnEntities (no parentId) and spawnDerivedEntities (a
 * parentId resolved by the caller before this is called) so both stay in exact lockstep
 * on id allocation, WeakMap registration, and attrs extraction. */
function spawnOneEntity(session: Session, kindId: number, el: unknown, ordinal: number, parentId?: number): EntityRecord {
	const id = session.nextEntityId++;
	if (el !== null && typeof el === 'object') {
		session.entityIdByRef.set(el, id);
	}
	const record: EntityRecord = { id, kindId, ordinal, attrs: copyPrimitiveAttrs(el) };
	if (parentId !== undefined) record.parentId = parentId;
	session.entities.push(record);
	return record;
}

/** Spawns one stable entity per element of `elements`, in array order -- see
 * spawnOneEntity for exactly what each spawned entity gets. Returns the newly-allocated
 * ids, in the same order as `elements`.
 *
 * Valid to call with zero later consumption -- nothing here depends on any subsequent
 * enterElement() call ever looking a spawned entity back up. */
export function spawnEntities(kindId: number, elements: readonly unknown[]): number[] {
	const session = requireSession('spawnEntities');
	return elements.map((el, ordinal) => spawnOneEntity(session, kindId, el, ordinal).id);
}

/** Spawns one stable entity per element of `elements`, IN THE SAME WAY spawnEntities
 * does (same id allocation, same WeakMap registration of `elements[i]` itself, same
 * attrs extraction -- see spawnOneEntity), but additionally links each spawned entity to
 * the entity (if any) that `parents[i]` was already known as.
 *
 * This exists for a `.map()`-derived `@toph entities` site: `elements[i]` is a BRAND NEW
 * object (e.g. one `.map()` callback invocation's return value) that is NOT the same
 * reference as `parents[i]` (the object the callback was invoked with) -- so plain
 * reference-identity (what spawnEntities/enterElement rely on) cannot link them. Instead,
 * for each index `i`: `parents[i]` is looked up in the SAME `session.entityIdByRef`
 * WeakMap spawnEntities/enterElement already populate and consult (not a second,
 * separate map) -- if `parents[i]` was itself spawned (or re-spawned, e.g. by an earlier
 * spawnDerivedEntities call) as an entity earlier in the CURRENT session, that id becomes
 * `elements[i]`'s new entity's `parentId`. If `parents[i]` has no known entity id (a
 * legitimate, non-error case -- e.g. this is called on data that was never spawned
 * upstream), the new entity simply has no `parentId` (omitted, never `0`/`null`).
 *
 * `elements` and `parents` must be the same length, in corresponding order (index `i` in
 * `elements` was derived FROM index `i` in `parents`) -- true by construction for a
 * `.map()` callback's output against its receiver, which is the only shape the compiler
 * generates a call like this for. Returns the newly-allocated ids, in the same order as
 * `elements`. */
export function spawnDerivedEntities(
	kindId: number,
	elements: readonly unknown[],
	parents: readonly unknown[]
): number[] {
	const session = requireSession('spawnDerivedEntities');
	return elements.map((el, ordinal) => {
		const parent = parents[ordinal];
		const parentId =
			parent !== null && typeof parent === 'object' ? session.entityIdByRef.get(parent) : undefined;
		return spawnOneEntity(session, kindId, el, ordinal, parentId).id;
	});
}

/** Snapshots `ref`'s CURRENT bytes -- a real copy, not a reference -- into the active
 * session's internal raster store, keyed by `assetId`, and records the asset's
 * `{id, name, kind, widthPx, heightPx}` metadata into the session (surfaced later via
 * finishTrace()'s `assets` array). The whole point of the copy is capturing the value
 * before the caller mutates the original array in place (the real target this exists
 * for -- ChainSpot's `collectComponents` -- does exactly that, using its mask argument
 * as its own BFS visited-set). Throws the same "no active session" error style as the
 * other runtime functions if called with none active. */
export function snapshotRaster(
	assetId: number,
	name: string,
	kind: AssetKind,
	ref: Uint8Array | Uint8ClampedArray,
	widthPx: number,
	heightPx: number
): void {
	const session = requireSession('snapshotRaster');
	session.rasterBytesById.set(assetId, ref.slice());
	session.assets.push({ id: assetId, name, kind, widthPx, heightPx });
}

/** Retrieves a previously-snapshotted raster's bytes, while the session that
 * snapshotted it is still active (i.e. before finishTrace()). Returns `undefined` if
 * `assetId` was never snapshotted in the current session.
 *
 * Deliberately NOT part of the JSON-serializable TraceRun: raw pixel arrays would bloat
 * a JSON trace enormously (a full-resolution image mask can be megabytes), and
 * DESIGN.md's own model stores rasters as separate PNG files, not inline JSON. Toph's
 * core has no PNG encoder and shouldn't gain one -- encoding/writing the bytes this
 * returns is a concern for whatever harness consumes them, not this runtime. Throws the
 * same "no active session" error style as the other runtime functions if called with
 * none active, since "the active session's internal raster store" this reads from only
 * exists while a session is active. */
export function getRasterBytes(assetId: number): Uint8Array | Uint8ClampedArray | undefined {
	const session = requireSession('getRasterBytes');
	return session.rasterBytesById.get(assetId);
}

/** Options for a complete, persisted trace lifecycle. */
export interface WithTophRunOptions {
  /** Destination directory. It is created recursively when absent. */
  dir: string;
  pipeline?: string;
  /** Compiler manifest to copy into the run directory. */
  manifest?: unknown;
  /** Optional compiler source map to copy alongside the manifest. */
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

interface FinishedRun {
  trace: TraceRun;
  assetBytes: Array<{ asset: AssetRecord; bytes: Uint8Array | Uint8ClampedArray }>;
}

function finishTraceWithAssets(): FinishedRun {
  const session = requireSession('finishTrace');
  const assetBytes = session.assets.flatMap((asset) => {
    const bytes = session.rasterBytesById.get(asset.id);
    return bytes === undefined ? [] : [{ asset, bytes }];
  });
  return { trace: finishTrace(), assetBytes };
}

function safeAssetName(name: string): string {
  const safe = name.replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^-+|-+$/g, '');
  return safe || 'asset';
}

/** Starts a trace, executes callback, and persists a self-contained run directory. */
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
/** Entity ids are the spine of dataflow evidence; object refs are resolved through the
 * session WeakMap. Collections remain ordinary JavaScript arrays. */
export type EntityRef = number | object;

export interface DataflowMapEvent {
	t: 'map';
	stage: number;
	parents: number[];
	children: number[];
}
export interface DataflowSplitEvent {
	t: 'split';
	stage: number;
	parent: number;
	children: number[];
}
export interface DataflowMergeEvent {
	t: 'merge';
	stage: number;
	parents: number[];
	child: number;
	rep?: number;
}
export interface DataflowReduceEvent {
	t: 'reduce';
	stage: number;
	inputs: number[];
	output: number;
}
export interface DataflowRankEvent {
	t: 'rank';
	stage: number;
	entity: number;
	rank: number;
	cutoff?: number;
}
export interface DataflowSelectEvent {
	t: 'select';
	stage: number;
	kept: number[];
	rejected: number[];
	name?: string;
}
export interface DataflowSuppressEvent {
	t: 'suppress';
	stage: number;
	entity: number;
	by?: number;
}
export interface DataflowRelateEvent {
	t: 'relate';
	stage: number;
	left: number;
	right: number;
	join?: number;
	relation?: string;
}
export type DataflowEvent =
	| DataflowMapEvent
	| DataflowSplitEvent
	| DataflowMergeEvent
	| DataflowReduceEvent
	| DataflowRankEvent
	| DataflowSelectEvent
	| DataflowSuppressEvent
	| DataflowRelateEvent;

/**
 * Returns the stable id bound to an object in this session, or 0 when it is unknown.
 * The zero sentinel mirrors the original Trace API design; recordDataflow rejects it
 * so an incomplete lineage can never be serialized as if it were real evidence.
 */
export function idOf(ref: object): number {
	const session = requireSession('idOf');
	return session.entityIdByRef.get(ref) ?? 0;
}

function requireDataflowEntity(session: Session, id: number): void {
	if (!Number.isInteger(id) || id <= 0 || !session.entities.some((entity) => entity.id === id)) {
throw new Error('toph: recordDataflow() referenced unknown entity id ' + String(id) + '.');
	}
}

function requireDataflowStage(session: Session, stage: number): void {
	if (!Number.isInteger(stage) || !session.stages.some((invocation) => invocation.invocationId === stage)) {
throw new Error('toph: recordDataflow() referenced unknown stage invocation id ' + String(stage) + '.');
	}
}

function copyDataflowEvent(event: DataflowEvent): DataflowEvent {
	switch (event.t) {
		case 'map': return { ...event, parents: [...event.parents], children: [...event.children] };
		case 'split': return { ...event, children: [...event.children] };
		case 'merge': return { ...event, parents: [...event.parents] };
		case 'reduce': return { ...event, inputs: [...event.inputs] };
		case 'select': return { ...event, kept: [...event.kept], rejected: [...event.rejected] };
		default: return { ...event };
	}
}

/** Records one validated, append-only dataflow fact without wrapping a JS collection. */
export function recordDataflow(event: DataflowEvent): void {
	const session = requireSession('recordDataflow');
	requireDataflowStage(session, event.stage);
	const ids: number[] = [];
	switch (event.t) {
		case 'map': ids.push(...event.parents, ...event.children); break;
		case 'split': ids.push(event.parent, ...event.children); break;
		case 'merge': ids.push(...event.parents, event.child); if (event.rep !== undefined) ids.push(event.rep); break;
		case 'reduce': ids.push(...event.inputs, event.output); break;
		case 'rank': ids.push(event.entity); break;
		case 'select': ids.push(...event.kept, ...event.rejected); break;
		case 'suppress': ids.push(event.entity); if (event.by !== undefined) ids.push(event.by); break;
		case 'relate': ids.push(event.left, event.right); if (event.join !== undefined) ids.push(event.join); break;
	}
	for (const id of ids) requireDataflowEntity(session, id);
	session.dataflow.push(copyDataflowEvent(event));
}
