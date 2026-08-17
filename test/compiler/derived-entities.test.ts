// Phase 6 (this task): the `.map()`-derived `@toph entities` shape -- the SECOND
// supported host-statement shape for `@toph entities <kind>`, alongside the
// already-working "plain array" shape (test/compiler/entities-and-assets.test.ts, left
// completely untouched by this file).
//
// This is the shape ChainSpot's real `rawObjectMask.ts` needs (see the task brief): a
// `.map()` call whose callback builds a BRAND NEW object per surviving element (a fresh
// `RawMaskTee` object literal, not the same reference as the `component` it came from),
// so plain reference-identity (what the plain-array shape and enterElement's ref lookup
// rely on) cannot link the new object back to the entity its source component was
// spawned as. `spawnDerivedEntities` (src/runtime/index.ts) closes that gap with an
// explicit `parentId` link -- this file's core behavioral claim is that link is correct,
// proven end to end against the real runtime, not just asserted structurally.
//
// Fixture mirrors the real target's shape closely: a `@toph entities component` spawn,
// a LATER `@toph filter` narrowing survivors (an ordinary `.filter()`, no Toph
// involvement in HOW it narrows), and a final `@toph entities tee` site whose `.map()`
// receiver is itself a real, side-effecting call (`sortSomehow`) -- standing in for
// ChainSpot's `sortComponents(teeComponents)` -- to prove exactly-once evaluation the
// same way test/adversarial/03-exactly-once-evaluation.test.ts does (a side-effect log,
// not a re-run/timing heuristic).
//
// Inlines its own real-runtime exec harness, following test/compiler/assignment-shape.ts
// and test/compiler/entities-and-assets.test.ts's precedent: a permanent compiler golden
// test shouldn't depend on test/adversarial/support.

import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import * as ts from 'typescript';
import { describe, expect, it } from 'vitest';
import { compileProduction, compileTrace, createIdAllocator } from '../../src/compiler/index.js';
import type { EntityRecord, TraceRun } from '../../src/runtime/index.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const runtimeSourcePath = join(__dirname, '..', '..', 'src', 'runtime', 'index.ts');

const transpileOpts: ts.TranspileOptions = {
	compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
};

/** Executes generated trace-mode code against the REAL runtime, returning its full
 * export namespace plus the resulting TraceRun. Same pattern as
 * test/compiler/assignment-shape.test.ts's inlined execWithRealRuntime. */
function execWithRealRuntime<TExports extends Record<string, unknown>>(
	generatedTsCode: string
): { moduleExports: TExports; trace: TraceRun } {
	const runtimeJs = ts.transpileModule(readFileSync(runtimeSourcePath, 'utf8'), transpileOpts).outputText;
	const generatedJs = ts.transpileModule(generatedTsCode, transpileOpts).outputText;

	const dir = mkdtempSync(join(tmpdir(), 'toph-derived-entities-'));
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
				"import { startTrace, finishTrace } from 'toph';",
				"import { writeFileSync } from 'node:fs';",
				'',
				'startTrace();',
				"const generated = await import('./generated.mjs');",
				'const trace = finishTrace();',
				'',
				"writeFileSync('./result.json', JSON.stringify({ moduleExports: { ...generated }, trace }));",
				'',
			].join('\n'),
			'utf8'
		);

		execFileSync(process.execPath, [runnerPath], { cwd: dir, stdio: 'pipe' });
		return JSON.parse(readFileSync(join(dir, 'result.json'), 'utf8'));
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

interface Component {
	x: number;
	area: number;
}

interface Tee {
	x: number;
	area: number;
}

/** The real-target-mirroring fixture: component spawn -> geometry filter -> tee
 * map-derive. `bodyForm` selects between the two callback-body shapes the task asks the
 * validator to accept (expression-bodied is the priority/real-target shape; block-bodied
 * with a single `return <expr>;` is the "support both if reasonably easy" extra). */
