// Item 14: repeated stage invocation inflates buildSurvivalFunnel's counts.
//
// THE ADVERSARIAL CLAIM (written before running anything, per this repo's precedent in
// test/adversarial/13-known-gap-family-scoped-first-loss.test.ts):
//
// `src/runtime/index.ts`'s `enterStage` doc comment (~L38-41) says outright: "the same
// logical stage (e.g. a `.filter()` inside a loop, or called more than once) gets a
// fresh `invocationId` every time but a stable, increasing `seq`". This is a DESIGNED-
// FOR scenario, not an edge case the runtime merely tolerates -- one compiled
// `@toph filter` site (one `stageId` in the manifest) can legally run more than once at
// runtime, e.g. because its containing function is called once per tile/region/retry
// pass. Nothing in `src/compiler/validate.ts` restricts an annotated filter site to a
// single call site or a top-level position -- `validateFilterSite` (~L247-349) only
// checks the tagged statement's own local AST shape, never its enclosing scope or how
// many times that scope's containing function is invoked.
//
// `enterElement(stageInvocationId, ref)` (runtime/index.ts ~L302-331) resolves ref-based
// entity identity via `session.entityIdByRef`, a `WeakMap` scoped to the WHOLE session,
// not to any one stage invocation -- so if the exact same spawned-entity object reference
// is fed into the SAME filter site's containing function twice (e.g. an overlapping tile
// margin re-processing a component that sits in two tiles, or a retry pass re-running the
// same gate over the same pool), BOTH invocations resolve to the SAME entityId.
//
// `buildStageBreakdowns` (src/cli/inspect.ts ~L288-347) groups check events by
// `stageInvocationId`, so this produces TWO separate `StageBreakdown` entries for that one
// entity -- both carrying the identical `stageName`, by design (each invocation really did
// happen, with its own checks). That part is not itself the bug.
//
// The bug is in `buildSurvivalFunnel` (inspect.ts ~L459-526), which loops over exactly
// those breakdowns and does:
//   stages[index].reached += 1;
//   if (breakdown.kept) stages[index].kept += 1;
// once PER BREAKDOWN -- not once per (entity, stageName) pair, and not capped by, or even
// compared against, `correspondedCount`. A single ground-truth object, resolving to a
// single entity that a single stage happened to run twice for, is therefore counted TWICE
// toward that stage's `reached`/`kept` totals: the funnel's own `reached` count for a
// stage can end up strictly greater than `correspondedCount` (the total number of
// ground-truth objects that reliably corresponded to ANY component at all) -- an
// arithmetic impossibility for what the funnel claims to measure ("of the corresponded
// [truth objects], how many reached and survived each stage"), given there was only ever
// one corresponded truth object in this fixture.
//
// Toph is BROKEN if: one `@toph entities` spawn feeds a pool into one `@toph filter` site
// whose containing function is called twice on the same pool (so one real entity re-enters
// the same logical stage across two distinct stage invocations, by real ref-based identity,
// not a hand-simulated pair of ids), and `buildSurvivalFunnel`'s reported `reached` (and/or
// `kept`) count for that stage exceeds `correspondedCount`, for a fixture with exactly one
// ground-truth object.
//
// Toph DEFENDS if: buildSurvivalFunnel counts each corresponded entity at most once per
// stage name (e.g. by deduping breakdowns per (entityId, stageName) before counting, or by
// taking any-kept-wins across an entity's invocations of the same stage), so `reached`
// never exceeds `correspondedCount`.
//
// This test asserts on the ACTUAL numbers produced by running real compiled trace-mode
// code through the real runtime (src/runtime/index.ts) via execModuleWithRealRuntime, then
// feeding the resulting real TraceRun + manifest into the real (uninlined)
// buildStageBreakdowns and buildSurvivalFunnel -- so the outcome is whatever Toph actually
// does, not a hand-simulated prediction.

