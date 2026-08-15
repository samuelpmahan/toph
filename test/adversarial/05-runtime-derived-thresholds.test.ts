// Item 5: runtime-derived (non-literal) thresholds. Mirrors the real ChainSpot pattern
// (`basketMedianArea * 0.09`, per IMPLEMENTATION-DECISIONS.md section 9's patch plan)
// -- the check's threshold is `median(sizes) * 0.09`, not a literal. Proves the
// recorded `threshold` in the check event is the ACTUAL runtime-computed number for
// that specific run, by changing the input data between two separately compiled+
// executed runs and confirming the recorded threshold tracks it exactly.

import { describe, expect, it } from 'vitest';
import { compileTrace, createIdAllocator } from '../../src/compiler/index.js';
import { execModuleWithRealRuntime } from './support/execModuleWithRealRuntime.js';

interface Component {
	area: number;
}

function median(xs: number[]): number {
	const sorted = [...xs].sort((a, b) => a - b);
	const mid = Math.floor(sorted.length / 2);
	return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

function buildSource(sizes: number[]): string {
	return [
		'export function median(xs: number[]): number {',
		'  const sorted = [...xs].sort((a, b) => a - b);',
		'  const mid = Math.floor(sorted.length / 2);',
		'  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];',
		'}',
		'',
		'export interface Component { area: number; }',
		`export const sizes: number[] = ${JSON.stringify(sizes)};`,
		'export const components: Component[] = [{ area: 5 }, { area: 50 }];',
		'',
		'/** @toph filter demo.threshold */',
		'const survivors = components.filter((component) => {',
		'  /** @toph check area.min */',
		'  const areaOk = component.area >= median(sizes) * 0.09;',
		'  if (!areaOk) return false;',
		'  return true;',
		'});',
		'',
		'export { survivors };',
		'',
	].join('\n');
}

describe('a computed (non-literal) threshold is recorded as its actual runtime value', () => {
	it('run 1 (sizes=[10,20,30], median=20, threshold=1.8): recorded threshold is 1.8, not a placeholder', () => {
		const sizes = [10, 20, 30];
		const expectedThreshold = median(sizes) * 0.09;
		expect(expectedThreshold).toBeCloseTo(1.8, 10);

		const source = buildSource(sizes);
		const result = compileTrace('threshold1.ts', source, createIdAllocator());
		expect(result.diagnostics).toEqual([]);

		// The generated code passes the *expression text* `median(sizes) * 0.09` verbatim
		// as the argument -- not a pre-computed literal baked in by the compiler. This is
		// the compile-time half of the claim: nothing about the threshold is known until
		// runtime.
		expect(result.code).toContain('median(sizes) * 0.09');
		expect(result.code).not.toMatch(/\b1\.8\b/);

		const { trace, error } = execModuleWithRealRuntime(result.code);
		expect(error).toBeNull();
		expect(trace.checks).toHaveLength(2);
		for (const check of trace.checks) {
			expect(check.threshold).toBe(expectedThreshold);
			expect(check.threshold).toBeCloseTo(1.8, 10);
		}
		// area=5 >= 1.8 -> pass; area=50 >= 1.8 -> pass.
		expect(trace.checks.map((c) => c.pass)).toEqual([true, true]);
	});

	it('run 2 (sizes=[100,200,300], median=200, threshold=18): recorded threshold changes to 18 accordingly', () => {
		const sizes = [100, 200, 300];
		const expectedThreshold = median(sizes) * 0.09;
		expect(expectedThreshold).toBeCloseTo(18, 10);

		const source = buildSource(sizes);
		const result = compileTrace('threshold2.ts', source, createIdAllocator());
		expect(result.diagnostics).toEqual([]);

		const { trace, error } = execModuleWithRealRuntime(result.code);
		expect(error).toBeNull();
		expect(trace.checks).toHaveLength(2);
		for (const check of trace.checks) {
			expect(check.threshold).toBe(expectedThreshold);
			expect(check.threshold).toBeCloseTo(18, 10);
		}
		// area=5 >= 18 -> fail; area=50 >= 18 -> pass. Different outcome than run 1 too,
		// confirming the SAME compiled shape genuinely re-derives the threshold at runtime
		// rather than caching/memoizing anything from a previous compile or run.
		expect(trace.checks.map((c) => c.pass)).toEqual([false, true]);
	});

	it('the two runs\' recorded thresholds are different numbers, proving it tracks input data, not compile-time state', () => {
		const source1 = buildSource([10, 20, 30]);
		const source2 = buildSource([100, 200, 300]);
		const result1 = compileTrace('threshold1.ts', source1, createIdAllocator());
		const result2 = compileTrace('threshold2.ts', source2, createIdAllocator());

		const { trace: trace1 } = execModuleWithRealRuntime(result1.code);
		const { trace: trace2 } = execModuleWithRealRuntime(result2.code);

		expect(trace1.checks[0].threshold).not.toBe(trace2.checks[0].threshold);
		expect(trace1.checks[0].threshold).toBeCloseTo(1.8, 10);
		expect(trace2.checks[0].threshold).toBeCloseTo(18, 10);
	});
});
