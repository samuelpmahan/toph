// Item 1: nested/multiple @toph filter sites don't cross-talk.
//
// IMPLEMENTATION-DECISIONS.md section 6 claims "no ambient/global 'current entity' --
// __toph_e/__toph_s<N> are ordinary local variables threaded through generated code
// only -- this is immune to the re-entrancy bugs a mutable 'current entity' global
// would have under nested @toph filter sites". This file proves that claim against
// REAL compiled + REAL-runtime-executed output, not just by reading the codegen.

import { describe, expect, it } from 'vitest';
import { compileTrace, createIdAllocator } from '../../src/compiler/index.js';
import { execModuleWithRealRuntime } from './support/execModuleWithRealRuntime.js';

describe('two independent @toph filter sites in one file', () => {
	const source = [
		'export interface Widget { area: number; }',
		'export interface Gadget { weight: number; }',
		'',
		'export const widgets: Widget[] = [{ area: 5 }, { area: 50 }, { area: 500 }];',
		'export const gadgets: Gadget[] = [{ weight: 1 }, { weight: 20 }];',
		'export const minArea = 10;',
		'export const minWeight = 5;',
		'',
		'/** @toph filter stageA */',
		'const survivorsA = widgets.filter((widget) => {',
		'  /** @toph check a.area */',
		'  const areaOk = widget.area >= minArea;',
		'  if (!areaOk) return false;',
		'  return true;',
		'});',
		'',
		'/** @toph filter stageB */',
		'const survivorsB = gadgets.filter((gadget) => {',
		'  /** @toph check b.weight */',
		'  const weightOk = gadget.weight >= minWeight;',
		'  if (!weightOk) return false;',
		'  return true;',
		'});',
		'',
		'export { survivorsA, survivorsB };',
		'',
	].join('\n');

	it('compiles both sites with distinct stage/check IDs', () => {
		const result = compileTrace('two-sites.ts', source, createIdAllocator());
		expect(result.diagnostics).toEqual([]);
		expect(result.manifest.stages).toHaveLength(2);
		expect(result.manifest.checks).toHaveLength(2);

		const [stageA, stageB] = result.manifest.stages;
		expect(stageA.name).toBe('stageA');
		expect(stageB.name).toBe('stageB');
		expect(stageA.id).not.toBe(stageB.id);

		const [checkA, checkB] = result.manifest.checks;
		expect(checkA.stageId).toBe(stageA.id);
		expect(checkB.stageId).toBe(stageB.id);
		expect(checkA.id).not.toBe(checkB.id);
	});

	it('executes with zero interference: stage B ordinals/IDs never leak into stage A, and vice versa', () => {
		const result = compileTrace('two-sites.ts', source, createIdAllocator());
		expect(result.diagnostics).toEqual([]);
		const [stageA, stageB] = result.manifest.stages;
		const [checkA, checkB] = result.manifest.checks;

		const { moduleExports, trace, error } = execModuleWithRealRuntime<{
			survivorsA: { area: number }[];
			survivorsB: { weight: number }[];
		}>(result.code);

		expect(error).toBeNull();
		expect(moduleExports?.survivorsA).toEqual([{ area: 50 }, { area: 500 }]);
		expect(moduleExports?.survivorsB).toEqual([{ weight: 20 }]);

		// Exactly one stage invocation each, both seq 0 (each stage ran once), with the
		// right stageId -- not swapped, not merged.
		expect(trace.stages).toHaveLength(2);
		const invA = trace.stages.find((s) => s.stageId === stageA.id);
		const invB = trace.stages.find((s) => s.stageId === stageB.id);
		expect(invA).toMatchObject({ stageId: stageA.id, seq: 0 });
		expect(invB).toMatchObject({ stageId: stageB.id, seq: 0 });
		expect(invA!.invocationId).not.toBe(invB!.invocationId);

		// Stage A's 3 elements have ordinals 0,1,2 scoped to invA -- stage B's 2 elements
		// have ordinals 0,1 scoped to invB. Neither invocation's element count or ordinal
		// sequence is polluted by the other's.
		const elsA = trace.elements.filter((e) => e.stageInvocationId === invA!.invocationId);
		const elsB = trace.elements.filter((e) => e.stageInvocationId === invB!.invocationId);
		expect(elsA.map((e) => e.ordinal).sort((x, y) => x - y)).toEqual([0, 1, 2]);
		expect(elsB.map((e) => e.ordinal).sort((x, y) => x - y)).toEqual([0, 1]);
		expect(trace.elements).toHaveLength(5); // 3 + 2, no phantom extras from cross-talk

		// checkA events only ever reference stage A's elements/invocation; checkB events
		// only ever reference stage B's. A cross-talk bug would show up as a checkA event
		// with an elementId that belongs to stage B's invocation (or vice versa).
		const checkAEvents = trace.checks.filter((c) => c.checkId === checkA.id);
		const checkBEvents = trace.checks.filter((c) => c.checkId === checkB.id);
		expect(checkAEvents).toHaveLength(3);
		expect(checkBEvents).toHaveLength(2);
		const elsAIds = new Set(elsA.map((e) => e.id));
		const elsBIds = new Set(elsB.map((e) => e.id));
		expect(checkAEvents.every((c) => elsAIds.has(c.elementId) && c.stageInvocationId === invA!.invocationId)).toBe(
			true
		);
		expect(checkBEvents.every((c) => elsBIds.has(c.elementId) && c.stageInvocationId === invB!.invocationId)).toBe(
			true
		);
		// No element id appears in both stages' element sets.
		for (const id of elsAIds) expect(elsBIds.has(id)).toBe(false);
	});
});

