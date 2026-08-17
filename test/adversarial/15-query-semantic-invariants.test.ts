import { describe, expect, it } from 'vitest';
import {
	enterStage,
	finishTrace,
	recordDataflow,
	recordMeasure,
	spawnEntities,
	startTrace,
	type EntityRecord,
	type TraceRun,
} from '../../src/runtime/index.js';
import {
	inspectTruth,
	resolveCorrespondence,
	selectFateOf,
	type TruthDocument,
} from '../../src/cli/inspect.js';
import { decodeLabelmap, type LabelmapDocument } from '../../src/cli/labelmap.js';

describe('query semantic invariants', () => {
	it('refuses coordinate-space mismatch until an explicit transform is supplied', () => {
		const trace: TraceRun = {
			version: 1,
			stages: [], elements: [], checks: [],
			entities: [{ id: 7, kindId: 1, ordinal: 0, attrs: { centroidX: 1, centroidY: 1 } }],
		};
		const labelmapDoc: LabelmapDocument = {
			assetId: 1, widthPx: 3, heightPx: 3, encoding: 'rle', space: 'cropped', entityIds: [7],
			runs: [[0, 4], [1, 1], [0, 4]],
		};
		const mismatched: TruthDocument = { objects: [{ label: 'x', point: { x: 11, y: 21, space: 'raw' } }] };
		const refused = inspectTruth({ truthLabel: 'x', truth: mismatched, trace, manifest: { stages: [], checks: [], entityKinds: [] }, labelmapDoc });
		if (refused.ambiguous !== undefined) throw new Error('expected resolved report');
		expect(refused.correspondence.method).toBe('unreconciled-space');
		expect(refused.correspondence.reliable).toBe(false);

		const reconciled: TruthDocument = {
			objects: mismatched.objects,
			transforms: [{ from: 'raw', to: 'cropped', dx: -10, dy: -20 }],
		};
		const accepted = inspectTruth({ truthLabel: 'x', truth: reconciled, trace, manifest: { stages: [], checks: [], entityKinds: [] }, labelmapDoc });
		if (accepted.ambiguous !== undefined) throw new Error('expected resolved report');
		expect(accepted.correspondence).toMatchObject({ method: 'direct-pixel-hit', entityId: 7, reliable: true });
	});

	it('does not guess when legacy ordinal lookup is ambiguous across spawn sites', () => {
		const entities: EntityRecord[] = [
			{ id: 1, kindId: 1, ordinal: 0, attrs: { centroidX: 0, centroidY: 0 } },
			{ id: 2, kindId: 2, ordinal: 0, attrs: { centroidX: 0, centroidY: 0 } },
		];
		const doc: LabelmapDocument = { assetId: 1, widthPx: 1, heightPx: 1, encoding: 'rle', runs: [[1, 1]] };
		const ambiguous = resolveCorrespondence({ label: 'x', point: { x: 0, y: 0 } }, decodeLabelmap(doc), 1, 1, entities);
		expect(ambiguous.correspondence).toMatchObject({ method: 'direct-pixel-hit', entityId: null, reliable: false });

		const bound = resolveCorrespondence({ label: 'x', point: { x: 0, y: 0 } }, decodeLabelmap(doc), 1, 1, entities, 20, [2]);
		expect(bound.correspondence).toMatchObject({ method: 'direct-pixel-hit', entityId: 2, reliable: true });
	});

	it('preserves population-relative select basis and exposes per-entity fate', () => {
		startTrace();
		const stage = enterStage(1);
		const refs = [{ n: 1 }, { n: 2 }];
		const [kept, rejected] = spawnEntities(1, refs);
		recordDataflow({
			t: 'select', stage, name: 'sizeConsensus', kept: [kept], rejected: [rejected],
			basis: { winningClusterSize: 17, runnerUpSize: 16, anchor: 42.5 },
		});
		const trace = finishTrace();
		expect(selectFateOf(rejected, trace)).toEqual([{
			stageInvocationId: stage,
			name: 'sizeConsensus',
			outcome: 'rejected',
			basis: { winningClusterSize: 17, runnerUpSize: 16, anchor: 42.5 },
		}]);
	});

	it('records stage-scoped measures without turning them into checks', () => {
		startTrace();
		const stage = enterStage(3);
		recordMeasure(stage, 'basketMedianArea', 1164, 'px2');
		const trace = finishTrace();
		expect(trace.checks).toEqual([]);
		expect(trace.measures).toEqual([{ stageInvocationId: stage, name: 'basketMedianArea', value: 1164, unit: 'px2' }]);
	});
});