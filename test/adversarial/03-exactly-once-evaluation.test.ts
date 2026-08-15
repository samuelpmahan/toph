// Item 3: exactly-once evaluation of check operands, proven by side effect (not by
// inspecting generated code text). A re-evaluation bug would show up as an extra log
// entry per element; a lost-evaluation bug would show up as a missing one.
//
// The FIRST check's operands are BOTH side-effecting calls (nextLeft on the left,
// nextRight on the right) -- this catches either side being duplicated for the SAME
// check, as the task explicitly asks for ("do this for both operands of at least one
// check"). A second, plain check creates a short-circuit differential so we can also
// confirm the side-effect logs correctly reflect "only evaluated for elements that
// actually reached this check" (not evaluated for elements that short-circuited
// earlier).

import { describe, expect, it } from 'vitest';
import { compileTrace, createIdAllocator } from '../../src/compiler/index.js';
import { execModuleWithRealRuntime } from './support/execModuleWithRealRuntime.js';

interface Component {
	id: number;
	area: number;
	aspect: number;
}

function buildSource(): string {
	return [
		'export interface Component { id: number; area: number; aspect: number; }',
		'export const leftLog: number[] = [];',
		'export const rightLog: number[] = [];',
		'export function nextLeft(id: number, value: number): number { leftLog.push(id); return value; }',
		'export function nextRight(id: number, value: number): number { rightLog.push(id); return value; }',
		'',
		'export const components: Component[] = [',
		'  { id: 1, area: 200, aspect: 1.2 },',
		'  { id: 2, area: 50, aspect: 1.5 },',
		'  { id: 3, area: 300, aspect: 4.0 },',
		'];',
		'export const minArea = 100;',
		'export const maxAspect = 2.0;',
		'',
		'/** @toph filter demo.sideeffect */',
		'const survivors = components.filter((component) => {',
		'  /** @toph check area.min */',
		'  const areaOk = nextLeft(component.id, component.area) >= nextRight(component.id, minArea);',
		'  if (!areaOk) return false;',
		'  /** @toph check aspect.max */',
		'  const aspectOk = component.aspect <= maxAspect;',
		'  if (!aspectOk) return false;',
		'  return true;',
		'});',
		'',
		'export { survivors };',
		'',
	].join('\n');
}

describe('exactly-once evaluation of both operands of a check', () => {
	it('leftLog and rightLog each have exactly one entry per element that reached the check -- no duplicates, no misses', () => {
		const source = buildSource();
		const result = compileTrace('sideeffect.ts', source, createIdAllocator());
		expect(result.diagnostics).toEqual([]);
		const [areaCheck, aspectCheck] = result.manifest.checks;

		const { moduleExports, trace, error } = execModuleWithRealRuntime<{
			survivors: Component[];
			leftLog: number[];
			rightLog: number[];
		}>(result.code);
		expect(error).toBeNull();

		// Sanity: id1 (area200>=100, aspect1.2<=2.0) survives; id2 fails area (short
		// circuits before aspect); id3 passes area but fails aspect.
		expect(moduleExports?.survivors).toEqual([{ id: 1, area: 200, aspect: 1.2 }]);

		// area.min is the FIRST check -- it always runs for every element regardless of
		// pass/fail, so BOTH its operands (nextLeft, nextRight) must have been called
		// exactly once per element: ids [1,2,3], in evaluation order, no repeats.
		expect(moduleExports?.leftLog).toEqual([1, 2, 3]);
		expect(moduleExports?.rightLog).toEqual([1, 2, 3]);

		// Cross-check against the recorded trace: exactly 3 area.min check events (one per
		// element), and exactly 2 aspect.max check events (only elements that passed
		// area.min: id1, id3 -- id2 short-circuited before reaching it).
		const areaEvents = trace.checks.filter((c) => c.checkId === areaCheck.id);
		const aspectEvents = trace.checks.filter((c) => c.checkId === aspectCheck.id);
		expect(areaEvents).toHaveLength(3);
		expect(aspectEvents).toHaveLength(2);

		// The recorded `value`/`threshold` for each area.min event are exactly what
		// nextLeft/nextRight returned (pass-through) -- proving the SAME evaluated result
		// was both used for the comparison AND recorded, not a second independent
		// re-evaluation that happened to log once but compare a different value.
		const byElementOrdinal = [...trace.elements].sort((a, b) => a.ordinal - b.ordinal);
		expect(areaEvents.map((c) => c.value)).toEqual(
			byElementOrdinal.map((_, i) => [200, 50, 300][i])
		);
		expect(areaEvents.map((c) => c.threshold)).toEqual([100, 100, 100]);
	});

	it('re-running with fresh IDs (a second independent compile) reproduces identical log shape -- not an artifact of shared allocator state', () => {
		const source = buildSource();
		const result = compileTrace('sideeffect2.ts', source, createIdAllocator(500, 900));
		expect(result.diagnostics).toEqual([]);
		const { moduleExports, error } = execModuleWithRealRuntime<{ leftLog: number[]; rightLog: number[] }>(
			result.code
		);
		expect(error).toBeNull();
		expect(moduleExports?.leftLog).toEqual([1, 2, 3]);
		expect(moduleExports?.rightLog).toEqual([1, 2, 3]);
	});
});
