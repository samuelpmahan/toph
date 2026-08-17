// AST shape validation for `@toph filter` / `@toph check` directive sites.
//
// Supported shapes are defined exactly by IMPLEMENTATION-DECISIONS.md section 4:
//
//   @toph filter <name>
//   const <ident> = <expr>.filter((<param>) => {
//     ...zero or more check groups...
//     return true;
//   });
//
//   check group:
//     @toph check <code> [unit=<unit>]
//     const <boolIdent> = <expr> <op> <expr>;
//     if (!<boolIdent>) return false;     // braces optional
//
// Nothing here guesses at unsupported shapes -- anything that doesn't match exactly
// produces a narrow TOPH1xx diagnostic (see IMPLEMENTATION-DECISIONS.md section 4 /
// the task spec's diagnostics list) and the enclosing @toph filter site is left
// uninstrumented.

import * as ts from 'typescript';
import type { CompilerDiagnostic } from './types.js';
import { diagnosticAtNode, diagnosticAtPos } from './diagnostics.js';
import {
	findLeadingDirective,
	findLeadingDirectives,
	parseCheckArgs,
	parseEntitiesArgs,
	parseFilterArgs,
	parseSnapshotArgs,
} from './directives.js';
import type { DirectiveHit } from './directives.js';

export interface CheckGroup {
	code: string;
	unit?: string;
	/** Raw source operator text, e.g. ">=", "===". */
	operator: string;
	boolIdent: string;
	/** Original left-operand source text, evaluated exactly once at its original position. */
	leftText: string;
	/** Original right-operand source text, evaluated exactly once at its original position. */
	rightText: string;
	/** Raw source text of the "if (!x) return false;" guard, copied verbatim. */
	guardText: string;
	/** 1-indexed line of the check's `const` declaration in the original source. */
	sourceLine: number;
}

export interface ValidFilterSite {
	node: ts.Statement;
	stageName: string;
	resultIdent: string;
	/** 'declare': `const <resultIdent> = ...`. 'assign': `<resultIdent> = ...` (a plain
	 * assignment to an identifier declared earlier, e.g. ChainSpot's `let x = []; ...;
	 * x = arr.filter(...)` pattern) -- codegen must reproduce whichever binding form the
	 * original code used, not always inject `const`. */
	bindingKind: 'declare' | 'assign';
	/** Original source text of the array expression being `.filter`ed. */
	arrayExprText: string;
	/** The filter callback's single parameter name. */
	paramText: string;
	checkGroups: CheckGroup[];
	/** Raw source text of the final "return true;" statement, copied verbatim. */
	finalReturnText: string;
	/** 1-indexed line of the filter's `const` declaration in the original source. */
	sourceLine: number;
}

export type FilterSiteRecord = { valid: true; site: ValidFilterSite } | { valid: false };

export interface ValidateFileResult {
	records: FilterSiteRecord[];
	diagnostics: CompilerDiagnostic[];
}

const BINARY_OPERATOR_TEXT: Partial<Record<ts.SyntaxKind, string>> = {
	[ts.SyntaxKind.GreaterThanEqualsToken]: '>=',
	[ts.SyntaxKind.LessThanEqualsToken]: '<=',
	[ts.SyntaxKind.GreaterThanToken]: '>',
	[ts.SyntaxKind.LessThanToken]: '<',
	[ts.SyntaxKind.EqualsEqualsEqualsToken]: '===',
	[ts.SyntaxKind.EqualsEqualsToken]: '==',
	[ts.SyntaxKind.ExclamationEqualsEqualsToken]: '!==',
	[ts.SyntaxKind.ExclamationEqualsToken]: '!=',
};

function sliceNode(sourceFile: ts.SourceFile, node: ts.Node): string {
	return sourceFile.text.slice(node.getStart(sourceFile), node.getEnd());
}

function lineOf(sourceFile: ts.SourceFile, pos: number): number {
	return sourceFile.getLineAndCharacterOfPosition(pos).line + 1;
}

function unsupportedCheckExpressionMessage(code: string): string {
	// Verbatim per the task spec's required TOPH102 message template.
	return `@toph check "${code}" is attached to an unsupported expression shape. Extract the condition into a named boolean comparison or use an explicit escape hatch.`;
}

export function collectStatements(sourceFile: ts.SourceFile): ts.Statement[] {
	const out: ts.Statement[] = [];
	const visit = (node: ts.Node): void => {
		if (ts.isStatement(node)) {
			out.push(node);
		}
		node.forEachChild(visit);
	};
	sourceFile.forEachChild(visit);
	return out;
}