function buildSource(bodyForm: 'expression' | 'block' = 'expression'): string {
	const mapCallback =
		bodyForm === 'expression'
			? '(component): Tee => ({\n  x: component.x,\n  area: component.area,\n})'
			: '(component): Tee => {\n  return { x: component.x, area: component.area };\n}';

	return [
		'export interface Component { x: number; area: number; }',
		'export interface Tee { x: number; area: number; }',
		'export function detectComponents(mask: Uint8Array, w: number, h: number): Component[] {',
		'  void mask;',
		'  void w;',
		'  void h;',
		'  return [{ x: 1, area: 200 }, { x: 2, area: 50 }, { x: 3, area: 300 }];',
		'}',
		'',
		'export const bright: Uint8Array = new Uint8Array([1, 2, 3, 4]);',
		'export const width = 2;',
		'export const height = 2;',
		'export const minArea = 100;',
		'',
		'export const sortCallLog: number[] = [];',
		'export function sortSomehow(arr: Component[]): Component[] {',
		'  sortCallLog.push(arr.length);',
		'  return arr;',
		'}',
		'',
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
		'/** @toph entities tee */',
		`const tees = sortSomehow(survivors).map(${mapCallback});`,
		'',
		'export { components, survivors, tees };',
		'',
	].join('\n');
}

describe('@toph entities <kind> .map()-derived shape: compileTrace structural shape', () => {
	it('produces two entity kinds, one stage, one check -- no diagnostics', () => {
		const source = buildSource();
		const result = compileTrace('derived.ts', source, createIdAllocator());

		expect(result.diagnostics).toEqual([]);
		expect(result.manifest.entityKinds).toHaveLength(2);
		expect(result.manifest.entityKinds.map((k) => k.name)).toEqual(['component', 'tee']);
		expect(result.manifest.stages).toHaveLength(1);
		expect(result.manifest.checks).toHaveLength(1);
	});

	it('evaluates the .map() receiver into a fresh generated temp const, calls .map() on THAT, and calls spawnDerivedEntities with it as `parents`', () => {
		const source = buildSource();
		const result = compileTrace('derived.ts', source, createIdAllocator());
		expect(result.diagnostics).toEqual([]);
		const teeKind = result.manifest.entityKinds.find((k) => k.name === 'tee')!;

		expect(result.code).toContain('const __toph_derive_1 = sortSomehow(survivors);');
		expect(result.code).toContain('const tees = __toph_derive_1.map((component): Tee => ({');
		expect(result.code).toContain(`__toph.spawnDerivedEntities(${teeKind.id}, tees, __toph_derive_1);`);

		// The original receiver expression is NEVER spliced as one contiguous
		// "receiver.map(" blob -- proof the rewrite genuinely happened, not merely
		// prepended alongside the untouched original statement.
		expect(result.code).not.toContain('sortSomehow(survivors).map(');

		// Ordering: temp binding, then the rewritten statement, then the derive call.
		const tempIdx = result.code.indexOf('const __toph_derive_1 =');
		const stmtIdx = result.code.indexOf('const tees =');
		const spawnIdx = result.code.indexOf('__toph.spawnDerivedEntities(');
		expect(tempIdx).toBeGreaterThanOrEqual(0);
		expect(tempIdx).toBeLessThan(stmtIdx);
		expect(stmtIdx).toBeLessThan(spawnIdx);

		// The callback itself -- the object-construction logic -- is copied verbatim,
		// never touched (same rule @toph filter/@toph entities already hold for the
		// statements/callbacks they wrap).
		expect(result.code).toContain('x: component.x,');
		expect(result.code).toContain('area: component.area,');

		// Directive comments never survive into trace-mode output.
		expect(result.code).not.toContain('@toph entities');
	});

	it('block-body callback ("return <expr>;") is also recognized and preserved verbatim', () => {
		const source = buildSource('block');
		const result = compileTrace('derived-block.ts', source, createIdAllocator());
		expect(result.diagnostics).toEqual([]);
		expect(result.code).toContain('const __toph_derive_1 = sortSomehow(survivors);');
		expect(result.code).toContain('const tees = __toph_derive_1.map((component): Tee => {');
		expect(result.code).toContain('return { x: component.x, area: component.area };');
	});
});

