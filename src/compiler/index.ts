// Toph compiler public API (Phase 1). See IMPLEMENTATION-DECISIONS.md sections 4-8
// for the exact spec this module implements.

import * as ts from 'typescript';
import type {
	CheckManifestEntry,
	CompileResult,
	CompilerDiagnostic,
	IdAllocator,
	InternalCheckManifestEntry,
	InternalStageManifestEntry,
	ManifestFragment,
	StageManifestEntry,
} from './types.js';
import { validateFile } from './validate.js';
import { generateTraceCode } from './codegen.js';

export type {
	SourceLocation,
	StageManifestEntry,
	CheckManifestEntry,
	ManifestFragment,
	CompilerDiagnostic,
	CompileResult,
	IdAllocator,
} from './types.js';

export function createIdAllocator(startStageId = 1, startCheckId = 1): IdAllocator {
	let nextStage = startStageId;
	let nextCheck = startCheckId;
	return {
		nextStageId: () => nextStage++,
		nextCheckId: () => nextCheck++,
	};
}

function parse(fileName: string, source: string): ts.SourceFile {
	return ts.createSourceFile(fileName, source, ts.ScriptTarget.ES2022, true);
}

/**
 * Compiles a single file to trace-mode instrumented code. Always returns `code` and
 * `manifest` best-effort: any @toph filter site with diagnostics is left
 * uninstrumented (original text preserved for that statement) while other, valid
 * sites in the same file are still instrumented. Callers decide whether the presence
 * of diagnostics should fail the build.
 */
export function compileTrace(fileName: string, source: string, ids: IdAllocator): CompileResult {
	const sourceFile = parse(fileName, source);
	const { records, diagnostics } = validateFile(sourceFile);
	const { code, manifest } = generateTraceCode(fileName, source, records, ids);
	return { code, manifest, diagnostics };
}

/**
 * Runs the identical shape validation used by compileTrace, but never rewrites the
 * AST. On success `code` is byte-identical to `source` -- there is nothing to strip
 * because nothing was ever inserted (IMPLEMENTATION-DECISIONS.md section 7).
 * Diagnostics are still reported even though `code` is always the original source,
 * so a bad annotation is caught in production builds too.
 */
export function compileProduction(fileName: string, source: string): { code: string; diagnostics: CompilerDiagnostic[] } {
	const sourceFile = parse(fileName, source);
	const { diagnostics } = validateFile(sourceFile);
	return { code: source, diagnostics };
}

/**
 * Merges manifest fragments from one or more compiled files into the final
 * `{stages, checks}` manifest shape plus a flat sourceMap. Stage/check IDs are
 * assumed already globally unique across fragments (the caller is responsible for
 * threading a single shared IdAllocator across every compileTrace call that
 * contributes to one manifest).
 */
export function writeManifest(fragments: ManifestFragment[]): {
	manifest: { stages: StageManifestEntry[]; checks: CheckManifestEntry[] };
	sourceMap: Array<{ generatedFile: string; generatedLine: number; file: string; line: number }>;
} {
	const stages: StageManifestEntry[] = [];
	const checks: CheckManifestEntry[] = [];
	const sourceMap: Array<{ generatedFile: string; generatedLine: number; file: string; line: number }> = [];

	for (const fragment of fragments) {
		for (const stage of fragment.stages) {
			stages.push({ id: stage.id, name: stage.name, kind: 'filter', source: stage.source });
			const ext = stage as Partial<InternalStageManifestEntry>;
			sourceMap.push({
				generatedFile: ext.generatedFile ?? stage.source.file,
				generatedLine: ext.generatedLine ?? 0,
				file: stage.source.file,
				line: stage.source.line,
			});
		}
		for (const check of fragment.checks) {
			const clean: CheckManifestEntry = {
				id: check.id,
				stageId: check.stageId,
				code: check.code,
				operator: check.operator,
				source: check.source,
			};
			if (check.unit !== undefined) clean.unit = check.unit;
			checks.push(clean);

			const ext = check as Partial<InternalCheckManifestEntry>;
			sourceMap.push({
				generatedFile: ext.generatedFile ?? check.source.file,
				generatedLine: ext.generatedLine ?? 0,
				file: check.source.file,
				line: check.source.line,
			});
		}
	}

	return { manifest: { stages, checks }, sourceMap };
}
