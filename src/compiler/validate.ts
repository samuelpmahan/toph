// AST-shape validation for Toph directive sites. The compiler stays deliberately
// narrow: unsupported syntax is diagnosed rather than guessed at.

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
	operator: string;
	boolIdent: string;
	leftText: string;
	rightText: string;
	guardText: string;
	sourceLine: number;
}

export interface ValidFilterSite {
	node: ts.Statement;
	stageName: string;
	family?: string;
	resultIdent: string;
	bindingKind: 'declare' | 'assign';
	arrayExprText: string;
	paramText: string;
	checkGroups: CheckGroup[];
	finalReturnText: string;
	sourceLine: number;
}

export type FilterSiteRecord = { valid: true; site: ValidFilterSite } | { valid: false };
export interface ValidateFileResult { records: FilterSiteRecord[]; diagnostics: CompilerDiagnostic[]; }

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

function sliceNode(sourceFile: ts.SourceFile, node: ts.Node): string { return sourceFile.text.slice(node.getStart(sourceFile), node.getEnd()); }
function lineOf(sourceFile: ts.SourceFile, pos: number): number { return sourceFile.getLineAndCharacterOfPosition(pos).line + 1; }
function unsupportedCheckExpressionMessage(code: string): string { return `@toph check "${code}" is attached to an unsupported expression shape. Extract the condition into a named boolean comparison or use an explicit escape hatch.`; }

export function collectStatements(sourceFile: ts.SourceFile): ts.Statement[] {
	const out: ts.Statement[] = [];
	const visit = (node: ts.Node): void => { if (ts.isStatement(node)) out.push(node); node.forEachChild(visit); };
	sourceFile.forEachChild(visit);
	return out;
}

function validateGuard(guardStmt: ts.Statement, boolIdent: string): boolean {
	if (!ts.isIfStatement(guardStmt) || guardStmt.elseStatement) return false;
	const cond = guardStmt.expression;
	if (!ts.isPrefixUnaryExpression(cond) || cond.operator !== ts.SyntaxKind.ExclamationToken) return false;
	if (!ts.isIdentifier(cond.operand) || cond.operand.text !== boolIdent) return false;
	const isReturnFalse = (s: ts.Statement): boolean => ts.isReturnStatement(s) && s.expression !== undefined && s.expression.kind === ts.SyntaxKind.FalseKeyword;
	const then = guardStmt.thenStatement;
	return isReturnFalse(then) || (ts.isBlock(then) && then.statements.length === 1 && isReturnFalse(then.statements[0]));
}

