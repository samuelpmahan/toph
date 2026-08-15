import { describe, expect, it } from 'vitest';
import { buildStageBreakdowns, inspectTruth, resolveCorrespondence } from '../../src/cli/inspect.js';
import { decodeLabelmap, labelAt, type LabelmapDocument } from '../../src/cli/labelmap.js';
import type { TraceRun } from '../../src/runtime/index.js';
import type { ManifestFragment } from '../../src/compiler/types.js';

// A tiny 4x4 labelmap: label 1 occupies (1,1) [row-major index 5], label 2 occupies
// (3,3) [row-major index 15]. Everything else 0.
function tinyLabelmapDoc(): LabelmapDocument {
	return {
		assetId: 1,
		widthPx: 4,
		heightPx: 4,
		encoding: 'rle',
		runs: [
			[0, 5], // indices 0-4
			[1, 1], // index 5 = (1,1)
			[0, 9], // indices 6-14
			[2, 1], // index 15 = (3,3)
		],
	};
}

describe('labelmap RLE decode/lookup', () => {
	it('decodes and looks up exact pixels', () => {
		const doc = tinyLabelmapDoc();
		const decoded = decodeLabelmap(doc);
		expect(decoded).toHaveLength(16);
		expect(labelAt(decoded, 4, 4, 1, 1)).toBe(1);
		expect(labelAt(decoded, 4, 4, 3, 3)).toBe(2);
		expect(labelAt(decoded, 4, 4, 0, 0)).toBe(0);
	});

	it('throws on out-of-bounds lookup', () => {
		const decoded = decodeLabelmap(tinyLabelmapDoc());
		expect(() => labelAt(decoded, 4, 4, 4, 0)).toThrow();
	});

	it('throws when runs do not cover exactly widthPx*heightPx pixels', () => {
		const bad: LabelmapDocument = { assetId: 1, widthPx: 4, heightPx: 4, encoding: 'rle', runs: [[0, 5]] };
		expect(() => decodeLabelmap(bad)).toThrow();
	});
});

function makeTrace(): TraceRun {
	return {
		version: 1,
		stages: [{ invocationId: 1, stageId: 10, seq: 0 }],
		elements: [],
		checks: [
			{ stageInvocationId: 1, elementId: 100, checkId: 1, operator: 'gte', value: 109, threshold: 157.14, pass: false },
			{ stageInvocationId: 1, elementId: 200, checkId: 1, operator: 'gte', value: 200, threshold: 157.14, pass: true },
			{ stageInvocationId: 1, elementId: 200, checkId: 2, operator: 'lte', value: 0.4, threshold: 0.55, pass: true },
		],
		entities: [
			{ id: 100, kindId: 1, ordinal: 0, attrs: { areaPx: 109, centroidX: 1, centroidY: 1, fill: 0.5 } },
			{ id: 200, kindId: 1, ordinal: 1, attrs: { areaPx: 300, centroidX: 3, centroidY: 3, fill: 0.4 } },
		],
	};
}

function makeManifest(): Pick<ManifestFragment, 'stages' | 'checks' | 'entityKinds'> {
	return {
		stages: [{ id: 10, name: 'p1.tee.geometry', kind: 'filter', source: { file: 'rawObjectMask.ts', line: 337 } }],
		checks: [
			{ id: 1, stageId: 10, code: 'area.min', operator: '>=', unit: 'px2', source: { file: 'rawObjectMask.ts', line: 339 } },
			{ id: 2, stageId: 10, code: 'fill.max', operator: '<=', source: { file: 'rawObjectMask.ts', line: 360 } },
		],
		entityKinds: [{ id: 1, name: 'component', source: { file: 'rawObjectMask.ts', line: 292 } }],
	};
}

