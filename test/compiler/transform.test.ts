import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { compileProduction, compileTrace, createIdAllocator, writeManifest } from '../../src/compiler/index.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const fixturePath = join(__dirname, 'fixtures', 'demo-geometry.ts');
const fixtureSource = readFileSync(fixturePath, 'utf8');

describe('compileTrace on the demo-geometry fixture', () => {
	it('produces a manifest with exactly 1 stage and 2 checks, with correct source locations', () => {
		const result = compileTrace(fixturePath, fixtureSource, createIdAllocator());
		expect(result.diagnostics).toEqual([]);

		expect(result.manifest.stages).toHaveLength(1);
		const [stage] = result.manifest.stages;
		expect(stage.name).toBe('demo.geometry');
		expect(stage.kind).toBe('filter');
		// Line 16 in the fixture: `const survivors = components.filter((component) => {`
		expect(stage.source).toEqual({ file: fixturePath, line: 16 });

		expect(result.manifest.checks).toHaveLength(2);
		const [areaCheck, aspectCheck] = result.manifest.checks;

		expect(areaCheck).toMatchObject({ code: 'area.min', operator: '>=', unit: 'px2', stageId: stage.id });
		// Line 18: `const areaOk = component.area >= minArea;`
		expect(areaCheck.source).toEqual({ file: fixturePath, line: 18 });

		expect(aspectCheck).toMatchObject({ code: 'aspect.max', operator: '<=', stageId: stage.id });
		expect(aspectCheck.unit).toBeUndefined();
		// Line 21: `const aspectOk = component.aspect <= maxAspect;`
		expect(aspectCheck.source).toEqual({ file: fixturePath, line: 21 });

		// Stage and check IDs are distinct integer sequences, allocated in document order.
		expect(areaCheck.id).not.toBe(aspectCheck.id);
	});

	it('generates trace-mode code matching the required shape (IMPLEMENTATION-DECISIONS.md section 6)', () => {
		const result = compileTrace(fixturePath, fixtureSource, createIdAllocator());
		const { code } = result;
		const [stage] = result.manifest.stages;
		const [areaCheck, aspectCheck] = result.manifest.checks;

		expect(code).toContain('import * as __toph from "toph";');
		expect(code).toContain(`const __toph_s${stage.id} = __toph.enterStage(${stage.id});`);
		expect(code).toContain('const survivors = components.filter((component) => {');
		expect(code).toContain(`const __toph_e = __toph.enterElement(__toph_s${stage.id}, component);`);

		// Each check call: elementId, checkId, then the two original sub-expressions in
		// their original left/right order, each appearing exactly once.
		expect(code).toContain(
			`const areaOk = __toph.gte(__toph_e, ${areaCheck.id}, component.area, minArea);`
		);
		expect(code).toContain('if (!areaOk) return false;');
		expect(code).toContain(
			`const aspectOk = __toph.lte(__toph_e, ${aspectCheck.id}, component.aspect, maxAspect);`
		);
		expect(code).toContain('if (!aspectOk) return false;');

		// keep() happens exactly once, immediately before the final "return true;" --
		// the rejection branches above are untouched (no extra call inserted there).
		const areaGuardIndex = code.indexOf('if (!areaOk) return false;');
		const aspectGuardIndex = code.indexOf('if (!aspectOk) return false;');
		const keepIndex = code.indexOf('__toph.keep(__toph_e);');
		const returnTrueIndex = code.lastIndexOf('return true;');
		expect(areaGuardIndex).toBeGreaterThan(-1);
		expect(aspectGuardIndex).toBeGreaterThan(areaGuardIndex);
		expect(keepIndex).toBeGreaterThan(aspectGuardIndex);
		expect(returnTrueIndex).toBeGreaterThan(keepIndex);
		expect((code.match(/__toph\.keep\(/g) ?? []).length).toBe(1);

		// No ambient/global "current entity" -- only explicit locals are threaded.
		expect(code).not.toMatch(/currentEntity/);
		expect(code).not.toMatch(/globalThis\.__toph/);
	});

	it('emits no import and an empty manifest when the file has no valid @toph filter sites', () => {
		const source = 'export const x = 1;\n';
		const result = compileTrace('empty.ts', source, createIdAllocator());
		expect(result.diagnostics).toEqual([]);
		expect(result.manifest).toEqual({ stages: [], checks: [], assets: [], entityKinds: [] });
		expect(result.code).toBe(source);
		expect(result.code).not.toContain('toph');
	});

	it('leaves an invalid @toph filter site uninstrumented and reports the exact required TOPH102 message', () => {
		const source = [
			'declare const components: { area: number }[];',
			'declare function someFunctionCall(c: { area: number }): boolean;',
			'',
			'/** @toph filter demo.bad */',
			'const survivors = components.filter((component) => {',
			'  /** @toph check area.min */',
			'  const areaOk = someFunctionCall(component);',
			'  if (!areaOk) return false;',
			'  return true;',
			'});',
			'',
		].join('\n');

		const result = compileTrace('bad.ts', source, createIdAllocator());

		expect(result.diagnostics).toHaveLength(1);
		expect(result.diagnostics[0]).toMatchObject({
			code: 'TOPH102',
			message:
				'@toph check "area.min" is attached to an unsupported expression shape. Extract the condition into a named boolean comparison or use an explicit escape hatch.',
			file: 'bad.ts',
		});

		// Invalid site: no instrumentation, no import, original text untouched.
		expect(result.code).toBe(source);
		expect(result.manifest).toEqual({ stages: [], checks: [], assets: [], entityKinds: [] });
	});
});

describe('compileProduction on the demo-geometry fixture', () => {
	it('returns code byte-identical to the input source, with no diagnostics', () => {
		const result = compileProduction(fixturePath, fixtureSource);
		expect(result.diagnostics).toEqual([]);
		expect(result.code === fixtureSource).toBe(true);
	});

	it('still validates shape and reports diagnostics, without ever rewriting the source', () => {
		const source = [
			'declare const components: { area: number }[];',
			'',
			'/** @toph filter demo.bad */',
			'const survivors = components.filter((component) => {',
			'  const areaOk = component.area >= 1;',
			'  if (!areaOk) return false;',
			'  return true;',
			'});',
			'',
		].join('\n');

		const result = compileProduction('bad.ts', source);
		// The check group has no @toph check annotation at all -> TOPH101 body-shape violation.
		expect(result.diagnostics).toHaveLength(1);
		expect(result.diagnostics[0].code).toBe('TOPH101');
		expect(result.code).toBe(source);
	});
});

describe('createIdAllocator', () => {
	it('defaults to a deterministic (1, 1) start', () => {
		const ids = createIdAllocator();
		expect(ids.nextStageId()).toBe(1);
		expect(ids.nextStageId()).toBe(2);
		expect(ids.nextCheckId()).toBe(1);
		expect(ids.nextCheckId()).toBe(2);
	});

	it('honors explicit starting IDs', () => {
		const ids = createIdAllocator(100, 200);
		expect(ids.nextStageId()).toBe(100);
		expect(ids.nextStageId()).toBe(101);
		expect(ids.nextCheckId()).toBe(200);
	});
});

describe('writeManifest', () => {
	it('merges fragments and builds a sourceMap with generated + original locations', () => {
		const result = compileTrace(fixturePath, fixtureSource, createIdAllocator());
		const { manifest, sourceMap } = writeManifest([result.manifest]);

		expect(manifest.stages).toHaveLength(1);
		expect(manifest.checks).toHaveLength(2);
		// One sourceMap record per stage/check: 1 stage + 2 checks.
		expect(sourceMap).toHaveLength(3);

		for (const entry of sourceMap) {
			expect(entry.generatedFile).toBe(fixturePath);
			expect(entry.generatedLine).toBeGreaterThan(0);
			expect(entry.file).toBe(fixturePath);
			expect(entry.line).toBeGreaterThan(0);
		}

		// The manifest shape returned by writeManifest matches the public
		// StageManifestEntry/CheckManifestEntry contract exactly -- no leaked
		// generatedLine/generatedFile bookkeeping fields.
		for (const stage of manifest.stages) {
			expect(Object.keys(stage).sort()).toEqual(['id', 'kind', 'name', 'source']);
		}
		for (const check of manifest.checks) {
			const expectedKeys =
				check.unit !== undefined
					? ['code', 'id', 'operator', 'source', 'stageId', 'unit']
					: ['code', 'id', 'operator', 'source', 'stageId'];
			expect(Object.keys(check).sort()).toEqual(expectedKeys);
		}
	});

	it('merges multiple fragments in order', () => {
		const fragmentA = {
			stages: [{ id: 1, name: 'a', kind: 'filter' as const, source: { file: 'a.ts', line: 1 } }],
			checks: [],
			assets: [],
			entityKinds: [],
		};
		const fragmentB = {
			stages: [{ id: 2, name: 'b', kind: 'filter' as const, source: { file: 'b.ts', line: 1 } }],
			checks: [],
			assets: [],
			entityKinds: [],
		};
		const { manifest } = writeManifest([fragmentA, fragmentB]);
		expect(manifest.stages.map((s) => s.name)).toEqual(['a', 'b']);
	});
});
