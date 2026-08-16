// Boolean-typed `@toph check`: a real production filter condition that is a plain
// boolean function call rather than a numeric comparison (ChainSpot's
// `centerFallsInsideBadge(component, badges, margin)`) gets expressed under the
// EXISTING directive shape as an explicit equality comparison against a boolean
// literal:
//
//   /** @toph check badge-overlap */
//   const badgeOverlapOk = centerFallsInsideBadge(component, margin) === false;
//   if (!badgeOverlapOk) return false;
//
// This mirrors test/adversarial/03-exactly-once-evaluation.test.ts (call-counting
// fixture proving exactly-once evaluation) and
// test/adversarial/04-checks-not-executed-after-failure.test.ts (proving a failing
// check short-circuits later checks in the same stage, absence visible in the whole
// trace, not just a pre-filtered slice) -- applied to a boolean-valued first check
// instead of a numeric one.

import { describe, expect, it } from 'vitest';
import { compileTrace, compileProduction, createIdAllocator } from '../../src/compiler/index.js';
import { execModuleWithRealRuntime } from './support/execModuleWithRealRuntime.js';

interface Component {
	id: number;
	cx: number;
	area: number;
}

// cx(5) < margin(10)  -> centerFallsInsideBadge = true  -> badgeOverlapOk = false -> FAILS badge check, short-circuits (area check never runs)
// cx(50) < margin(10) -> centerFallsInsideBadge = false -> badgeOverlapOk = true  -> PASSES badge check; area(50) >= minArea(100) is false -> FAILS area check
// cx(60) < margin(10) -> centerFallsInsideBadge = false -> badgeOverlapOk = true  -> PASSES badge check; area(300) >= minArea(100) is true -> PASSES -> SURVIVES
const components: Component[] = [
	{ id: 1, cx: 5, area: 200 },
	{ id: 2, cx: 50, area: 50 },
	{ id: 3, cx: 60, area: 300 },
];
const margin = 10;
const minArea = 100;

function buildSource(): string {
	return [
		'export interface Component { id: number; cx: number; area: number; }',
		'export const badgeCallLog: number[] = [];',
		'export function centerFallsInsideBadge(component: Component, m: number): boolean {',
		'  badgeCallLog.push(component.id);',
		'  return component.cx < m;',
		'}',
		'',
		`export const components: Component[] = ${JSON.stringify(components)};`,
		`export const margin = ${margin};`,
		`export const minArea = ${minArea};`,
		'',
		'/** @toph filter badge.overlap */',
		'const survivors = components.filter((component) => {',
		'  /** @toph check badge-overlap */',
		'  const badgeOverlapOk = centerFallsInsideBadge(component, margin) === false;',
		'  if (!badgeOverlapOk) return false;',
		'  /** @toph check area.min */',
		'  const areaOk = component.area >= minArea;',
		'  if (!areaOk) return false;',
		'  return true;',
		'});',
		'',
		'export { survivors };',
		'',
	].join('\n');
}

