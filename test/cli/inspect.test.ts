import { describe, expect, it } from 'vitest';
import {
	buildStageBreakdowns,
	buildSurvivalFunnel,
	DEFAULT_MAX_CORRESPONDENCE_DISTANCE_PX,
	inspectTruth,
	resolveCorrespondence,
} from '../../src/cli/inspect.js';
import { decodeLabelmap, labelAt, type LabelmapDocument } from '../../src/cli/labelmap.js';
import type { TraceRun } from '../../src/runtime/index.js';
import type { ManifestFragment } from '../../src/compiler/types.js';
import type { TruthDocument } from '../../src/cli/inspect.js';

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
		expect(correspondence).toEqual({ method: 'direct-pixel-hit', distancePx: 0, entityId: 100, reliable: true });
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
		// Well within the default reliability threshold.
		expect(correspondence.reliable).toBe(true);
	});

	it('no entities at all -> method "none", no crash, not reliable', () => {
		const decoded = decodeLabelmap(tinyLabelmapDoc());
		const { correspondence } = resolveCorrespondence({ label: 'H3', point: { x: 2, y: 2 } }, decoded, 4, 4, []);
		expect(correspondence).toEqual({ method: 'none', distancePx: null, entityId: null, reliable: false });
	});

	it('a nearest-centroid match beyond the default max distance is reported honestly but marked unreliable', () => {
		// A big, all-background labelmap (no direct hits possible) with one entity far from
		// the truth point -- on real Heritage data this shape produced a "match" ~30px from
		// a ~15px-wide glyph, which is the failure mode this threshold exists to catch.
		const doc: LabelmapDocument = { assetId: 9, widthPx: 200, heightPx: 200, encoding: 'rle', runs: [[0, 40000]] };
		const decoded = decodeLabelmap(doc);
		const entities = [{ id: 500, kindId: 1, ordinal: 0, attrs: { centroidX: 90, centroidY: 90 } }];
		const { correspondence } = resolveCorrespondence({ label: 'F1', point: { x: 0, y: 0 } }, decoded, 200, 200, entities);
		expect(correspondence.method).toBe('nearest-centroid');
		expect(correspondence.entityId).toBe(500);
		expect(correspondence.distancePx).toBeCloseTo(Math.hypot(90, 90), 5);
		expect(correspondence.distancePx).toBeGreaterThan(DEFAULT_MAX_CORRESPONDENCE_DISTANCE_PX);
		expect(correspondence.reliable).toBe(false);
	});

	it('a nearest-centroid match exactly at the max distance counts as reliable (inclusive boundary)', () => {
		const doc: LabelmapDocument = { assetId: 9, widthPx: 200, heightPx: 200, encoding: 'rle', runs: [[0, 40000]] };
		const decoded = decodeLabelmap(doc);
		const entities = [{ id: 500, kindId: 1, ordinal: 0, attrs: { centroidX: DEFAULT_MAX_CORRESPONDENCE_DISTANCE_PX, centroidY: 0 } }];
		const { correspondence } = resolveCorrespondence({ label: 'F2', point: { x: 0, y: 0 } }, decoded, 200, 200, entities);
		expect(correspondence.distancePx).toBeCloseTo(DEFAULT_MAX_CORRESPONDENCE_DISTANCE_PX, 5);
		expect(correspondence.reliable).toBe(true);
	});

	it('a caller-supplied maxDistancePx overrides the default threshold in both directions', () => {
		const doc: LabelmapDocument = { assetId: 9, widthPx: 200, heightPx: 200, encoding: 'rle', runs: [[0, 40000]] };
		const decoded = decodeLabelmap(doc);
		const entities = [{ id: 500, kindId: 1, ordinal: 0, attrs: { centroidX: 10, centroidY: 0 } }];
		const stricter = resolveCorrespondence({ label: 'F3', point: { x: 0, y: 0 } }, decoded, 200, 200, entities, 5);
		expect(stricter.correspondence.reliable).toBe(false);
		const looser = resolveCorrespondence({ label: 'F3', point: { x: 0, y: 0 } }, decoded, 200, 200, entities, 15);
		expect(looser.correspondence.reliable).toBe(true);
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
		if (report.ambiguous) throw new Error('expected a resolved report');

		expect(report.truth.label).toBe('H1');
		expect(report.whiteMaskSupport.directHit).toBe(true);
		expect(report.correspondence.method).toBe('direct-pixel-hit');
		expect(report.correspondence.reliable).toBe(true);
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
		if (report.ambiguous) throw new Error('expected a resolved report');

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

	it('an object with no `status` field behaves exactly like `status: "confident"` (backward compatibility with examples/heritage-first-loss/truth.json)', () => {
		const withoutStatus = inspectTruth({
			truthLabel: 'H1',
			truth: { objects: [{ label: 'H1', point: { x: 1, y: 1 }, expect: 'tee' }] },
			trace: makeTrace(),
			manifest: makeManifest(),
			labelmapDoc: tinyLabelmapDoc(),
		});
		const withStatus = inspectTruth({
			truthLabel: 'H1',
			truth: { objects: [{ label: 'H1', point: { x: 1, y: 1 }, expect: 'tee', status: 'confident' }] },
			trace: makeTrace(),
			manifest: makeManifest(),
			labelmapDoc: tinyLabelmapDoc(),
		});
		expect(withoutStatus.ambiguous).toBeUndefined();
		expect(withoutStatus).toEqual({ ...withStatus, truth: { ...withStatus.truth, status: undefined } });
	});

	it('an ambiguous truth object short-circuits: no whiteMaskSupport/correspondence/component/stages, just the reason', () => {
		const report = inspectTruth({
			truthLabel: 'H5',
			truth: {
				objects: [
					{
						label: 'H5',
						point: { x: 1, y: 1 },
						status: 'ambiguous',
						reason: 'tee marker visually merged with the adjacent hole-number badge',
					},
				],
			},
			trace: makeTrace(),
			manifest: makeManifest(),
			labelmapDoc: tinyLabelmapDoc(),
		});

		expect(report.ambiguous).toEqual({ reason: 'tee marker visually merged with the adjacent hole-number badge' });
		// None of the resolution machinery ran -- these keys must not even be present,
		// not merely falsy/empty, so a caller can't mistake "never looked" for "looked,
		// found nothing." Note the truth point (1,1) DOES sit on a labeled pixel in
		// tinyLabelmapDoc() -- a non-ambiguous query would find whiteMaskSupport.directHit
		// true here, which makes this a real test of the short-circuit, not an accident of
		// there being nothing to find.
		expect('whiteMaskSupport' in report).toBe(false);
		expect('correspondence' in report).toBe(false);
		expect('component' in report).toBe(false);
		expect('stages' in report).toBe(false);
		expect('downstreamNote' in report).toBe(false);
	});

	it('an ambiguous truth object with no `reason` still short-circuits, with a fallback reason string', () => {
		const report = inspectTruth({
			truthLabel: 'H6',
			truth: { objects: [{ label: 'H6', point: { x: 1, y: 1 }, status: 'ambiguous' }] },
			trace: makeTrace(),
			manifest: makeManifest(),
			labelmapDoc: tinyLabelmapDoc(),
		});
		expect(report.ambiguous?.reason).toBeTruthy();
	});

	it('a confident truth object whose nearest entity is beyond the reliability threshold does NOT populate component/stages -- an unreliable match is not treated as a corresponding component, even though real check data exists for that entity', () => {
		const bigLabelmap: LabelmapDocument = { assetId: 9, widthPx: 200, heightPx: 200, encoding: 'rle', runs: [[0, 40000]] };
		const trace: TraceRun = {
			version: 1,
			stages: [{ invocationId: 1, stageId: 10, seq: 0 }],
			elements: [],
			checks: [{ stageInvocationId: 1, elementId: 500, checkId: 1, operator: 'gte', value: 200, threshold: 100, pass: true }],
			entities: [{ id: 500, kindId: 1, ordinal: 0, attrs: { centroidX: 90, centroidY: 90 } }],
		};
		const report = inspectTruth({
			truthLabel: 'F1',
			truth: { objects: [{ label: 'F1', point: { x: 0, y: 0 } }] },
			trace,
			manifest: makeManifest(),
			labelmapDoc: bigLabelmap,
		});
		if (report.ambiguous) throw new Error('expected a resolved report');

		expect(report.correspondence.method).toBe('nearest-centroid');
		expect(report.correspondence.entityId).toBe(500);
		expect(report.correspondence.distancePx).toBeCloseTo(Math.hypot(90, 90), 5);
		expect(report.correspondence.reliable).toBe(false);
		// The unreliable match's distance/entity are still reported honestly above, but no
		// component/stage report is built on top of it -- even though checks DO exist for
		// entity 500 in the trace, proving this is a deliberate "don't trust it" choice,
		// not an artifact of there being nothing to find.
		expect(report.component).toBeNull();
		expect(report.stages).toEqual([]);
		expect(report.downstreamNote).toContain('reliable-match threshold');
	});

	it('a caller-supplied maxCorrespondenceDistancePx changes whether the same match is treated as reliable', () => {
		const bigLabelmap: LabelmapDocument = { assetId: 9, widthPx: 200, heightPx: 200, encoding: 'rle', runs: [[0, 40000]] };
		const trace: TraceRun = {
			version: 1,
			stages: [],
			elements: [],
			checks: [],
			entities: [{ id: 500, kindId: 1, ordinal: 0, attrs: { centroidX: 90, centroidY: 90 } }],
		};
		const report = inspectTruth({
			truthLabel: 'F1',
			truth: { objects: [{ label: 'F1', point: { x: 0, y: 0 } }] },
			trace,
			manifest: makeManifest(),
			labelmapDoc: bigLabelmap,
			maxCorrespondenceDistancePx: 200,
		});
		if (report.ambiguous) throw new Error('expected a resolved report');
		expect(report.correspondence.reliable).toBe(true);
		expect(report.component?.entityId).toBe(500);
	});
});

