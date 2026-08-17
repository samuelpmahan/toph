import { describe, expect, it } from 'vitest';
import { compileTrace, createIdAllocator } from '../../src/compiler/index.js';
import { buildStageBreakdowns, buildSurvivalFunnel, inspectTruth } from '../../src/cli/inspect.js';
import type { LabelmapDocument } from '../../src/cli/labelmap.js';
import type { TruthDocument } from '../../src/cli/inspect.js';
import { execModuleWithRealRuntime } from './support/execModuleWithRealRuntime.js';

const source = [
	'export interface Widget { score: number; }',
	'/** @toph entities widget */',
	'const widgets: Widget[] = [{ score: 10 }];',
	'function runGate(input: Widget[]) {',
	'  /** @toph filter demo.gate */',
	'  const survivors = input.filter((w) => {',
	'    /** @toph check score.min */',
	'    const ok = w.score >= 5;',
	'    if (!ok) return false;',
	'    return true;',
	'  });',
	'  return survivors;',
	'}',
	'export const first = runGate(widgets);',
	'export const second = runGate(widgets);',
].join('\n');

// Same widget, same logical stage, invoked twice with a mutable module-level threshold so
// the SECOND invocation genuinely rejects what the first kept. This is the honest-mixed-
// outcome case the two tests above never exercise -- both of their invocations keep, so a
// "last invocation wins" bug and a correct "mixed" verdict would look identical there.
const mixedSource = [
	'export interface Widget { score: number; }',
	'/** @toph entities widget */',
	'const widgets: Widget[] = [{ score: 10 }];',
	'let minScore = 5;',
	'function runGate(input: Widget[]) {',
	'  /** @toph filter demo.gate family=tee */',
	'  const survivors = input.filter((w) => {',
	'    /** @toph check score.min */',
	'    const ok = w.score >= minScore;',
	'    if (!ok) return false;',
	'    return true;',
	'  });',
	'  return survivors;',
	'}',
	'export const first = runGate(widgets);',
	'minScore = 50;',
	'export const second = runGate(widgets);',
].join('\n');

describe('repeated stage invocation aggregation', () => {
	it('preserves both real invocations in the execution breakdown', () => {
		const result = compileTrace('repeated-invocation.ts', source, createIdAllocator());
		expect(result.diagnostics).toEqual([]);
		const { trace, error } = execModuleWithRealRuntime(result.code);
		expect(error).toBeNull();
		const entityId = trace.entities![0].id;
		const breakdowns = buildStageBreakdowns(entityId, trace, result.manifest);
		expect(breakdowns).toHaveLength(2);
		expect(breakdowns.map((b) => b.kept)).toEqual([true, true]);
	});

	it('counts one truth/entity at most once per logical stage in an object funnel', () => {
		const result = compileTrace('repeated-invocation.ts', source, createIdAllocator());
		const { trace, error } = execModuleWithRealRuntime(result.code);
		expect(error).toBeNull();
		const entity = trace.entities![0];
		const labelmapDoc: LabelmapDocument = {
			assetId: 1,
			widthPx: 1,
			heightPx: 1,
			encoding: 'rle',
			entityIds: [entity.id],
			runs: [[1, 1]],
		};
		const truth: TruthDocument = { objects: [{ label: 'widget1', point: { x: 0, y: 0 } }] };
		const funnel = buildSurvivalFunnel({ truth, trace, manifest: result.manifest, labelmapDoc, stageOrder: ['demo.gate'] });
		expect(funnel.correspondedCount).toBe(1);
		expect(funnel.stages).toEqual([{ stageName: 'demo.gate', reached: 1, kept: 1 }]);
		expect(funnel.stages[0].reached).toBeLessThanOrEqual(funnel.correspondedCount);
	});

	it('represents a kept-then-rejected pair of invocations as mixed, not as whichever invocation ran last', () => {
		const result = compileTrace('mixed-invocation.ts', mixedSource, createIdAllocator());
		expect(result.diagnostics).toEqual([]);
		const { trace, error } = execModuleWithRealRuntime(result.code);
		expect(error).toBeNull();
		const entity = trace.entities![0];
		const breakdowns = buildStageBreakdowns(entity.id, trace, result.manifest);
		expect(breakdowns.map((b) => b.kept)).toEqual([true, false]);

		const labelmapDoc: LabelmapDocument = { assetId: 1, widthPx: 1, heightPx: 1, encoding: 'rle', entityIds: [entity.id], runs: [[1, 1]] };
		const objectTruth: TruthDocument = { objects: [{ label: 'widget1', point: { x: 0, y: 0 } }] };
		const funnel = buildSurvivalFunnel({ truth: objectTruth, trace, manifest: result.manifest, labelmapDoc, stageOrder: ['demo.gate'] });
		expect(funnel.stages).toEqual([{ stageName: 'demo.gate', reached: 1, kept: 0, mixed: 1 }]);

		const familyTruth: TruthDocument = { objects: [{ label: 'widget1', point: { x: 0, y: 0 }, expect: 'tee' }] };
		const report = inspectTruth({ truthLabel: 'widget1', truth: familyTruth, trace, manifest: result.manifest, labelmapDoc });
		if (report.ambiguous) throw new Error('expected a resolved report');
		expect(report.downstreamNote).toContain('mixed outcomes');
		expect(report.downstreamNote).toContain('refusing to collapse');
	});
});