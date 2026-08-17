// Item 6: duplicate check codes.
//
// (a) Two @toph check sites with the SAME code within ONE @toph filter stage -> must
//     produce TOPH104 and leave that filter site uninstrumented.
// (b) The SAME check code reused across TWO DIFFERENT @toph filter stages in the same
//     file -- validate.ts's `seenCodes` set is declared *inside* `validateFilterSite`
//     (a fresh `new Set<string>()` per call, i.e. per filter site), so nothing tracks
//     codes across stages. Prediction: this is allowed, no diagnostic. Proven
//     empirically below -- if the prediction were wrong this test would fail and that
//     mismatch would itself be the finding.

import { describe, expect, it } from 'vitest';
import { compileTrace, createIdAllocator } from '../../src/compiler/index.js';

describe('(a) duplicate check code within one filter stage', () => {
	const source = [
		'export interface Component { area: number; aspect: number; }',
		'export const components: Component[] = [{ area: 200, aspect: 1.2 }];',
		'export const minArea = 100;',
		'export const maxAspect = 2.0;',
		'',
		'/** @toph filter demo.dup */',
		'const survivors = components.filter((component) => {',
		'  /** @toph check area.min */',
		'  const areaOk = component.area >= minArea;',
		'  if (!areaOk) return false;',
		'  /** @toph check area.min */',
		'  const aspectOk = component.aspect <= maxAspect;',
		'  if (!aspectOk) return false;',
		'  return true;',
		'});',
		'',
		'export { survivors };',
		'',
	].join('\n');

	it('produces exactly one TOPH104 diagnostic and leaves the WHOLE filter site uninstrumented', () => {
		const result = compileTrace('dup-in-stage.ts', source, createIdAllocator());

		expect(result.diagnostics).toHaveLength(1);
		expect(result.diagnostics[0]).toMatchObject({
			code: 'TOPH104',
			message: 'Duplicate @toph check code "area.min" in filter stage "demo.dup".',
		});

		// The whole site (both checks, not just the second/duplicate one) is left
		// uninstrumented -- source untouched, no manifest entries at all for this file.
		expect(result.code).toBe(source);
		expect(result.manifest).toEqual({ stages: [], checks: [], assets: [], entityKinds: [] });
	});
});

describe('(b) the SAME check code reused across two DIFFERENT filter stages in one file', () => {
	const source = [
		'export interface Widget { area: number; }',
		'export interface Gadget { area: number; }',
		'export const widgets: Widget[] = [{ area: 200 }];',
		'export const gadgets: Gadget[] = [{ area: 300 }];',
		'export const minArea = 100;',
		'',
		'/** @toph filter stageA */',
		'const survivorsA = widgets.filter((w) => {',
		'  /** @toph check area.min */',
		'  const areaOk = w.area >= minArea;',
		'  if (!areaOk) return false;',
		'  return true;',
		'});',
		'',
		'/** @toph filter stageB */',
		'const survivorsB = gadgets.filter((g) => {',
		'  /** @toph check area.min */',
		'  const areaOk = g.area >= minArea;',
		'  if (!areaOk) return false;',
		'  return true;',
		'});',
		'',
		'export { survivorsA, survivorsB };',
		'',
	].join('\n');

	it('is currently ALLOWED: zero diagnostics, both stages instrumented, both checks share code "area.min" but have distinct IDs/stageIds', () => {
		const result = compileTrace('dup-across-stages.ts', source, createIdAllocator());

		expect(result.diagnostics).toEqual([]);
		expect(result.manifest.stages).toHaveLength(2);
		expect(result.manifest.checks).toHaveLength(2);

		const [checkA, checkB] = result.manifest.checks;
		expect(checkA.code).toBe('area.min');
		expect(checkB.code).toBe('area.min');
		expect(checkA.id).not.toBe(checkB.id);
		expect(checkA.stageId).not.toBe(checkB.stageId);

		// Both sites are actually instrumented (not silently dropped).
		expect(result.code.match(/__toph\.enterStage\(/g) ?? []).toHaveLength(2);
		expect(result.code.match(/__toph\.gte\(/g) ?? []).toHaveLength(2);
	});
});
