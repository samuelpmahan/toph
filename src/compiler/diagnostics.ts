import * as ts from 'typescript';
import type { CompilerDiagnostic } from './types.js';

function locationOf(sourceFile: ts.SourceFile, pos: number): { line: number; column: number } {
	const { line, character } = sourceFile.getLineAndCharacterOfPosition(pos);
	return { line: line + 1, column: character + 1 };
}

export function diagnosticAtPos(
	code: string,
	message: string,
	sourceFile: ts.SourceFile,
	pos: number
): CompilerDiagnostic {
	const { line, column } = locationOf(sourceFile, pos);
	return { code, message, file: sourceFile.fileName, line, column };
}

export function diagnosticAtNode(
	code: string,
	message: string,
	sourceFile: ts.SourceFile,
	node: ts.Node
): CompilerDiagnostic {
	return diagnosticAtPos(code, message, sourceFile, node.getStart(sourceFile));
}
