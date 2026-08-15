// Item 4: a 3+ check chain -- when check 2 fails, checks 3 (and 4) produce ZERO
// events, proven by scanning the WHOLE trace for any check record with that checkId
// for the failing element (not merely "count is zero" on a pre-filtered slice, which
// could hide a bug if the filter predicate itself were wrong).

import { describe, expect, it } from 'vitest';
import { compileTrace, createIdAllocator } from '../../src/compiler/index.js';
import { execModuleWithRealRuntime } from './support/execModuleWithRealRuntime.js';

interface Component {
	id: number;
	area: number;
	aspect: number;
	count: number;
	ratio: number;
}

function buildSource(): string {
	return [
		'export interface Component { id: number; area: number; aspect: number; count: number; ratio: number; }',
		'export const components: Component[] = [',
		'  { id: 1, area: 200, aspect: 1.2, count: 5, ratio: 0.5 },', // passes all 4
		'  { id: 2, area: 200, aspect: 9.0, count: 5, ratio: 0.5 },', // fails check 2 (aspect)
		'];',
		'export const minArea = 100;',
		'export const maxAspect = 2.0;',
		'export const minCount = 1;',
		'export const maxRatio = 1.0;',
		'',
		'/** @toph filter demo.chain4 */',
		'const survivors = components.filter((component) => {',
		'  /** @toph check c1.area */',
		'  const c1 = component.area >= minArea;',
		'  if (!c1) return false;',
		'  /** @toph check c2.aspect */',
		'  const c2 = component.aspect <= maxAspect;',
		'  if (!c2) return false;',
		'  /** @toph check c3.count */',
		'  const c3 = component.count >= minCount;',
		'  if (!c3) return false;',
		'  /** @toph check c4.ratio */',
		'  const c4 = component.ratio <= maxRatio;',
		'  if (!c4) return false;',
		'  return true;',
		'});',
		'',
		'export { survivors };',
		'',
	].join('\n');
}

describe('a 4-check chain: failure at check 2 produces zero events for checks 3 and 4', () => {
	it('checks 3 and 4 never appear ANYWHERE in the trace for the element that failed check 2', () => {
		const source = buildSource();
		const result = compileTrace('chain4.ts', source, createIdAllocator());
		expect(result.diagnostics).toEqual([]);
		expect(result.manifest.checks).toHaveLength(4);
		const [c1, c2, c3, c4] = result.manifest.checks;

		const { moduleExports, trace, error } = execModuleWithRealRuntime<{ survivors: Component[] }>(result.code);
		expect(error).toBeNull();
		expect(moduleExports?.survivors).toEqual([components()[0]]);

		const byOrdinal = [...trace.elements].sort((a, b) => a.ordinal - b.ordinal);
		const [elPass, elFailAt2] = byOrdinal;

		// Element 0 (all-pass) proves checks 3 and 4 CAN and DO run when reached -- this
		// makes the "zero events for element 1" assertion below meaningful rather than
		// vacuously true because checks 3/4 never fire for anyone.
		expect(elPass.kept).toBe(true);
		for (const check of [c1, c2, c3, c4]) {
			expect(
				trace.checks.some((c) => c.elementId === elPass.id && c.checkId === check.id)
			).toBe(true);
		}

		// Element 1 fails check 2 (aspect 9.0 > 2.0). It must have EXACTLY check 1 (pass)
		// and check 2 (fail) recorded, and check 3/4 must not appear anywhere in the
		// entire trace.checks array for this element -- scanning the whole array, not a
		// pre-filtered slice.
		expect(elFailAt2.kept).toBe(false);
		const eventsForFailedElement = trace.checks.filter((c) => c.elementId === elFailAt2.id);
		expect(eventsForFailedElement).toHaveLength(2);
		expect(eventsForFailedElement.map((c) => c.checkId)).toEqual([c1.id, c2.id]);
		expect(eventsForFailedElement[0].pass).toBe(true);
		expect(eventsForFailedElement[1].pass).toBe(false);

		// The stronger assertion the task explicitly asks for: no record with checkId 3 or
		// 4 exists ANYWHERE in the trace that also references the failing element's id --
		// scan trace.checks in full, not `eventsForFailedElement`.
		expect(trace.checks.some((c) => c.elementId === elFailAt2.id && c.checkId === c3.id)).toBe(false);
		expect(trace.checks.some((c) => c.elementId === elFailAt2.id && c.checkId === c4.id)).toBe(false);
	});
});

function components(): Component[] {
	return [
		{ id: 1, area: 200, aspect: 1.2, count: 5, ratio: 0.5 },
		{ id: 2, area: 200, aspect: 9.0, count: 5, ratio: 0.5 },
	];
}
