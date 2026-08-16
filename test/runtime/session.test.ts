// Unit tests on the runtime alone (no compiler involved). See
// test/runtime/integration.test.ts for the proof that this runtime actually satisfies
// Phase 1's real generated output end-to-end.

import { beforeEach, describe, expect, it } from 'vitest';
import * as toph from '../../src/runtime/index.js';

// Every test starts with a guaranteed-clean module state: if a previous test left a
// session active (e.g. it failed before calling finishTrace()), that would otherwise
// leak into the next test as a spurious "already active" error.
beforeEach(() => {
	try {
		toph.finishTrace();
	} catch {
		// No active session to clean up -- fine, that's the expected steady state.
	}
});

describe('startTrace / finishTrace lifecycle', () => {
	it('finishTrace returns a version:1 TraceRun with empty arrays for a session with no activity', () => {
		toph.startTrace();
		const run = toph.finishTrace();
		expect(run).toEqual({ version: 1, stages: [], elements: [], checks: [] });
	});

	it('carries the optional pipeline name through to the returned TraceRun', () => {
		toph.startTrace({ pipeline: 'demo.geometry' });
		const run = toph.finishTrace();
		expect(run.pipeline).toBe('demo.geometry');
	});

	it('omits `pipeline` entirely when not provided (not present as undefined)', () => {
		toph.startTrace();
		const run = toph.finishTrace();
		expect('pipeline' in run).toBe(false);
	});

	it('the returned TraceRun is trivially JSON-serializable (no Maps/Sets/class instances survive)', () => {
		toph.startTrace();
		const s1 = toph.enterStage(1);
		const e1 = toph.enterElement(s1);
		toph.gte(e1, 1, 5, 1);
		toph.keep(e1);
		const run = toph.finishTrace();

		const roundTripped = JSON.parse(JSON.stringify(run));
		expect(roundTripped).toEqual(run);
	});

	it('throws when startTrace() is called while a session is already active', () => {
		toph.startTrace();
		expect(() => toph.startTrace()).toThrow(/already active/i);
	});

	it('finishTrace clears the active session -- a subsequent enterStage() throws until startTrace() runs again', () => {
		toph.startTrace();
		toph.finishTrace();
		expect(() => toph.enterStage(1)).toThrow(/no active trace session/i);
	});
});

describe('calls with no active session fail loudly', () => {
	// No beforeEach startTrace() here -- these all assert the "never call this without a
	// session" failure mode, distinctly from a generic crash.

	it('enterStage() throws a clear, specific error', () => {
		expect(() => toph.enterStage(1)).toThrow(/toph: enterStage\(\).*no active trace session/i);
	});

	it('enterElement() throws a clear, specific error', () => {
		expect(() => toph.enterElement(1)).toThrow(/toph: enterElement\(\).*no active trace session/i);
	});

	it('each comparator throws a clear, specific error', () => {
		expect(() => toph.gte(1, 1, 5, 1)).toThrow(/toph: gte\(\).*no active trace session/i);
		expect(() => toph.lte(1, 1, 5, 1)).toThrow(/toph: lte\(\).*no active trace session/i);
		expect(() => toph.gt(1, 1, 5, 1)).toThrow(/toph: gt\(\).*no active trace session/i);
		expect(() => toph.lt(1, 1, 5, 1)).toThrow(/toph: lt\(\).*no active trace session/i);
		expect(() => toph.eq(1, 1, 5, 1)).toThrow(/toph: eq\(\).*no active trace session/i);
		expect(() => toph.neq(1, 1, 5, 1)).toThrow(/toph: neq\(\).*no active trace session/i);
	});

	it('keep() throws a clear, specific error', () => {
		expect(() => toph.keep(1)).toThrow(/toph: keep\(\).*no active trace session/i);
	});
});

describe('enterStage', () => {
	it('the same stageId run twice produces two distinct invocation ids with seq 0 and 1', () => {
		toph.startTrace();
		const first = toph.enterStage(17);
		const second = toph.enterStage(17);
		const run = toph.finishTrace();

		expect(first).not.toBe(second);
		expect(run.stages).toEqual([
			{ invocationId: first, stageId: 17, seq: 0 },
			{ invocationId: second, stageId: 17, seq: 1 },
		]);
	});

	it('records seq 0, 1, 2 for three invocations of the same stageId, and independent seq counters per stageId', () => {
		toph.startTrace();
		toph.enterStage(17);
		toph.enterStage(5); // different stage -- its own seq counter starts at 0
		toph.enterStage(17);
		toph.enterStage(17);
		const run = toph.finishTrace();

		const seqsForSeventeen = run.stages.filter((s) => s.stageId === 17).map((s) => s.seq);
		expect(seqsForSeventeen).toEqual([0, 1, 2]);

		const seqsForFive = run.stages.filter((s) => s.stageId === 5).map((s) => s.seq);
		expect(seqsForFive).toEqual([0]);
	});

	it('invocation ids are distinct across the whole session, not just per stageId', () => {
		toph.startTrace();
		const ids = [toph.enterStage(1), toph.enterStage(1), toph.enterStage(2)];
		toph.finishTrace();
		expect(new Set(ids).size).toBe(3);
	});
});

