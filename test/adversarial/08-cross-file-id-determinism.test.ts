// Item 8: cross-file / multi-compile ID determinism.
//
// (a) Two different synthetic fixtures compiled with ONE shared IdAllocator (as a real
//     multi-file build would thread it) -> globally unique IDs across both files'
//     manifests, assigned in document order.
// (b) compileTrace called twice on the SAME source with two fresh, identically
//     configured allocators -> byte-identical `code` output both times (no hidden
//     nondeterminism -- object key ordering, Math.random, Date, etc).

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { compileTrace, createIdAllocator } from '../../src/compiler/index.js';

function fileA(): string {
	return [
		'export interface Widget { area: number; weight: number; }',
		'export const widgets: Widget[] = [{ area: 200, weight: 3 }];',
		'export const minArea = 10;',
		'export const minWeight = 1;',
		'',
		'/** @toph filter fileA.first */',
		'const first = widgets.filter((w) => {',
		'  /** @toph check a.area */',
		'  const areaOk = w.area >= minArea;',
		'  if (!areaOk) return false;',
		'  /** @toph check a.weight */',
		'  const weightOk = w.weight >= minWeight;',
		'  if (!weightOk) return false;',
		'  return true;',
		'});',
		'',
		'/** @toph filter fileA.second */',
		'const second = first.filter((w) => {',
		'  /** @toph check a.weight2 */',
		'  const weightOk = w.weight >= minWeight;',
		'  if (!weightOk) return false;',
		'  return true;',
		'});',
		'',
		'export { first, second };',
		'',
	].join('\n');
}

function fileB(): string {
	return [
		'export interface Gadget { size: number; }',
		'export const gadgets: Gadget[] = [{ size: 7 }];',
		'export const minSize = 1;',
		'',
		'/** @toph filter fileB.only */',
		'const kept = gadgets.filter((g) => {',
		'  /** @toph check b.size */',
		'  const sizeOk = g.size >= minSize;',
		'  if (!sizeOk) return false;',
		'  return true;',
		'});',
		'',
		'export { kept };',
		'',
	].join('\n');
}

describe('a single shared IdAllocator threaded across two file compiles', () => {
	it('produces globally unique stage/check IDs across both files, in deterministic (call-order, then document-order) sequence', () => {
		const ids = createIdAllocator();
		const resultA = compileTrace('fileA.ts', fileA(), ids);
		const resultB = compileTrace('fileB.ts', fileB(), ids);

		expect(resultA.diagnostics).toEqual([]);
		expect(resultB.diagnostics).toEqual([]);

		// fileA has 2 stages (first, second) and 3 checks (a.area, a.weight, a.weight2), in
		// document order.
		expect(resultA.manifest.stages.map((s) => s.name)).toEqual(['fileA.first', 'fileA.second']);
		expect(resultA.manifest.checks.map((c) => c.code)).toEqual(['a.area', 'a.weight', 'a.weight2']);
		// IDs increase monotonically within the file, matching document order.
		expect(resultA.manifest.stages[0].id).toBeLessThan(resultA.manifest.stages[1].id);
		expect(resultA.manifest.checks[0].id).toBeLessThan(resultA.manifest.checks[1].id);
		expect(resultA.manifest.checks[1].id).toBeLessThan(resultA.manifest.checks[2].id);

		// fileB has 1 stage, 1 check.
		expect(resultB.manifest.stages.map((s) => s.name)).toEqual(['fileB.only']);
		expect(resultB.manifest.checks.map((c) => c.code)).toEqual(['b.size']);

		// fileB's IDs come strictly AFTER all of fileA's, because fileA was compiled first
		// against the same shared allocator (deterministic call-order sequencing).
		const maxStageIdA = Math.max(...resultA.manifest.stages.map((s) => s.id));
		const maxCheckIdA = Math.max(...resultA.manifest.checks.map((c) => c.id));
		expect(resultB.manifest.stages[0].id).toBeGreaterThan(maxStageIdA);
		expect(resultB.manifest.checks[0].id).toBeGreaterThan(maxCheckIdA);

		// No collisions anywhere: every stage id across both files is unique, every check
		// id across both files is unique (checked as one combined set per category).
		const allStageIds = [...resultA.manifest.stages, ...resultB.manifest.stages].map((s) => s.id);
		const allCheckIds = [...resultA.manifest.checks, ...resultB.manifest.checks].map((c) => c.id);
		expect(new Set(allStageIds).size).toBe(allStageIds.length);
		expect(new Set(allCheckIds).size).toBe(allCheckIds.length);
		// Stage IDs and check IDs are independent counters (both allowed to start at 1) --
		// confirm there's no accidental sharing of the same counter between the two kinds.
		expect(resultA.manifest.stages[0].id).toBe(1);
		expect(resultA.manifest.checks[0].id).toBe(1);
	});
});

describe('reproducibility: two fresh, identically-configured allocators produce byte-identical output', () => {
	it('compileTrace(fileA) run twice with two separate createIdAllocator() instances yields byte-identical code and deep-equal manifests', () => {
		const source = fileA();
		const result1 = compileTrace('repro.ts', source, createIdAllocator());
		const result2 = compileTrace('repro.ts', source, createIdAllocator());

		expect(result1.code).toBe(result2.code);
		expect(result1.manifest).toEqual(result2.manifest);
		// Not just deep-equal -- JSON-serialized byte-identical too, ruling out silent
		// object-key-ordering differences that .toEqual's structural comparison wouldn't
		// catch (toEqual doesn't care about key order; JSON.stringify does).
		expect(JSON.stringify(result1.manifest)).toBe(JSON.stringify(result2.manifest));
	});

	it('the same property holds for a real, previously-committed multi-check fixture (demo-geometry.ts)', () => {
		// Deliberately re-reads the file rather than importing test/compiler's fixture
		// re-export, to keep this file's determinism claim self-contained.
		const fixturePath = new URL('../compiler/fixtures/demo-geometry.ts', import.meta.url);
		const source = readFileSync(fixturePath, 'utf8');
		const result1 = compileTrace('demo-geometry.ts', source, createIdAllocator());
		const result2 = compileTrace('demo-geometry.ts', source, createIdAllocator());
		expect(result1.code).toBe(result2.code);
		expect(JSON.stringify(result1.manifest)).toBe(JSON.stringify(result2.manifest));
	});
});

describe('static audit: no timestamp/RNG-derived nondeterminism anywhere in the compiler source', () => {
	it('src/compiler/*.ts contains no Math.random, Date.now, or `new Date` usage', async () => {
		const compilerDir = new URL('../../src/compiler/', import.meta.url);
		const files = ['codegen.ts', 'diagnostics.ts', 'directives.ts', 'index.ts', 'types.ts', 'validate.ts'];
		for (const file of files) {
			const text = readFileSync(new URL(file, compilerDir), 'utf8');
			expect(text, `${file} should not use Math.random()`).not.toMatch(/Math\.random\s*\(/);
			expect(text, `${file} should not use Date.now()`).not.toMatch(/Date\.now\s*\(/);
			expect(text, `${file} should not construct \`new Date(\`)`).not.toMatch(/new\s+Date\s*\(/);
		}
	});
});