function validateGuard(guardStmt: ts.Statement, boolIdent: string): boolean {
	if (!ts.isIfStatement(guardStmt)) return false;
	if (guardStmt.elseStatement) return false;
	const cond = guardStmt.expression;
	if (!ts.isPrefixUnaryExpression(cond) || cond.operator !== ts.SyntaxKind.ExclamationToken) return false;
	if (!ts.isIdentifier(cond.operand) || cond.operand.text !== boolIdent) return false;

	const isReturnFalse = (s: ts.Statement): boolean =>
		ts.isReturnStatement(s) && s.expression !== undefined && s.expression.kind === ts.SyntaxKind.FalseKeyword;

	const then = guardStmt.thenStatement;
	if (isReturnFalse(then)) return true;
	if (ts.isBlock(then) && then.statements.length === 1 && isReturnFalse(then.statements[0])) return true;
	return false;
}

function validateCheckGroup(
	sourceFile: ts.SourceFile,
	declStmt: ts.Statement,
	guardStmt: ts.Statement,
	stageName: string,
	seenCodes: Set<string>,
	diagnostics: CompilerDiagnostic[]
): CheckGroup | null {
	const hit = findLeadingDirective(sourceFile, declStmt);

	if (hit === null) {
		diagnostics.push(
			diagnosticAtNode(
				'TOPH101',
				`@toph filter "${stageName}": expected a "@toph check <code>"-annotated declaration here, found an unannotated statement.`,
				sourceFile,
				declStmt
			)
		);
		return null;
	}
	if (hit.kind === 'malformed') {
		diagnostics.push(
			diagnosticAtPos(
				'TOPH105',
				`Directive comment "${hit.text}" does not parse as "@toph <verb> <args>".`,
				sourceFile,
				hit.range.pos
			)
		);
		return null;
	}
	if (hit.directive.verb !== 'check') {
		diagnostics.push(
			diagnosticAtNode(
				'TOPH101',
				`@toph filter "${stageName}": expected a "@toph check <code>" annotation here, found "@toph ${hit.directive.verb}".`,
				sourceFile,
				declStmt
			)
		);
		return null;
	}

	const parsedArgs = parseCheckArgs(hit.directive.args);
	if (parsedArgs === null) {
		diagnostics.push(
			diagnosticAtPos(
				'TOPH105',
				`Directive "@toph check ${hit.directive.args}" does not parse as "@toph check <code> [unit=<unit>]".`,
				sourceFile,
				hit.range.pos
			)
		);
		return null;
	}
	const { code, unit } = parsedArgs;

	if (seenCodes.has(code)) {
		diagnostics.push(
			diagnosticAtNode(
				'TOPH104',
				`Duplicate @toph check code "${code}" in filter stage "${stageName}".`,
				sourceFile,
				declStmt
			)
		);
		return null;
	}
	seenCodes.add(code);

	let boolIdent: string | null = null;
	let operator: string | null = null;
	let leftText: string | null = null;
	let rightText: string | null = null;

	if (ts.isVariableStatement(declStmt)) {
		const declList = declStmt.declarationList;
		if (declList.declarations.length === 1) {
			const decl = declList.declarations[0];
			if (ts.isIdentifier(decl.name)) {
				boolIdent = decl.name.text;
				const init = decl.initializer;
				if (init && ts.isBinaryExpression(init)) {
					const opText = BINARY_OPERATOR_TEXT[init.operatorToken.kind];
					if (opText) {
						operator = opText;
						leftText = sliceNode(sourceFile, init.left);
						rightText = sliceNode(sourceFile, init.right);
					}
				}
			}
		}
	}

	if (boolIdent === null || operator === null || leftText === null || rightText === null) {
		diagnostics.push(diagnosticAtNode('TOPH102', unsupportedCheckExpressionMessage(code), sourceFile, declStmt));
		return null;
	}

	if (!validateGuard(guardStmt, boolIdent)) {
		diagnostics.push(
			diagnosticAtNode(
				'TOPH103',
				`@toph check "${code}": declaration must be immediately followed by "if (!${boolIdent}) return false;".`,
				sourceFile,
				guardStmt
			)
		);
		return null;
	}

	const guardText = sliceNode(sourceFile, guardStmt);
	const sourceLine = lineOf(sourceFile, declStmt.getStart(sourceFile));

	return { code, unit, operator, boolIdent, leftText, rightText, guardText, sourceLine };
}

