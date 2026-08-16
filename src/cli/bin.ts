#!/usr/bin/env node
// Thin CLI wrapper around inspectTruth: `toph inspect --trace <trace.json> --manifest
// <manifest.json> --labelmap <labelmap.json> --truth <truth.json> --point <label>`.
// All file reading/argv parsing lives here so inspect.ts itself stays a pure, directly
// testable function with no filesystem/process dependency.

import { readFileSync } from 'node:fs';
import { buildSurvivalFunnel, inspectTruth, type FunnelReport, type InspectReport } from './inspect.js';
import type { LabelmapDocument } from './labelmap.js';

function parseArgs(argv: string[]): Record<string, string> {
	const out: Record<string, string> = {};
	for (let i = 0; i < argv.length; i += 1) {
		const arg = argv[i];
		if (arg.startsWith('--')) {
			const key = arg.slice(2);
			const value = argv[i + 1];
			if (value === undefined || value.startsWith('--')) {
				throw new Error(`toph inspect: missing value for --${key}`);
			}
			out[key] = value;
			i += 1;
		}
	}
	return out;
}

function readJson<T>(path: string): T {
	return JSON.parse(readFileSync(path, 'utf8')) as T;
}

function formatCheck(c: { code: string; operator: string; value: number; threshold: number; unit?: string; pass: boolean }): string {
	const unit = c.unit ? ` ${c.unit}` : '';
	const mark = c.pass ? 'PASS' : 'FAIL';
	return `    ${c.code.padEnd(16)} ${c.value}${unit} ${c.operator} ${c.threshold}${unit}  [${mark}]`;
}

export function formatReport(report: InspectReport): string {
	const lines: string[] = [];
	lines.push(`Ground truth: ${report.truth.label} at (${report.truth.point.x}, ${report.truth.point.y})${report.truth.expect ? ` (expect: ${report.truth.expect})` : ''}`);
	lines.push('');

	if (report.ambiguous) {
		lines.push(`${report.truth.label}: marked ambiguous -- ${report.ambiguous.reason} -- not resolved.`);
		return lines.join('\n');
	}

	lines.push('White-mask support:');
	if (report.whiteMaskSupport.directHit) {
		lines.push(`  Direct hit -- bright pixel at the truth point, label ${report.whiteMaskSupport.labelAtPoint}.`);
	} else {
		lines.push('  No bright pixel exactly at the truth point.');
	}
	lines.push('');
	lines.push('Correspondence:');
	lines.push(`  method: ${report.correspondence.method}`);
	lines.push(`  distance: ${report.correspondence.distancePx === null ? 'n/a' : `${report.correspondence.distancePx.toFixed(2)}px`}`);
	if (report.component) {
		lines.push(`  component entity: ${report.component.entityId}`);
		lines.push('  attrs:');
		for (const [key, value] of Object.entries(report.component.attrs)) {
			lines.push(`    ${key}: ${value}`);
		}
	} else {
		lines.push('  No corresponding component found.');
	}
	lines.push('');
	for (const stage of report.stages) {
		lines.push(`Stage: ${stage.stageName}  (${stage.stageSource.file}:${stage.stageSource.line})`);
		lines.push('  Checks executed (in order):');
		for (const check of stage.checksExecuted) {
			lines.push(formatCheck(check) + `  (${check.source.file}:${check.source.line})`);
		}
		if (stage.firstFailingCheck) {
			lines.push(`  First failing check: ${stage.firstFailingCheck.code}`);
		}
		if (stage.checksNotEvaluated.length > 0) {
			lines.push(`  Checks NOT evaluated: ${stage.checksNotEvaluated.join(', ')}`);
		}
		lines.push(`  Kept: ${stage.kept}`);
		lines.push('');
	}
	lines.push(`Downstream: ${report.downstreamNote}`);
	return lines.join('\n');
}

/** Compact, skimmable summary for `buildSurvivalFunnel` -- a handful of lines, not a wall
 * of JSON: total/confident/ambiguous/corresponded counts, one line per stage's
 * reached/kept, then the materialized count. */
export function formatFunnelReport(report: FunnelReport): string {
	const lines: string[] = [];
	lines.push(`Truth objects: ${report.totalTruthObjects} total (${report.confidentCount} confident, ${report.ambiguousCount} ambiguous)`);
	lines.push(`Corresponded: ${report.correspondedCount} / ${report.confidentCount} confident`);
	for (const stage of report.stages) {
		lines.push(`  ${stage.stageName}: reached ${stage.reached}, kept ${stage.kept}`);
	}
	lines.push(`Materialized: ${report.materializedCount}`);
	return lines.join('\n');
}

const USAGE =
	'Usage:\n' +
	'  toph inspect --trace <trace.json> --manifest <manifest.json> --labelmap <labelmap.json> --truth <truth.json> --point <label>\n' +
	'  toph inspect --trace <trace.json> --manifest <manifest.json> --labelmap <labelmap.json> --truth <truth.json> --stages <name,name,...> [--max-distance <px>]';

function main(): void {
	const command = process.argv[2];
	if (command !== 'inspect') {
		console.error(USAGE);
		process.exit(1);
	}

	const args = parseArgs(process.argv.slice(3)); // skip "node", "bin.js", "inspect"

	for (const required of ['trace', 'manifest', 'labelmap', 'truth']) {
		if (!args[required]) {
			console.error(`toph inspect: missing required --${required}`);
			process.exit(1);
		}
	}
	if (!args.point && !args.stages) {
		console.error('toph inspect: supply either --point <label> (single-point query) or --stages <name,name,...> (fixture-wide survival funnel).\n\n' + USAGE);
		process.exit(1);
	}
	if (args.point && args.stages) {
		console.error('toph inspect: --point and --stages are mutually exclusive -- pass one or the other.');
		process.exit(1);
	}

	let maxCorrespondenceDistancePx: number | undefined;
	if (args['max-distance'] !== undefined) {
		maxCorrespondenceDistancePx = Number(args['max-distance']);
		if (Number.isNaN(maxCorrespondenceDistancePx)) {
			console.error(`toph inspect: --max-distance must be a number, got "${args['max-distance']}"`);
			process.exit(1);
		}
	}

	const trace = readJson(args.trace);
	const manifest = readJson(args.manifest);
	const labelmapDoc = readJson<LabelmapDocument>(args.labelmap);
	const truth = readJson(args.truth);

	if (args.point) {
		const report = inspectTruth({
			truthLabel: args.point,
			truth: truth as any,
			trace: trace as any,
			manifest: manifest as any,
			labelmapDoc,
			maxCorrespondenceDistancePx,
		});
		console.log(formatReport(report));
		return;
	}

	const stageOrder = args.stages
		.split(',')
		.map((s) => s.trim())
		.filter((s) => s.length > 0);
	const funnel = buildSurvivalFunnel({
		truth: truth as any,
		trace: trace as any,
		manifest: manifest as any,
		labelmapDoc,
		stageOrder,
		maxCorrespondenceDistancePx,
	});
	console.log(formatFunnelReport(funnel));
}

main();
