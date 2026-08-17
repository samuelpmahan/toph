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
	// SingleLineCommentTrivia
	return raw.startsWith('//') ? raw.slice(2) : raw;
}

/**
 * Attempts to parse a single comment body (delimiters already stripped) as a Toph
 * directive. Returns:
 *   - a ParsedDirective if it matches "@toph <verb> <args>",
 *   - 'malformed' if it contains "@toph" but doesn't match,
 *   - null if it doesn't mention "@toph" at all (an ordinary comment).
 */
function tryParseDirectiveBody(body: string): ParsedDirective | 'malformed' | null {
	if (!body.includes('@toph')) return null;
	const match = DIRECTIVE_RE.exec(body);
	if (!match) return 'malformed';
	const verb = match[1] as DirectiveVerb;
	const args = match[2].trim();
	return { verb, args };
}

/**
 * Finds the first @toph-directive-shaped leading comment attached to `node`, scanning
 * its leading comment ranges in source order. Returns null if none of node's leading
 * comments mention "@toph" at all.
 */
export function findLeadingDirective(
	sourceFile: ts.SourceFile,
	node: ts.Node
): DirectiveHit | MalformedDirectiveHit | null {
	const ranges = ts.getLeadingCommentRanges(sourceFile.text, node.getFullStart()) ?? [];
	for (const range of ranges) {
		const body = stripCommentDelimiters(sourceFile.text, range);
		const result = tryParseDirectiveBody(body);
		if (result === null) continue;
		if (result === 'malformed') {
			return { kind: 'malformed', range, text: body.trim() };
		}
		return { kind: 'parsed', range, directive: result };
	}
	return null;
}

/**
 * Like findLeadingDirective, but returns EVERY @toph-directive-shaped leading comment
 * attached to `node` (in source order), not just the first. Needed for directive kinds
 * that can legitimately co-occur on the same statement -- e.g. a `@toph snapshot` and a
 * `@toph entities` directive both attached to the same `const <ident> = <expr>;`
 * declaration (see src/compiler/index.ts's asset/entity validation), which fire at
 * different points relative to that one statement rather than competing for the same
 * slot the way `@toph filter` does.
 *
 * findLeadingDirective itself is left untouched and still used as-is by the existing
 * `@toph filter`/`@toph check` code paths in validate.ts, which only ever need "the
 * first directive-shaped comment" and must keep behaving exactly as before.
 */
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
		if (result === 'malformed') {
			hits.push({ kind: 'malformed', range, text: body.trim() });
		} else {
			hits.push({ kind: 'parsed', range, directive: result });
		}
	}
	return hits;
}

/** Parsed `@toph check <code> [unit=<unit>]` arguments. */
export interface ParsedCheckArgs {
	code: string;
	unit?: string;
}

/**
 * Parses the args portion of a `@toph check` directive ("area.min unit=px2" or
 * "aspect.max"). Returns null if the args don't parse as "<code> [unit=<unit>]".
 */
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

/**
 * Parses the args portion of a `@toph filter` directive ("demo.geometry"). Returns
 * null if the args aren't exactly one whitespace-free token.
 */
export function parseFilterArgs(args: string): string | null {
	return singleToken(args);
}

/**
 * Parses the args portion of a `@toph entities` directive ("component"). Same shape as
 * `@toph filter`'s args (exactly one whitespace-free token, the entity kind name) --
 * kept as a distinct function (rather than reusing parseFilterArgs directly at call
 * sites) so each directive's own validator reads as validating its own grammar, not
 * borrowing another directive's.
 */
export function parseEntitiesArgs(args: string): string | null {
	return singleToken(args);
}

const SNAPSHOT_IDENT_RE = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

/** Parsed `@toph snapshot <assetName> kind=mask ref=<ident> width=<ident> height=<ident>` arguments. */
export interface ParsedSnapshotArgs {
	assetName: string;
	kind: 'mask';
	ref: string;
	width: string;
	height: string;
}

/**
 * Parses the args portion of a `@toph snapshot` directive. Returns null unless the args
 * are exactly five whitespace-separated tokens: `<assetName> kind=mask ref=<ident>
 * width=<ident> height=<ident>`, where each `<ident>` is a plain JS identifier (these
 * are spliced directly into generated code as expressions, so they're restricted to
 * identifier text, not arbitrary sub-expressions). `kind=mask` is currently the only
 * supported kind -- a `kind=` value other than `mask` does not parse, rather than being
 * silently accepted as some other (unimplemented) asset kind.
 */
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
