// Test-only harness: executes compileTrace's generated TypeScript output for real, in a
// fresh Node subprocess, with `toph` resolved to this project's REAL runtime
// (src/runtime/index.ts) -- not the Phase 1 fake shim in
// test/compiler/support/fakeRuntime.ts.
//
// This mirrors test/compiler/support/execTraceModule.ts's subprocess/node_modules
// resolution strategy (same reasons: `import * as __toph from "toph"` is a bare
// specifier and we want completely ordinary Node ESM node_modules resolution,
// independent of vitest/Vite's own loader behavior for files outside the project
// root), but additionally has to get startTrace()/finishTrace() called at the right
// moments around the generated module's own top-level execution -- see the runner
// script built below.

import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import * as ts from 'typescript';
import type { TraceRun } from '../../../src/runtime/index.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const runtimeSourcePath = join(__dirname, '..', '..', '..', 'src', 'runtime', 'index.ts');

const transpileOpts: ts.TranspileOptions = {
	compilerOptions: {
		module: ts.ModuleKind.ESNext,
		target: ts.ScriptTarget.ES2022,
	},
};

export interface ExecWithRealRuntimeResult<TSurvivor> {
	survivors: TSurvivor[];
	trace: TraceRun;
}

/**
 * Runs `generatedTsCode` (the `code` returned by compileTrace) to completion against
 * this project's real runtime, calling startTrace() immediately before the generated
 * module's top-level code executes and finishTrace() immediately after, exactly as the
 * task contract requires of any real harness. Returns the generated module's exported
 * `survivors` binding plus the real TraceRun finishTrace() produced.
 *
 * Like execTraceModule.ts, `generatedTsCode` (and, here, the runtime source itself) is
 * transpiled via ts.transpileModule (type-erasure only, no logic rewriting) before
 * execution, since Node has no native TypeScript support and a real consumer would run
 * both through its own build step first.
 */
export function execWithRealRuntime<TSurvivor = unknown>(
	generatedTsCode: string,
	opts?: { pipeline?: string }
): ExecWithRealRuntimeResult<TSurvivor> {
	const runtimeSource = readFileSync(runtimeSourcePath, 'utf8');
	const { outputText: runtimeJs } = ts.transpileModule(runtimeSource, transpileOpts);
	const { outputText: generatedJs } = ts.transpileModule(generatedTsCode, transpileOpts);

	const dir = mkdtempSync(join(tmpdir(), 'toph-real-runtime-'));
	try {
		const tophDir = join(dir, 'node_modules', 'toph');
		mkdirSync(tophDir, { recursive: true });
		writeFileSync(join(tophDir, 'package.json'), JSON.stringify({ name: 'toph', main: './index.mjs' }), 'utf8');
		writeFileSync(join(tophDir, 'index.mjs'), runtimeJs, 'utf8');

		writeFileSync(join(dir, 'generated.mjs'), generatedJs, 'utf8');

		// A static `import { survivors } from './generated.mjs'` at the top of this
		// runner would be hoisted and evaluated before startTrace() runs (ESM import
		// bindings are resolved before any of the importing module's own top-level
		// statements execute) -- which would run the generated module's `.filter()` call
		// with no active session and throw. A dynamic import() after startTrace() gives
		// us control over that ordering, matching "call startTrace() before and
		// finishTrace() after" from the task contract.
		const runnerPath = join(dir, 'run.mjs');
		writeFileSync(
			runnerPath,
			[
				"import { startTrace, finishTrace } from 'toph';",
				"import { writeFileSync } from 'node:fs';",
				'',
				`startTrace(${JSON.stringify(opts ?? {})});`,
				"const generated = await import('./generated.mjs');",
				'const trace = finishTrace();',
				'',
				"writeFileSync('./result.json', JSON.stringify({ survivors: generated.survivors, trace }));",
				'',
			].join('\n'),
			'utf8'
		);

		execFileSync(process.execPath, [runnerPath], { cwd: dir, stdio: 'pipe' });

		const raw = readFileSync(join(dir, 'result.json'), 'utf8');
		return JSON.parse(raw) as ExecWithRealRuntimeResult<TSurvivor>;
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

/**
 * Like execWithRealRuntime, but runs the SAME compiled module's top-level code more
 * than once within a single startTrace()/finishTrace() session -- each entry of
 * `generatedTsCode` is written to its own file and imported as a distinct module
 * instance (ordinary per-specifier ESM module caching means importing the literal same
 * path twice would only execute it once, so re-executing the identical generated text
 * requires giving each run its own file). This is how "the same compiler-allocated
 * stageId runs repeatedly" is exercised against real generated output: the compiled
 * `enterStage(<id>)` call site is identical across runs, proving the resulting
 * TraceRun distinguishes them by invocationId/seq exactly as enterStage's own unit
 * tests already prove for the runtime in isolation.
 */
export function execSequenceWithRealRuntime(
	generatedTsCode: string[],
	opts?: { pipeline?: string }
): { moduleExports: Record<string, unknown>[]; trace: TraceRun } {
	const runtimeSource = readFileSync(runtimeSourcePath, 'utf8');
	const { outputText: runtimeJs } = ts.transpileModule(runtimeSource, transpileOpts);

	const dir = mkdtempSync(join(tmpdir(), 'toph-real-runtime-seq-'));
	try {
		const tophDir = join(dir, 'node_modules', 'toph');
		mkdirSync(tophDir, { recursive: true });
		writeFileSync(join(tophDir, 'package.json'), JSON.stringify({ name: 'toph', main: './index.mjs' }), 'utf8');
		writeFileSync(join(tophDir, 'index.mjs'), runtimeJs, 'utf8');

		const generatedFiles = generatedTsCode.map((code, i) => {
			const { outputText } = ts.transpileModule(code, transpileOpts);
			const fileName = `generated${i}.mjs`;
			writeFileSync(join(dir, fileName), outputText, 'utf8');
			return fileName;
		});

		const runnerPath = join(dir, 'run.mjs');
		const importLines = generatedFiles.map((f, i) => `const m${i} = await import('./${f}');`);
		writeFileSync(
			runnerPath,
			[
				"import { startTrace, finishTrace } from 'toph';",
				"import { writeFileSync } from 'node:fs';",
				'',
				`startTrace(${JSON.stringify(opts ?? {})});`,
				...importLines,
				'const trace = finishTrace();',
				'',
				`const moduleExports = [${generatedFiles.map((_, i) => `m${i}`).join(', ')}];`,
				"writeFileSync('./result.json', JSON.stringify({ moduleExports, trace }));",
				'',
			].join('\n'),
			'utf8'
		);

		execFileSync(process.execPath, [runnerPath], { cwd: dir, stdio: 'pipe' });

		const raw = readFileSync(join(dir, 'result.json'), 'utf8');
		return JSON.parse(raw) as { moduleExports: Record<string, unknown>[]; trace: TraceRun };
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}