describe('a second @toph filter site consuming the first stage\'s survivors (chained)', () => {
	const source = [
		'export interface Comp { area: number; aspect: number; }',
		'export const raw: Comp[] = [',
		'  { area: 200, aspect: 1.0 },',
		'  { area: 5, aspect: 1.0 },',
		'  { area: 300, aspect: 9.0 },',
		'];',
		'export const minArea = 10;',
		'export const maxAspect = 2.0;',
		'',
		'/** @toph filter byArea */',
		'const byAreaSurvivors = raw.filter((c) => {',
		'  /** @toph check area.min */',
		'  const areaOk = c.area >= minArea;',
		'  if (!areaOk) return false;',
		'  return true;',
		'});',
		'',
		'/** @toph filter byAspect */',
		'const finalSurvivors = byAreaSurvivors.filter((c) => {',
		'  /** @toph check aspect.max */',
		'  const aspectOk = c.aspect <= maxAspect;',
		'  if (!aspectOk) return false;',
		'  return true;',
		'});',
		'',
		'export { finalSurvivors };',
		'',
	].join('\n');

	it('the second stage\'s ordinals start fresh at 0 over the FIRST stage\'s survivor count, not the original array length', () => {
		const result = compileTrace('chained.ts', source, createIdAllocator());
		expect(result.diagnostics).toEqual([]);
		const [stageByArea, stageByAspect] = result.manifest.stages;

		const { moduleExports, trace, error } = execModuleWithRealRuntime<{ finalSurvivors: unknown[] }>(result.code);
		expect(error).toBeNull();
		// raw[0] survives both; raw[1] fails area; raw[2] passes area but fails aspect.
		expect(moduleExports?.finalSurvivors).toEqual([{ area: 200, aspect: 1.0 }]);

		const invByArea = trace.stages.find((s) => s.stageId === stageByArea.id)!;
		const invByAspect = trace.stages.find((s) => s.stageId === stageByAspect.id)!;

		// byArea saw all 3 raw elements (ordinals 0,1,2).
		const elsByArea = trace.elements.filter((e) => e.stageInvocationId === invByArea.invocationId);
		expect(elsByArea.map((e) => e.ordinal).sort()).toEqual([0, 1, 2]);

		// byAspect only saw the 2 survivors of byArea (raw[0], raw[2]) -- its ordinals
		// restart at 0, independent of byArea's element ids/ordinals.
		const elsByAspect = trace.elements.filter((e) => e.stageInvocationId === invByAspect.invocationId);
		expect(elsByAspect.map((e) => e.ordinal).sort()).toEqual([0, 1]);
		expect(elsByAspect).toHaveLength(2);
	});
});

