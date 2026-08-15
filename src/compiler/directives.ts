// Directive comment parsing.
//
// Per IMPLEMENTATION-DECISIONS.md section 2: directives are matched against raw
// leading-comment text via ts.getLeadingCommentRanges, NOT via ts.getJSDocTags --
// @toph is not a tag TypeScript's own JSDoc parser recognizes or associates with
// arbitrary statements.

import * as ts from 'typescript';

export type DirectiveVerb = 'filter' | 'check';

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

const DIRECTIVE_RE = /^\s*\*?\s*@toph\s+(filter|check)\b(.*)$/m;

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

/**
 * Parses the args portion of a `@toph filter` directive ("demo.geometry"). Returns
 * null if the args aren't exactly one whitespace-free token.
 */
export function parseFilterArgs(args: string): string | null {
	const tokens = args.split(/\s+/).filter((t) => t.length > 0);
	if (tokens.length !== 1) return null;
	return tokens[0];
}
