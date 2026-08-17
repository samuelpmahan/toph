// Phase 5: `@toph snapshot` + `@toph entities`, and their interaction with the EXISTING
// `@toph filter`/`@toph check` directives -- entity identity surviving from a spawn site
// into a LATER filter's check events is the core thing this phase exists to prove (see
// IMPLEMENTATION-DECISIONS.md section 5: Phase 1-4 deliberately deferred this).
//
// Mirrors the real ChainSpot target shape named in the task brief: a raster ("mask")
// snapshotted immediately before a component-detection call that mutates its own mask
// argument in place (so the pristine value only exists briefly), the detected
// components spawned as stable entities, and a later `.filter()` stage whose checks
// must reference those SAME entity ids.
//
// Inlines its own real-runtime exec harness (following test/compiler/assignment-shape.ts's
// precedent of a self-contained compiler golden test, not depending on
// test/runtime/support) extended with the one extra capability this phase's behavioral
// claim needs that no existing harness provides: mutating the traced module's own
// exported array AFTER import, then reading getRasterBytes() back out -- all while the
// trace session is still active, before finishTrace().

import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import * as ts from 'typescript';
import { describe, expect, it } from 'vitest';
import { compileTrace, createIdAllocator } from '../../src/compiler/index.js';
import type { TraceRun } from '../../src/runtime/index.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const runtimeSourcePath = join(__dirname, '..', '..', 'src', 'runtime', 'index.ts');

const transpileOpts: ts.TranspileOptions = {
	compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
};

interface Component {
	area: number;
}

function buildSource(): string {
	return [
		'export interface Component { area: number; }',
		'export function detectComponents(mask: Uint8Array, w: number, h: number): Component[] {',
		'  void mask;',
		'  void w;',
		'  void h;',
		'  return [{ area: 200 }, { area: 50 }];',
		'}',
		'',
		'export const bright: Uint8Array = new Uint8Array([1, 2, 3, 4]);',
		'export const width = 2;',
		'export const height = 2;',
		'export const minArea = 100;',
		'',
		'/** @toph snapshot bright.mask kind=mask ref=bright width=width height=height */',
		'/** @toph entities component */',
		'const components = detectComponents(bright, width, height);',
		'',
		'/** @toph filter demo.geometry */',
		'const survivors = components.filter((component) => {',
		'  /** @toph check area.min */',
		'  const areaOk = component.area >= minArea;',
		'  if (!areaOk) return false;',
		'  return true;',
		'});',
		'',
		'export { bright, components, survivors };',
		'',
	].join('\n');
}

/**
 * Runs `generatedTsCode` against the REAL runtime, then -- while the session is STILL
 * ACTIVE, after the generated module's top-level code has finished -- mutates the
 * exported `bright` array (proving getRasterBytes's copy is independent of later
 * mutation of the original) and reads `getRasterBytes(assetId)` back out, before
 * finally calling finishTrace().
 */