describe('enterElement', () => {
	it('ordinals start at 0 and increment per stage invocation', () => {
		toph.startTrace();
		const s = toph.enterStage(1);
		const e0 = toph.enterElement(s);
		const e1 = toph.enterElement(s);
		const e2 = toph.enterElement(s);
		const run = toph.finishTrace();

		const byId = new Map(run.elements.map((e) => [e.id, e]));
		expect(byId.get(e0)?.ordinal).toBe(0);
		expect(byId.get(e1)?.ordinal).toBe(1);
		expect(byId.get(e2)?.ordinal).toBe(2);
	});

	it('ordinals restart at 0 for a fresh stage invocation, even of the same stageId', () => {
		toph.startTrace();
		const s1 = toph.enterStage(9);
		toph.enterElement(s1);
		toph.enterElement(s1);
		const s2 = toph.enterStage(9); // second run of the same logical stage
		const e = toph.enterElement(s2);
		const run = toph.finishTrace();

		const record = run.elements.find((el) => el.id === e);
		expect(record?.ordinal).toBe(0);
		expect(record?.stageInvocationId).toBe(s2);
	});

	it('element ids are distinct across the whole session, including across different stage invocations', () => {
		toph.startTrace();
		const s1 = toph.enterStage(1);
		const s2 = toph.enterStage(2);
		const ids = [toph.enterElement(s1), toph.enterElement(s1), toph.enterElement(s2)];
		toph.finishTrace();
		expect(new Set(ids).size).toBe(3);
	});

	it('throws when given a stageInvocationId that was never produced by enterStage()', () => {
		toph.startTrace();
		expect(() => toph.enterElement(999)).toThrow(/not produced by enterStage/i);
	});
});

describe('comparators', () => {
	let s: number;
	let e: number;

	beforeEach(() => {
		toph.startTrace();
		s = toph.enterStage(1);
		e = toph.enterElement(s);
	});

	const cases: Array<{
		name: 'gte' | 'lte' | 'gt' | 'lt' | 'eq' | 'neq';
		fn: (elementId: number, checkId: number, value: number, threshold: number) => boolean;
		passing: [number, number];
		failing: [number, number];
	}> = [
		{ name: 'gte', fn: toph.gte, passing: [5, 5], failing: [4, 5] },
		{ name: 'lte', fn: toph.lte, passing: [5, 5], failing: [6, 5] },
		{ name: 'gt', fn: toph.gt, passing: [6, 5], failing: [5, 5] },
		{ name: 'lt', fn: toph.lt, passing: [4, 5], failing: [5, 5] },
		{ name: 'eq', fn: toph.eq, passing: [5, 5], failing: [4, 5] },
		{ name: 'neq', fn: toph.neq, passing: [4, 5], failing: [5, 5] },
	];

	for (const { name, fn, passing, failing } of cases) {
		it(`${name}: returns true and records pass:true for a passing comparison`, () => {
			const [value, threshold] = passing;
			const result = fn(e, 42, value, threshold);
			const run = toph.finishTrace();

			expect(result).toBe(true);
			expect(run.checks).toEqual([
				{ stageInvocationId: s, elementId: e, checkId: 42, operator: name, value, threshold, pass: true },
			]);
		});

		it(`${name}: returns false and records pass:false for a failing comparison`, () => {
			const [value, threshold] = failing;
			const result = fn(e, 42, value, threshold);
			const run = toph.finishTrace();

			expect(result).toBe(false);
			expect(run.checks).toEqual([
				{ stageInvocationId: s, elementId: e, checkId: 42, operator: name, value, threshold, pass: false },
			]);
		});
	}

	it('matches native JS operator semantics for NaN edge cases', () => {
		expect(toph.gte(e, 1, NaN, 5)).toBe(false);
		expect(toph.lte(e, 2, NaN, 5)).toBe(false);
		expect(toph.gt(e, 3, NaN, 5)).toBe(false);
		expect(toph.lt(e, 4, NaN, 5)).toBe(false);
		expect(toph.eq(e, 5, NaN, NaN)).toBe(false);
		expect(toph.neq(e, 6, NaN, NaN)).toBe(true);
	});

	it('records checks in call order, including multiple checks for the same element', () => {
		toph.gte(e, 1, 10, 5);
		toph.lte(e, 2, 10, 5); // fails
		toph.eq(e, 3, 10, 10);
		const run = toph.finishTrace();

		expect(run.checks.map((c) => c.checkId)).toEqual([1, 2, 3]);
		expect(run.checks.map((c) => c.pass)).toEqual([true, false, true]);
	});

	it('throws when given an elementId that was never produced by enterElement()', () => {
		expect(() => toph.gte(999, 1, 5, 5)).toThrow(/not produced by enterElement/i);
	});
});

