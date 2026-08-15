import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { compileTrace, createIdAllocator } from '../../src/compiler/index.js';
import { execTraceModule } from './support/execTraceModule.js';
import type { FakeEvent } from './support/fakeRuntime.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const fixturePath = join(__dirname, 'fixtures', 'demo-geometry.ts');
const fixtureSource = readFileSync(fixturePath, 'utf8');

interface Component {
	area: number;
	aspect: number;
}

// Same three cases the task spec asks for:
//   (a) passes both checks
//   (b) fails the first check (area.min) -- must short-circuit, no second check event
//   (c) fails only the second check (aspect.max)
const sampleComponents: Component[] = [
	{ area: 200, aspect: 1.2 }, // (a) passes both: area 200 >= 100, aspect 1.2 <= 2.0
	{ area: 50, aspect: 1.5 }, // (b) fails area.min: 50 >= 100 is false; aspect never checked
	{ area: 300, aspect: 4.0 }, // (c) passes area.min, fails aspect.max: 4.0 <= 2.0 is false
];
const minArea = 100;
const maxAspect = 2.0;

function replaceSampleData(fixtureText: string): string {
	// Swap in a fixed, test-controlled sample dataset in place of the fixture's own
	// `components`/`minArea`/`maxAspect` bindings so the behavioral assertions below
	// don't silently drift if the fixture's illustrative data ever changes.
	return fixtureText
		.replace(
			/export const components: Component\[\] = \[[\s\S]*?\];/,
			`export const components: Component[] = ${JSON.stringify(sampleComponents)};`
		)
		.replace(/export const minArea = [^;]+;/, `export const minArea = ${minArea};`)
		.replace(/export const maxAspect = [^;]+;/, `export const maxAspect = ${maxAspect};`);
}

describe('executing compileTrace output (behavioral)', () => {
	it('produces the same survivors as the original, un-instrumented predicate, and records the exact expected event log', () => {
		const testSource = replaceSampleData(fixtureSource);

		// Sanity: the plain, un-instrumented predicate is the ground truth for what
		// `.filter` should return.
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

		const { survivors, events } = execTraceModule<Component>(result.code);

		// Trace mode must not change production behavior.
		expect(survivors).toEqual(expectedSurvivors);

		// Expected event sequence:
		//   enterStage(stage)
		//   element 0 (passes both): enterElement, check area (pass), check aspect (pass), keep
		//   element 1 (fails area): enterElement, check area (fail) -- NO aspect check event
		//   element 2 (fails aspect): enterElement, check area (pass), check aspect (fail) -- no keep
		const expected: FakeEvent[] = [
			{ type: 'enterStage', stageId: stage.id, invocationId: 1 },

			{ type: 'enterElement', stageInvocationId: 1, elementId: 1 },
			{
				type: 'check',
				op: 'gte',
				elementId: 1,
				checkId: areaCheck.id,
				value: sampleComponents[0].area,
				threshold: minArea,
				pass: true,
			},
			{
				type: 'check',
				op: 'lte',
				elementId: 1,
				checkId: aspectCheck.id,
				value: sampleComponents[0].aspect,
				threshold: maxAspect,
				pass: true,
			},
			{ type: 'keep', elementId: 1 },

			{ type: 'enterElement', stageInvocationId: 1, elementId: 2 },
			{
				type: 'check',
				op: 'gte',
				elementId: 2,
				checkId: areaCheck.id,
				value: sampleComponents[1].area,
				threshold: minArea,
				pass: false,
			},

			{ type: 'enterElement', stageInvocationId: 1, elementId: 3 },
			{
				type: 'check',
				op: 'gte',
				elementId: 3,
				checkId: areaCheck.id,
				value: sampleComponents[2].area,
				threshold: minArea,
				pass: true,
			},
			{
				type: 'check',
				op: 'lte',
				elementId: 3,
				checkId: aspectCheck.id,
				value: sampleComponents[2].aspect,
				threshold: maxAspect,
				pass: false,
			},
		];

		expect(events).toEqual(expected);
	});

	it('records no event for a check that never runs due to short-circuiting on element (b)', () => {
		const testSource = replaceSampleData(fixtureSource);
		const result = compileTrace(fixturePath, testSource, createIdAllocator());
		const { events } = execTraceModule<Component>(result.code);

		// Element 2 (elementId 2, the area-min failure) must have exactly one check
		// event (area) and no aspect check event and no keep event.
		const elementTwoEvents = events.filter(
			(e) => (e.type === 'check' || e.type === 'keep') && e.elementId === 2
		);
		expect(elementTwoEvents).toHaveLength(1);
		expect(elementTwoEvents[0]).toMatchObject({ type: 'check', op: 'gte', pass: false });
	});
});
