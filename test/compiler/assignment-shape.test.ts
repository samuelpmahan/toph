// Golden test for the `<ident> = <expr>.filter(...)` assignment-statement filter shape
// (as opposed to a fresh `const <ident> = ...` declaration).
//
// This closes a gap Phase 3's adversarial pass confirmed but deliberately did not fix
// (see IMPLEMENTATION-DECISIONS.md section 9): ChainSpot's real tee-family filter uses
// a plain assignment to a `let` seeded with a default value --
//
//   let teeComponents: MaskComponent[] = [];
//   // ...
//   teeComponents = brightComponents.filter((component) => { /* checks */ return true; });
//
// -- not a fresh `const` declaration, because the assignment lives inside a conditional
// block with the `let` providing the empty-array default for the branch where the
// filter never runs at all. Without support for this shape, Phase 4 could not
// instrument the actual ChainSpot code the whole project exists to explain.
//
// This file previously lived at test/adversarial/11-known-gap-let-assignment.test.ts
// and asserted the OPPOSITE (that this shape was rejected as TOPH101) -- that was
// correct at the time (Phase 3 predates this fix) but is now stale. It's replaced here,
// as a compiler golden test alongside transform.test.ts/behavioral.test.ts, because
// supporting this shape is now a first-class, permanent compiler capability, not an
// adversarial finding.

import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import * as ts from 'typescript';
import { describe, expect, it } from 'vitest';
import { compileProduction, compileTrace, createIdAllocator } from '../../src/compiler/index.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const runtimeSourcePath = join(__dirname, '..', '..', 'src', 'runtime', 'index.ts');

const transpileOpts: ts.TranspileOptions = {
	compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
};

/** Executes generated trace-mode code against the real runtime, returning its full
 * export namespace plus the resulting TraceRun. Inlined rather than imported from
 * test/adversarial/support -- that directory is Phase 3's adversarial-pass scope, this
 * is a permanent compiler golden test and shouldn't depend on it. */
function execWithRealRuntime<TExports extends Record<string, unknown>>(
	generatedTsCode: string
): { moduleExports: TExports; trace: unknown } {
	const runtimeJs = ts.transpileModule(readFileSync(runtimeSourcePath, 'utf8'), transpileOpts).outputText;
	const generatedJs = ts.transpileModule(generatedTsCode, transpileOpts).outputText;

	const dir = mkdtempSync(join(tmpdir(), 'toph-assignment-shape-'));
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

function buildSource(componentsLiteral: string): string {
	return [
		'export interface MaskComponent { area: number; }',
		`export const brightComponents: MaskComponent[] = ${componentsLiteral};`,
		'export const minArea = 100;',
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

describe('the ChainSpot-realistic assignment-to-a-pre-declared-let shape', () => {
	it('compileTrace: no diagnostics, and generated code preserves the assignment (no injected "const")', () => {
		const source = buildSource('[{ area: 200 }, { area: 50 }]');
		const result = compileTrace('tee-geometry.ts', source, createIdAllocator());

		expect(result.diagnostics).toEqual([]);
		expect(result.manifest.stages).toHaveLength(1);
		expect(result.manifest.stages[0].name).toBe('p1.tee.geometry');
		expect(result.manifest.checks).toHaveLength(1);

		// The original `let teeComponents = [];` declaration is untouched, and the
		// filter site is now an assignment -- NOT a "const teeComponents = ..." (that
		// would be a duplicate-declaration compile error in real TS, since `teeComponents`
		// is already declared above via `let`).
		expect(result.code).toContain('let teeComponents: MaskComponent[] = [];');
		expect(result.code).toContain('teeComponents = brightComponents.filter((component) => {');
		expect(result.code).not.toMatch(/const teeComponents/);
	});

	it('compileProduction: no diagnostics, code byte-identical to source (same as the const-declaration shape)', () => {
		const source = buildSource('[{ area: 200 }, { area: 50 }]');
		const result = compileProduction('tee-geometry.ts', source);
		expect(result.diagnostics).toEqual([]);
		expect(result.code).toBe(source);
	});

	it('behavioral: executes correctly against the real runtime, survivors match the un-instrumented predicate', () => {
		const source = buildSource('[{ area: 200 }, { area: 50 }]');
		const result = compileTrace('tee-geometry.ts', source, createIdAllocator());
		expect(result.diagnostics).toEqual([]);
		const [check] = result.manifest.checks;

		const { moduleExports, trace } = execWithRealRuntime<{ teeComponents: { area: number }[] }>(result.code);

		// Same survivors the original `brightComponents.filter(c => c.area >= 100)` would
		// produce -- the assignment form doesn't change production behavior any more than
		// the const-declaration form does.
		expect(moduleExports.teeComponents).toEqual([{ area: 200 }]);

		const t = trace as {
			stages: Array<{ invocationId: number; stageId: number; seq: number }>;
			elements: Array<{ id: number; kept: boolean }>;
			checks: Array<{
				stageInvocationId: number;
				elementId: number;
				checkId: number;
				value: number;
				threshold: number;
				operator: string;
				pass: boolean;
			}>;
		};
		expect(t.stages).toHaveLength(1);
		const stageInvocationId = t.stages[0].invocationId;
		expect(t.elements).toHaveLength(2);
		expect(t.elements.map((e) => e.kept)).toEqual([true, false]);
		const [elA, elB] = t.elements;
		expect(t.checks).toEqual([
			{
				stageInvocationId,
				elementId: elA.id,
				checkId: check.id,
				value: 200,
				threshold: 100,
				operator: 'gte',
				pass: true,
			},
			{
				stageInvocationId,
				elementId: elB.id,
				checkId: check.id,
				value: 50,
				threshold: 100,
				operator: 'gte',
				pass: false,
			},
		]);
	});

	it('a plain `const` declaration site elsewhere in the same file is unaffected -- both shapes coexist', () => {
		const source = [
			buildSource('[{ area: 200 }]'),
			'',
			'export interface Other { size: number; }',
			'export const others: Other[] = [{ size: 5 }];',
			'export const minSize = 1;',
			'',
			'/** @toph filter other.geometry */',
			'const otherSurvivors = others.filter((o) => {',
			'  /** @toph check size.min */',
			'  const sizeOk = o.size >= minSize;',
			'  if (!sizeOk) return false;',
			'  return true;',
			'});',
			'export { otherSurvivors };',
			'',
		].join('\n');

		const result = compileTrace('mixed-shapes.ts', source, createIdAllocator());
		expect(result.diagnostics).toEqual([]);
		expect(result.manifest.stages.map((s) => s.name).sort()).toEqual(['other.geometry', 'p1.tee.geometry']);
		expect(result.code).toContain('teeComponents = brightComponents.filter((component) => {');
		expect(result.code).toContain('const otherSurvivors = others.filter((o) => {');
	});
});
