import { describe, expect, it } from 'vitest';
import { compileTrace, createIdAllocator } from '../../src/compiler/index.js';
import { inspectTruth } from '../../src/cli/inspect.js';
import type { LabelmapDocument } from '../../src/cli/labelmap.js';
import type { TruthDocument } from '../../src/cli/inspect.js';
import { execModuleWithRealRuntime } from './support/execModuleWithRealRuntime.js';

function source(order: 'true-first' | 'wrong-first'): string {
	const trueStage = [
		'/** @toph filter trueGate family=tee */',
		'const trueFamilySurvivors = components.filter((c) => {',
		'  /** @toph check t.area */',
		'  const areaOk = c.area >= 50;',
		'  if (!areaOk) return false;',
		'  return true;',
		'});',
	].join('\n');
	const wrongStage = [
		'/** @toph filter wrongGate family=basket */',
		'const wrongFamilySurvivors = components.filter((c) => {',
		'  /** @toph check f.aspect */',
		'  const aspectOk = c.aspect <= 0.5;',
		'  if (!aspectOk) return false;',
		'  return true;',
		'});',
	].join('\n');
	return [
		'export interface Component { area: number; aspect: number; }',
		'/** @toph entities component */',
		'const components: Component[] = [{ area: 200, aspect: 1.0 }];',
		order === 'true-first' ? trueStage : wrongStage,
		order === 'true-first' ? wrongStage : trueStage,
		'export { components, trueFamilySurvivors, wrongFamilySurvivors };',
	].join('\n\n');
}

function inspect(order: 'true-first' | 'wrong-first') {
	const result = compileTrace('family-scoped.ts', source(order), createIdAllocator());
	expect(result.diagnostics).toEqual([]);
	expect(result.manifest.stages.map((s) => ({ name: s.name, family: s.family }))).toEqual(
		order === 'true-first'
			? [{ name: 'trueGate', family: 'tee' }, { name: 'wrongGate', family: 'basket' }]
			: [{ name: 'wrongGate', family: 'basket' }, { name: 'trueGate', family: 'tee' }]
	);
	const { trace, error } = execModuleWithRealRuntime(result.code);
	expect(error).toBeNull();
	const entity = trace.entities![0];
	const labelmapDoc: LabelmapDocument = {
		assetId: 1,
		widthPx: 3,
		heightPx: 3,
		encoding: 'rle',
		entityIds: [entity.id],
		runs: [[0, 4], [1, 1], [0, 4]],
	};
	const truth: TruthDocument = { objects: [{ label: 'tee1', point: { x: 1, y: 1 }, expect: 'tee' }] };
	return inspectTruth({ truthLabel: 'tee1', truth, trace, manifest: result.manifest, labelmapDoc });
}

describe('family-scoped first-loss', () => {
	it('uses the declared semantic family rather than the last stage that touched the entity', () => {
		const report = inspect('true-first');
		if (report.ambiguous !== undefined) throw new Error('expected resolved report');
		expect(report.stages).toHaveLength(2);
		expect(report.stages.find((s) => s.family === 'tee')).toMatchObject({ stageName: 'trueGate', kept: true });
		expect(report.stages.find((s) => s.family === 'basket')).toMatchObject({ stageName: 'wrongGate', kept: false });
		expect(report.downstreamNote).toBe('This component survived every instrumented stage that declares semantic family "tee"; rejections in unrelated families are not losses for this truth object.');
	});

	it('is invariant to execution order', () => {
		const first = inspect('true-first');
		const second = inspect('wrong-first');
		if (first.ambiguous !== undefined || second.ambiguous !== undefined) throw new Error('expected resolved reports');
		expect(second.downstreamNote).toBe(first.downstreamNote);
	});

	it('refuses a confident verdict when the expected family has no attributable stage', () => {
		const result = compileTrace('family-scoped.ts', source('true-first'), createIdAllocator());
		const { trace } = execModuleWithRealRuntime(result.code);
		const entity = trace.entities![0];
		const labelmapDoc: LabelmapDocument = { assetId: 1, widthPx: 1, heightPx: 1, encoding: 'rle', entityIds: [entity.id], runs: [[1, 1]] };
		const truth: TruthDocument = { objects: [{ label: 'x', point: { x: 0, y: 0 }, expect: 'unknown-family' }] };
		const report = inspectTruth({ truthLabel: 'x', truth, trace, manifest: result.manifest, labelmapDoc });
		if (report.ambiguous !== undefined) throw new Error('expected resolved report');
		expect(report.downstreamNote).toContain('refusing to infer a verdict');
	});
});