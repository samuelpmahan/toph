// Item 9: production-residue audit, done honestly.
//
// compileProduction's `code` being byte-identical to the input (still containing the
// literal "@toph" comment text) is NOT a bug -- directives are inert comments, and a
// real build always strips comments before shipping. The actual claim to verify is
// about what survives to a REAL build output: run compileProduction's validated code
// through ts.transpileModule({removeComments:true}) (simulating a real downstream
// tsc/bundler build) and diff it against a hand-written zero-@toph equivalent. They
// must be identical. Separately, grep the RAW (pre-strip) compileProduction output and
// prove every "toph" occurrence lives inside a comment span -- never in a string
// literal, import, or identifier that would survive comment-stripping.

import { readFileSync } from 'node:fs';
import * as ts from 'typescript';
import { describe, expect, it } from 'vitest';
import { compileProduction } from '../../src/compiler/index.js';

const transpileOpts: ts.TranspileOptions = {
	compilerOptions: {
		module: ts.ModuleKind.ESNext,
		target: ts.ScriptTarget.ES2022,
		removeComments: true,
	},
};

/**
 * Returns every [start, end) span in `sourceText` occupied by a comment (single-line
 * or multi-line), found via the real TS scanner in non-trivia-skipping mode -- i.e.
 * the same tokenizer the compiler itself is built on, not a hand-rolled regex that
 * might disagree with it about what counts as a comment.
 */
function findCommentSpans(sourceText: string): Array<[number, number]> {
	const scanner = ts.createScanner(ts.ScriptTarget.ES2022, /* skipTrivia */ false);
	scanner.setText(sourceText);
	const spans: Array<[number, number]> = [];
	let kind = scanner.scan();
	while (kind !== ts.SyntaxKind.EndOfFileToken) {
		if (kind === ts.SyntaxKind.SingleLineCommentTrivia || kind === ts.SyntaxKind.MultiLineCommentTrivia) {
			spans.push([scanner.getTokenStart(), scanner.getTokenEnd()]);
		}
		kind = scanner.scan();
	}
	return spans;
}

function assertAllOccurrencesInComments(sourceText: string, needle: RegExp): void {
	const spans = findCommentSpans(sourceText);
	const offenders: number[] = [];
	const re = new RegExp(needle.source, needle.flags.includes('g') ? needle.flags : needle.flags + 'g');
	let match: RegExpExecArray | null;
	while ((match = re.exec(sourceText)) !== null) {
		const idx = match.index;
		const inComment = spans.some(([start, end]) => idx >= start && idx < end);
		if (!inComment) offenders.push(idx);
		if (match[0].length === 0) re.lastIndex++; // guard against zero-length matches looping forever
	}
	expect(offenders, `found "${needle}" outside any comment at offsets: ${offenders.join(', ')}`).toEqual([]);
}

describe('production build residue: comment-stripped output matches a hand-written unannotated equivalent', () => {
	it('demo-geometry.ts (real committed fixture): comment-stripped compileProduction output === comment-stripped hand-written equivalent', () => {
		const fixturePath = new URL('../compiler/fixtures/demo-geometry.ts', import.meta.url);
		const annotatedSource = readFileSync(fixturePath, 'utf8');

		const result = compileProduction(fixturePath.pathname, annotatedSource);
		expect(result.diagnostics).toEqual([]);
		expect(result.code).toBe(annotatedSource); // the documented (non-)claim, restated

		// Derive the hand-written control by mechanically deleting the two @toph
		// directive-comment LINES (comment + its own newline) -- guarantees the two
		// sources are identical outside the directive comments themselves, so any
		// remaining diff after comment-stripping is attributable only to the compiler's
		// (absence of) transformation, not to an accidental typo between two independently
		// hand-typed fixtures.
		const handWritten = annotatedSource.replace(/^[ \t]*\/\*\*\s*@toph[^\n]*\*\/\n/gm, '');
		expect(handWritten).not.toContain('@toph');

		const strippedProduction = ts.transpileModule(result.code, transpileOpts).outputText;
		const strippedHandWritten = ts.transpileModule(handWritten, transpileOpts).outputText;

		expect(strippedProduction).toBe(strippedHandWritten);
	});

	it('a synthetic fixture with multiple directive styles (single-line // and block /** */) also strips identically', () => {
		const annotatedSource = [
			'export interface Component { area: number; aspect: number; }',
			'export const components: Component[] = [{ area: 5, aspect: 1 }];',
			'export const minArea = 1;',
			'export const maxAspect = 2;',
			'',
			'// @toph filter demo.mixed',
			'const survivors = components.filter((component) => {',
			'  /** @toph check area.min */',
			'  const areaOk = component.area >= minArea;',
			'  if (!areaOk) return false;',
			'  // @toph check aspect.max',
			'  const aspectOk = component.aspect <= maxAspect;',
			'  if (!aspectOk) return false;',
			'  return true;',
			'});',
			'',
			'export { survivors };',
			'',
		].join('\n');

		const result = compileProduction('mixed.ts', annotatedSource);
		expect(result.diagnostics).toEqual([]);

		const handWritten = annotatedSource
			.replace(/^[ \t]*\/\/\s*@toph[^\n]*\n/gm, '')
			.replace(/^[ \t]*\/\*\*\s*@toph[^\n]*\*\/\n/gm, '');
		expect(handWritten).not.toContain('@toph');

		const strippedProduction = ts.transpileModule(result.code, transpileOpts).outputText;
		const strippedHandWritten = ts.transpileModule(handWritten, transpileOpts).outputText;
		expect(strippedProduction).toBe(strippedHandWritten);
	});
});

describe('raw compileProduction output: every "toph" occurrence lives inside a comment', () => {
	it('demo-geometry.ts: no "toph" substring survives outside a comment span', () => {
		const fixturePath = new URL('../compiler/fixtures/demo-geometry.ts', import.meta.url);
		const annotatedSource = readFileSync(fixturePath, 'utf8');
		const result = compileProduction(fixturePath.pathname, annotatedSource);
		assertAllOccurrencesInComments(result.code, /toph/gi);
	});

	it('a fixture with a decoy identifier containing "toph" as a substring OUTSIDE any comment, in code that has NOTHING to do with the compiler, is correctly flagged by the detector itself', () => {
		// Meta-check: prove the detector used above can actually catch a real violation
		// (isn't vacuously true because comment spans cover the whole file, or because the
		// regex never matches). This fixture is deliberately NOT run through
		// compileProduction -- it stands alone to validate the assertion helper only.
		const decoySource = [
			'export const tophDebugFlag = true; // not a real toph API, just a decoy name',
			'',
		].join('\n');
		expect(() => assertAllOccurrencesInComments(decoySource, /toph/gi)).toThrow(/found "\/toph\/gi" outside any comment/);
	});

	it('a synthetic multi-directive fixture: no "toph" substring survives outside a comment span', () => {
		const source = [
			'export interface Component { area: number; }',
			'export const components: Component[] = [{ area: 5 }];',
			'export const minArea = 1;',
			'',
			'/** @toph filter demo.residue */',
			'const survivors = components.filter((component) => {',
			'  /** @toph check area.min unit=px2 */',
			'  const areaOk = component.area >= minArea;',
			'  if (!areaOk) return false;',
			'  return true;',
			'});',
			'',
			'export { survivors };',
			'',
		].join('\n');
		const result = compileProduction('residue.ts', source);
		expect(result.diagnostics).toEqual([]);
		assertAllOccurrencesInComments(result.code, /toph/gi);
	});
});
