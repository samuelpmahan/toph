// Public API types for the Toph compiler.
//
// This is the exact contract described in IMPLEMENTATION-DECISIONS.md section 6/7/8
// and the Phase 1 task spec. Other phases (runtime, later compiler phases) depend on
// these shapes verbatim -- do not add/remove/rename fields here without checking who
// else consumes them.

export interface SourceLocation {
	file: string;
	line: number;
}

export interface StageManifestEntry {
	id: number;
	name: string;
	kind: 'filter';
	source: SourceLocation;
}

export interface CheckManifestEntry {
	id: number;
	stageId: number;
	code: string;
	operator: string;
	unit?: string;
	source: SourceLocation;
}

export interface ManifestFragment {
	stages: StageManifestEntry[];
	checks: CheckManifestEntry[];
}

export interface CompilerDiagnostic {
	code: string;
	message: string;
	file: string;
	line: number;
	column: number;
}

export interface CompileResult {
	code: string;
	manifest: ManifestFragment;
	diagnostics: CompilerDiagnostic[];
}

export interface IdAllocator {
	nextStageId(): number;
	nextCheckId(): number;
}

/**
 * Internal-only extension of StageManifestEntry: compileTrace additionally records
 * where in the *generated* code string this stage's `enterStage` call landed, so that
 * writeManifest can build the flat sourceMap without re-parsing generated code.
 *
 * This field is NOT part of the public StageManifestEntry contract (the manifest JSON
 * shape must stay exactly {id, name, kind, source}) -- it rides along on the same
 * object at runtime and writeManifest strips it back out when building the public
 * manifest, using it only to populate the separate sourceMap array.
 */
export interface InternalStageManifestEntry extends StageManifestEntry {
	generatedFile: string;
	generatedLine: number;
}

/** Internal-only extension of CheckManifestEntry -- see InternalStageManifestEntry. */
export interface InternalCheckManifestEntry extends CheckManifestEntry {
	generatedFile: string;
	generatedLine: number;
}