function validateCheckGroup(sourceFile: ts.SourceFile, declStmt: ts.Statement, guardStmt: ts.Statement, stageName: string, seenCodes: Set<string>, diagnostics: CompilerDiagnostic[]): CheckGroup | null {
	const hit = findLeadingDirective(sourceFile, declStmt);
	if (hit === null) { diagnostics.push(diagnosticAtNode('TOPH101', `@toph filter "${stageName}": expected a "@toph check <code>"-annotated declaration here, found an unannotated statement.`, sourceFile, declStmt)); return null; }
	if (hit.kind === 'malformed') { diagnostics.push(diagnosticAtPos('TOPH105', `Directive comment "${hit.text}" does not parse as "@toph <verb> <args>".`, sourceFile, hit.range.pos)); return null; }
	if (hit.directive.verb !== 'check') { diagnostics.push(diagnosticAtNode('TOPH101', `@toph filter "${stageName}": expected a "@toph check <code>" annotation here, found "@toph ${hit.directive.verb}".`, sourceFile, declStmt)); return null; }
	const parsedArgs = parseCheckArgs(hit.directive.args);
	if (parsedArgs === null) { diagnostics.push(diagnosticAtPos('TOPH105', `Directive "@toph check ${hit.directive.args}" does not parse as "@toph check <code> [unit=<unit>]".`, sourceFile, hit.range.pos)); return null; }
	const { code, unit } = parsedArgs;
	if (seenCodes.has(code)) { diagnostics.push(diagnosticAtNode('TOPH104', `Duplicate @toph check code "${code}" in filter stage "${stageName}".`, sourceFile, declStmt)); return null; }
	seenCodes.add(code);
	if (!ts.isVariableStatement(declStmt) || declStmt.declarationList.declarations.length !== 1) { diagnostics.push(diagnosticAtNode('TOPH102', unsupportedCheckExpressionMessage(code), sourceFile, declStmt)); return null; }
	const decl = declStmt.declarationList.declarations[0];
	if (!ts.isIdentifier(decl.name) || !decl.initializer || !ts.isBinaryExpression(decl.initializer)) { diagnostics.push(diagnosticAtNode('TOPH102', unsupportedCheckExpressionMessage(code), sourceFile, declStmt)); return null; }
	const operator = BINARY_OPERATOR_TEXT[decl.initializer.operatorToken.kind];
	if (!operator) { diagnostics.push(diagnosticAtNode('TOPH102', unsupportedCheckExpressionMessage(code), sourceFile, declStmt)); return null; }
	const boolIdent = decl.name.text;
	if (!validateGuard(guardStmt, boolIdent)) { diagnostics.push(diagnosticAtNode('TOPH103', `@toph check "${code}": declaration must be immediately followed by "if (!${boolIdent}) return false;".`, sourceFile, guardStmt)); return null; }
	return { code, unit, operator, boolIdent, leftText: sliceNode(sourceFile, decl.initializer.left), rightText: sliceNode(sourceFile, decl.initializer.right), guardText: sliceNode(sourceFile, guardStmt), sourceLine: lineOf(sourceFile, declStmt.getStart(sourceFile)) };
}

function validateFilterSite(sourceFile: ts.SourceFile, node: ts.Statement, directiveArgs: string, consumed: Set<ts.Node>, diagnostics: CompilerDiagnostic[]): ValidFilterSite | null {
	consumed.add(node);
	const parsedFilter = parseFilterArgs(directiveArgs);
	if (parsedFilter === null) { diagnostics.push(diagnosticAtNode('TOPH105', `Directive "@toph filter ${directiveArgs}" does not parse as "@toph filter <stage-name> [family=<family>]".`, sourceFile, node)); return null; }
	const { stageName, family } = parsedFilter;
	const fail = (message: string): null => { diagnostics.push(diagnosticAtNode('TOPH101', message, sourceFile, node)); return null; };
	const shapeError = `@toph filter "${stageName}" must be attached to a "const <ident> = <expr>.filter((<param>) => { ... })" statement, or a "<ident> = <expr>.filter((<param>) => { ... })" assignment to a previously-declared identifier, whose body is zero or more check groups followed by "return true;".`;
	let resultIdent: string; let bindingKind: 'declare' | 'assign'; let init: ts.Expression;
	if (ts.isVariableStatement(node)) {
		if (node.declarationList.declarations.length !== 1) return fail(shapeError);
		const decl = node.declarationList.declarations[0];
		if (!ts.isIdentifier(decl.name) || !decl.initializer) return fail(shapeError);
		resultIdent = decl.name.text; bindingKind = 'declare'; init = decl.initializer;
	} else if (ts.isExpressionStatement(node) && ts.isBinaryExpression(node.expression) && node.expression.operatorToken.kind === ts.SyntaxKind.EqualsToken && ts.isIdentifier(node.expression.left)) {
		resultIdent = node.expression.left.text; bindingKind = 'assign'; init = node.expression.right;
	} else return fail(shapeError);
	if (!ts.isCallExpression(init) || !ts.isPropertyAccessExpression(init.expression) || init.expression.name.text !== 'filter') return fail(shapeError);
	const arrayExprText = sliceNode(sourceFile, init.expression.expression);
	if (init.arguments.length !== 1 || !ts.isArrowFunction(init.arguments[0])) return fail(shapeError);
	const arrow = init.arguments[0];
	if (arrow.parameters.length !== 1 || !ts.isIdentifier(arrow.parameters[0].name) || !ts.isBlock(arrow.body)) return fail(shapeError);
	const paramText = arrow.parameters[0].name.text;
	const stmts = arrow.body.statements; for (const s of stmts) consumed.add(s);
	if (stmts.length === 0) return fail(shapeError);
	const lastStmt = stmts[stmts.length - 1];
	if (!ts.isReturnStatement(lastStmt) || !lastStmt.expression || lastStmt.expression.kind !== ts.SyntaxKind.TrueKeyword) return fail(shapeError);
	const bodyStmts = stmts.slice(0, -1); if (bodyStmts.length % 2 !== 0) return fail(shapeError);
	const checkGroups: CheckGroup[] = []; const seenCodes = new Set<string>(); let siteHasErrors = false;
	for (let i = 0; i < bodyStmts.length; i += 2) { const group = validateCheckGroup(sourceFile, bodyStmts[i], bodyStmts[i + 1], stageName, seenCodes, diagnostics); if (group === null) siteHasErrors = true; else checkGroups.push(group); }
	if (siteHasErrors) return null;
	return { node, stageName, family, resultIdent, bindingKind, arrayExprText, paramText, checkGroups, finalReturnText: sliceNode(sourceFile, lastStmt), sourceLine: lineOf(sourceFile, node.getStart(sourceFile)) };
}

