// formatCheck (src/cli/bin.ts) rendering a boolean-valued check's PASS/FAIL line.
//
// formatCheck is not exported (only reachable through main()'s console.log), and
// bin.ts calls main() unconditionally at module top level -- see
// test/cli/support/runInspectCli.ts's doc comment for why this drives the REAL CLI
// as a subprocess instead of importing bin.ts directly.
//
// The claim under test: `${c.value}${unit} ${c.operator} ${c.threshold}${unit}`
// already renders a boolean value/threshold correctly (JS template-literal
// stringification of `true`/`false` needs no special-casing) -- proven by actually
// running it, not assumed.

import { describe, expect, it } from 'vitest';
import { runInspectCli } from './support/runInspectCli.js';

// A minimal 1x1 labelmap: the single pixel (0,0) is labeled 1, so the truth point
// below resolves via a direct pixel hit straight to entity 1 -- no correspondence
// ambiguity to account for in the assertions.
const labelmap = { assetId: 1, widthPx: 1, heightPx: 1, encoding: 'rle', runs: [[1, 1]] };

function traceWith(checkEvent: { value: unknown; threshold: unknown; pass: boolean }) {
	return {
		version: 1,
		stages: [{ invocationId: 1, stageId: 1, seq: 0 }],
		elements: [{ id: 1, stageInvocationId: 1, ordinal: 0, kept: checkEvent.pass }],
		checks: [{ stageInvocationId: 1, elementId: 1, checkId: 1, operator: 'eq', ...checkEvent }],
		entities: [{ id: 1, kindId: 1, ordinal: 0, attrs: {} }],
	};
}

const manifest = {
	stages: [{ id: 1, name: 'badge.overlap', kind: 'filter', source: { file: 'chainspot.ts', line: 10 } }],
	checks: [{ id: 1, stageId: 1, code: 'badge-overlap', operator: '===', source: { file: 'chainspot.ts', line: 11 } }],
	entityKinds: [{ id: 1, name: 'component', source: { file: 'chainspot.ts', line: 5 } }],
};

const truth = { objects: [{ label: 'B1', point: { x: 0, y: 0 } }] };

function writeFixtures(checkEvent: { value: unknown; threshold: unknown; pass: boolean }) {
	return {
		'trace.json': traceWith(checkEvent),
		'manifest.json': manifest,
		'labelmap.json': labelmap,
		'truth.json': truth,
	};
}

describe('formatCheck via the real `toph inspect` CLI: boolean-valued checks', () => {
	it('renders a FAILING boolean check ("true eq false") with the exact same generic template as a numeric check -- no special-casing', () => {
		const stdout = runInspectCli(
			['--trace', 'trace.json', '--manifest', 'manifest.json', '--labelmap', 'labelmap.json', '--truth', 'truth.json', '--point', 'B1'],
			writeFixtures({ value: true, threshold: false, pass: false })
		);

		// Exactly formatCheck's own template: `    ${code.padEnd(16)} ${value}${unit} ${operator} ${threshold}${unit}  [${mark}]`
		const expectedLine = `    ${'badge-overlap'.padEnd(16)} true eq false  [FAIL]`;
		expect(stdout).toContain(expectedLine);
	});

	it('renders a PASSING boolean check ("false eq false")', () => {
		const stdout = runInspectCli(
			['--trace', 'trace.json', '--manifest', 'manifest.json', '--labelmap', 'labelmap.json', '--truth', 'truth.json', '--point', 'B1'],
			writeFixtures({ value: false, threshold: false, pass: true })
		);

		const expectedLine = `    ${'badge-overlap'.padEnd(16)} false eq false  [PASS]`;
		expect(stdout).toContain(expectedLine);
	});
});
