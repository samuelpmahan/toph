import { describe, expect, it } from 'vitest';
import { compileTrace, createIdAllocator } from '../../src/compiler/index.js';
import { buildStageBreakdowns, buildSurvivalFunnel } from '../../src/cli/inspect.js';
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
});