function validateFilterSite(
	sourceFile: ts.SourceFile,
	node: ts.Statement,
	directiveArgs: string,
	consumed: Set<ts.Node>,
	diagnostics: CompilerDiagnostic[]
): ValidFilterSite | null {
	consumed.add(node);

	const stageName = parseFilterArgs(directiveArgs);
	if (stageName === null) {
		diagnostics.push(
			diagnosticAtNode(
				'TOPH105',
				`Directive "@toph filter ${directiveArgs}" does not parse as "@toph filter <stage-name>".`,
				sourceFile,
				node
			)
		);
		return null;
	}

	const fail = (message: string): null => {
		diagnostics.push(diagnosticAtNode('TOPH101', message, sourceFile, node));
		return null;
	};
	const shapeError = `@toph filter "${stageName}" must be attached to a "const <ident> = <expr>.filter((<param>) => { ... })" statement, or a "<ident> = <expr>.filter((<param>) => { ... })" assignment to a previously-declared identifier, whose body is zero or more check groups followed by "return true;".`;

	// Two supported host-statement shapes bind `resultIdent`/`init` before the shared
	// body-shape validation below (identical for both): a fresh `const` declaration, or
	// a plain assignment to an identifier declared earlier (e.g. `let x = []; ...; x =
	// arr.filter(...)`) -- the real ChainSpot target uses the latter (a `let` seeded
	// with a default and reassigned inside a conditional block), so both are first-class,
	// not one "supported" and one "worked around."
	let resultIdent: string;
	let bindingKind: 'declare' | 'assign';
	let init: ts.Expression;

	if (ts.isVariableStatement(node)) {
		const declList = node.declarationList;
		if (declList.declarations.length !== 1) return fail(shapeError);
		const decl = declList.declarations[0];
		if (!ts.isIdentifier(decl.name)) return fail(shapeError);
		if (!decl.initializer) return fail(shapeError);
		resultIdent = decl.name.text;
		bindingKind = 'declare';
		init = decl.initializer;
	} else if (
		ts.isExpressionStatement(node) &&
		ts.isBinaryExpression(node.expression) &&
		node.expression.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
		ts.isIdentifier(node.expression.left)
	) {
		resultIdent = node.expression.left.text;
		bindingKind = 'assign';
		init = node.expression.right;
	} else {
		return fail(shapeError);
	}

	if (!ts.isCallExpression(init)) return fail(shapeError);
	if (!ts.isPropertyAccessExpression(init.expression) || init.expression.name.text !== 'filter') {
		return fail(shapeError);
	}
	const arrayExprText = sliceNode(sourceFile, init.expression.expression);

	if (init.arguments.length !== 1 || !ts.isArrowFunction(init.arguments[0])) return fail(shapeError);
	const arrow = init.arguments[0] as ts.ArrowFunction;
	if (arrow.parameters.length !== 1 || !ts.isIdentifier(arrow.parameters[0].name)) return fail(shapeError);
	const paramText = arrow.parameters[0].name.text;
	if (!ts.isBlock(arrow.body)) return fail(shapeError);

	const block = arrow.body;
	const stmts = block.statements;
	for (const s of stmts) consumed.add(s);

	if (stmts.length === 0) return fail(shapeError);
	const lastStmt = stmts[stmts.length - 1];
	if (!ts.isReturnStatement(lastStmt)) return fail(shapeError);
	if (!lastStmt.expression || lastStmt.expression.kind !== ts.SyntaxKind.TrueKeyword) return fail(shapeError);
	const finalReturnText = sliceNode(sourceFile, lastStmt);
	const sourceLine = lineOf(sourceFile, node.getStart(sourceFile));

	const bodyStmts = stmts.slice(0, -1);
	if (bodyStmts.length % 2 !== 0) return fail(shapeError);

	const checkGroups: CheckGroup[] = [];
	const seenCodes = new Set<string>();
	let siteHasErrors = false;

	for (let i = 0; i < bodyStmts.length; i += 2) {
		const group = validateCheckGroup(sourceFile, bodyStmts[i], bodyStmts[i + 1], stageName, seenCodes, diagnostics);
		if (group === null) {
			siteHasErrors = true;
		} else {
			checkGroups.push(group);
		}
	}

	if (siteHasErrors) return null;

	return { node, stageName, resultIdent, bindingKind, arrayExprText, paramText, checkGroups, finalReturnText, sourceLine };
}

