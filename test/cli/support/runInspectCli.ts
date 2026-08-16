// Test-only harness: runs src/cli/bin.ts as a REAL, separate `toph inspect` CLI
// invocation, in a fresh Node subprocess, against real JSON files on disk.
//
// Why a subprocess instead of a direct `import` of bin.ts from inside the vitest
// process: bin.ts calls its own `main()` unconditionally at module top level (it's
// meant to run as `node bin.js inspect ...`), which reads `process.argv` and can call
// `process.exit()` -- importing it directly into the vitest worker's own process
// would read *vitest's* argv (not "inspect") and could terminate the whole test
// worker. Spawning it as its own subprocess, with `process.argv` set exactly the way
// a real `toph inspect ...` invocation would set it, is both safe and the only way to
// exercise its actual output (formatCheck/formatReport are not exported, only
// reachable through main()'s console.log).
//
// Mirrors test/compiler/support/execTraceModule.ts's transpile-then-execFileSync
// strategy for the same underlying reason (Node has no native TypeScript support).
// src/cli/bin.ts, inspect.ts, and labelmap.ts are transpiled (type erasure only) and
// written out under their EXACT original relative filenames (as .js, not .mjs) with a
// "type":"module" package.json alongside, so their untouched `./inspect.js` /
// `./labelmap.js` import specifiers keep resolving correctly.

import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import * as ts from 'typescript';

const __dirname = dirname(fileURLToPath(import.meta.url));
const cliSrcDir = join(__dirname, '..', '..', '..', 'src', 'cli');

const transpileOpts: ts.TranspileOptions = {
	compilerOptions: {
		module: ts.ModuleKind.ESNext,
		target: ts.ScriptTarget.ES2022,
	},
};

function transpileFile(name: string): string {
	const source = readFileSync(join(cliSrcDir, name), 'utf8');
	return ts.transpileModule(source, transpileOpts).outputText;
}

/**
 * Runs `toph inspect <argv...>` for real (src/cli/bin.ts's actual main()), against
 * `files` written to a fresh temp directory first (keys are filenames, e.g.
 * "trace.json", values are JSON-serialized as-is). Returns stdout. Throws (with
 * stderr attached via execFileSync's own error) if the CLI exits non-zero.
 */
export function runInspectCli(argv: string[], files: Record<string, unknown>): string {
	const dir = mkdtempSync(join(tmpdir(), 'toph-cli-'));
	try {
		writeFileSync(join(dir, 'package.json'), JSON.stringify({ type: 'module' }), 'utf8');
		writeFileSync(join(dir, 'bin.js'), transpileFile('bin.ts'), 'utf8');
		writeFileSync(join(dir, 'inspect.js'), transpileFile('inspect.ts'), 'utf8');
		writeFileSync(join(dir, 'labelmap.js'), transpileFile('labelmap.ts'), 'utf8');

		for (const [name, content] of Object.entries(files)) {
			writeFileSync(join(dir, name), JSON.stringify(content), 'utf8');
		}

		const stdout = execFileSync(process.execPath, [join(dir, 'bin.js'), 'inspect', ...argv], {
			cwd: dir,
			encoding: 'utf8',
		});
		return stdout;
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}
