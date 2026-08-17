// Toph compiler public API (Phase 1). See IMPLEMENTATION-DECISIONS.md sections 4-8
// for the exact spec this module implements.

import * as ts from 'typescript';
import type {
	AssetManifestEntry,
	CheckManifestEntry,
	CompileResult,
	CompilerDiagnostic,
	EntityKindManifestEntry,
	IdAllocator,
	InternalAssetManifestEntry,
	InternalCheckManifestEntry,
	InternalEntityKindManifestEntry,
	InternalStageManifestEntry,
	ManifestFragment,
	StageManifestEntry,
} from './types.js';
import { validateFile, validateAssetsAndEntities } from './validate.js';
import { generateTraceCode } from './codegen.js';

export type {
	SourceLocation,
	StageManifestEntry,
	CheckManifestEntry,
	AssetManifestEntry,
	EntityKindManifestEntry,
	ManifestFragment,
	CompilerDiagnostic,
	CompileResult,
	IdAllocator,
} from './types.js';

export function createIdAllocator(startStageId = 1, startCheckId = 1, startAssetId = 1, startEntityKindId = 1): IdAllocator {
	let nextStage = startStageId;
	let nextCheck = startCheckId;
	let nextAsset = startAssetId;
	let nextEntityKind = startEntityKindId;
	return {
		nextStageId: () => nextStage++,
		nextCheckId: () => nextCheck++,
		nextAssetId: () => nextAsset++,
		nextEntityKindId: () => nextEntityKind++,
	};
}

function parse(fileName: string, source: string): ts.SourceFile {
	return ts.createSourceFile(fileName, source, ts.ScriptTarget.ES2022, true);
}

export function compileTrace(fileName: string, source: string, ids: IdAllocator): CompileResult {
	const sourceFile = parse(fileName, source);
	const { records, diagnostics: filterDiagnostics } = validateFile(sourceFile);
	const { snapshotRecords, entitiesRecords, diagnostics: assetDiagnostics } = validateAssetsAndEntities(sourceFile);
	const { code, manifest } = generateTraceCode(fileName, source, records, snapshotRecords, entitiesRecords, ids);
	return { code, manifest, diagnostics: [...filterDiagnostics, ...assetDiagnostics] };
}

export function compileProduction(fileName: string, source: string): { code: string; diagnostics: CompilerDiagnostic[] } {
	const sourceFile = parse(fileName, source);
	const { diagnostics: filterDiagnostics } = validateFile(sourceFile);
	const { diagnostics: assetDiagnostics } = validateAssetsAndEntities(sourceFile);
	return { code: source, diagnostics: [...filterDiagnostics, ...assetDiagnostics] };
}

export function writeManifest(fragments: ManifestFragment[]): {
	manifest: {
		stages: StageManifestEntry[];
		checks: CheckManifestEntry[];
		assets: AssetManifestEntry[];
		entityKinds: EntityKindManifestEntry[];
	};
	sourceMap: Array<{ generatedFile: string; generatedLine: number; file: string; line: number }>;
} {
	const stages: StageManifestEntry[] = [];
	const checks: CheckManifestEntry[] = [];
	const assets: AssetManifestEntry[] = [];
	const entityKinds: EntityKindManifestEntry[] = [];
	const sourceMap: Array<{ generatedFile: string; generatedLine: number; file: string; line: number }> = [];

	for (const fragment of fragments) {
		for (const stage of fragment.stages) {
			const clean: StageManifestEntry = { id: stage.id, name: stage.name, kind: 'filter', source: stage.source };
			if (stage.family !== undefined) clean.family = stage.family;
			stages.push(clean);
			const ext = stage as Partial<InternalStageManifestEntry>;
			sourceMap.push({ generatedFile: ext.generatedFile ?? stage.source.file, generatedLine: ext.generatedLine ?? 0, file: stage.source.file, line: stage.source.line });
		}
		for (const check of fragment.checks) {
			const clean: CheckManifestEntry = { id: check.id, stageId: check.stageId, code: check.code, operator: check.operator, source: check.source };
			if (check.unit !== undefined) clean.unit = check.unit;
			checks.push(clean);
			const ext = check as Partial<InternalCheckManifestEntry>;
			sourceMap.push({ generatedFile: ext.generatedFile ?? check.source.file, generatedLine: ext.generatedLine ?? 0, file: check.source.file, line: check.source.line });
		}
		for (const asset of fragment.assets) {
			assets.push({ id: asset.id, name: asset.name, kind: asset.kind, source: asset.source });
			const ext = asset as Partial<InternalAssetManifestEntry>;
			sourceMap.push({ generatedFile: ext.generatedFile ?? asset.source.file, generatedLine: ext.generatedLine ?? 0, file: asset.source.file, line: asset.source.line });
		}
		for (const entityKind of fragment.entityKinds) {
			entityKinds.push({ id: entityKind.id, name: entityKind.name, source: entityKind.source });
			const ext = entityKind as Partial<InternalEntityKindManifestEntry>;
			sourceMap.push({ generatedFile: ext.generatedFile ?? entityKind.source.file, generatedLine: ext.generatedLine ?? 0, file: entityKind.source.file, line: entityKind.source.line });
		}
	}
	return { manifest: { stages, checks, assets, entityKinds }, sourceMap };
}