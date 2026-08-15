// Item 7: unsupported syntax -> clear, correctly-coded diagnostics, 6 distinct shapes.
// Each test asserts the EXACT TOPH1xx code (not just "some diagnostic exists"), and
// that compileTrace's `code` output leaves that exact site completely unmodified
// while unrelated code in the same file (including, for some cases, an entirely
// separate VALID @toph filter site) is untouched.

import { describe, expect, it } from 'vitest';
import { compileTrace, createIdAllocator } from '../../src/compiler/index.js';

const UNRELATED = 'export const unrelated = 42;';
const VALID_SITE = [
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
].join('\n');

function assertUnrelatedAndValidSiteUntouched(code: string, badSiteSnippet: string): void {
	// The bad site's original text is still literally present, byte for byte.
	expect(code).toContain(badSiteSnippet);
	// Unrelated code elsewhere in the file is untouched.
	expect(code).toContain(UNRELATED);
	// The separate VALID site nearby WAS instrumented -- proving the bad site's presence
	// doesn't poison the rest of the file.
	expect(code).toContain('__toph.enterStage(');
	expect(code).toContain('const otherSurvivors = others.filter((o) => {');
}

describe('shape 1: guard combining two conditions ("if (!a || !b) return false;")', () => {
	const badSite = [
		'/** @toph filter demo.combinedGuard */',
		'const survivors = components.filter((component) => {',
		'  /** @toph check area.min */',
		'  const areaOk = component.area >= minArea;',
		'  if (!areaOk || extraFlag) return false;',
		'  return true;',
		'});',
	].join('\n');

	const source = [
		'export interface Component { area: number; }',
		'export const components: Component[] = [{ area: 5 }];',
		'export const minArea = 1;',
		'export const extraFlag = true;',
		UNRELATED,
		badSite,
		VALID_SITE,
		'',
	].join('\n');

	it('is TOPH103 (guard shape mismatch), site left unmodified, rest of file instrumented normally', () => {
		const result = compileTrace('bad1.ts', source, createIdAllocator());
		expect(result.diagnostics).toHaveLength(1);
		expect(result.diagnostics[0].code).toBe('TOPH103');
		assertUnrelatedAndValidSiteUntouched(result.code, badSite);
		// Only the valid site got instrumented -- 1 stage, not 2.
		expect(result.manifest.stages).toHaveLength(1);
		expect(result.manifest.stages[0].name).toBe('valid.other');
	});
});

describe('shape 2: a ternary in place of the guard\'s condition', () => {
	const badSite = [
		'/** @toph filter demo.ternaryGuard */',
		'const survivors = components.filter((component) => {',
		'  /** @toph check area.min */',
		'  const areaOk = component.area >= minArea;',
		'  if (areaOk ? false : true) return false;',
		'  return true;',
		'});',
	].join('\n');

	const source = [
		'export interface Component { area: number; }',
		'export const components: Component[] = [{ area: 5 }];',
		'export const minArea = 1;',
		UNRELATED,
		badSite,
		VALID_SITE,
		'',
	].join('\n');

	it('is TOPH103 (guard condition is not "!<boolIdent>"), site left unmodified', () => {
		const result = compileTrace('bad2.ts', source, createIdAllocator());
		expect(result.diagnostics).toHaveLength(1);
		expect(result.diagnostics[0].code).toBe('TOPH103');
		assertUnrelatedAndValidSiteUntouched(result.code, badSite);
	});
});

describe('shape 3: check declaration initializer is a bare identifier (not a binary comparison), valid-looking guard after', () => {
	const badSite = [
		'/** @toph filter demo.bareIdent */',
		'const survivors = components.filter((component) => {',
		'  /** @toph check area.min */',
		'  const areaOk = component.precomputedFlag;',
		'  if (!areaOk) return false;',
		'  return true;',
		'});',
	].join('\n');

	const source = [
		'export interface Component { area: number; precomputedFlag: boolean; }',
		'export const components: Component[] = [{ area: 5, precomputedFlag: true }];',
		UNRELATED,
		badSite,
		VALID_SITE,
		'',
	].join('\n');

	it('is TOPH102 (unsupported expression shape), site left unmodified', () => {
		const result = compileTrace('bad3.ts', source, createIdAllocator());
		expect(result.diagnostics).toHaveLength(1);
		expect(result.diagnostics[0].code).toBe('TOPH102');
		expect(result.diagnostics[0].message).toContain('area.min');
		assertUnrelatedAndValidSiteUntouched(result.code, badSite);
	});
});