describe('the plain-array @toph entities shape is byte-for-byte unaffected by the map-derive shape existing in the same file', () => {
	it('the "component" spawn (plain-array shape) keeps its statement text verbatim, unmodified, with no temp binding anywhere near it', () => {
		const source = buildSource();
		const result = compileTrace('derived.ts', source, createIdAllocator());
		expect(result.diagnostics).toEqual([]);
		const componentKind = result.manifest.entityKinds.find((k) => k.name === 'component')!;

		const stmtText = 'const components = detectComponents(bright, width, height);';
		const spawnCall = `__toph.spawnEntities(${componentKind.id}, components);`;
		expect(result.code).toContain(stmtText);
		expect(result.code).toContain(spawnCall);

		const stmtIdx = result.code.indexOf(stmtText);
		const spawnIdx = result.code.indexOf(spawnCall);
		expect(stmtIdx).toBeGreaterThanOrEqual(0);
		expect(stmtIdx).toBeLessThan(spawnIdx);
		// The array-shape site never uses (or needs) a derive temp binding, and only ONE
		// such binding exists in the whole file -- the one made for the "tee" site
		// (declared once, then read twice: as the `.map()` receiver and as
		// spawnDerivedEntities's `parents` argument).
		expect((result.code.match(/__toph_derive_/g) ?? []).length).toBe(3);
	});

	it('a plain-array @toph entities site with NO later map-derive site anywhere in the file is completely unaffected (regression control)', () => {
		const source = [
			'export interface Widget { n: number; }',
			'export function detectWidgets(): Widget[] { return [{ n: 1 }, { n: 2 }]; }',
			'',
			'/** @toph entities widget */',
			'const widgets = detectWidgets();',
			'',
			'export { widgets };',
			'',
		].join('\n');
		const result = compileTrace('plain-only.ts', source, createIdAllocator());
		expect(result.diagnostics).toEqual([]);
		expect(result.manifest.entityKinds).toHaveLength(1);
		const [kind] = result.manifest.entityKinds;
		expect(result.code).toContain('const widgets = detectWidgets();');
		expect(result.code).toContain(`__toph.spawnEntities(${kind.id}, widgets);`);
		expect(result.code).not.toContain('__toph_derive_');
		expect(result.code).not.toContain('spawnDerivedEntities');
	});
});

describe('@toph entities <kind> .map()-derived shape: production mode is a byte-identical passthrough', () => {
	it('compileProduction leaves the source untouched, with no diagnostics, for both callback body forms', () => {
		for (const bodyForm of ['expression', 'block'] as const) {
			const source = buildSource(bodyForm);
			const result = compileProduction('derived.ts', source);
			expect(result.diagnostics).toEqual([]);
			expect(result.code).toBe(source);
		}
	});
});

describe('diagnostics: TOPH107 for an @toph entities site matching NEITHER shape', () => {
	it('attached to a bare (unassigned) .filter() call -- not "const <ident> = <expr>;" at all', () => {
		const source = [
			'export interface Widget { n: number; }',
			'export const widgets: Widget[] = [{ n: 1 }];',
			'',
			'/** @toph entities widget */',
			'widgets.filter((w) => w.n > 0);',
			'',
			'export { widgets };',
			'',
		].join('\n');

		const result = compileTrace('bad-entities-bare-filter.ts', source, createIdAllocator());
		expect(result.diagnostics).toHaveLength(1);
		expect(result.diagnostics[0].code).toBe('TOPH107');
		// Actionable: message mentions BOTH supported shapes.
		expect(result.diagnostics[0].message).toContain('const <ident> = <expr>');
		expect(result.diagnostics[0].message).toContain('.map((<param>) => (<objectExpr>))');
		expect(result.code).toBe(source);
		expect(result.manifest).toEqual({ stages: [], checks: [], assets: [], entityKinds: [] });
	});

	it('a .map() call with a two-parameter callback does not qualify as the map shape (and is not silently accepted as the plain-array shape either)', () => {
		const source = [
			'export interface Widget { n: number; }',
			'export const widgets: Widget[] = [{ n: 1 }, { n: 2 }];',
			'',
			'/** @toph entities widget */',
			'const mapped = widgets.map((w, i) => ({ n: w.n, i }));',
			'',
			'export { mapped };',
			'',
		].join('\n');

		const result = compileTrace('bad-entities-two-param.ts', source, createIdAllocator());
		expect(result.diagnostics).toHaveLength(1);
		expect(result.diagnostics[0].code).toBe('TOPH107');
		expect(result.diagnostics[0].message).toContain('exactly one parameter');
		expect(result.code).toBe(source);
		expect(result.manifest).toEqual({ stages: [], checks: [], assets: [], entityKinds: [] });
	});

	it('a .map() call whose callback does not return an object literal does not qualify as the map shape', () => {
		const source = [
			'export interface Widget { n: number; }',
			'export const widgets: Widget[] = [{ n: 1 }, { n: 2 }];',
			'',
			'/** @toph entities widget */',
			'const mapped = widgets.map((w) => w.n);',
			'',
			'export { mapped };',
			'',
		].join('\n');

		const result = compileTrace('bad-entities-non-object.ts', source, createIdAllocator());
		expect(result.diagnostics).toHaveLength(1);
		expect(result.diagnostics[0].code).toBe('TOPH107');
		expect(result.code).toBe(source);
		expect(result.manifest).toEqual({ stages: [], checks: [], assets: [], entityKinds: [] });
	});
});