describe('eq/neq on boolean operands', () => {
	let s: number;
	let e: number;

	beforeEach(() => {
		toph.startTrace();
		s = toph.enterStage(1);
		e = toph.enterElement(s);
	});

	it('compares booleans with real === / !== semantics and records real boolean value/threshold in the CheckRecord', () => {
		expect(toph.eq(e, 1, true, true)).toBe(true);
		expect(toph.eq(e, 2, true, false)).toBe(false);
		expect(toph.neq(e, 3, true, false)).toBe(true);
		expect(toph.neq(e, 4, false, false)).toBe(false);
		const run = toph.finishTrace();

		expect(run.checks).toEqual([
			{ stageInvocationId: s, elementId: e, checkId: 1, operator: 'eq', value: true, threshold: true, pass: true },
			{ stageInvocationId: s, elementId: e, checkId: 2, operator: 'eq', value: true, threshold: false, pass: false },
			{ stageInvocationId: s, elementId: e, checkId: 3, operator: 'neq', value: true, threshold: false, pass: true },
			{ stageInvocationId: s, elementId: e, checkId: 4, operator: 'neq', value: false, threshold: false, pass: false },
		]);
		// The recorded value/threshold are real JS booleans, not stringified/coerced.
		expect(typeof run.checks[0].value).toBe('boolean');
		expect(typeof run.checks[0].threshold).toBe('boolean');
	});

	it('the returned TraceRun with boolean-valued checks is still trivially JSON-serializable', () => {
		toph.eq(e, 1, true, false);
		const run = toph.finishTrace();
		expect(JSON.parse(JSON.stringify(run))).toEqual(run);
	});

	it('gte/lte/gt/lt reject boolean arguments at the TYPE level; eq/neq accept them -- checked by tsc, never executed at runtime', () => {
		// This function is intentionally never called. Its only purpose is to be
		// typechecked by `tsc --noEmit -p .` (vitest's own transform does not typecheck),
		// proving gte/lte/gt/lt stayed strictly number-only (makeCheck<number>) while
		// eq/neq were deliberately widened to makeCheck<number | boolean>. Referencing it
		// via `typeof` below keeps it from being flagged as an unused declaration.
		function typeOnlyChecks(): void {
			// @ts-expect-error -- gte is number-only; a boolean value/threshold must be rejected.
			toph.gte(1, 1, true, false);
			// @ts-expect-error -- lte is number-only.
			toph.lte(1, 1, true, false);
			// @ts-expect-error -- gt is number-only.
			toph.gt(1, 1, true, false);
			// @ts-expect-error -- lt is number-only.
			toph.lt(1, 1, true, false);
			// No @ts-expect-error here: eq/neq must compile cleanly with boolean arguments.
			toph.eq(1, 1, true, false);
			toph.neq(1, 1, true, false);
		}
		expect(typeof typeOnlyChecks).toBe('function');
	});
});

describe('keep', () => {
	it('flips the kept flag of exactly the given element, leaving others untouched', () => {
		toph.startTrace();
		const s = toph.enterStage(1);
		const a = toph.enterElement(s);
		const b = toph.enterElement(s);
		const c = toph.enterElement(s);

		toph.keep(b);
		const run = toph.finishTrace();

		const byId = new Map(run.elements.map((el) => [el.id, el.kept]));
		expect(byId.get(a)).toBe(false);
		expect(byId.get(b)).toBe(true);
		expect(byId.get(c)).toBe(false);
	});

	it('throws when given an elementId that was never produced by enterElement()', () => {
		toph.startTrace();
		expect(() => toph.keep(999)).toThrow(/not produced by enterElement/i);
		toph.finishTrace();
	});
});
