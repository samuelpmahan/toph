// Trace-mode source generation. Generated code threads explicit local entity/stage
// variables through rewritten filter callbacks and leaves ordinary TypeScript control
// flow intact.

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

class LineTrackingBuilder {
	private parts: string[] = [];
	private line = 1;
	append(text: string): void {
		this.parts.push(text);
		for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 10) this.line++;
	}
	currentLine(): number { return this.line; }
	toString(): string { return this.parts.join(''); }
}

export interface GenerateResult { code: string; manifest: ManifestFragment; }
interface WrapSite { node: ts.Statement; snapshot?: ValidSnapshotSite; entities?: ValidEntitiesSite; }
type Edit = { kind: 'filter'; node: ts.Statement; filter: ValidFilterSite } | { kind: 'wrap'; node: ts.Statement; wrap: WrapSite };

export function generateTraceCode(
	fileName: string,
	source: string,
	records: FilterSiteRecord[],
	snapshotRecords: SnapshotSiteRecord[],
	entitiesRecords: EntitiesSiteRecord[],
	ids: IdAllocator
): GenerateResult {
	const validFilterSites = records.filter((r): r is { valid: true; site: ValidFilterSite } => r.valid).map((r) => r.site);
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
	edits.sort((a, b) => a.node.getFullStart() - b.node.getFullStart());
	if (edits.length === 0) return { code: source, manifest: { stages: [], checks: [], assets: [], entityKinds: [] } };

	const stages: InternalStageManifestEntry[] = [];
	const checks: InternalCheckManifestEntry[] = [];
	const assets: InternalAssetManifestEntry[] = [];
	const entityKinds: InternalEntityKindManifestEntry[] = [];
	const entityKindIdByName = new Map<string, number>();
	const builder = new LineTrackingBuilder();
	builder.append('import * as __toph from "toph";\n\n');
	let nextDeriveTempSuffix = 1;
	let cursor = 0;

	for (const edit of edits) {
		const nodeStart = edit.node.getFullStart();
		let between = source.slice(cursor, nodeStart);
		if (between.length > 0 && !between.endsWith('\n')) between += '\n';
		builder.append(between);
		if (edit.kind === 'filter') emitFilterSite(builder, edit.filter, ids, fileName, stages, checks);
		else emitWrapSite(builder, edit.wrap, ids, fileName, source, assets, entityKinds, entityKindIdByName, () => nextDeriveTempSuffix++);
		cursor = edit.node.getEnd();
	}
	builder.append(source.slice(cursor));
	return { code: builder.toString(), manifest: { stages, checks, assets, entityKinds } };
}

function emitWrapSite(
	builder: LineTrackingBuilder,
	wrap: WrapSite,
	ids: IdAllocator,
	fileName: string,
	source: string,
	assets: InternalAssetManifestEntry[],
	entityKinds: InternalEntityKindManifestEntry[],
	entityKindIdByName: Map<string, number>,
	nextDeriveTempSuffix: () => number
): void {
	if (wrap.snapshot) {
		const s = wrap.snapshot;
		const assetId = ids.nextAssetId();
		const generatedLine = builder.currentLine();
		builder.append(`__toph.snapshotRaster(${assetId}, ${JSON.stringify(s.assetName)}, "mask", ${s.ref}, ${s.width}, ${s.height});\n`);
		assets.push({ id: assetId, name: s.assetName, kind: 'mask', source: { file: fileName, line: s.sourceLine }, generatedFile: fileName, generatedLine });
	}

	let deriveTempIdent: string | null = null;
	if (wrap.entities && wrap.entities.shape === 'map') {
		const e = wrap.entities;
		deriveTempIdent = `__toph_derive_${nextDeriveTempSuffix()}`;
		builder.append(`const ${deriveTempIdent} = ${e.receiverExprText};\n`);
		builder.append(`const ${e.resultIdent} = ${deriveTempIdent}.map(${e.callbackText});\n`);
	} else {
		builder.append(`${source.slice(wrap.node.getStart(), wrap.node.getEnd())}\n`);
	}

	if (wrap.entities) {
		const e = wrap.entities;
		let entityKindId = entityKindIdByName.get(e.kindName);
		if (entityKindId === undefined) {
			entityKindId = ids.nextEntityKindId();
			entityKindIdByName.set(e.kindName, entityKindId);
			entityKinds.push({ id: entityKindId, name: e.kindName, source: { file: fileName, line: e.sourceLine }, generatedFile: fileName, generatedLine: builder.currentLine() });
		}
		if (e.shape === 'map') builder.append(`__toph.spawnDerivedEntities(${entityKindId}, ${e.resultIdent}, ${deriveTempIdent});\n`);
		else builder.append(`__toph.spawnEntities(${entityKindId}, ${e.resultIdent});\n`);
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
	builder.append(`  const __toph_e = __toph.enterElement(__toph_s${stageId}, ${site.paramText});\n`);

	for (const group of site.checkGroups) {
		const checkId = ids.nextCheckId();
		const fn = OPERATOR_FN[group.operator];
		const checkLine = builder.currentLine();
		builder.append(`  const ${group.boolIdent} = __toph.${fn}(__toph_e, ${checkId}, ${group.leftText}, ${group.rightText});\n`);
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
	const stageEntry: InternalStageManifestEntry = {
		id: stageId,
		name: site.stageName,
		kind: 'filter',
		source: { file: fileName, line: site.sourceLine },
		generatedFile: fileName,
		generatedLine: stageLine,
	};
	if (site.family !== undefined) stageEntry.family = site.family;
	stages.push(stageEntry);
}