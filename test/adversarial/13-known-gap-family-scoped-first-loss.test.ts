// Item 13: family-scoped first-loss.
//
// THE ADVERSARIAL CLAIM (write this before running anything, per the task brief):
//
// `inspectTruth` (src/cli/inspect.ts ~L360-420) resolves a ground-truth point to an
// entity via `resolveCorrespondence`, then calls `buildStageBreakdowns` (~L288-347),
// then derives a human-readable verdict at L409-414:
//
//   const lastStage = stages[stages.length - 1];
//   downstreamNote = lastStage.kept
//     ? 'This component survived every instrumented check...'
//     : `This component was rejected at "${lastStage.firstFailingCheck?.code}" in
//        stage "${lastStage.stageName}" -- every check and stage after that point
//        never ran, so nothing downstream ... was evaluated.`;
//
// `buildStageBreakdowns` buckets `trace.checks` events for one entityId by
// `stageInvocationId` into a `Map`, which iterates in TRACE-INSERTION order (i.e. the
// order those check events were actually recorded during execution) -- NOT in any
// order tied to which stage is the entity's true/expected family. `stages[stages.length
// - 1]` is therefore whichever stage's checks happened to be recorded LAST for that
// entity id, an accident of pipeline/source-code stage ordering. `TruthObject.expect`
// (the ground-truth author's declared expected family) exists in the schema but is
// never read by `inspectTruth`, `buildStageBreakdowns`, or `resolveCorrespondence` --
// there is no family-scoping defense anywhere in this file.
//
// This reproduces the real field bug documented in slice-feedback.md (a hand-rolled
// Toph slice run inside ChainSpot against a real 4-course corpus): "First-loss must be
// family/verdict-scoped. The naive query ('first rejection in any stage')
// misattributed nearly every truth: a tee dying at the basket pool is expected, not a
// loss ... This was the largest correctness bug in the slice." In that real run, the
// tee family's checks happened to execute AFTER the basket family's, so "last stage
// wins" coincidentally landed on the right answer for that specific case -- masking
// that the heuristic isn't actually family-aware.
//
// Toph is BROKEN if: a synthetic pipeline has two independent `@toph filter` stages
// (T = "trueFamily", running FIRST in source/execution order; F = "wrongFamily",
// running SECOND) both filtering the SAME underlying `@toph entities`-spawned pool
// (two parallel family gates over one component pool -- NOT a serial pipe where one
// stage's survivors feed the next), where a single entity is genuinely KEPT by its
// true family (T) and genuinely, expectedly REJECTED by the unrelated family it was
// never meant to belong to (F) -- and `inspectTruth`'s `downstreamNote` for a
// ground-truth point resolving to that entity confidently reports it as REJECTED
// (attributing the loss to F's gate), with no diagnostic flag distinguishing this from
// a real loss.
//
// Toph DEFENDS if: the reported verdict correctly reflects that the entity was kept by
// at least one of its stages, or clearly flags that multiple families/stages touched
// this entity and refuses to assert a single confident verdict.
//
// This test asserts on the ACTUAL `report.downstreamNote` string produced by running
// real compiled trace-mode code through the real runtime (src/runtime/index.ts) via
// execModuleWithRealRuntime, then feeding the resulting real TraceRun + manifest into
// the real (uninlined) inspectTruth -- so the outcome is whatever Toph actually does,
// not a hand-simulated prediction.

import { describe, expect, it } from 'vitest';
import { compileTrace, createIdAllocator } from '../../src/compiler/index.js';
import { inspectTruth } from '../../src/cli/inspect.js';
import type { LabelmapDocument } from '../../src/cli/labelmap.js';
import type { TruthDocument } from '../../src/cli/inspect.js';
import { execModuleWithRealRuntime } from './support/execModuleWithRealRuntime.js';