describe('resolveCorrespondence', () => {
	it('direct pixel hit: truth point lands exactly on a labeled pixel -> distance 0, correct entity by ordinal', () => {
		const doc = tinyLabelmapDoc();
		const decoded = decodeLabelmap(doc);
		const { whiteMaskSupport, correspondence } = resolveCorrespondence(
			{ label: 'H1', point: { x: 1, y: 1 } },
			decoded,
			4,
			4,
			makeTrace().entities!
		);
		expect(whiteMaskSupport).toEqual({ directHit: true, labelAtPoint: 1 });
		expect(correspondence).toEqual({ method: 'direct-pixel-hit', distancePx: 0, entityId: 100 });
	});

	it('no direct hit: falls back to nearest entity by centroid distance, reporting the method and distance honestly', () => {
		const doc = tinyLabelmapDoc();
		const decoded = decodeLabelmap(doc);
		// (3,2) is background in the labelmap; distance to entity 200's centroid (3,3) is
		// 1, distance to entity 100's centroid (1,1) is sqrt(4+1)=sqrt(5) -- unambiguously
		// closer to 200.
		const { whiteMaskSupport, correspondence } = resolveCorrespondence(
			{ label: 'H2', point: { x: 3, y: 2 } },
			decoded,
			4,
			4,
			makeTrace().entities!
		);
		expect(whiteMaskSupport).toEqual({ directHit: false, labelAtPoint: 0 });
		expect(correspondence.method).toBe('nearest-centroid');
		expect(correspondence.entityId).toBe(200);
		expect(correspondence.distancePx).toBeCloseTo(1, 5);
	});

	it('no entities at all -> method "none", no crash', () => {
		const decoded = decodeLabelmap(tinyLabelmapDoc());
		const { correspondence } = resolveCorrespondence({ label: 'H3', point: { x: 2, y: 2 } }, decoded, 4, 4, []);
		expect(correspondence).toEqual({ method: 'none', distancePx: null, entityId: null });
	});
});

describe('buildStageBreakdowns', () => {
	it('reports first failing check and not-evaluated checks for a rejected entity', () => {
		const breakdowns = buildStageBreakdowns(100, makeTrace(), makeManifest());
		expect(breakdowns).toHaveLength(1);
		const [b] = breakdowns;
		expect(b.stageName).toBe('p1.tee.geometry');
		expect(b.checksExecuted).toEqual([
			{ code: 'area.min', operator: 'gte', value: 109, threshold: 157.14, unit: 'px2', pass: false, source: { file: 'rawObjectMask.ts', line: 339 } },
		]);
		expect(b.firstFailingCheck?.code).toBe('area.min');
		expect(b.checksNotEvaluated).toEqual(['fill.max']);
		expect(b.kept).toBe(false);
	});

	it('reports kept=true and no missing checks for a fully-passing entity', () => {
		const breakdowns = buildStageBreakdowns(200, makeTrace(), makeManifest());
		const [b] = breakdowns;
		expect(b.checksExecuted).toHaveLength(2);
		expect(b.firstFailingCheck).toBeNull();
		expect(b.checksNotEvaluated).toEqual([]);
		expect(b.kept).toBe(true);
	});

	it('an entity with no recorded checks at all produces an empty breakdown list', () => {
		const breakdowns = buildStageBreakdowns(999, makeTrace(), makeManifest());
		expect(breakdowns).toEqual([]);
	});
});

describe('inspectTruth (end to end)', () => {
	it('full report for a rejected component, matching the acceptance query shape', () => {
		const report = inspectTruth({
			truthLabel: 'H1',
			truth: { objects: [{ label: 'H1', point: { x: 1, y: 1 }, expect: 'tee' }] },
			trace: makeTrace(),
			manifest: makeManifest(),
			labelmapDoc: tinyLabelmapDoc(),
		});

		expect(report.truth.label).toBe('H1');
		expect(report.whiteMaskSupport.directHit).toBe(true);
		expect(report.correspondence.method).toBe('direct-pixel-hit');
		expect(report.component?.entityId).toBe(100);
		expect(report.component?.attrs.areaPx).toBe(109);
		expect(report.stages).toHaveLength(1);
		expect(report.stages[0].firstFailingCheck?.code).toBe('area.min');
		expect(report.stages[0].checksNotEvaluated).toEqual(['fill.max']);
		expect(report.downstreamNote).toContain('rejected at "area.min"');
	});

	it('full report for a kept component', () => {
		const report = inspectTruth({
			truthLabel: 'H2',
			truth: { objects: [{ label: 'H2', point: { x: 3, y: 3 } }] },
			trace: makeTrace(),
			manifest: makeManifest(),
			labelmapDoc: tinyLabelmapDoc(),
		});
		expect(report.stages[0].kept).toBe(true);
		expect(report.downstreamNote).toContain('survived every instrumented check');
	});

	it('throws a clear error for an unknown truth label', () => {
		expect(() =>
			inspectTruth({
				truthLabel: 'H99',
				truth: { objects: [{ label: 'H1', point: { x: 1, y: 1 } }] },
				trace: makeTrace(),
				manifest: makeManifest(),
				labelmapDoc: tinyLabelmapDoc(),
			})
		).toThrow(/H99/);
	});
});