/**
 * Validates every `@toph filter` / `@toph check` directive site in a parsed source
 * file. Returns one FilterSiteRecord per `@toph filter`-tagged statement found (in
 * document order) plus the full flat diagnostics list.
 *
 * Note on scope: a `@toph check` directive that is not inside the body of a
 * recognized `@toph filter` site is not independently validated or diagnosed here
 * (see the compiler's final report for why this is an intentional Phase 1
 * simplification, not an oversight).
 */
export function validateFile(sourceFile: ts.SourceFile): ValidateFileResult {
	const diagnostics: CompilerDiagnostic[] = [];
	const consumed = new Set<ts.Node>();
	const allStatements = collectStatements(sourceFile);
	const records: FilterSiteRecord[] = [];

	// Pass 1: process every @toph-filter-tagged statement, in document order. This
	// also consumes (marks handled) every statement in its body, valid or not, so
	// pass 2 doesn't re-diagnose them.
	for (const stmt of allStatements) {
		if (consumed.has(stmt)) continue;
		const hit = findLeadingDirective(sourceFile, stmt);
		if (hit === null || hit.kind === 'malformed' || hit.directive.verb !== 'filter') continue;
		const site = validateFilterSite(sourceFile, stmt, hit.directive.args, consumed, diagnostics);
		records.push(site ? { valid: true, site } : { valid: false });
	}

	// Pass 2: any statement not consumed by pass 1 whose leading comment mentions
	// "@toph" but doesn't parse as "@toph <verb> <args>" at all is TOPH105.
	for (const stmt of allStatements) {
		if (consumed.has(stmt)) continue;
		const hit = findLeadingDirective(sourceFile, stmt);
		if (hit !== null && hit.kind === 'malformed') {
			diagnostics.push(
				diagnosticAtPos(
					'TOPH105',
					`Directive comment "${hit.text}" does not parse as "@toph <verb> <args>".`,
					sourceFile,
					hit.range.pos
				)
			);
			consumed.add(stmt);
		}
	}

	return { records, diagnostics };
}

// ---------------------------------------------------------------------------------
// `@toph snapshot` / `@toph entities` directive sites.
//
// These are a separate, independent family from `@toph filter`/`@toph check` above:
// they don't replace their host statement, they WRAP it (insert a call immediately
// before and/or after, leaving the statement's own text untouched) -- see codegen.ts's
// emitWrapSite. A single statement may carry both at once (a `@toph snapshot` and a
// `@toph entities` directive on the same `const <ident> = <expr>;` declaration is the
// task's own real-target shape), which is exactly why findLeadingDirectives (plural) is
// needed here instead of findLeadingDirective. The one exception to "leaving the
// statement's own text untouched" is `ValidEntitiesMapSite` below (the `.map()`-derived
// `@toph entities` shape): its host statement's initializer genuinely has to change (the
// `.map()` receiver becomes a generated temp binding, evaluated exactly once) -- see that
// interface's doc comment and codegen.ts's emitWrapSite for why and how.
//
// Because "snapshot"/"entities" are now recognized verbs in directives.ts's DIRECTIVE_RE,
// validateFile's own TOPH105 stray-malformed-comment pass above never fires for a
// statement whose only leading comment is a well-formed `@toph snapshot`/`@toph
// entities` directive (it isn't "malformed" at the verb-parsing level) -- so there is no
// double-diagnosis between that pass and this one. An args-shape violation for either
// directive (e.g. the wrong number of tokens) is diagnosed here, as TOPH106/TOPH107
// respectively, not TOPH105 -- unlike parseFilterArgs/parseCheckArgs's failures, which
// (for historical Phase 1-4 reasons) reuse TOPH105. This phase's task spec calls for
// dedicated codes instead.
// ---------------------------------------------------------------------------------

export interface ValidSnapshotSite {
	node: ts.Statement;
	assetName: string;
	ref: string;
	width: string;
	height: string;
	/** 1-indexed line of the annotated statement in the original source. */
	sourceLine: number;
}

export type SnapshotSiteRecord = { valid: true; site: ValidSnapshotSite } | { valid: false };

/** The already-working "plain array" `@toph entities` host shape: `const <ident> =
 * <expr>;` for ANY expression -- codegen just calls spawnEntities(kindId, <ident>)
 * immediately after the statement, unmodified. */