export function validateFile(sourceFile: ts.SourceFile): ValidateFileResult {
	const diagnostics: CompilerDiagnostic[] = []; const consumed = new Set<ts.Node>(); const allStatements = collectStatements(sourceFile); const records: FilterSiteRecord[] = [];
	for (const stmt of allStatements) { if (consumed.has(stmt)) continue; const hit = findLeadingDirective(sourceFile, stmt); if (hit === null || hit.kind === 'malformed' || hit.directive.verb !== 'filter') continue; const site = validateFilterSite(sourceFile, stmt, hit.directive.args, consumed, diagnostics); records.push(site ? { valid: true, site } : { valid: false }); }
	for (const stmt of allStatements) { if (consumed.has(stmt)) continue; const hit = findLeadingDirective(sourceFile, stmt); if (hit !== null && hit.kind === 'malformed') { diagnostics.push(diagnosticAtPos('TOPH105', `Directive comment "${hit.text}" does not parse as "@toph <verb> <args>".`, sourceFile, hit.range.pos)); consumed.add(stmt); } }
	return { records, diagnostics };
}

export interface ValidSnapshotSite { node: ts.Statement; assetName: string; ref: string; width: string; height: string; sourceLine: number; }
export type SnapshotSiteRecord = { valid: true; site: ValidSnapshotSite } | { valid: false };
export interface ValidEntitiesArraySite { shape: 'array'; node: ts.Statement; kindName: string; resultIdent: string; sourceLine: number; }
export interface ValidEntitiesMapSite { shape: 'map'; node: ts.Statement; kindName: string; resultIdent: string; receiverExprText: string; callbackText: string; sourceLine: number; }
export type ValidEntitiesSite = ValidEntitiesArraySite | ValidEntitiesMapSite;
export type EntitiesSiteRecord = { valid: true; site: ValidEntitiesSite } | { valid: false };

function unwrapParens(expr: ts.Expression): ts.Expression { let e = expr; while (ts.isParenthesizedExpression(e)) e = e.expression; return e; }
function extractMapCallbackReturnExpr(arrow: ts.ArrowFunction): ts.Expression | null { if (!ts.isBlock(arrow.body)) return unwrapParens(arrow.body); if (arrow.body.statements.length !== 1) return null; const stmt = arrow.body.statements[0]; if (!ts.isReturnStatement(stmt) || !stmt.expression) return null; return unwrapParens(stmt.expression); }
export interface ValidateAssetsAndEntitiesResult { snapshotRecords: SnapshotSiteRecord[]; entitiesRecords: EntitiesSiteRecord[]; diagnostics: CompilerDiagnostic[]; }