describe('shape 3b: check declaration initializer is a bare boolean literal', () => {
	const badSite = [
		'/** @toph filter demo.boolLiteral */',
		'const survivors = components.filter((component) => {',
		'  /** @toph check area.min */',
		'  const areaOk = true;',
		'  if (!areaOk) return false;',
		'  return true;',
		'});',
	].join('\n');

	const source = [
		'export interface Component { area: number; }',
		'export const components: Component[] = [{ area: 5 }];',
		UNRELATED,
		badSite,
		VALID_SITE,
		'',
	].join('\n');

	it('is TOPH102, site left unmodified', () => {
		const result = compileTrace('bad3b.ts', source, createIdAllocator());
		expect(result.diagnostics).toHaveLength(1);
		expect(result.diagnostics[0].code).toBe('TOPH102');
		assertUnrelatedAndValidSiteUntouched(result.code, badSite);
	});
});

describe('shape 4: .filter(function(x) { ... }) -- function expression instead of arrow', () => {
	const badSite = [
		'/** @toph filter demo.funcExpr */',
		'const survivors = components.filter(function (component) {',
		'  /** @toph check area.min */',
		'  const areaOk = component.area >= minArea;',
		'  if (!areaOk) return false;',
		'  return true;',
		'});',
	].join('\n');

	const source = [
		'export interface Component { area: number; }',
		'export const components: Component[] = [{ area: 5 }];',
		'export const minArea = 1;',
		UNRELATED,
		badSite,
		VALID_SITE,
		'',
	].join('\n');

	it('is TOPH101 (filter site shape), site left unmodified', () => {
		const result = compileTrace('bad4.ts', source, createIdAllocator());
		expect(result.diagnostics).toHaveLength(1);
		expect(result.diagnostics[0].code).toBe('TOPH101');
		assertUnrelatedAndValidSiteUntouched(result.code, badSite);
	});
});

describe('shape 5: two-parameter arrow function', () => {
	const badSite = [
		'/** @toph filter demo.twoParams */',
		'const survivors = components.filter((component, index) => {',
		'  /** @toph check area.min */',
		'  const areaOk = component.area >= minArea;',
		'  if (!areaOk) return false;',
		'  return true;',
		'});',
	].join('\n');

	const source = [
		'export interface Component { area: number; }',
		'export const components: Component[] = [{ area: 5 }];',
		'export const minArea = 1;',
		UNRELATED,
		badSite,
		VALID_SITE,
		'',
	].join('\n');

	it('is TOPH101 (filter site shape), site left unmodified', () => {
		const result = compileTrace('bad5.ts', source, createIdAllocator());
		expect(result.diagnostics).toHaveLength(1);
		expect(result.diagnostics[0].code).toBe('TOPH101');
		assertUnrelatedAndValidSiteUntouched(result.code, badSite);
	});
});

describe('shape 6: filter body does not end in "return true;" (ends in "return survivors;" instead)', () => {
	const badSite = [
		'/** @toph filter demo.wrongFinalReturn */',
		'const survivors = components.filter((component) => {',
		'  /** @toph check area.min */',
		'  const areaOk = component.area >= minArea;',
		'  if (!areaOk) return false;',
		'  const survivors = true;',
		'  return survivors;',
		'});',
	].join('\n');

	const source = [
		'export interface Component { area: number; }',
		'export const components: Component[] = [{ area: 5 }];',
		'export const minArea = 1;',
		UNRELATED,
		badSite,
		VALID_SITE,
		'',
	].join('\n');

	it('is TOPH101 (filter site shape), site left unmodified', () => {
		const result = compileTrace('bad6.ts', source, createIdAllocator());
		expect(result.diagnostics).toHaveLength(1);
		expect(result.diagnostics[0].code).toBe('TOPH101');
		assertUnrelatedAndValidSiteUntouched(result.code, badSite);
	});
});

describe('shape 6b: trailing dead code after the checks (no final return at all in the right position)', () => {
	const badSite = [
		'/** @toph filter demo.trailingDeadCode */',
		'const survivors = components.filter((component) => {',
		'  /** @toph check area.min */',
		'  const areaOk = component.area >= minArea;',
		'  if (!areaOk) return false;',
		'  return true;',
		'  console.log("unreachable");',
		'});',
	].join('\n');

	const source = [
		'export interface Component { area: number; }',
		'export const components: Component[] = [{ area: 5 }];',
		'export const minArea = 1;',
		UNRELATED,
		badSite,
		VALID_SITE,
		'',
	].join('\n');

	it('is TOPH101 (final statement is not the trailing "return true;"), site left unmodified', () => {
		const result = compileTrace('bad6b.ts', source, createIdAllocator());
		expect(result.diagnostics).toHaveLength(1);
		expect(result.diagnostics[0].code).toBe('TOPH101');
		assertUnrelatedAndValidSiteUntouched(result.code, badSite);
	});
});
