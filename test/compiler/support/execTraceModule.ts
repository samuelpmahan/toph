// Test-only harness: executes compileTrace's generated TypeScript output for real,
// in a fresh Node subprocess, with `toph` resolved to the fake runtime.
//
// Why a subprocess instead of a direct dynamic import() from inside the vitest
// process: the generated code's `import * as __toph from "toph"` is a bare
// specifier, and we want it resolved via completely ordinary Node ESM node_modules
// resolution (a real node_modules/toph sibling directory), independent of
// vitest/Vite's own module loader/alias behavior for files living outside the
// project root. A plain `node run.mjs` subprocess makes that resolution unambiguous.

import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import * as ts from 'typescript';
import { FAKE_RUNTIME_SOURCE, type FakeEvent } from './fakeRuntime.js';

export interface ExecTraceResult<TSurvivor> {
	survivors: TSurvivor[];
	events: FakeEvent[];
}

/**
 * Runs `generatedTsCode` (the `code` returned by compileTrace) to completion and
 * returns its exported `survivors` binding plus the fake runtime's recorded event
 * log, in call order.
 *
 * `generatedTsCode` is transpiled (type-stripped only, via ts.transpileModule) before
 * execution -- Node has no TypeScript support, and a real consumer would always run
 * compileTrace's output through its own bundler/tsc first. This is a test-execution
 * convenience, not part of the compiler under test: transpileModule performs no
 * logic rewriting, only type erasure, so it does not change the behavior being
 * asserted on.
 */
export function execTraceModule<TSurvivor = unknown>(generatedTsCode: string): ExecTraceResult<TSurvivor> {
	const { outputText } = ts.transpileModule(generatedTsCode, {
		compilerOptions: {
			module: ts.ModuleKind.ESNext,
			target: ts.ScriptTarget.ES2022,
		},
	});

	const dir = mkdtempSync(join(tmpdir(), 'toph-trace-'));
	try {
		const tophDir = join(dir, 'node_modules', 'toph');
		mkdirSync(tophDir, { recursive: true });
		writeFileSync(join(tophDir, 'package.json'), JSON.stringify({ name: 'toph', main: './index.mjs' }), 'utf8');
		writeFileSync(join(tophDir, 'index.mjs'), FAKE_RUNTIME_SOURCE, 'utf8');

		writeFileSync(join(dir, 'generated.mjs'), outputText, 'utf8');

		const runnerPath = join(dir, 'run.mjs');
		writeFileSync(
			runnerPath,
			[
				"import { survivors } from './generated.mjs';",
				"import { events } from 'toph';",
				"import { writeFileSync } from 'node:fs';",
				"writeFileSync('./result.json', JSON.stringify({ survivors, events }));",
				'',
			].join('\n'),
			'utf8'
		);

		execFileSync(process.execPath, [runnerPath], { cwd: dir, stdio: 'pipe' });

		const raw = readFileSync(join(dir, 'result.json'), 'utf8');
		return JSON.parse(raw) as ExecTraceResult<TSurvivor>;
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}