describe('behavioral (real runtime, subprocess): entity identity survives component -> filter -> map-derive tee', () => {
	it('each surviving tee entity\'s parentId is EXACTLY the entity id its source component was spawned with -- not a fresh id, not an ordinal', () => {
		const source = buildSource();
		const result = compileTrace('derived.ts', source, createIdAllocator());
		expect(result.diagnostics).toEqual([]);
		const componentKind = result.manifest.entityKinds.find((k) => k.name === 'component')!;
		const teeKind = result.manifest.entityKinds.find((k) => k.name === 'tee')!;
		const [areaCheck] = result.manifest.checks;

		const { moduleExports, trace } = execWithRealRuntime<{
			components: Component[];
			survivors: Component[];
			tees: Tee[];
			sortCallLog: number[];
		}>(result.code);

		// Production-equivalent behavior first: same result an un-instrumented pipeline
		// would produce.
		expect(moduleExports.survivors).toEqual([
			{ x: 1, area: 200 },
			{ x: 3, area: 300 },
		]);
		expect(moduleExports.tees).toEqual([
			{ x: 1, area: 200 },
			{ x: 3, area: 300 },
		]);

		const entities = trace.entities ?? [];
		const componentEntities = entities.filter((e) => e.kindId === componentKind.id).sort((a, b) => a.ordinal - b.ordinal);
		const teeEntities = entities.filter((e) => e.kindId === teeKind.id).sort((a, b) => a.ordinal - b.ordinal);

		expect(componentEntities).toHaveLength(3);
		expect(teeEntities).toHaveLength(2);

		// Plain-array-spawned entities NEVER carry a parentId (that field belongs
		// exclusively to spawnDerivedEntities's output).
		for (const c of componentEntities) {
			expect('parentId' in c).toBe(false);
		}

		const survivorComponent = componentEntities[0]; // x:1, area:200 -- passes area.min
		const rejectedComponent = componentEntities[1]; // x:2, area:50 -- fails area.min
		const secondSurvivorComponent = componentEntities[2]; // x:3, area:300 -- passes area.min

		// THE CORE CLAIM: tee ordinal 0 (x:1) is derived from componentEntities[0], tee
		// ordinal 1 (x:3) is derived from componentEntities[2] -- exact id equality, not
		// merely "some id" or the ordinal/index.
		expect(teeEntities[0].parentId).toBe(survivorComponent.id);
		expect(teeEntities[0].attrs).toEqual({ x: 1, area: 200 });
		expect(teeEntities[1].parentId).toBe(secondSurvivorComponent.id);
		expect(teeEntities[1].attrs).toEqual({ x: 3, area: 300 });

		// The rejected component (area 50, never reaches .map() at all) has no tee entity
		// pointing back at it.
		expect(teeEntities.some((t) => t.parentId === rejectedComponent.id)).toBe(false);

		// The filter's own checks still reference the ORIGINAL component entity ids
		// (identity surviving the filter untouched, exactly like the plain-array-shape
		// test already proves) -- this map-derive addition doesn't disturb that.
		expect(trace.checks).toHaveLength(3);
		const survivorCheck = trace.checks.find((c) => c.elementId === survivorComponent.id);
		const rejectedCheck = trace.checks.find((c) => c.elementId === rejectedComponent.id);
		expect(survivorCheck).toMatchObject({ checkId: areaCheck.id, value: 200, pass: true });
		expect(rejectedCheck).toMatchObject({ checkId: areaCheck.id, value: 50, pass: false });

		// Whole TraceRun still round-trips through JSON with no loss (parentId included).
		expect(JSON.parse(JSON.stringify(trace))).toEqual(trace);
	});

	it('the .map() receiver expression (sortSomehow(survivors)) is evaluated EXACTLY ONCE -- not re-evaluated for the spawnDerivedEntities `parents` argument', () => {
		const source = buildSource();
		const result = compileTrace('derived-once.ts', source, createIdAllocator());
		expect(result.diagnostics).toEqual([]);

		const { moduleExports } = execWithRealRuntime<{ sortCallLog: number[]; survivors: Component[] }>(result.code);

		// Exactly one call, and it was called with the 2-element survivors array -- not
		// zero calls (lost evaluation) and not two (the receiver spliced twice: once for
		// `.map()`, once again for spawnDerivedEntities's `parents` argument, which is
		// exactly the bug a temp binding exists to prevent).
		expect(moduleExports.sortCallLog).toEqual([2]);
	});
});
