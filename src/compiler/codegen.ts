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
import type { IdAllocator, InternalCheckManifestEntry, InternalStageManifestEntry, ManifestFragment } from './types.js';
import type { FilterSiteRecord, ValidFilterSite } from './validate.js';

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

export function generateTraceCode(
	fileName: string,
	source: string,
	records: FilterSiteRecord[],
	ids: IdAllocator
): GenerateResult {
	const validSites: ValidFilterSite[] = [];
	for (const record of records) {
		if (record.valid) validSites.push(record.site);
	}
	// Document order (statements are already discovered in document order by
	// validateFile's traversal, but sort defensively on position to be explicit).
	validSites.sort((a, b) => a.node.getFullStart() - b.node.getFullStart());

	if (validSites.length === 0) {
		// No import survives if the file has no valid @toph filter sites to instrument.
		return { code: source, manifest: { stages: [], checks: [] } };
	}

	const stages: InternalStageManifestEntry[] = [];
	const checks: InternalCheckManifestEntry[] = [];

	const builder = new LineTrackingBuilder();
	builder.append('import * as __toph from "toph";\n\n');

	let cursor = 0;
	for (const site of validSites) {
		const nodeStart = site.node.getFullStart();
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
		emitFilterSite(builder, site, ids, fileName, stages, checks);
		cursor = site.node.getEnd();
	}
	builder.append(source.slice(cursor));

	return { code: builder.toString(), manifest: { stages, checks } };
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
	builder.append(`const __toph_s${stageId} = __toph.enterStage(${stageId});\n`);
	builder.append(`const ${site.resultIdent} = ${site.arrayExprText}.filter((${site.paramText}) => {\n`);
	builder.append(`  const __toph_e = __toph.enterElement(__toph_s${stageId});\n`);

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