describe('family-scoped first-loss: two parallel family gates over one component pool', () => {
	// One `@toph entities` spawn site producing a single component pool. TWO independent
	// `@toph filter` sites both iterate the SAME `components` array (not chained -- neither
	// stage consumes the other's survivors), mirroring the real ChainSpot shape of
	// parallel per-family gates run over one shared candidate pool. Because both filter
	// callbacks receive the exact same array elements by reference, enterElement's
	// ref-based WeakMap lookup (src/runtime/index.ts's entityIdByRef) makes both stages'
	// check events reference the SAME real entityId -- not two coincidentally-equal ids.
	//
	// stage trueFamily (T) runs FIRST in source order: its one check (`t.area`) is a
	// gate the entity genuinely passes (area 200 >= 50).
	// stage wrongFamily (F) runs SECOND in source order: its one check (`f.aspect`) is an
	// unrelated, plausible-but-irrelevant gate (an aspect-ratio ceiling that would make
	// sense for a differently-shaped family) the entity genuinely, expectedly fails
	// (aspect 1.0 <= 0.5 is false) -- exactly like "a tee isn't shaped like a basket."
	const source = [
		'export interface Component { area: number; aspect: number; }',
		'',
		'/** @toph entities component */',
		'const components: Component[] = [{ area: 200, aspect: 1.0 }];',
		'',
		'export const minAreaForTrue = 50;',
		'export const maxAspectForWrong = 0.5;',
		'',
		'/** @toph filter trueFamily */',
		'const trueFamilySurvivors = components.filter((c) => {',
		'  /** @toph check t.area */',
		'  const areaOk = c.area >= minAreaForTrue;',
		'  if (!areaOk) return false;',
		'  return true;',
		'});',
		'',
		'/** @toph filter wrongFamily */',
		'const wrongFamilySurvivors = components.filter((c) => {',
		'  /** @toph check f.aspect */',
		'  const aspectOk = c.aspect <= maxAspectForWrong;',
		'  if (!aspectOk) return false;',
		'  return true;',
		'});',
		'',
		'export { components, trueFamilySurvivors, wrongFamilySurvivors };',
		'',
	].join('\n');

	it('compiles both stages against one shared entities pool, no diagnostics', () => {
		const result = compileTrace('family-scoped.ts', source, createIdAllocator());
		expect(result.diagnostics).toEqual([]);
		expect(result.manifest.entityKinds).toHaveLength(1);
		expect(result.manifest.stages).toHaveLength(2);
		expect(result.manifest.stages.map((s) => s.name)).toEqual(['trueFamily', 'wrongFamily']);
		expect(result.manifest.checks).toHaveLength(2);
	});

	it('the entity is genuinely kept by its true family and genuinely rejected by the unrelated family, sharing one real entityId', () => {
		const result = compileTrace('family-scoped.ts', source, createIdAllocator());
		expect(result.diagnostics).toEqual([]);

		const { moduleExports, trace, error } = execModuleWithRealRuntime<{
			trueFamilySurvivors: { area: number; aspect: number }[];
			wrongFamilySurvivors: { area: number; aspect: number }[];
		}>(result.code);
		expect(error).toBeNull();

		// Kept by its true family...
		expect(moduleExports?.trueFamilySurvivors).toEqual([{ area: 200, aspect: 1.0 }]);
		// ...and correctly rejected by the unrelated family.
		expect(moduleExports?.wrongFamilySurvivors).toEqual([]);

		// Exactly one entity was spawned, and BOTH stages' check events reference that
		// SAME entity id -- proving this is real shared object identity via
		// enterElement's ref-based lookup, not two coincidentally-equal ids.
		expect(trace.entities).toHaveLength(1);
		const entityId = trace.entities![0].id;
		const referencedEntityIds = new Set(trace.checks.map((c) => c.elementId));
		expect(referencedEntityIds).toEqual(new Set([entityId]));
		expect(trace.checks).toHaveLength(2);
		expect(trace.checks[0]).toMatchObject({ elementId: entityId, pass: true }); // trueFamily's check, ran first
		expect(trace.checks[1]).toMatchObject({ elementId: entityId, pass: false }); // wrongFamily's check, ran second
	});

	it('VERDICT: inspectTruth\'s downstreamNote for this entity', () => {
		const result = compileTrace('family-scoped.ts', source, createIdAllocator());
		expect(result.diagnostics).toEqual([]);

		const { trace, error } = execModuleWithRealRuntime(result.code);
		expect(error).toBeNull();
		expect(trace.entities).toHaveLength(1);
		const entity = trace.entities![0];

		// A tiny 3x3 labelmap with exactly one labeled pixel, at (1,1), label 1 -- label N
		// corresponds to the entity spawned at ordinal N-1 (resolveCorrespondence's
		// documented direct-pixel-hit convention), so label 1 -> ordinal 0 -> our one
		// spawned entity. The ground-truth point lands exactly on that pixel, so
		// resolveCorrespondence resolves via 'direct-pixel-hit' (distance 0, always
		// reliable) -- no nearest-centroid guessing involved.
		expect(entity.ordinal).toBe(0);
		const labelmapDoc: LabelmapDocument = {
			assetId: 1,
			widthPx: 3,
			heightPx: 3,
			encoding: 'rle',
			runs: [
				[0, 4], // indices 0-3: (0,0) (1,0) (2,0) (0,1)
				[1, 1], // index 4 = (1,1): the one labeled pixel
				[0, 4], // indices 5-8: (2,1) (0,2) (1,2) (2,2)
			],
		};

		// `expect: 'trueFamily'` records the ground-truth author's declared expected
		// family -- present on the object per the schema, but (per this file's leading
		// doc comment) never read anywhere in inspect.ts's resolution/filtering logic.
		const truth: TruthDocument = {
			objects: [{ label: 'entity1', point: { x: 1, y: 1 }, expect: 'trueFamily' }],
		};

		const report = inspectTruth({
			truthLabel: 'entity1',
			truth,
			trace,
			manifest: result.manifest,
			labelmapDoc,
		});

		expect(report.ambiguous).toBeUndefined();
		if (report.ambiguous !== undefined) throw new Error('unreachable: expected a resolved report');

		// Correspondence must have found our exact entity via the direct pixel hit, not a
		// fallback/guess -- otherwise this test wouldn't even be exercising the scenario it
		// claims to.
		expect(report.correspondence).toEqual({
			method: 'direct-pixel-hit',
			distancePx: 0,
			entityId: entity.id,
			reliable: true,
		});
		expect(report.component?.entityId).toBe(entity.id);

		// buildStageBreakdowns finds the entity in BOTH stages, in trace-insertion order:
		// trueFamily (kept: true) first, wrongFamily (kept: false) second -- exactly
		// mirroring the real field bug's execution order (the true family's gate ran
		// first, the unrelated family's gate ran second).
		expect(report.stages).toHaveLength(2);
		expect(report.stages[0]).toMatchObject({ stageName: 'trueFamily', kept: true });
		expect(report.stages[1]).toMatchObject({ stageName: 'wrongFamily', kept: false });

		// THE HONEST, FALSIFIABLE ASSERTION: what does downstreamNote actually say?
		//
		// If Toph were family-scoped (or otherwise honest about multi-family ambiguity),
		// downstreamNote here would either report the entity as kept (it WAS kept, by its
		// true family) or explicitly flag that more than one family/stage touched this
		// entity and refuse to pick one. Observed behavior below is neither: it picks
		// `stages[stages.length - 1]` (wrongFamily, which merely ran later in source/
		// execution order) and reports a confident rejection.
		//
		// VERDICT: Toph is VULNERABLE.
		//
		// Observed downstreamNote (the buggy, confidently-wrong answer Toph actually
		// produces):
		//   'This component was rejected at "f.aspect" in stage "wrongFamily" -- every
		//   check and stage after that point never ran, so nothing downstream (including
		//   any un-instrumented appearance/association stage) was evaluated.'
		//
		// The correct real-world answer -- what a family-scoped query would report -- is
		// that this entity was KEPT (by trueFamily); wrongFamily's rejection is expected
		// and irrelevant, exactly the "a tee dying at the basket pool is expected, not a
		// loss" case from slice-feedback.md. Toph's downstreamNote asserts the opposite
		// with no hedge, no ambiguity flag, and no reference to `truth.expect` (which
		// does correctly say 'trueFamily' right here on the same object, completely
		// unconsulted). The gap lives at src/cli/inspect.ts's
		// `const lastStage = stages[stages.length - 1];` (~L410): "last" is trace-
		// insertion order, not "the entity's true family," and nothing upstream of it
		// (buildStageBreakdowns, resolveCorrespondence) carries or consults any family
		// concept either.
		expect(report.downstreamNote).toBe(
			'This component was rejected at "f.aspect" in stage "wrongFamily" -- every check and stage after that point never ran, so nothing downstream (including any un-instrumented appearance/association stage) was evaluated.'
		);

		// The misattribution is total: downstreamNote never mentions that the entity was
		// kept by ANY stage, even though report.stages[0].kept === true right there in the
		// same report object -- a consumer reading only downstreamNote (the human-readable
		// "the answer" field) has no way to recover that fact without re-deriving it from
		// `stages` themselves, defeating the point of a summary verdict.
		expect(report.downstreamNote).not.toContain('kept');
		expect(report.downstreamNote).not.toContain('survived');
		expect(report.downstreamNote).not.toContain('trueFamily');
	});
});