export interface ValidEntitiesArraySite {
	shape: 'array';
	node: ts.Statement;
	kindName: string;
	/** The `const <ident>` being declared -- the array `spawnEntities` iterates. */
	resultIdent: string;
	sourceLine: number;
}

/** The `.map()`-derived `@toph entities` host shape: `const <ident> = <arrayExpr>.map((
 * <param>) => (<objectExpr>));` -- a `.map()` call whose callback takes exactly one
 * parameter and returns an object (expression body, or a block body with a single
 * `return <expr>;`). This is what lets an entity spawned from `<arrayExpr>`'s OWN
 * elements earlier in the pipeline stay linked to the brand-new object each callback
 * invocation returns, via spawnDerivedEntities's `parentId` (src/runtime/index.ts) --
 * see codegen.ts's emitWrapSite for how `receiverExprText` is evaluated into a fresh
 * generated temp binding exactly once, then used BOTH as the `.map()` receiver and as
 * spawnDerivedEntities's `parents` argument. */
export interface ValidEntitiesMapSite {
	shape: 'map';
	node: ts.Statement;
	kindName: string;
	/** The `const <ident>` being declared -- the array `spawnDerivedEntities` iterates as
	 * its `elements` argument. */
	resultIdent: string;
	/** Original source text of the `.map()` receiver expression (e.g.
	 * "sortComponents(teeComponents)") -- must be evaluated exactly once, via a generated
	 * temp binding, never re-spliced verbatim a second time. */
	receiverExprText: string;
	/** Raw source text of the ENTIRE map callback (the arrow function, parameter list
	 * through body), copied verbatim -- codegen must not alter it at all, only redirect
	 * what receiver it's `.map()`-called on. */
	callbackText: string;
	sourceLine: number;
}

export type ValidEntitiesSite = ValidEntitiesArraySite | ValidEntitiesMapSite;

export type EntitiesSiteRecord = { valid: true; site: ValidEntitiesSite } | { valid: false };

/** Unwraps any number of parenthesization layers, e.g. `((x))` -> `x`. TypeScript's AST
 * keeps ParenthesizedExpression as a real node (unlike some parsers, which discard
 * grouping parens outright) -- an object-literal arrow body like `(p) => ({ x: 1 })`
 * MUST be parenthesized (bare `{` would parse as a block), so this unwrap is required to
 * see the ObjectLiteralExpression underneath. */
function unwrapParens(expr: ts.Expression): ts.Expression {
	let e = expr;
	while (ts.isParenthesizedExpression(e)) e = e.expression;
	return e;
}

/** Extracts the expression a `.map()` callback's body evaluates to, supporting both
 * forms the task allows: a bare expression body (`(p) => (<expr>)`) or a block body
 * whose ONLY statement is `return <expr>;`. Returns null for anything else (an empty
 * block, more than one statement, a bare `return;` with no expression, ...) -- callers
 * treat null as "doesn't qualify for the map shape," not as a shape to guess at. */
function extractMapCallbackReturnExpr(arrow: ts.ArrowFunction): ts.Expression | null {
	if (!ts.isBlock(arrow.body)) return unwrapParens(arrow.body);
	const stmts = arrow.body.statements;
	if (stmts.length !== 1) return null;
	const [stmt] = stmts;
	if (!ts.isReturnStatement(stmt) || !stmt.expression) return null;
	return unwrapParens(stmt.expression);
}

export interface ValidateAssetsAndEntitiesResult {
	snapshotRecords: SnapshotSiteRecord[];
	entitiesRecords: EntitiesSiteRecord[];
	diagnostics: CompilerDiagnostic[];
}

function validateSnapshotSite(
	sourceFile: ts.SourceFile,
	node: ts.Statement,
	hit: DirectiveHit,
	diagnostics: CompilerDiagnostic[]
): ValidSnapshotSite | null {
	const parsed = parseSnapshotArgs(hit.directive.args);
	if (parsed === null) {
		diagnostics.push(
			diagnosticAtPos(
				'TOPH106',
				`Directive "@toph snapshot ${hit.directive.args}" does not parse as "@toph snapshot <assetName> kind=mask ref=<ident> width=<ident> height=<ident>".`,
				sourceFile,
				hit.range.pos
			)
		);
		return null;
	}

	const sourceLine = lineOf(sourceFile, node.getStart(sourceFile));
	return { node, assetName: parsed.assetName, ref: parsed.ref, width: parsed.width, height: parsed.height, sourceLine };
}

