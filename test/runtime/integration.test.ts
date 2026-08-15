// Integration test proving the REAL runtime (src/runtime/index.ts) actually satisfies
// Phase 1's real compiler output -- not just this phase's own unit tests in isolation.
//
// Reuses the exact same fixture and sample data Phase 1's own behavioral test
// (test/compiler/behavioral.test.ts) used to prove the compiler's output correct
// against the fake runtime; this test proves the same property against the real thing.
// Per the task scope, this is a new, separate test file -- the Phase 1 fake-runtime
// test infrastructure (test/compiler/*) is untouched.

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { compileTrace, createIdAllocator } from '../../src/compiler/index.js';
import { execWithRealRuntime, execSequenceWithRealRuntime } from './support/execWithRealRuntime.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const fixturePath = join(__dirname, '..', 'compiler', 'fixtures', 'demo-geometry.ts');
const fixtureSource = readFileSync(fixturePath, 'utf8');

interface Component {
	area: number;
	aspect: number;
}

// Same three cases test/compiler/behavioral.test.ts uses:
//   (a) passes both checks
//   (b) fails the first check (area.min) -- must short-circuit, no second check event
//   (c) passes the first check, fails the second (aspect.max)
const sampleComponents: Component[] = [
	{ area: 200, aspect: 1.2 }, // (a)
	{ area: 50, aspect: 1.5 }, // (b)
	{ area: 300, aspect: 4.0 }, // (c)
];
const minArea = 100;
const maxAspect = 2.0;

function replaceSampleData(fixtureText: string): string {
	return fixtureText
		.replace(
			/export const components: Component\[\] = \[[\s\S]*?\];/,
			`export const components: Component[] = ${JSON.stringify(sampleComponents)};`
		)
		.replace(/export const minArea = [^;]+;/, `export const minArea = ${minArea};`)
		.replace(/export const maxAspect = [^;]+;/, `export const maxAspect = ${maxAspect};`);
}

describe('real runtime executing compileTrace output (integration)', () => {
	it('produces the same survivors as the original, un-instrumented predicate, and a correct TraceRun', () => {
		const testSource = replaceSampleData(fixtureSource);

		const expectedSurvivors = sampleComponents.filter((component) => {
			const areaOk = component.area >= minArea;
			if (!areaOk) return false;
			const aspectOk = component.aspect <= maxAspect;
			if (!aspectOk) return false;
			return true;
		});
		expect(expectedSurvivors).toEqual([sampleComponents[0]]);

		const result = compileTrace(fixturePath, testSource, createIdAllocator());
		expect(result.diagnostics).toEqual([]);
		const [stage] = result.manifest.stages;
		const [areaCheck, aspectCheck] = result.manifest.checks;

		const { survivors, trace } = execWithRealRuntime<Component>(result.code, { pipeline: 'demo.geometry' });

		// Trace mode must not change production behavior.
		expect(survivors).toEqual(expectedSurvivors);

		// Exactly 1 stage invocation, of the compiler-allocated stage id, seq 0 (first and
		// only run of this stage in the process).
		expect(trace.version).toBe(1);
		expect(trace.pipeline).toBe('demo.geometry');
		expect(trace.stages).toEqual([{ invocationId: trace.stages[0].invocationId, stageId: stage.id, seq: 0 }]);
		const stageInvocationId = trace.stages[0].invocationId;

		// Exactly 3 elements (one per input component), ordinals 0, 1, 2 in evaluation
		// order, and `kept` matching which components actually survived.
		expect(trace.elements).toHaveLength(3);
		const elementsByOrdinal = [...trace.elements].sort((a, b) => a.ordinal - b.ordinal);
		expect(elementsByOrdinal.map((e) => e.ordinal)).toEqual([0, 1, 2]);
		expect(elementsByOrdinal.every((e) => e.stageInvocationId === stageInvocationId)).toBe(true);
		expect(elementsByOrdinal.map((e) => e.kept)).toEqual([true, false, false]);

		const [elA, elB, elC] = elementsByOrdinal;

		// The exact expected check sequence, including the short-circuit case: element B
		// (fails area.min) has no second (aspect) check event at all.
		const expectedChecks = [
			{
				stageInvocationId,
				elementId: elA.id,
				checkId: areaCheck.id,
				operator: 'gte',
				value: sampleComponents[0].area,
				threshold: minArea,
				pass: true,
			},
			{
				stageInvocationId,
				elementId: elA.id,
				checkId: aspectCheck.id,
				operator: 'lte',
				value: sampleComponents[0].aspect,
				threshold: maxAspect,
				pass: true,
			},
			{
				stageInvocationId,
				elementId: elB.id,
				checkId: areaCheck.id,
				operator: 'gte',
				value: sampleComponents[1].area,
				threshold: minArea,
				pass: false,
			},
			{
				stageInvocationId,
				elementId: elC.id,
				checkId: areaCheck.id,
				operator: 'gte',
				value: sampleComponents[2].area,
				threshold: minArea,
				pass: true,
			},
			{
				stageInvocationId,
				elementId: elC.id,
				checkId: aspectCheck.id,
				operator: 'lte',
				value: sampleComponents[2].aspect,
				threshold: maxAspect,
				pass: false,
			},
		];
		expect(trace.checks).toEqual(expectedChecks);

		// The whole TraceRun must round-trip through JSON with no loss (no Maps/Sets/class
		// instances leaking into the public shape).
		expect(JSON.parse(JSON.stringify(trace))).toEqual(trace);
	});

	it('produces two distinct stage invocations (seq 0 and 1) if the same compiled stage runs twice in one session', () => {
		const testSource = replaceSampleData(fixtureSource);
		const result = compileTrace(fixturePath, testSource, createIdAllocator());
		expect(result.diagnostics).toEqual([]);

		// Run the literal same compiled output (same compiler-allocated stageId baked into
		// the same `enterStage(<id>)` call site) as two separate module instances within
		// one trace session -- proving that against real generated output, not just the
		// runtime in isolation, "the same logical stage running repeatedly" yields distinct
		// invocations with increasing seq, not two disjoint stages.
		const { trace } = execSequenceWithRealRuntime([result.code, result.code]);

		expect(trace.stages).toHaveLength(2);
		const [stageId] = new Set(trace.stages.map((s) => s.stageId));
		expect(trace.stages.every((s) => s.stageId === stageId)).toBe(true);
		expect(trace.stages.map((s) => s.seq)).toEqual([0, 1]);
		expect(new Set(trace.stages.map((s) => s.invocationId)).size).toBe(2);

		// 3 elements per run, 6 total, each scoped to its own stage invocation with ordinals
		// restarting at 0.
		expect(trace.elements).toHaveLength(6);
		for (const invocation of trace.stages) {
			const ordinalsForInvocation = trace.elements
				.filter((e) => e.stageInvocationId === invocation.invocationId)
				.map((e) => e.ordinal)
				.sort((a, b) => a - b);
			expect(ordinalsForInvocation).toEqual([0, 1, 2]);
		}
	});
});
