// Item 2: exceptions from a check operand propagate unchanged, and prior recorded
// trace state survives a mid-run throw.
//
// Fixture: computeArea() throws a RangeError for a negative area. The predicate is
// `computeArea(component) >= minArea`. Data is arranged so 2 elements are fully
// evaluated (one keeps, one fails the check normally) BEFORE the 3rd element's operand
// evaluation throws.

import { describe, expect, it } from 'vitest';
import { compileTrace, createIdAllocator } from '../../src/compiler/index.js';
import { execModuleWithRealRuntime, execPlainModule } from './support/execModuleWithRealRuntime.js';

interface Component {
	area: number;
}

const componentsLiteral = '[{ area: 50 }, { area: 5 }, { area: -1 }]';

function buildSource(): string {
	return [
		'export interface Component { area: number; }',
		'export function computeArea(c: Component): number {',
		'  if (c.area < 0) throw new RangeError("negative area: " + c.area);',
		'  return c.area;',
		'}',
		`export const components: Component[] = ${componentsLiteral};`,
		'export const minArea = 10;',
		'',
		'/** @toph filter demo.throw */',
		'const survivors = components.filter((component) => {',
		'  /** @toph check area.min */',
		'  const areaOk = computeArea(component) >= minArea;',
		'  if (!areaOk) return false;',
		'  return true;',
		'});',
		'',
		'export { survivors };',
		'',
	].join('\n');
}

describe('exceptions from a check operand propagate unchanged (not swallowed, not wrapped, not turned into pass:false)', () => {
	it('the original (un-instrumented) predicate throws RangeError("negative area: -1")', async () => {
		const source = buildSource();
		// compileProduction's code is byte-identical to source (nothing rewritten) --
		// executing it directly is executing the real, original, un-instrumented
		// predicate.
		const { moduleExports, error } = await execPlainModule<{ survivors: Component[] }>(source);
		expect(moduleExports).toBeNull();
		expect(error).not.toBeNull();
		expect(error!.name).toBe('RangeError');
		expect(error!.message).toBe('negative area: -1');
	});

	it('the trace-mode compiled version throws the IDENTICAL error (same type, same message)', () => {
		const source = buildSource();
		const result = compileTrace('throws.ts', source, createIdAllocator());
		expect(result.diagnostics).toEqual([]);

		const { moduleExports, error } = execModuleWithRealRuntime<{ survivors: Component[] }>(result.code);
		expect(moduleExports).toBeNull();
		expect(error).not.toBeNull();
		expect(error!.name).toBe('RangeError');
		expect(error!.message).toBe('negative area: -1');
	});

	it('check events recorded for elements evaluated BEFORE the throwing element survive intact in the partial trace', () => {
		const source = buildSource();
		const result = compileTrace('throws.ts', source, createIdAllocator());
		expect(result.diagnostics).toEqual([]);
		const [check] = result.manifest.checks;

		const { trace, error } = execModuleWithRealRuntime(result.code);
		expect(error).not.toBeNull();
		expect(error!.name).toBe('RangeError');

		// Exactly 1 stage invocation was started (enterStage happens before the .filter()
		// callback runs at all).
		expect(trace.stages).toHaveLength(1);

		// 3 elements entered evaluation: element 0 (area 50, passes+kept), element 1 (area
		// 5, fails normally), element 2 (area -1, enterElement() itself succeeds -- it's
		// called before the throwing computeArea() -- but never gets a check event or a
		// keep(), because computeArea() throws while evaluating gte()'s arguments, before
		// gte() is ever entered).
		expect(trace.elements).toHaveLength(3);
		const byOrdinal = [...trace.elements].sort((a, b) => a.ordinal - b.ordinal);
		expect(byOrdinal.map((e) => e.ordinal)).toEqual([0, 1, 2]);
		expect(byOrdinal.map((e) => e.kept)).toEqual([true, false, false]);

		// Exactly 2 check events recorded (for elements 0 and 1) -- nothing corrupted,
		// nothing duplicated, nothing missing among the elements that DID complete.
		expect(trace.checks).toHaveLength(2);
		expect(trace.checks[0]).toMatchObject({
			elementId: byOrdinal[0].id,
			checkId: check.id,
			value: 50,
			threshold: 10,
			pass: true,
		});
		expect(trace.checks[1]).toMatchObject({
			elementId: byOrdinal[1].id,
			checkId: check.id,
			value: 5,
			threshold: 10,
			pass: false,
		});
		// No check event at all -- of any kind -- references the throwing element.
		expect(trace.checks.some((c) => c.elementId === byOrdinal[2].id)).toBe(false);

		// The whole partial TraceRun still round-trips cleanly through JSON.
		expect(JSON.parse(JSON.stringify(trace))).toEqual(trace);
	});
});
