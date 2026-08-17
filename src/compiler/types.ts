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
	/** Optional semantic verdict family declared by `@toph filter <name> family=<family>`.
	 * Execution stage names answer where code ran; family answers what kind of truth this
	 * stage is entitled to adjudicate. Queries must never infer family from the name. */
	family?: string;
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

/** One `@toph snapshot` site: a named raster asset captured immediately before its
 * annotated statement runs. `kind` has exactly one supported value ('mask') for now --
 * see directives.ts's parseSnapshotArgs. */
export interface AssetManifestEntry {
	id: number;
	name: string;
	kind: 'mask';
	source: SourceLocation;
}

/** One distinct entity-kind name seen across `@toph entities <kind>` sites in a compile
 * (e.g. "component"). Multiple `@toph entities` sites sharing the same kind string
 * reuse this same manifest entry's id -- see codegen.ts's entityKindIdByName map. */
export interface EntityKindManifestEntry {
	id: number;
	name: string;
	source: SourceLocation;
}

export interface ManifestFragment {
	stages: StageManifestEntry[];
	checks: CheckManifestEntry[];
	assets: AssetManifestEntry[];
	entityKinds: EntityKindManifestEntry[];
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
	nextAssetId(): number;
	nextEntityKindId(): number;
}

/**
 * Internal-only extension of StageManifestEntry: compileTrace additionally records
 * where in the *generated* code string this stage's `enterStage` call landed, so that
 * writeManifest can build the flat sourceMap without re-parsing generated code.
 *
 * This field is NOT part of the public StageManifestEntry contract; it rides along on
 * the same object at runtime and writeManifest strips it back out when building the
 * public manifest, using it only to populate the separate sourceMap array.
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

/** Internal-only extension of AssetManifestEntry -- see InternalStageManifestEntry. */
export interface InternalAssetManifestEntry extends AssetManifestEntry {
	generatedFile: string;
	generatedLine: number;
}

/** Internal-only extension of EntityKindManifestEntry -- see InternalStageManifestEntry. */
export interface InternalEntityKindManifestEntry extends EntityKindManifestEntry {
	generatedFile: string;
	generatedLine: number;
}