function validateEntitiesSite(
	sourceFile: ts.SourceFile,
	node: ts.Statement,
	hit: DirectiveHit,
	diagnostics: CompilerDiagnostic[]
): ValidEntitiesSite | null {
	const kindName = parseEntitiesArgs(hit.directive.args);
	if (kindName === null) {
		diagnostics.push(
			diagnosticAtPos(
				'TOPH107',
				`Directive "@toph entities ${hit.directive.args}" does not parse as "@toph entities <kind>".`,
				sourceFile,
				hit.range.pos
			)
		);
		return null;
	}

	// Verbatim-mentions-both-shapes message per the task spec -- every TOPH107 this
	// function raises below reuses it, so whichever shape an author was reaching for, the
	// error tells them what both supported shapes actually look like.
	const shapeError = `@toph entities "${kindName}" must be attached to either a "const <ident> = <expr>;" statement, or a "const <ident> = <arrayExpr>.map((<param>) => (<objectExpr>));" statement whose callback takes exactly one parameter and returns an object.`;
	const fail = (): null => {
		diagnostics.push(diagnosticAtNode('TOPH107', shapeError, sourceFile, node));
		return null;
	};

	if (!ts.isVariableStatement(node)) return fail();
	const declList = node.declarationList;
	if (!(declList.flags & ts.NodeFlags.Const) || declList.declarations.length !== 1) return fail();
	const decl = declList.declarations[0];
	if (!ts.isIdentifier(decl.name) || !decl.initializer) return fail();

	const resultIdent = decl.name.text;
	const sourceLine = lineOf(sourceFile, node.getStart(sourceFile));
	const init = decl.initializer;

	// A `.map()` call as the initializer is unambiguously an attempt at the derived-entity
	// shape -- once the initializer is recognized as a `.map()` call, it must fully
	// conform (exactly one parameter, object-returning body) or it's TOPH107; it never
	// silently falls back to the plain-array shape below, which would spawn entities from
	// the map's OUTPUT with no parent link at all -- a shape that looks like it was
	// reaching for identity-preservation and would otherwise silently not get it.
	if (ts.isCallExpression(init) && ts.isPropertyAccessExpression(init.expression) && init.expression.name.text === 'map') {
		if (init.arguments.length !== 1 || !ts.isArrowFunction(init.arguments[0])) return fail();
		const arrow = init.arguments[0] as ts.ArrowFunction;
		if (arrow.parameters.length !== 1 || !ts.isIdentifier(arrow.parameters[0].name)) return fail();

		const returnExpr = extractMapCallbackReturnExpr(arrow);
		if (returnExpr === null || !ts.isObjectLiteralExpression(returnExpr)) return fail();

		const receiverExprText = sliceNode(sourceFile, init.expression.expression);
		const callbackText = sliceNode(sourceFile, arrow);
		return { shape: 'map', node, kindName, resultIdent, receiverExprText, callbackText, sourceLine };
	}

	return { shape: 'array', node, kindName, resultIdent, sourceLine };
}

/**
 * Validates every `@toph snapshot` / `@toph entities` directive site in a parsed source
 * file, independent of (and in addition to) validateFile's `@toph filter`/`@toph check`
 * handling above. Scans every statement in the file (not just top-level ones, mirroring
 * validateFile's own collectStatements traversal) since the real target shape these
 * directives exist for lives inside a function body, not at module top level.
 */
export function validateAssetsAndEntities(sourceFile: ts.SourceFile): ValidateAssetsAndEntitiesResult {
	const diagnostics: CompilerDiagnostic[] = [];
	const snapshotRecords: SnapshotSiteRecord[] = [];
	const entitiesRecords: EntitiesSiteRecord[] = [];
	const allStatements = collectStatements(sourceFile);

	for (const stmt of allStatements) {
		const hits = findLeadingDirectives(sourceFile, stmt);
		for (const hit of hits) {
			if (hit.kind !== 'parsed') continue;
			if (hit.directive.verb === 'snapshot') {
				const site = validateSnapshotSite(sourceFile, stmt, hit, diagnostics);
				snapshotRecords.push(site ? { valid: true, site } : { valid: false });
			} else if (hit.directive.verb === 'entities') {
				const site = validateEntitiesSite(sourceFile, stmt, hit, diagnostics);
				entitiesRecords.push(site ? { valid: true, site } : { valid: false });
			}
		}
	}

	return { snapshotRecords, entitiesRecords, diagnostics };
}