describe('boolean-valued @toph check (ChainSpot-shaped: <boolean expr> === false)', () => {
	it('compiles with no diagnostics -- the compiler layer needs zero changes for a boolean equality check', () => {
		const result = compileTrace('badge-overlap.ts', buildSource(), createIdAllocator());
		expect(result.diagnostics).toEqual([]);
		expect(result.manifest.checks.map((c) => c.code)).toEqual(['badge-overlap', 'area.min']);
		expect(result.manifest.checks[0].operator).toBe('===');
	});

	it('run through the FULL real pipeline (compileTrace -> real runtime): CheckRecord.value/threshold are real booleans, pass computed by real === semantics, survivors match the un-instrumented predicate', () => {
		const source = buildSource();
		const result = compileTrace('badge-overlap.ts', source, createIdAllocator());
		expect(result.diagnostics).toEqual([]);
		const [badgeCheck, areaCheck] = result.manifest.checks;

		const expectedSurvivors = components.filter((component) => {
			const badgeOverlapOk = (component.cx < margin) === false;
			if (!badgeOverlapOk) return false;
			const areaOk = component.area >= minArea;
			if (!areaOk) return false;
			return true;
		});
		expect(expectedSurvivors).toEqual([components[2]]);

		const { moduleExports, trace, error } = execModuleWithRealRuntime<{
			survivors: Component[];
			badgeCallLog: number[];
		}>(result.code);
		expect(error).toBeNull();
		expect(moduleExports?.survivors).toEqual(expectedSurvivors);

		const elementsByOrdinal = [...trace.elements].sort((a, b) => a.ordinal - b.ordinal);
		expect(elementsByOrdinal.map((e) => e.kept)).toEqual([false, false, true]);
		const [el1, el2, el3] = elementsByOrdinal;

		// Every badge-overlap check event -- the first check in the stage, so it always
		// runs regardless of pass/fail -- carries a real boolean `value` (the LEFT
		// operand's actual return value) and a real boolean `threshold` (the literal
		// `false` on the right), not a number, not a stringified boolean.
		const badgeEvents = trace.checks.filter((c) => c.checkId === badgeCheck.id);
		expect(badgeEvents).toHaveLength(3);
		for (const event of badgeEvents) {
			expect(typeof event.value).toBe('boolean');
			expect(typeof event.threshold).toBe('boolean');
			expect(event.threshold).toBe(false);
		}
		// component 1: centerFallsInsideBadge -> true, so value:true, threshold:false,
		// real `===` says true !== false -> pass:false.
		expect(badgeEvents.find((e) => e.elementId === el1.id)).toMatchObject({ value: true, threshold: false, pass: false });
		// components 2 and 3: centerFallsInsideBadge -> false, so value:false,
		// threshold:false, real `===` says false === false -> pass:true.
		expect(badgeEvents.find((e) => e.elementId === el2.id)).toMatchObject({ value: false, threshold: false, pass: true });
		expect(badgeEvents.find((e) => e.elementId === el3.id)).toMatchObject({ value: false, threshold: false, pass: true });

		// area.min only ran for elements that passed the boolean badge check (2 and 3).
		const areaEvents = trace.checks.filter((c) => c.checkId === areaCheck.id);
		expect(areaEvents).toHaveLength(2);
		const numericSort = (a: number, b: number) => a - b;
		expect(areaEvents.map((c) => c.elementId).sort(numericSort)).toEqual([el2.id, el3.id].sort(numericSort));

		// The whole TraceRun -- boolean-valued checks included -- round-trips through
		// JSON with no loss.
		expect(JSON.parse(JSON.stringify(trace))).toEqual(trace);
	});

	it('exact control-flow preservation: a FAILING boolean check short-circuits exactly like a failing numeric one -- the later numeric check never runs for that element, and its absence is visible in the trace (not just "did the code not throw")', () => {
		const source = buildSource();
		const result = compileTrace('badge-overlap.ts', source, createIdAllocator());
		expect(result.diagnostics).toEqual([]);
		const [badgeCheck, areaCheck] = result.manifest.checks;

		const { trace, error } = execModuleWithRealRuntime<{ survivors: Component[] }>(result.code);
		expect(error).toBeNull();

		// Element 1 (id 1, cx 5) fails the boolean badge-overlap check.
		const el1 = trace.elements.find((e) => e.ordinal === 0)!;
		expect(el1.kept).toBe(false);

		// It has EXACTLY one check event (badge-overlap, failing) -- scanning the WHOLE
		// trace.checks array, not a pre-filtered slice, per the existing
		// checks-not-executed-after-failure pattern.
		const eventsForEl1 = trace.checks.filter((c) => c.elementId === el1.id);
		expect(eventsForEl1).toHaveLength(1);
		expect(eventsForEl1[0].checkId).toBe(badgeCheck.id);
		expect(eventsForEl1[0].pass).toBe(false);
		expect(trace.checks.some((c) => c.elementId === el1.id && c.checkId === areaCheck.id)).toBe(false);

		// Elements 2 and 3 (which DO pass the boolean check) prove area.min CAN and DOES
		// run when reached -- making the absence above meaningful, not vacuous.
		const el2 = trace.elements.find((e) => e.ordinal === 1)!;
		const el3 = trace.elements.find((e) => e.ordinal === 2)!;
		expect(trace.checks.some((c) => c.elementId === el2.id && c.checkId === areaCheck.id)).toBe(true);
		expect(trace.checks.some((c) => c.elementId === el3.id && c.checkId === areaCheck.id)).toBe(true);
	});

	it('the boolean-valued expression is evaluated exactly once per element -- a call-counting fixture proves no duplicate and no missed evaluation', () => {
		const source = buildSource();
		const result = compileTrace('badge-overlap.ts', source, createIdAllocator());
		expect(result.diagnostics).toEqual([]);

		const { moduleExports, error } = execModuleWithRealRuntime<{ badgeCallLog: number[] }>(result.code);
		expect(error).toBeNull();

		// badge-overlap is the FIRST check -- it always runs for every element regardless
		// of pass/fail, so centerFallsInsideBadge (the boolean expression's side-effecting
		// left operand) must have been called exactly once per element: ids [1, 2, 3], in
		// evaluation order, no repeats, no misses.
		expect(moduleExports?.badgeCallLog).toEqual([1, 2, 3]);
	});

	it('compileProduction on the same boolean-check source is byte-identical to the original source -- production erasure is unaffected by this runtime-only change', () => {
		const source = buildSource();
		const result = compileProduction('badge-overlap.ts', source);
		expect(result.diagnostics).toEqual([]);
		expect(result.code).toBe(source);
	});
});
