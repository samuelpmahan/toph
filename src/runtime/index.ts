// Toph runtime (Phase 2).
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
 * elementId) which one short-circuited the rest. */
export interface CheckRecord {
	stageInvocationId: number;
	elementId: number;
	checkId: number;
	operator: CheckOperator;
	value: number;
	threshold: number;
	pass: boolean;
}

/** The full accumulated output of one trace session. Always a plain, JSON-serializable
 * object -- no class instances, Maps, or Sets anywhere in this shape. */
export interface TraceRun {
	version: 1;
	pipeline?: string;
	stages: StageInvocationRecord[];
	elements: ElementRecord[];
	checks: CheckRecord[];
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
	 * can find/mutate the same object that lives in `elements`, in O(1). */
	elementsById: Map<number, ElementRecord>;
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
 * next, ...), not global across the whole session. */
export function enterElement(stageInvocationId: number): number {
	const session = requireSession('enterElement');
	const ordinal = session.nextOrdinalByStageInvocation.get(stageInvocationId);
	if (ordinal === undefined) {
		throw new Error(
			`toph: enterElement() was called with stage invocation id ${stageInvocationId}, ` +
				'which was not produced by enterStage() in the current trace session.'
		);
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

function makeCheck(operator: CheckOperator, compare: (value: number, threshold: number) => boolean) {
	return (elementId: number, checkId: number, value: number, threshold: number): boolean => {
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

export const gte = makeCheck('gte', (value, threshold) => value >= threshold);
export const lte = makeCheck('lte', (value, threshold) => value <= threshold);
export const gt = makeCheck('gt', (value, threshold) => value > threshold);
export const lt = makeCheck('lt', (value, threshold) => value < threshold);
export const eq = makeCheck('eq', (value, threshold) => value === threshold);
export const neq = makeCheck('neq', (value, threshold) => value !== threshold);

/** Marks an element as a survivor of its filter stage. This is the only explicit
 * "outcome" call generated code makes -- rejection is never recorded directly, it is
 * simply the absence of a keep() call for that element id (see the module doc
 * comment). */
export function keep(elementId: number): void {
	const session = requireSession('keep');
	const element = lookupElement(session, 'keep', elementId);
	element.kept = true;
}
