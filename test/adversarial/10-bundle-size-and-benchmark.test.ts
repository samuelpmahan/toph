// Item 10: bundle-size and benchmark, on a synthetic fixture large enough to be
// measurable (60,000 synthetic elements, 3 checks). The filter logic lives inside an
// exported `runOnce()` function so it can be invoked repeatedly for stable timing
// without re-importing (paying module-instantiation cost) on every iteration.
//
// (a) size of the comment-stripped production output vs. a hand-written unannotated
//     equivalent -- expect byte-identical (they compile to literally the same
//     erasure), reported honestly either way.
// (b) wall-clock execution time of the production-compiled version vs. the
//     hand-written baseline, over enough iterations for a stable measurement --
//     expect statistically indistinguishable (same code post-erasure), measured for
//     real and reported with actual numbers.

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import * as ts from 'typescript';
import { describe, expect, it } from 'vitest';
import { compileProduction } from '../../src/compiler/index.js';

const N = 60_000;
const WARMUP_ROUNDS = 30;
const TIMED_ROUNDS = 300;

const transpileOpts: ts.TranspileOptions = {
	compilerOptions: {
		module: ts.ModuleKind.ESNext,
		target: ts.ScriptTarget.ES2022,
		removeComments: true,
	},
};

function buildAnnotatedSource(n: number): string {
	return [
		'export interface Component { area: number; aspect: number; count: number; }',
		'',
		'function makeData(n: number): Component[] {',
		'  return Array.from({ length: n }, (_, i) => ({',
		'    area: (i % 500) + 1,',
		'    aspect: (i % 10) / 5,',
		'    count: i % 3,',
		'  }));',
		'}',
		'',
		`export const components: Component[] = makeData(${n});`,
		'export const minArea = 100;',
		'export const maxAspect = 1.4;',
		'export const minCount = 1;',
		'',
		'export function runOnce(): number {',
		'  /** @toph filter perf.bench */',
		'  const survivors = components.filter((component) => {',
		'    /** @toph check area.min */',
		'    const areaOk = component.area >= minArea;',
		'    if (!areaOk) return false;',
		'    /** @toph check aspect.max */',
		'    const aspectOk = component.aspect <= maxAspect;',
		'    if (!aspectOk) return false;',
		'    /** @toph check count.min */',
		'    const countOk = component.count >= minCount;',
		'    if (!countOk) return false;',
		'    return true;',
		'  });',
		'  return survivors.length;',
		'}',
		'',
	].join('\n');
}

function stripDirectiveComments(source: string): string {
	const handWritten = source.replace(/^[ \t]*\/\*\*\s*@toph[^\n]*\*\/\n/gm, '');
	if (handWritten.includes('@toph')) {
		throw new Error('stripDirectiveComments left an @toph comment behind -- fixture/regex mismatch');
	}
	return handWritten;
}

async function loadRunOnce(jsSource: string, tag: string): Promise<() => number> {
	const dir = mkdtempSync(join(tmpdir(), `toph-bench-${tag}-`));
	const file = join(dir, 'mod.mjs');
	writeFileSync(file, jsSource, 'utf8');
	const mod = (await import(/* @vite-ignore */ pathToFileURL(file).href)) as { runOnce: () => number };
	return mod.runOnce;
}

function timeCallsMs(fn: () => number, rounds: number): number[] {
	const times: number[] = [];
	for (let i = 0; i < rounds; i++) {
		const start = performance.now();
		fn();
		times.push(performance.now() - start);
	}
	return times;
}

function summarize(samples: number[]): { totalMs: number; meanMs: number; medianMs: number } {
	const sorted = [...samples].sort((a, b) => a - b);
	const totalMs = samples.reduce((a, b) => a + b, 0);
	const meanMs = totalMs / samples.length;
	const medianMs = sorted[Math.floor(sorted.length / 2)];
	return { totalMs, meanMs, medianMs };
}

