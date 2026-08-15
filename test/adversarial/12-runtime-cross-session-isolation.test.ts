// Item 12: runtime-level adversarial case -- session isolation, not just
// single-session correctness.
//
// Checked first: test/runtime/session.test.ts's "throws when given a stageInvocationId
// that was never produced by enterStage()" test uses id 999, which was NEVER valid in
// ANY session -- it doesn't prove isolation between sessions, only that garbage input
// is rejected. This test specifically reuses a stageInvocationId that WAS valid in a
// previous, now-finished session, deliberately choosing a small id (nextStageInvocationId
// resets to 1 on every startTrace()) so it's numerically identical to what the new
// session's own counters would produce -- proving rejection happens because bookkeeping
// is scoped to a fresh Session object per startTrace(), not because the number itself
// looks out of range.

import { describe, expect, it } from 'vitest';
import * as toph from '../../src/runtime/index.js';

describe('a stage invocation id valid in a PREVIOUS (finished) session is rejected by a NEW session', () => {
	it('throws "not produced by enterStage() in the current trace session" rather than silently succeeding against stale bookkeeping', () => {
		// Session 1: run to completion.
		toph.startTrace();
		const staleInvocationId = toph.enterStage(999); // stageId is just a label; invocationId is 1
		toph.enterElement(staleInvocationId);
		const finishedRun = toph.finishTrace();
		expect(finishedRun.stages).toEqual([{ invocationId: staleInvocationId, stageId: 999, seq: 0 }]);

		// Session 2: brand new session. Nothing has called enterStage() in it yet.
		toph.startTrace();
		try {
			expect(() => toph.enterElement(staleInvocationId)).toThrow(
				/not produced by enterStage\(\) in the current trace session/i
			);

			// Also try the comparators and keep() directly against the stale id, in case a
			// caller skipped straight to one of them -- same isolation guarantee must hold
			// for every entry point that accepts an id, not just enterElement().
			expect(() => toph.keep(staleInvocationId)).toThrow(/not produced by enterElement\(\)/i);
			expect(() => toph.gte(staleInvocationId, 1, 5, 1)).toThrow(/not produced by enterElement\(\)/i);
		} finally {
			toph.finishTrace();
		}
	});

	it('once session 2 legitimately produces its OWN invocation with the same numeric id, that one works normally -- proving the rejection above was about session scope, not the number', () => {
		toph.startTrace();
		const idSession1 = toph.enterStage(999);
		toph.finishTrace();

		toph.startTrace();
		const idSession2 = toph.enterStage(1); // first enterStage() in a fresh session -> also invocationId 1
		expect(idSession2).toBe(idSession1); // same numeric id, different session -- the coincidence that matters
		const elementId = toph.enterElement(idSession2); // legitimate in THIS session -> must succeed
		expect(() => toph.keep(elementId)).not.toThrow();
		const run = toph.finishTrace();
		expect(run.elements).toHaveLength(1);
		expect(run.elements[0].kept).toBe(true);
	});

	it('an element id valid in a previous session is likewise rejected by keep()/comparators in a new session', () => {
		toph.startTrace();
		const s1 = toph.enterStage(1);
		const staleElementId = toph.enterElement(s1);
		toph.finishTrace();

		toph.startTrace();
		try {
			expect(() => toph.keep(staleElementId)).toThrow(/not produced by enterElement\(\)/i);
			expect(() => toph.lte(staleElementId, 1, 5, 1)).toThrow(/not produced by enterElement\(\)/i);
		} finally {
			toph.finishTrace();
		}
	});
});