describe('true nested stage invocation: a check operand call re-enters a DIFFERENT @toph filter stage', () => {
	// This is the strongest form of "nesting" expressible under the supported grammar
	// (IMPLEMENTATION-DECISIONS.md section 4): a check operand may be any expression,
	// including a function call, and nothing stops that function's body from containing
	// its own independent @toph filter site. Every time the outer stage evaluates this
	// check for one element, the WHOLE inner stage runs again from scratch (a fresh
	// enterStage() call, fresh element ordinals) *while the outer element's own
	// __toph_e is still logically "in scope"* (its check hasn't returned yet). If
	// __toph_e / __toph_s were anything other than ordinary block-scoped locals (e.g. a
	// mutable "current entity" global), this is exactly the shape that would corrupt
	// state -- IMPLEMENTATION-DECISIONS.md section 6's "no ambient/global 'current
	// entity'" claim is a claim about surviving precisely this case.
	const source = [
		'export interface Item { value: number; }',
		'export const outerItems: Item[] = [{ value: 1 }, { value: 2 }, { value: 3 }];',
		'export const innerItems: Item[] = [{ value: 10 }, { value: -1 }, { value: 20 }];',
		'',
		'export function runInnerStage(): number {',
		'  /** @toph filter stageInner */',
		'  const innerSurvivors = innerItems.filter((innerItem) => {',
		'    /** @toph check inner.positive */',
		'    const innerOk = innerItem.value >= 0;',
		'    if (!innerOk) return false;',
		'    return true;',
		'  });',
		'  return innerSurvivors.length;',
		'}',
		'',
		'/** @toph filter stageOuter */',
		'const outerSurvivors = outerItems.filter((outerItem) => {',
		'  /** @toph check outer.positiveInnerCount */',
		'  const outerOk = runInnerStage() >= outerItem.value;',
		'  if (!outerOk) return false;',
		'  return true;',
		'});',
		'',
		'export { outerSurvivors };',
		'',
	].join('\n');

	it('executes correctly with the inner stage re-entered once per outer element, none of it leaking into the outer bookkeeping', () => {
		const result = compileTrace('nested-stage.ts', source, createIdAllocator());
		expect(result.diagnostics).toEqual([]);
		expect(result.manifest.stages).toHaveLength(2);
		const stageInner = result.manifest.stages.find((s) => s.name === 'stageInner')!;
		const stageOuter = result.manifest.stages.find((s) => s.name === 'stageOuter')!;

		const { moduleExports, trace, error } = execModuleWithRealRuntime<{ outerSurvivors: { value: number }[] }>(
			result.code
		);
		expect(error).toBeNull();

		// runInnerStage() always returns 2 (innerItems has 2 non-negative values: 10, 20).
		// outerOk = 2 >= outerItem.value -- true for value 1 and 2, false for value 3.
		expect(moduleExports?.outerSurvivors).toEqual([{ value: 1 }, { value: 2 }]);

		// The outer stage ran exactly once (it's a single top-level .filter() call).
		const outerInvocations = trace.stages.filter((s) => s.stageId === stageOuter.id);
		expect(outerInvocations).toHaveLength(1);
		expect(outerInvocations[0].seq).toBe(0);

		// The check operand `runInnerStage() >= outerItem.value` calls runInnerStage()
		// unconditionally (it's the left operand, evaluated before the comparison, and
		// it's the only check in this stage, so no short-circuiting skips it) -- once per
		// outer element evaluated. outerItems has 3 elements, so the inner stage must have
		// run exactly 3 times, with seq 0, 1, 2, in that order.
		const innerInvocations = trace.stages.filter((s) => s.stageId === stageInner.id);
		expect(innerInvocations).toHaveLength(3);
		expect(innerInvocations.map((s) => s.seq)).toEqual([0, 1, 2]);

		// Every inner invocation independently saw all 3 innerItems (ordinals 0,1,2) --
		// none of the outer stage's element bookkeeping bled into it, and none of one
		// inner invocation's elements bled into another.
		for (const inv of innerInvocations) {
			const els = trace.elements.filter((e) => e.stageInvocationId === inv.invocationId);
			expect(els.map((e) => e.ordinal).sort((a, b) => a - b)).toEqual([0, 1, 2]);
			// 2 of the 3 innerItems are non-negative -> exactly 2 kept per invocation.
			expect(els.filter((e) => e.kept)).toHaveLength(2);
		}

		// Outer stage's own 3 elements (ordinals 0,1,2) are exactly the outer invocation's
		// elements -- untouched by the 9 total inner elements (3 invocations x 3 items)
		// that were recorded interleaved with them.
		const outerEls = trace.elements.filter((e) => e.stageInvocationId === outerInvocations[0].invocationId);
		expect(outerEls.map((e) => e.ordinal).sort((a, b) => a - b)).toEqual([0, 1, 2]);
		expect(outerEls.filter((e) => e.kept)).toHaveLength(2);

		// Total element count: 3 outer + 3*3 inner = 12. No phantom/missing elements from
		// interleaving.
		expect(trace.elements).toHaveLength(12);

		// Every element id across both stages is globally unique (no id ever reused
		// between an outer element and an inner one from any invocation).
		expect(new Set(trace.elements.map((e) => e.id)).size).toBe(12);
		// Every stage invocation id is globally unique across the 1 outer + 3 inner = 4
		// invocations.
		expect(new Set(trace.stages.map((s) => s.invocationId)).size).toBe(4);
	});
});

