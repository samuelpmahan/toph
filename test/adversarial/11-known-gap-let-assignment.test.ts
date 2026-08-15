// Item 11: known, already-documented gap (IMPLEMENTATION-DECISIONS.md section 9) --
// ChainSpot's real target code uses an ASSIGNMENT to a pre-declared `let`, not a
// `const` declaration:
//
//   let teeComponents: MaskComponent[] = [];
//   // ...
//   teeComponents = brightComponents.filter((component) => { /* checks */ return true; });
//
// This is NOT news -- it's a confirmed gap the orchestrator already knows about. This
// test exists to pin down PRECISELY which diagnostic fires (TOPH101, from the
// @toph-filter site-shape validation, since validateFilterSite's very first shape
// check is `ts.isVariableStatement(node)`, and an ExpressionStatement assignment is
// not a VariableStatement) and to prove nothing crashes or mis-instruments -- solid
// evidence ahead of closing the gap in Phase 4, not a fix.

import { describe, expect, it } from 'vitest';
import { compileTrace, compileProduction, createIdAllocator } from '../../src/compiler/index.js';

function buildSource(): string {
	return [
		'export interface MaskComponent { area: number; }',
		'export declare const brightComponents: MaskComponent[];',
		'export declare const minArea: number;',
		'',
		'let teeComponents: MaskComponent[] = [];',
		'',
		'/** @toph filter p1.tee.geometry */',
		'teeComponents = brightComponents.filter((component) => {',
		'  /** @toph check area.min */',
		'  const areaOk = component.area >= minArea;',
		'  if (!areaOk) return false;',
		'  return true;',
		'});',
		'',
		'export { teeComponents };',
		'',
	].join('\n');
}

describe('the real ChainSpot let-assignment shape is rejected as TOPH101, not silently mis-instrumented', () => {
	it('compileTrace: exactly one TOPH101 diagnostic, code left completely unmodified, no crash', () => {
		const source = buildSource();
		expect(() => compileTrace('let-assign.ts', source, createIdAllocator())).not.toThrow();

		const result = compileTrace('let-assign.ts', source, createIdAllocator());
		expect(result.diagnostics).toHaveLength(1);
		expect(result.diagnostics[0].code).toBe('TOPH101');
		// Specifically the filter-site shape message (references the stage name), not
		// TOPH102/103/104/105 -- confirming it's diagnosed as a filter-site shape mismatch,
		// not misread as a malformed check or a duplicate-code error.
		expect(result.diagnostics[0].message).toContain('p1.tee.geometry');
		expect(result.diagnostics[0].message).toContain('must be attached to a "const');

		expect(result.code).toBe(source);
		expect(result.manifest).toEqual({ stages: [], checks: [] });
	});

	it('compileProduction: same TOPH101, code still byte-identical to source (production mode never crashes on this shape either)', () => {
		const source = buildSource();
		const result = compileProduction('let-assign.ts', source);
		expect(result.diagnostics).toHaveLength(1);
		expect(result.diagnostics[0].code).toBe('TOPH101');
		expect(result.code).toBe(source);
	});

	it('an unrelated, valid @toph filter site elsewhere in the same file is still instrumented normally -- the gap is local to the let-assignment site', () => {
		const source = [
			buildSource(),
			'',
			'export interface Other { size: number; }',
			'export const others: Other[] = [{ size: 5 }];',
			'export const minSize = 1;',
			'',
			'/** @toph filter valid.other */',
			'const otherSurvivors = others.filter((o) => {',
			'  /** @toph check size.min */',
			'  const sizeOk = o.size >= minSize;',
			'  if (!sizeOk) return false;',
			'  return true;',
			'});',
			'export { otherSurvivors };',
			'',
		].join('\n');

		const result = compileTrace('let-assign-mixed.ts', source, createIdAllocator());
		expect(result.diagnostics).toHaveLength(1);
		expect(result.diagnostics[0].code).toBe('TOPH101');

		expect(result.manifest.stages).toHaveLength(1);
		expect(result.manifest.stages[0].name).toBe('valid.other');
		expect(result.code).toContain('__toph.enterStage(');
		expect(result.code).toContain('const otherSurvivors = others.filter((o) => {');
		// The let-assignment site's original text is preserved verbatim, uninstrumented.
		expect(result.code).toContain('teeComponents = brightComponents.filter((component) => {');
		expect(result.code).not.toContain('__toph.enterStage(1);\nlet teeComponents');
	});
});
