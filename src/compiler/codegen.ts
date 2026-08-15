// Trace-mode source generation. Per IMPLEMENTATION-DECISIONS.md section 6, generated
// code threads explicit local `__toph_e` / `__toph_s<N>` variables through the
// rewritten filter callback -- no ambient/global "current entity" -- and every
// original sub-expression is copied verbatim (evaluated exactly once, at its
// original position).
//
// Untouched source (everything outside a valid @toph filter site's statement span)
// is copied through byte-for-byte via string splicing; only the statements that make
// up a *valid* filter site are replaced. Sites with diagnostics are left completely
// unmodified, per the task spec ("that block must NOT be instrumented").

import * as ts from 'typescript';
import type {
	IdAllocator,
	InternalAssetManifestEntry,
	InternalCheckManifestEntry,
	InternalEntityKindManifestEntry,
	InternalStageManifestEntry,
	ManifestFragment,
} from './types.js';
import type {
	EntitiesSiteRecord,
	FilterSiteRecord,
	SnapshotSiteRecord,
	ValidEntitiesSite,
	ValidFilterSite,
	ValidSnapshotSite,
} from './validate.js';

const OPERATOR_FN: Record<string, string> = {
	'>=': 'gte',
	'<=': 'lte',
	'>': 'gt',
	'<': 'lt',
	'===': 'eq',
	'==': 'eq',
	'!==': 'neq',
	'!=': 'neq',
};

/** Accumulates generated text while tracking the 1-indexed line the next append starts on. */
class LineTrackingBuilder {
	private parts: string[] = [];
	private line = 1;

	append(text: string): void {
		this.parts.push(text);
		for (let i = 0; i < text.length; i++) {
			if (text.charCodeAt(i) === 10 /* \n */) this.line++;
		}
	}

	currentLine(): number {
		return this.line;
	}

	toString(): string {
		return this.parts.join('');
	}
}

export interface GenerateResult {
	code: string;
	manifest: ManifestFragment;
}

/** One statement carrying a `@toph snapshot` and/or a `@toph entities` directive --
 * built by grouping SnapshotSiteRecord/EntitiesSiteRecord by their shared host node
 * (they validate independently in validate.ts but can co-occur on one statement). */
interface WrapSite {
	node: ts.Statement;
	snapshot?: ValidSnapshotSite;
	entities?: ValidEntitiesSite;
}

type Edit =
	| { kind: 'filter'; node: ts.Statement; filter: ValidFilterSite }
	| { kind: 'wrap'; node: ts.Statement; wrap: WrapSite };

export function generateTraceCode(
	fileName: string,
	source: string,
	records: FilterSiteRecord[],
	snapshotRecords: SnapshotSiteRecord[],
	entitiesRecords: EntitiesSiteRecord[],
	ids: IdAllocator
): GenerateResult {
	const validFilterSites: ValidFilterSite[] = [];
	for (const record of records) {
		if (record.valid) validFilterSites.push(record.site);
	}

	// Group valid snapshot/entities sites by host statement -- a single statement may
	// carry both (see validate.ts's ValidateAssetsAndEntitiesResult doc comment).
	const wrapByNode = new Map<ts.Statement, WrapSite>();
	for (const record of snapshotRecords) {
		if (!record.valid) continue;
		const existing = wrapByNode.get(record.site.node) ?? { node: record.site.node };
		existing.snapshot = record.site;
		wrapByNode.set(record.site.node, existing);
	}
	for (const record of entitiesRecords) {
		if (!record.valid) continue;
		const existing = wrapByNode.get(record.site.node) ?? { node: record.site.node };
		existing.entities = record.site;
		wrapByNode.set(record.site.node, existing);
	}

	const edits: Edit[] = [
		...validFilterSites.map((filter): Edit => ({ kind: 'filter', node: filter.node, filter })),
		...[...wrapByNode.values()].map((wrap): Edit => ({ kind: 'wrap', node: wrap.node, wrap })),
	];
	// Document order (statements are already discovered in document order by the
	// validators' traversals, but sort defensively on position to be explicit -- also
	// necessary here since the two groups above are concatenated, not already merged in
	// position order).
	edits.sort((a, b) => a.node.getFullStart() - b.node.getFullStart());

	if (edits.length === 0) {
		// No import survives if the file has no valid @toph sites to instrument.
		return { code: source, manifest: { stages: [], checks: [], assets: [], entityKinds: [] } };
	}

	const stages: InternalStageManifestEntry[] = [];
	const checks: InternalCheckManifestEntry[] = [];
	const assets: InternalAssetManifestEntry[] = [];
	const entityKinds: InternalEntityKindManifestEntry[] = [];
	// Reuses the same manifest entity-kind id for repeated `@toph entities <kind>` sites
	// sharing the same kind string within this one file's compile -- scoped to this one
	// generateTraceCode call (i.e. "the same compile" of this file), not threaded across
	// files, per the task's entity-identity scope.
	const entityKindIdByName = new Map<string, number>();

	const builder = new LineTrackingBuilder();
	builder.append('import * as __toph from "toph";\n\n');

	let cursor = 0;
	for (const edit of edits) {
		const nodeStart = edit.node.getFullStart();
		// node.getFullStart() sits immediately after the previous token -- i.e. right
		// before the directive comment's leading trivia begins, with no newline of its
		// own. Dropping that trivia (to drop the directive comment along with it) would
		// otherwise glue this segment directly onto the generated replacement's first
		// line with no separator; ensure exactly one newline between them.
		let between = source.slice(cursor, nodeStart);
		if (between.length > 0 && !between.endsWith('\n')) {
			between += '\n';
		}
		builder.append(between);

		if (edit.kind === 'filter') {
			emitFilterSite(builder, edit.filter, ids, fileName, stages, checks);
		} else {
			emitWrapSite(builder, edit.wrap, ids, fileName, source, assets, entityKinds, entityKindIdByName);
		}

		cursor = edit.node.getEnd();
	}
	builder.append(source.slice(cursor));

	return { code: builder.toString(), manifest: { stages, checks, assets, entityKinds } };
}