function execEntityWorkflow(
	generatedTsCode: string,
	assetId: number
): {
	survivors: Component[];
	trace: TraceRun;
	rasterBytesAfterMutation: number[] | null;
	mutatedBright: number[];
} {
	const runtimeSource = readFileSync(runtimeSourcePath, 'utf8');
	const { outputText: runtimeJs } = ts.transpileModule(runtimeSource, transpileOpts);
	const { outputText: generatedJs } = ts.transpileModule(generatedTsCode, transpileOpts);

	const dir = mkdtempSync(join(tmpdir(), 'toph-entities-'));
	try {
		const tophDir = join(dir, 'node_modules', 'toph');
		mkdirSync(tophDir, { recursive: true });
		writeFileSync(join(tophDir, 'package.json'), JSON.stringify({ name: 'toph', main: './index.mjs' }), 'utf8');
		writeFileSync(join(tophDir, 'index.mjs'), runtimeJs, 'utf8');
		writeFileSync(join(dir, 'generated.mjs'), generatedJs, 'utf8');

		const runnerPath = join(dir, 'run.mjs');
		writeFileSync(
			runnerPath,
			[
				"import { startTrace, finishTrace, getRasterBytes } from 'toph';",
				"import { writeFileSync } from 'node:fs';",
				'',
				'startTrace();',
				"const generated = await import('./generated.mjs');",
				'',
				'// Mutate the ORIGINAL array AFTER the annotated statement has already run --',
				'// this is the moment snapshotRaster must already have copied its bytes, since',
				'// this mutation happens strictly later.',
				'generated.bright[0] = 255;',
				'',
				`const rasterBytesAfterMutation = getRasterBytes(${assetId});`,
				'const trace = finishTrace();',
				'',
				"writeFileSync('./result.json', JSON.stringify({",
				'  survivors: generated.survivors,',
				'  trace,',
				'  rasterBytesAfterMutation: rasterBytesAfterMutation ? Array.from(rasterBytesAfterMutation) : null,',
				'  mutatedBright: Array.from(generated.bright),',
				'}));',
				'',
			].join('\n'),
			'utf8'
		);

		execFileSync(process.execPath, [runnerPath], { cwd: dir, stdio: 'pipe' });
		const raw = readFileSync(join(dir, 'result.json'), 'utf8');
		return JSON.parse(raw);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

describe('@toph snapshot + @toph entities: compileTrace structural shape', () => {
	it('produces one asset, one entity kind, one stage, one check -- no diagnostics', () => {
		const source = buildSource();
		const result = compileTrace('p5-fixture.ts', source, createIdAllocator());

		expect(result.diagnostics).toEqual([]);
		expect(result.manifest.assets).toHaveLength(1);
		expect(result.manifest.entityKinds).toHaveLength(1);
		expect(result.manifest.stages).toHaveLength(1);
		expect(result.manifest.checks).toHaveLength(1);

		const [asset] = result.manifest.assets;
		expect(asset).toMatchObject({ name: 'bright.mask', kind: 'mask' });
		// Line 16: the `/** @toph snapshot ... */` directive's OWN statement (`const
		// components = ...`) is what source location is attributed to.
		expect(asset.source.line).toBe(16);

		const [entityKind] = result.manifest.entityKinds;
		expect(entityKind).toMatchObject({ name: 'component' });
		expect(entityKind.source.line).toBe(16);

		const [stage] = result.manifest.stages;
		expect(stage.name).toBe('demo.geometry');
	});

	it('emits snapshotRaster immediately BEFORE, and spawnEntities immediately AFTER, the unmodified statement', () => {
		const source = buildSource();
		const result = compileTrace('p5-fixture.ts', source, createIdAllocator());
		expect(result.diagnostics).toEqual([]);
		const [asset] = result.manifest.assets;
		const [entityKind] = result.manifest.entityKinds;

		const snapshotCall = `__toph.snapshotRaster(${asset.id}, "bright.mask", "mask", bright, width, height);`;
		const spawnCall = `__toph.spawnEntities(${entityKind.id}, components);`;
		const stmtText = 'const components = detectComponents(bright, width, height);';

		expect(result.code).toContain(snapshotCall);
		expect(result.code).toContain(spawnCall);
		// The statement's right-hand side is completely untouched.
		expect(result.code).toContain(stmtText);

		const snapshotIdx = result.code.indexOf(snapshotCall);
		const stmtIdx = result.code.indexOf(stmtText);
		const spawnIdx = result.code.indexOf(spawnCall);
		expect(snapshotIdx).toBeLessThan(stmtIdx);
		expect(stmtIdx).toBeLessThan(spawnIdx);

		// The directive comments themselves don't survive into trace-mode output.
		expect(result.code).not.toContain('@toph snapshot');
		expect(result.code).not.toContain('@toph entities');

		// enterElement's call site for the LATER filter always passes the callback
		// parameter as `ref` -- see codegen.ts's emitFilterSite doc comment.
		expect(result.code).toContain('__toph.enterElement(__toph_s');
		expect(result.code).toMatch(/__toph\.enterElement\(__toph_s\d+, component\)/);
	});

	it('reusing the same entity kind name across two @toph entities sites in one file reuses one manifest id', () => {
		const source = [
			'export interface Widget { n: number; }',
			'export const a: Widget[] = [{ n: 1 }];',
			'export const b: Widget[] = [{ n: 2 }];',
			'',
			'/** @toph entities widget */',
			'const spawnedA = a;',
			'',
			'/** @toph entities widget */',
			'const spawnedB = b;',
			'',
			'export { spawnedA, spawnedB };',
			'',
		].join('\n');

		const result = compileTrace('reuse.ts', source, createIdAllocator());
		expect(result.diagnostics).toEqual([]);
		expect(result.manifest.entityKinds).toHaveLength(1);
		expect(result.manifest.entityKinds[0].name).toBe('widget');
		expect((result.code.match(/__toph\.spawnEntities\(/g) ?? []).length).toBe(2);
		const [entityKindId] = result.code.match(/__toph\.spawnEntities\((\d+),/) ?? [];
		expect(entityKindId).toBeDefined();
		// Both spawnEntities call sites use the exact same numeric kind id.
		const ids = [...result.code.matchAll(/__toph\.spawnEntities\((\d+),/g)].map((m) => m[1]);
		expect(ids).toHaveLength(2);
		expect(ids[0]).toBe(ids[1]);
	});
});

describe('@toph snapshot + @toph entities: production mode is a byte-identical passthrough', () => {
	it('compileProduction leaves the source untouched, with no diagnostics', async () => {
		const { compileProduction } = await import('../../src/compiler/index.js');
		const source = buildSource();
		const result = compileProduction('p5-fixture.ts', source);
		expect(result.diagnostics).toEqual([]);
		expect(result.code).toBe(source);
	});
});

describe('diagnostics: TOPH106 (malformed @toph snapshot args)', () => {
	it('an unsupported kind value does not parse -- TOPH106, site left completely uninstrumented', () => {
		const source = [
			'export const bright: Uint8Array = new Uint8Array([1, 2]);',
			'export const width = 1;',
			'export const height = 2;',
			'',
			'/** @toph snapshot bright.mask kind=bogus ref=bright width=width height=height */',
			'const components = [bright];',
			'',
			'export { components };',
			'',
		].join('\n');

		const result = compileTrace('bad-snapshot.ts', source, createIdAllocator());

		expect(result.diagnostics).toHaveLength(1);
		expect(result.diagnostics[0].code).toBe('TOPH106');
		expect(result.diagnostics[0].message).toContain('@toph snapshot');
		expect(result.diagnostics[0].message).toContain('kind=mask');

		// No edit sites at all in this file -> byte-identical passthrough, exactly like an
		// unrecognized/invalid @toph filter site.
		expect(result.code).toBe(source);
		expect(result.manifest).toEqual({ stages: [], checks: [], assets: [], entityKinds: [] });
	});

	it('the wrong number of tokens does not parse -- TOPH106', () => {
		const source = [
			'export const bright: Uint8Array = new Uint8Array([1, 2]);',
			'',
			'/** @toph snapshot bright.mask kind=mask ref=bright */',
			'const components = [bright];',
			'',
			'export { components };',
			'',
		].join('\n');

		const result = compileTrace('bad-snapshot2.ts', source, createIdAllocator());
		expect(result.diagnostics).toHaveLength(1);
		expect(result.diagnostics[0].code).toBe('TOPH106');
		expect(result.code).toBe(source);
	});
});

describe('diagnostics: TOPH107 (malformed @toph entities args or host shape)', () => {
	it('more than one token does not parse -- TOPH107, site left completely uninstrumented', () => {
		const source = [
			'export interface Widget { n: number; }',
			'export const widgets: Widget[] = [{ n: 1 }];',
			'',
			'/** @toph entities foo bar */',
			'const spawned = widgets;',
			'',
			'export { spawned };',
			'',
		].join('\n');

		const result = compileTrace('bad-entities.ts', source, createIdAllocator());

		expect(result.diagnostics).toHaveLength(1);
		expect(result.diagnostics[0].code).toBe('TOPH107');
		expect(result.diagnostics[0].message).toContain('@toph entities');

		expect(result.code).toBe(source);
		expect(result.manifest).toEqual({ stages: [], checks: [], assets: [], entityKinds: [] });
	});

	it('attached to a "let" (not "const") declaration does not qualify -- TOPH107', () => {
		const source = [
			'export interface Widget { n: number; }',
			'export const widgets: Widget[] = [{ n: 1 }];',
			'',
			'/** @toph entities widget */',
			'let spawned = widgets;',
			'',
			'export { spawned };',
			'',
		].join('\n');

		const result = compileTrace('bad-entities2.ts', source, createIdAllocator());
		expect(result.diagnostics).toHaveLength(1);
		expect(result.diagnostics[0].code).toBe('TOPH107');
		expect(result.diagnostics[0].message).toContain('const <ident>');
		expect(result.code).toBe(source);
	});
});

describe('behavioral: entity identity survives from @toph entities into a LATER @toph filter (real runtime)', () => {
	it('spawnEntities produces one entity per component with correct attrs, and the geometry filter\'s check events reference those SAME entity ids', () => {
		const source = buildSource();
		const result = compileTrace('p5-fixture.ts', source, createIdAllocator());
		expect(result.diagnostics).toEqual([]);
		const [asset] = result.manifest.assets;
		const [areaCheck] = result.manifest.checks;

		const { survivors, trace, rasterBytesAfterMutation, mutatedBright } = execEntityWorkflow(result.code, asset.id);

		// (a) snapshotRaster captured the array's value at the moment it fired -- a real
		// copy, not a live reference. `bright` was mutated (index 0 -> 255) strictly AFTER
		// the annotated statement finished; the pre-mutation bytes [1,2,3,4] must still be
		// what getRasterBytes returns.
		expect(mutatedBright).toEqual([255, 2, 3, 4]);
		expect(rasterBytesAfterMutation).toEqual([1, 2, 3, 4]);
		expect(rasterBytesAfterMutation).not.toEqual(mutatedBright);

		expect(trace.assets).toEqual([
			{ id: asset.id, name: 'bright.mask', kind: 'mask', widthPx: 2, heightPx: 2 },
		]);

		// (b) spawnEntities produced exactly one entity per component, correct attrs,
		// ordinals 0 and 1 matching the components array's own order.
		expect(trace.entities).toHaveLength(2);
		const byOrdinal = [...(trace.entities ?? [])].sort((x, y) => x.ordinal - y.ordinal);
		expect(byOrdinal[0]).toMatchObject({ ordinal: 0, attrs: { area: 200 } });
		expect(byOrdinal[1]).toMatchObject({ ordinal: 1, attrs: { area: 50 } });
		const [survivorEntity, rejectedEntity] = byOrdinal;
		expect(survivorEntity.id).not.toBe(rejectedEntity.id);

		// Production-equivalent behavior: same survivors as the plain, un-instrumented
		// `.filter(c => c.area >= 100)` would produce.
		expect(survivors).toEqual([{ area: 200 }]);

		// enterElement's fresh-ordinal path was NEVER used for this filter's elements --
		// both of its elements resolved via entity-identity reuse, so the public
		// `elements` array (Phase 1-4's ordinal-scoped bookkeeping) stays empty.
		expect(trace.elements).toEqual([]);

		// (c) THE CORE CLAIM: the geometry filter's check events reference the EXACT SAME
		// entity ids spawnEntities allocated -- not fresh, unrelated ordinals. Pick the
		// component that survives (area 200) and the one that's rejected (area 50) and
		// confirm each one's check event elementId matches ITS OWN spawned entity id.
		expect(trace.checks).toHaveLength(2);
		const survivorCheck = trace.checks.find((c) => c.elementId === survivorEntity.id);
		const rejectedCheck = trace.checks.find((c) => c.elementId === rejectedEntity.id);
		expect(survivorCheck).toMatchObject({
			checkId: areaCheck.id,
			value: 200,
			threshold: 100,
			pass: true,
		});
		expect(rejectedCheck).toMatchObject({
			checkId: areaCheck.id,
			value: 50,
			threshold: 100,
			pass: false,
		});
		// No check event references any id other than the two spawned entity ids (i.e. no
		// stray ordinal-based element id leaked in alongside them).
		expect(trace.checks.every((c) => c.elementId === survivorEntity.id || c.elementId === rejectedEntity.id)).toBe(
			true
		);

		// The whole TraceRun (assets/entities included) still round-trips through JSON with
		// no loss.
		expect(JSON.parse(JSON.stringify(trace))).toEqual(trace);
	});
});