describe('production-mode erasure at scale: 60,000 elements, 3 checks', () => {
	it('correctness: production-erased code and hand-written code agree on the survivor count', async () => {
		const annotatedSource = buildAnnotatedSource(N);
		const result = compileProduction('perf.ts', annotatedSource);
		expect(result.diagnostics).toEqual([]);
		expect(result.code).toBe(annotatedSource);

		const handWrittenSource = stripDirectiveComments(annotatedSource);
		const strippedProduction = ts.transpileModule(result.code, transpileOpts).outputText;
		const strippedHandWritten = ts.transpileModule(handWrittenSource, transpileOpts).outputText;

		const runOnceProd = await loadRunOnce(strippedProduction, 'prod-correctness');
		const runOnceHand = await loadRunOnce(strippedHandWritten, 'hand-correctness');
		const countProd = runOnceProd();
		const countHand = runOnceHand();

		// Ground truth, computed independently in the test (not via either compiled path).
		const expectedCount = Array.from({ length: N }, (_, i) => ({
			area: (i % 500) + 1,
			aspect: (i % 10) / 5,
			count: i % 3,
		})).filter((c) => c.area >= 100 && c.aspect <= 1.4 && c.count >= 1).length;

		expect(countProd).toBe(expectedCount);
		expect(countHand).toBe(expectedCount);
		expect(countProd).toBe(countHand);
		expect(countProd).toBeGreaterThan(0); // sanity: the check gates actually filter something
		expect(countProd).toBeLessThan(N); // sanity: not a no-op filter either
	});

	it('(a) size: comment-stripped production output vs. hand-written equivalent', () => {
		const annotatedSource = buildAnnotatedSource(N);
		const result = compileProduction('perf.ts', annotatedSource);
		expect(result.diagnostics).toEqual([]);

		const handWrittenSource = stripDirectiveComments(annotatedSource);
		const strippedProduction = ts.transpileModule(result.code, transpileOpts).outputText;
		const strippedHandWritten = ts.transpileModule(handWrittenSource, transpileOpts).outputText;

		const prodBytes = Buffer.byteLength(strippedProduction, 'utf8');
		const handBytes = Buffer.byteLength(strippedHandWritten, 'utf8');

		// eslint-disable-next-line no-console
		console.log(
			`[toph adversarial bench] comment-stripped production output: ${prodBytes} bytes; hand-written: ${handBytes} bytes; diff: ${prodBytes - handBytes} bytes`
		);

		expect(strippedProduction).toBe(strippedHandWritten);
		expect(prodBytes).toBe(handBytes);
	});

	it('(b) wall-clock: production-compiled vs hand-written, interleaved over many rounds', async () => {
		const annotatedSource = buildAnnotatedSource(N);
		const result = compileProduction('perf.ts', annotatedSource);
		const handWrittenSource = stripDirectiveComments(annotatedSource);
		const strippedProduction = ts.transpileModule(result.code, transpileOpts).outputText;
		const strippedHandWritten = ts.transpileModule(handWrittenSource, transpileOpts).outputText;

		const runOnceProd = await loadRunOnce(strippedProduction, 'prod-bench');
		const runOnceHand = await loadRunOnce(strippedHandWritten, 'hand-bench');

		// Warm up both independently first (let the JIT settle before timing).
		timeCallsMs(runOnceProd, WARMUP_ROUNDS);
		timeCallsMs(runOnceHand, WARMUP_ROUNDS);

		// Interleave timed rounds (A, B, A, B, ...) so neither side systematically benefits
		// from being measured first/warmer/cooler than the other.
		const prodTimes: number[] = [];
		const handTimes: number[] = [];
		for (let i = 0; i < TIMED_ROUNDS; i++) {
			const t0 = performance.now();
			runOnceProd();
			prodTimes.push(performance.now() - t0);

			const t1 = performance.now();
			runOnceHand();
			handTimes.push(performance.now() - t1);
		}

		const prodStats = summarize(prodTimes);
		const handStats = summarize(handTimes);

		// eslint-disable-next-line no-console
		console.log(
			`[toph adversarial bench] ${TIMED_ROUNDS} rounds over ${N} elements:\n` +
				`  production : total=${prodStats.totalMs.toFixed(2)}ms mean=${prodStats.meanMs.toFixed(4)}ms median=${prodStats.medianMs.toFixed(4)}ms\n` +
				`  hand-written: total=${handStats.totalMs.toFixed(2)}ms mean=${handStats.meanMs.toFixed(4)}ms median=${handStats.medianMs.toFixed(4)}ms\n` +
				`  mean ratio (production/hand-written): ${(prodStats.meanMs / handStats.meanMs).toFixed(3)}`
		);

		// They are the SAME code (byte-identical after erasure+transpile) loaded from two
		// different files -- this is confirmatory, not a real independent comparison. The
		// bound is intentionally generous (order-of-magnitude, not percent-level) to avoid
		// CI flakiness while still catching a genuine anomaly (e.g. accidental toph import
		// surviving into "production" and adding real overhead).
		const ratio = prodStats.meanMs / handStats.meanMs;
		expect(ratio).toBeGreaterThan(0.2);
		expect(ratio).toBeLessThan(5);
	});
});