describe('buildSurvivalFunnel', () => {
	// A small synthetic multi-hole/multi-stage fixture covering exactly the four cases the
	// funnel needs to distinguish:
	//   H1 -> entity 10: passes stage.geometry AND stage.appearance, then materializes
	//         (entity 30 is spawned from it -- parentId: 10).
	//   H2 -> entity 20: reaches stage.geometry but fails its check there, so it never
	//         reaches stage.appearance and never materializes.
	//   H3: marked ambiguous -- excluded before correspondence is even attempted.
	//   H4: far from every entity -- correspondence is unreliable, so it counts as "no
	//       corresponding entity at all" for the funnel, same as method: 'none' would.
	function funnelLabelmap(): LabelmapDocument {
		// All-background (no direct pixel hits anywhere) -- every truth object below
		// resolves via nearest-centroid or not at all.
		return { assetId: 3, widthPx: 2000, heightPx: 2000, encoding: 'rle', runs: [[0, 4_000_000]] };
	}

	function funnelTruth(): TruthDocument {
		return {
			objects: [
				{ label: 'H1', point: { x: 5, y: 5 } },
				{ label: 'H2', point: { x: 50, y: 50 } },
				{ label: 'H3', point: { x: 999, y: 999 }, status: 'ambiguous', reason: 'glyph merged with badge' },
				{ label: 'H4', point: { x: 1000, y: 1000 } },
			],
		};
	}

	function funnelManifest(): Pick<ManifestFragment, 'stages' | 'checks' | 'entityKinds'> {
		return {
			stages: [
				{ id: 100, name: 'stage.geometry', kind: 'filter', source: { file: 'x.ts', line: 1 } },
				{ id: 200, name: 'stage.appearance', kind: 'filter', source: { file: 'x.ts', line: 2 } },
			],
			checks: [
				{ id: 1, stageId: 100, code: 'geom.check', operator: '>=', source: { file: 'x.ts', line: 3 } },
				{ id: 2, stageId: 200, code: 'appear.check', operator: '>=', source: { file: 'x.ts', line: 4 } },
			],
			entityKinds: [
				{ id: 1, name: 'component', source: { file: 'x.ts', line: 5 } },
				{ id: 2, name: 'candidate', source: { file: 'x.ts', line: 6 } },
			],
		};
	}

	function funnelTrace(): TraceRun {
		return {
			version: 1,
			stages: [
				{ invocationId: 1, stageId: 100, seq: 0 },
				{ invocationId: 2, stageId: 200, seq: 0 },
			],
			elements: [],
			checks: [
				{ stageInvocationId: 1, elementId: 10, checkId: 1, operator: 'gte', value: 10, threshold: 5, pass: true },
				{ stageInvocationId: 1, elementId: 20, checkId: 1, operator: 'gte', value: 1, threshold: 5, pass: false },
				{ stageInvocationId: 2, elementId: 10, checkId: 2, operator: 'gte', value: 10, threshold: 5, pass: true },
			],
			entities: [
				{ id: 10, kindId: 1, ordinal: 0, attrs: { centroidX: 5, centroidY: 5 } },
				{ id: 20, kindId: 1, ordinal: 1, attrs: { centroidX: 50, centroidY: 50 } },
				{ id: 30, kindId: 2, ordinal: 0, attrs: { centroidX: 5, centroidY: 5 }, parentId: 10 },
			],
		};
	}

	it('produces exactly the expected counts for the synthetic fixture', () => {
		const report = buildSurvivalFunnel({
			truth: funnelTruth(),
			trace: funnelTrace(),
			manifest: funnelManifest(),
			labelmapDoc: funnelLabelmap(),
			stageOrder: ['stage.geometry', 'stage.appearance'],
		});

		expect(report).toEqual({
			totalTruthObjects: 4,
			confidentCount: 3,
			ambiguousCount: 1,
			correspondedCount: 2,
			stages: [
				{ stageName: 'stage.geometry', reached: 2, kept: 1 },
				{ stageName: 'stage.appearance', reached: 1, kept: 1 },
			],
			materializedCount: 1,
		});
	});

	it('an empty stageOrder still computes correspondence/materialization counts, with an empty stages array', () => {
		const report = buildSurvivalFunnel({
			truth: funnelTruth(),
			trace: funnelTrace(),
			manifest: funnelManifest(),
			labelmapDoc: funnelLabelmap(),
			stageOrder: [],
		});
		expect(report.stages).toEqual([]);
		expect(report.correspondedCount).toBe(2);
		expect(report.materializedCount).toBe(1);
	});

	it('a stage name with no matching manifest stage reports reached=0, kept=0 rather than crashing', () => {
		const report = buildSurvivalFunnel({
			truth: funnelTruth(),
			trace: funnelTrace(),
			manifest: funnelManifest(),
			labelmapDoc: funnelLabelmap(),
			stageOrder: ['stage.geometry', 'stage.nonexistent'],
		});
		expect(report.stages[1]).toEqual({ stageName: 'stage.nonexistent', reached: 0, kept: 0 });
	});

	it('a caller-supplied maxCorrespondenceDistancePx changes correspondedCount', () => {
		const report = buildSurvivalFunnel({
			truth: funnelTruth(),
			trace: funnelTrace(),
			manifest: funnelManifest(),
			labelmapDoc: funnelLabelmap(),
			stageOrder: ['stage.geometry', 'stage.appearance'],
			maxCorrespondenceDistancePx: 2000, // wide enough that H4 now corresponds too
		});
		expect(report.correspondedCount).toBe(3);
	});
});
