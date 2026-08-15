// Adversarial-test-only harness: a generalization of
// test/runtime/support/execWithRealRuntime.ts that (a) returns the generated module's
// FULL export namespace (not just a `survivors` binding), so tests can read arbitrary
// side-effect logs / extra exports back out, and (b) optionally captures a thrown
// error from the generated module's top-level evaluation instead of letting the
// subprocess crash, while still calling finishTrace() afterward so the PARTIAL trace
// (whatever was recorded before the throw) is recoverable.
//
// Reuses the exact same subprocess/node_modules-resolution strategy as
// test/runtime/support/execWithRealRuntime.ts and test/compiler/support/execTraceModule.ts
// (both already committed) for the same reason: `import * as __toph from "toph"` is a
// bare specifier that needs completely ordinary Node ESM node_modules resolution.

import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
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

export interface ExecModuleResult<TExports extends Record<string, unknown>> {
	/** The generated module's full export namespace, or null if its top-level evaluation threw. */
	moduleExports: TExports | null;
	/** The TraceRun accumulated up to (and including) whatever ran before any throw. */
	trace: TraceRun;
	/** Set iff the generated module's top-level evaluation threw. */
	error: { name: string; message: string } | null;
}

/**
 * Runs `generatedTsCode` (the `code` returned by compileTrace) against the REAL
 * runtime (src/runtime/index.ts), calling startTrace() immediately before the
 * generated module's top-level code executes. Unlike execWithRealRuntime, the dynamic
 * import is wrapped in try/catch *inside the subprocess*: if the generated module's
 * top-level evaluation throws (e.g. because a check operand's function call throws),
 * that error's name/message is captured and returned instead of propagating -- and
 * finishTrace() is still called afterward (nothing in the runtime clears the active
 * session on a thrown error; only an explicit finishTrace() call does), so the
 * PARTIAL trace recorded before the throw is still recoverable.
 */
export function execModuleWithRealRuntime<TExports extends Record<string, unknown> = Record<string, unknown>>(
	generatedTsCode: string,
	opts?: { pipeline?: string }
): ExecModuleResult<TExports> {
	const runtimeSource = readFileSync(runtimeSourcePath, 'utf8');
	const { outputText: runtimeJs } = ts.transpileModule(runtimeSource, transpileOpts);
	const { outputText: generatedJs } = ts.transpileModule(generatedTsCode, transpileOpts);

	const dir = mkdtempSync(join(tmpdir(), 'toph-adversarial-runtime-'));
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
				`startTrace(${JSON.stringify(opts ?? {})});`,
				'let moduleExports = null;',
				'let error = null;',
				'try {',
				"  const generated = await import('./generated.mjs');",
				'  moduleExports = { ...generated };',
				'} catch (err) {',
				'  error = { name: err && err.constructor ? err.constructor.name : typeof err, message: String(err && err.message !== undefined ? err.message : err) };',
				'}',
				'const trace = finishTrace();',
				'',
				"writeFileSync('./result.json', JSON.stringify({ moduleExports, trace, error }));",
				'',
			].join('\n'),
			'utf8'
		);

		execFileSync(process.execPath, [runnerPath], { cwd: dir, stdio: 'pipe' });

		const raw = readFileSync(join(dir, 'result.json'), 'utf8');
		return JSON.parse(raw) as ExecModuleResult<TExports>;
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

/**
 * Like execModuleWithRealRuntime, but runs the *original, un-instrumented* source
 * (compileProduction's byte-identical output, or any hand-written equivalent) with no
 * toph import required at all -- no subprocess, no session lifecycle, just type-erase
 * and dynamic-import in-process, catching a thrown error the same way. Used to compare
 * "does the original predicate throw the identical error" against the trace-mode path
 * without needing a fake toph package on disk.
 */
export async function execPlainModule<TExports extends Record<string, unknown> = Record<string, unknown>>(
	plainTsCode: string
): Promise<{ moduleExports: TExports | null; error: { name: string; message: string } | null }> {
	const { outputText } = ts.transpileModule(plainTsCode, transpileOpts);
	const dir = mkdtempSync(join(tmpdir(), 'toph-adversarial-plain-'));
	const file = join(dir, `plain-${Date.now()}-${Math.random().toString(36).slice(2)}.mjs`);
	try {
		writeFileSync(file, outputText, 'utf8');
		const fileUrl = pathToFileURL(file).href;
		try {
			const mod = (await import(/* @vite-ignore */ fileUrl)) as TExports;
			return { moduleExports: { ...mod }, error: null };
		} catch (err) {
			const name = err instanceof Error ? err.constructor.name : typeof err;
			const message = err instanceof Error ? err.message : String(err);
			return { moduleExports: null, error: { name, message } };
		}
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}