function validateSnapshotSite(sourceFile: ts.SourceFile, node: ts.Statement, hit: DirectiveHit, diagnostics: CompilerDiagnostic[]): ValidSnapshotSite | null {
	const parsed = parseSnapshotArgs(hit.directive.args); if (parsed === null) { diagnostics.push(diagnosticAtPos('TOPH106', `Directive "@toph snapshot ${hit.directive.args}" does not parse as "@toph snapshot <assetName> kind=mask ref=<ident> width=<ident> height=<ident>".`, sourceFile, hit.range.pos)); return null; }
	return { node, assetName: parsed.assetName, ref: parsed.ref, width: parsed.width, height: parsed.height, sourceLine: lineOf(sourceFile, node.getStart(sourceFile)) };
}

function validateEntitiesSite(sourceFile: ts.SourceFile, node: ts.Statement, hit: DirectiveHit, diagnostics: CompilerDiagnostic[]): ValidEntitiesSite | null {
	const kindName = parseEntitiesArgs(hit.directive.args); if (kindName === null) { diagnostics.push(diagnosticAtPos('TOPH107', `Directive "@toph entities ${hit.directive.args}" does not parse as "@toph entities <kind>".`, sourceFile, hit.range.pos)); return null; }
	const shapeError = `@toph entities "${kindName}" must be attached to either a "const <ident> = <expr>;" statement, or a "const <ident> = <arrayExpr>.map((<param>) => (<objectExpr>));" statement whose callback takes exactly one parameter and returns an object.`;
	const fail = (): null => { diagnostics.push(diagnosticAtNode('TOPH107', shapeError, sourceFile, node)); return null; };
	if (!ts.isVariableStatement(node)) return fail(); const declList = node.declarationList; if (!(declList.flags & ts.NodeFlags.Const) || declList.declarations.length !== 1) return fail(); const decl = declList.declarations[0]; if (!ts.isIdentifier(decl.name) || !decl.initializer) return fail();
	const resultIdent = decl.name.text; const sourceLine = lineOf(sourceFile, node.getStart(sourceFile)); const init = decl.initializer;
	if (ts.isCallExpression(init) && ts.isPropertyAccessExpression(init.expression) && init.expression.name.text === 'map') { if (init.arguments.length !== 1 || !ts.isArrowFunction(init.arguments[0])) return fail(); const arrow = init.arguments[0]; if (arrow.parameters.length !== 1 || !ts.isIdentifier(arrow.parameters[0].name)) return fail(); const returnExpr = extractMapCallbackReturnExpr(arrow); if (returnExpr === null || !ts.isObjectLiteralExpression(returnExpr)) return fail(); return { shape: 'map', node, kindName, resultIdent, receiverExprText: sliceNode(sourceFile, init.expression.expression), callbackText: sliceNode(sourceFile, arrow), sourceLine }; }
	return { shape: 'array', node, kindName, resultIdent, sourceLine };
}

export function validateAssetsAndEntities(sourceFile: ts.SourceFile): ValidateAssetsAndEntitiesResult {
	const diagnostics: CompilerDiagnostic[] = []; const snapshotRecords: SnapshotSiteRecord[] = []; const entitiesRecords: EntitiesSiteRecord[] = [];
	for (const stmt of collectStatements(sourceFile)) for (const hit of findLeadingDirectives(sourceFile, stmt)) { if (hit.kind !== 'parsed') continue; if (hit.directive.verb === 'snapshot') { const site = validateSnapshotSite(sourceFile, stmt, hit, diagnostics); snapshotRecords.push(site ? { valid: true, site } : { valid: false }); } else if (hit.directive.verb === 'entities') { const site = validateEntitiesSite(sourceFile, stmt, hit, diagnostics); entitiesRecords.push(site ? { valid: true, site } : { valid: false }); } }
	return { snapshotRecords, entitiesRecords, diagnostics };
}