describe('an inline, un-annotated .filter() embedded inside a check operand is never mistaken for a filter site', () => {
	// This is the shape the brief describes as "a nested .filter() call sharing the
	// outer element in scope" -- but directives attach to *statements*
	// (findLeadingDirective looks at a statement's leading comment), and an inline
	// `.filter()` used as a sub-expression of a check's operand is not itself a
	// statement -- there is no syntactic position for a `@toph filter` comment to
	// attach to it even if an author wanted to. So true syntactic nesting of two
	// *directive-recognized* filter sites, one inside the other's callback body, is not
	// expressible: the AST shape rules preclude it structurally, not just by
	// convention. What IS expressible (and worth checking doesn't misfire) is an
	// ordinary, un-annotated `.filter()` call embedded in a check operand -- this must
	// never be treated as a second filter site, and must not perturb the outer stage's
	// own element identity.
	const source = [
		'export interface Item { value: number; }',
		'export const outerItems: Item[] = [{ value: 1 }, { value: 2 }, { value: 3 }];',
		'export const pool: number[] = [1, 2, 3, 4, 5];',
		'',
		'/** @toph filter stageOuter */',
		'const outerSurvivors = outerItems.filter((outerItem) => {',
		'  /** @toph check outer.poolCount */',
		'  const outerOk = pool.filter((p) => p >= outerItem.value).length >= 2;',
		'  if (!outerOk) return false;',
		'  return true;',
		'});',
		'',
		'export { outerSurvivors };',
		'',
	].join('\n');

	it('compiles with exactly ONE stage/check (the inline .filter() is not separately instrumented)', () => {
		const result = compileTrace('inline-filter.ts', source, createIdAllocator());
		expect(result.diagnostics).toEqual([]);
		expect(result.manifest.stages).toHaveLength(1);
		expect(result.manifest.checks).toHaveLength(1);
		// The inline `pool.filter(...)` call survives verbatim in the generated check
		// argument text -- it is not rewritten, wrapped, or given its own enterStage call.
		expect(result.code).toContain('pool.filter((p) => p >= outerItem.value).length');
		expect(result.code.match(/__toph\.enterStage\(/g) ?? []).toHaveLength(1);
	});

	it('executes correctly with outer element identity intact despite the embedded plain .filter() calls', () => {
		const result = compileTrace('inline-filter.ts', source, createIdAllocator());
		const { moduleExports, trace, error } = execModuleWithRealRuntime<{ outerSurvivors: { value: number }[] }>(
			result.code
		);
		expect(error).toBeNull();
		// pool = [1,2,3,4,5]. outerItem.value=1 -> pool>=1 count 5 -> ok. value=2 -> count 4
		// -> ok. value=3 -> count 3 -> ok. All 3 survive.
		expect(moduleExports?.outerSurvivors).toEqual([{ value: 1 }, { value: 2 }, { value: 3 }]);

		expect(trace.stages).toHaveLength(1);
		expect(trace.elements).toHaveLength(3);
		const ordinals = trace.elements.map((e) => e.ordinal).sort((a, b) => a - b);
		expect(ordinals).toEqual([0, 1, 2]);
		expect(trace.elements.every((e) => e.kept)).toBe(true);
	});
});
