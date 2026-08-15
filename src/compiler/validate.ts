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
import { findLeadingDirective, parseCheckArgs, parseFilterArgs } from './directives.js';

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

function collectStatements(sourceFile: ts.SourceFile): ts.Statement[] {
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
	const shapeError = `@toph filter "${stageName}" must be attached to a "const <ident> = <expr>.filter((<param>) => { ... })" statement whose body is zero or more check groups followed by "return true;".`;

	if (!ts.isVariableStatement(node)) return fail(shapeError);
	const declList = node.declarationList;
	if (declList.declarations.length !== 1) return fail(shapeError);
	const decl = declList.declarations[0];
	if (!ts.isIdentifier(decl.name)) return fail(shapeError);
	const resultIdent = decl.name.text;

	const init = decl.initializer;
	if (!init || !ts.isCallExpression(init)) return fail(shapeError);
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

	return { node, stageName, resultIdent, arrayExprText, paramText, checkGroups, finalReturnText, sourceLine };
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