import { describe, expect, it } from 'vitest';
import { compileTrace, createIdAllocator } from '../../src/compiler/index.js';
import { buildStageBreakdowns, buildSurvivalFunnel } from '../../src/cli/inspect.js';
import type { LabelmapDocument } from '../../src/cli/labelmap.js';
import type { TruthDocument } from '../../src/cli/inspect.js';
import { execModuleWithRealRuntime } from './support/execModuleWithRealRuntime.js';

describe('repeated stage invocation: one filter site, one shared entity, called twice', () => {
	// One `@toph entities` spawn site producing a single-element pool. ONE `@toph filter`
	// site lives inside `runGate`, a plain function -- not a loop, nothing exotic --
	// mirroring the ordinary "extract the gate into a reusable function" shape a real
	// pipeline would use for a gate applied per tile/region/pass. `runGate` is called
	// TWICE on the exact same `pool` array reference, so the exact same spawned Widget
	// object (not a copy, not a lookalike) is fed through the SAME filter site twice.
	const source = [
		'export interface Widget { ok: boolean; }',
		'',
		'/** @toph entities widget */',
		'const pool: Widget[] = [{ ok: true }];',
		'',
		'function runGate(items: Widget[]): Widget[] {',
		'  /** @toph filter demo.gate */',
		'  const kept = items.filter((w) => {',
		'    /** @toph check w.ok */',
		'    const ok = w.ok === true;',
		'    if (!ok) return false;',
		'    return true;',
		'  });',
		'  return kept;',
		'}',
		'',
		'const survivorsA = runGate(pool);',
		'const survivorsB = runGate(pool);',
		'',
		'export { pool, survivorsA, survivorsB };',
		'',
	].join('\n');

	it('compiles one entity kind and one filter stage, no diagnostics', () => {
		const result = compileTrace('repeated-invocation.ts', source, createIdAllocator());
		expect(result.diagnostics).toEqual([]);
		expect(result.manifest.entityKinds).toHaveLength(1);
		// Exactly ONE compiled stage -- the runtime-level invocation-doubling this test is
		// about happens at RUNTIME (two enterStage(sameId) calls), not at compile time.
		expect(result.manifest.stages).toHaveLength(1);
		expect(result.manifest.stages[0].name).toBe('demo.gate');
		expect(result.manifest.checks).toHaveLength(1);
	});

	it('one real entity re-enters the same stage across two real stage invocations, by ref-based identity', () => {
		const result = compileTrace('repeated-invocation.ts', source, createIdAllocator());
		expect(result.diagnostics).toEqual([]);

		const { moduleExports, trace, error } = execModuleWithRealRuntime<{
			survivorsA: { ok: boolean }[];
			survivorsB: { ok: boolean }[];
		}>(result.code);
		expect(error).toBeNull();

		// Genuinely kept, both times.
		expect(moduleExports?.survivorsA).toEqual([{ ok: true }]);
		expect(moduleExports?.survivorsB).toEqual([{ ok: true }]);

		// Exactly one entity was ever spawned (spawnEntities ran once, over a 1-element pool).
		expect(trace.entities).toHaveLength(1);
		const entityId = trace.entities![0].id;

		// The SAME compiled stage (one stageId) really did run TWICE at runtime -- two
		// distinct invocationIds, seq 0 then seq 1, matching enterStage's documented
		// "called more than once" contract.
		expect(trace.stages).toHaveLength(2);
		expect(trace.stages[0].stageId).toBe(trace.stages[1].stageId);
		expect(trace.stages.map((s) => s.seq)).toEqual([0, 1]);
		expect(trace.stages[0].invocationId).not.toBe(trace.stages[1].invocationId);

		// BOTH invocations' check events reference the exact SAME entityId -- real
		// ref-based identity (enterElement's WeakMap lookup), not two coincidentally-equal
		// ids -- because `pool`'s one element object was fed into `runGate` twice by the
		// same reference.
		expect(trace.checks).toHaveLength(2);
		expect(trace.checks[0]).toMatchObject({ elementId: entityId, pass: true });
		expect(trace.checks[1]).toMatchObject({ elementId: entityId, pass: true });
		expect(trace.checks[0].stageInvocationId).not.toBe(trace.checks[1].stageInvocationId);
	});

	it('buildStageBreakdowns reports two same-named breakdowns for the one entity (not itself the bug)', () => {
		const result = compileTrace('repeated-invocation.ts', source, createIdAllocator());
		expect(result.diagnostics).toEqual([]);
		const { trace, error } = execModuleWithRealRuntime(result.code);
		expect(error).toBeNull();
		const entityId = trace.entities![0].id;

		const breakdowns = buildStageBreakdowns(entityId, trace, result.manifest);
		expect(breakdowns).toHaveLength(2);
		expect(breakdowns[0].stageName).toBe('demo.gate');
		expect(breakdowns[1].stageName).toBe('demo.gate');
		expect(breakdowns[0].kept).toBe(true);
		expect(breakdowns[1].kept).toBe(true);
	});

	it('VERDICT: buildSurvivalFunnel double-counts the one truth object toward "demo.gate"', () => {
		const result = compileTrace('repeated-invocation.ts', source, createIdAllocator());
		expect(result.diagnostics).toEqual([]);

		const { trace, error } = execModuleWithRealRuntime(result.code);
		expect(error).toBeNull();
		expect(trace.entities).toHaveLength(1);
		const entity = trace.entities![0];
		expect(entity.ordinal).toBe(0);

		// A tiny 3x3 labelmap with exactly one labeled pixel, at (1,1), label 1 -> ordinal 0
		// -> our one spawned entity (resolveCorrespondence's documented direct-pixel-hit
		// convention, same fixture shape as item 13's test).
		const labelmapDoc: LabelmapDocument = {
			assetId: 1,
			widthPx: 3,
			heightPx: 3,
			encoding: 'rle',
			runs: [
				[0, 4],
				[1, 1],
				[0, 4],
			],
		};

		// Exactly ONE ground-truth object in the whole fixture.
		const truth: TruthDocument = {
			objects: [{ label: 'widget1', point: { x: 1, y: 1 } }],
		};

		const funnel = buildSurvivalFunnel({
			truth,
			trace,
			manifest: result.manifest,
			labelmapDoc,
			stageOrder: ['demo.gate'],
		});

		// One truth object, confidently resolved, reliably corresponded to exactly one
		// component. So far, everything is internally consistent.
		expect(funnel.totalTruthObjects).toBe(1);
		expect(funnel.confidentCount).toBe(1);
		expect(funnel.ambiguousCount).toBe(0);
		expect(funnel.correspondedCount).toBe(1);

		// THE HONEST, FALSIFIABLE ASSERTION: what does the funnel actually report for
		// "demo.gate"?
		//
		// If buildSurvivalFunnel counted each corresponded entity AT MOST ONCE per stage
		// name (deduping the two same-named breakdowns, or taking "reached/kept" as a
		// boolean per entity per stage rather than per breakdown), `reached` and `kept`
		// here would both be 1 -- matching `correspondedCount`, the only truth object in
		// the fixture. Observed behavior is neither: it sums across ALL breakdowns
		// regardless of how many invocations produced them.
		//
		// VERDICT: Toph is VULNERABLE. `reached` (and `kept`) for "demo.gate" is 2 -- double
		// `correspondedCount` (1) -- purely because this one entity's single filter stage
		// happened to run twice. Nothing in the FunnelReport flags this as anomalous; a
		// consumer reading `stages` sees "2 objects reached demo.gate, both kept" when in
		// truth there was only ever one ground-truth object in the entire fixture.
		expect(funnel.stages).toHaveLength(1);
		expect(funnel.stages[0]).toEqual({ stageName: 'demo.gate', reached: 2, kept: 2 });

		// The arithmetic impossibility, stated directly: a stage's reached count strictly
		// exceeding the total number of corresponded ground-truth objects that fed the
		// funnel at all.
		expect(funnel.stages[0].reached).toBeGreaterThan(funnel.correspondedCount);
	});
});