/**
 * Emits a `@toph snapshot` / `@toph entities` wrap site: unlike a filter site, the
 * annotated statement's own text is preserved verbatim (its right-hand side is never
 * touched) -- only a `snapshotRaster` call immediately before and/or a `spawnEntities`
 * call immediately after are inserted. The statement's own leading directive comment(s)
 * are dropped the same way a filter site's are: generateTraceCode's caller already
 * skipped past the node's full leading-trivia span (getFullStart() -> getStart()) via
 * the "between" splice above, so slicing from getStart() here naturally excludes them.
 */
function emitWrapSite(
	builder: LineTrackingBuilder,
	wrap: WrapSite,
	ids: IdAllocator,
	fileName: string,
	source: string,
	assets: InternalAssetManifestEntry[],
	entityKinds: InternalEntityKindManifestEntry[],
	entityKindIdByName: Map<string, number>
): void {
	if (wrap.snapshot) {
		const s = wrap.snapshot;
		const assetId = ids.nextAssetId();
		const generatedLine = builder.currentLine();
		builder.append(
			`__toph.snapshotRaster(${assetId}, ${JSON.stringify(s.assetName)}, "mask", ${s.ref}, ${s.width}, ${s.height});\n`
		);
		assets.push({
			id: assetId,
			name: s.assetName,
			kind: 'mask',
			source: { file: fileName, line: s.sourceLine },
			generatedFile: fileName,
			generatedLine,
		});
	}

	const stmtText = source.slice(wrap.node.getStart(), wrap.node.getEnd());
	builder.append(`${stmtText}\n`);

	if (wrap.entities) {
		const e = wrap.entities;
		let entityKindId = entityKindIdByName.get(e.kindName);
		if (entityKindId === undefined) {
			entityKindId = ids.nextEntityKindId();
			entityKindIdByName.set(e.kindName, entityKindId);
			entityKinds.push({
				id: entityKindId,
				name: e.kindName,
				source: { file: fileName, line: e.sourceLine },
				generatedFile: fileName,
				generatedLine: builder.currentLine(),
			});
		}
		builder.append(`__toph.spawnEntities(${entityKindId}, ${e.resultIdent});\n`);
	}
}

function emitFilterSite(
	builder: LineTrackingBuilder,
	site: ValidFilterSite,
	ids: IdAllocator,
	fileName: string,
	stages: InternalStageManifestEntry[],
	checks: InternalCheckManifestEntry[]
): void {
	const stageId = ids.nextStageId();

	const stageLine = builder.currentLine();
	const bindingPrefix = site.bindingKind === 'declare' ? 'const ' : '';
	builder.append(`const __toph_s${stageId} = __toph.enterStage(${stageId});\n`);
	builder.append(`${bindingPrefix}${site.resultIdent} = ${site.arrayExprText}.filter((${site.paramText}) => {\n`);
	// Always pass the callback's own element as `ref` -- enterElement's WeakMap lookup
	// (src/runtime/index.ts) is a no-op fallback to the ordinary fresh-ordinal path when
	// `ref` was never spawned via `@toph entities` (the common case: most filter sites'
	// elements have no upstream spawn at all). The compiler has no cross-statement
	// data-flow analysis to prove "this array's elements came from a spawn" -- and
	// deliberately doesn't need one, since passing `ref` unconditionally is free when
	// unused and is exactly what lets a later filter's checks pick up a SAME entity id
	// when they do.
	builder.append(`  const __toph_e = __toph.enterElement(__toph_s${stageId}, ${site.paramText});\n`);

	for (const group of site.checkGroups) {
		const checkId = ids.nextCheckId();
		const fn = OPERATOR_FN[group.operator];
		const checkLine = builder.currentLine();
		builder.append(
			`  const ${group.boolIdent} = __toph.${fn}(__toph_e, ${checkId}, ${group.leftText}, ${group.rightText});\n`
		);
		builder.append(`  ${group.guardText}\n`);

		const checkEntry: InternalCheckManifestEntry = {
			id: checkId,
			stageId,
			code: group.code,
			operator: group.operator,
			source: { file: fileName, line: group.sourceLine },
			generatedFile: fileName,
			generatedLine: checkLine,
		};
		if (group.unit !== undefined) checkEntry.unit = group.unit;
		checks.push(checkEntry);
	}

	builder.append('  __toph.keep(__toph_e);\n');
	builder.append(`  ${site.finalReturnText}\n`);
	builder.append('});\n');

	stages.push({
		id: stageId,
		name: site.stageName,
		kind: 'filter',
		source: { file: fileName, line: site.sourceLine },
		generatedFile: fileName,
		generatedLine: stageLine,
	});
}
