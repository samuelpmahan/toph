// Directive comment parsing.
//
// Per IMPLEMENTATION-DECISIONS.md section 2: directives are matched against raw
// leading-comment text via ts.getLeadingCommentRanges, NOT via ts.getJSDocTags --
// @toph is not a tag TypeScript's own JSDoc parser recognizes or associates with
// arbitrary statements.

import * as ts from 'typescript';

export type DirectiveVerb = 'filter' | 'check' | 'snapshot' | 'entities';

export interface ParsedDirective {
	verb: DirectiveVerb;
	/** Raw trimmed text following the verb, e.g. "demo.geometry" or "area.min unit=px2". */
	args: string;
}

/** A leading comment that looks like a directive attempt, successfully parsed. */
export interface DirectiveHit {
	kind: 'parsed';
	range: ts.CommentRange;
	directive: ParsedDirective;
}

/** A leading comment that contains "@toph" but does not parse as "@toph <verb> <args>". */
export interface MalformedDirectiveHit {
	kind: 'malformed';
	range: ts.CommentRange;
	/** The comment text with its delimiters stripped, for building a diagnostic message. */
	text: string;
}

const DIRECTIVE_RE = /^\s*\*?\s*@toph\s+(filter|check|snapshot|entities)\b(.*)$/m;

/**
 * Strips the surrounding comment delimiters (/* ... *\/ or // ...) from a raw comment
 * range's text so the directive regex can be matched against comment *content*, the
 * same way it would for a multi-line JSDoc comment where each interior line is
 * prefixed with " * ". Without this, a single-line "/** @toph filter x *\/" comment
 * never matches because the pattern's optional leading "*" can't also absorb the "/".
 */
function stripCommentDelimiters(sourceText: string, range: ts.CommentRange): string {
	const raw = sourceText.slice(range.pos, range.end);
	if (range.kind === ts.SyntaxKind.MultiLineCommentTrivia) {
		const withoutOpen = raw.startsWith('/*') ? raw.slice(2) : raw;
		return withoutOpen.endsWith('*/') ? withoutOpen.slice(0, -2) : withoutOpen;
	}
	return raw.startsWith('//') ? raw.slice(2) : raw;
}

function tryParseDirectiveBody(body: string): ParsedDirective | 'malformed' | null {
	if (!body.includes('@toph')) return null;
	const match = DIRECTIVE_RE.exec(body);
	if (!match) return 'malformed';
	const verb = match[1] as DirectiveVerb;
	const args = match[2].trim();
	return { verb, args };
}

export function findLeadingDirective(
	sourceFile: ts.SourceFile,
	node: ts.Node
): DirectiveHit | MalformedDirectiveHit | null {
	const ranges = ts.getLeadingCommentRanges(sourceFile.text, node.getFullStart()) ?? [];
	for (const range of ranges) {
		const body = stripCommentDelimiters(sourceFile.text, range);
		const result = tryParseDirectiveBody(body);
		if (result === null) continue;
		if (result === 'malformed') return { kind: 'malformed', range, text: body.trim() };
		return { kind: 'parsed', range, directive: result };
	}
	return null;
}

export function findLeadingDirectives(
	sourceFile: ts.SourceFile,
	node: ts.Node
): Array<DirectiveHit | MalformedDirectiveHit> {
	const ranges = ts.getLeadingCommentRanges(sourceFile.text, node.getFullStart()) ?? [];
	const hits: Array<DirectiveHit | MalformedDirectiveHit> = [];
	for (const range of ranges) {
		const body = stripCommentDelimiters(sourceFile.text, range);
		const result = tryParseDirectiveBody(body);
		if (result === null) continue;
		if (result === 'malformed') hits.push({ kind: 'malformed', range, text: body.trim() });
		else hits.push({ kind: 'parsed', range, directive: result });
	}
	return hits;
}

export interface ParsedCheckArgs {
	code: string;
	unit?: string;
}

export function parseCheckArgs(args: string): ParsedCheckArgs | null {
	const tokens = args.split(/\s+/).filter((t) => t.length > 0);
	if (tokens.length === 0 || tokens.length > 2) return null;
	const [code, unitToken] = tokens;
	if (!/^[^\s]+$/.test(code)) return null;
	if (unitToken === undefined) return { code };
	const unitMatch = /^unit=(.+)$/.exec(unitToken);
	if (!unitMatch) return null;
	return { code, unit: unitMatch[1] };
}

function singleToken(args: string): string | null {
	const tokens = args.split(/\s+/).filter((t) => t.length > 0);
	if (tokens.length !== 1) return null;
	return tokens[0];
}

export interface ParsedFilterArgs {
	stageName: string;
	family?: string;
}

/**
 * Parses `@toph filter <stage-name> [family=<family>]`.
 *
 * `family` is deliberately explicit semantic metadata. The compiler/query layer must
 * never derive it from stage-name spelling such as `p1.teeFamily`; execution topology
 * and semantic verdict scope are separate contracts.
 */
export function parseFilterArgs(args: string): ParsedFilterArgs | null {
	const tokens = args.split(/\s+/).filter((t) => t.length > 0);
	if (tokens.length < 1 || tokens.length > 2) return null;
	const [stageName, familyToken] = tokens;
	if (!stageName) return null;
	if (familyToken === undefined) return { stageName };
	const familyMatch = /^family=(.+)$/.exec(familyToken);
	if (!familyMatch || familyMatch[1].length === 0) return null;
	return { stageName, family: familyMatch[1] };
}

export function parseEntitiesArgs(args: string): string | null {
	return singleToken(args);
}

const SNAPSHOT_IDENT_RE = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

export interface ParsedSnapshotArgs {
	assetName: string;
	kind: 'mask';
	ref: string;
	width: string;
	height: string;
}

export function parseSnapshotArgs(args: string): ParsedSnapshotArgs | null {
	const tokens = args.split(/\s+/).filter((t) => t.length > 0);
	if (tokens.length !== 5) return null;
	const [assetName, kindToken, refToken, widthToken, heightToken] = tokens;
	if (kindToken !== 'kind=mask') return null;

	const refMatch = /^ref=(.+)$/.exec(refToken);
	const widthMatch = /^width=(.+)$/.exec(widthToken);
	const heightMatch = /^height=(.+)$/.exec(heightToken);
	if (!refMatch || !widthMatch || !heightMatch) return null;
	if (!SNAPSHOT_IDENT_RE.test(refMatch[1])) return null;
	if (!SNAPSHOT_IDENT_RE.test(widthMatch[1])) return null;
	if (!SNAPSHOT_IDENT_RE.test(heightMatch[1])) return null;

	return { assetName, kind: 'mask', ref: refMatch[1], width: widthMatch[1], height: heightMatch[1] };
}