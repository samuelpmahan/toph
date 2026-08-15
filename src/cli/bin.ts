#!/usr/bin/env node
// Thin CLI wrapper around inspectTruth: `toph inspect --trace <trace.json> --manifest
// <manifest.json> --labelmap <labelmap.json> --truth <truth.json> --point <label>`.
// All file reading/argv parsing lives here so inspect.ts itself stays a pure, directly
// testable function with no filesystem/process dependency.

import { readFileSync } from 'node:fs';
import { inspectTruth, type InspectReport } from './inspect.js';
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

function main(): void {
	const args = parseArgs(process.argv.slice(3)); // skip "node", "bin.js", "inspect"
	const command = process.argv[2];
	if (command !== 'inspect') {
		console.error('Usage: toph inspect --trace <trace.json> --manifest <manifest.json> --labelmap <labelmap.json> --truth <truth.json> --point <label>');
		process.exit(1);
	}
	for (const required of ['trace', 'manifest', 'labelmap', 'truth', 'point']) {
		if (!args[required]) {
			console.error(`toph inspect: missing required --${required}`);
			process.exit(1);
		}
	}

	const trace = readJson(args.trace);
	const manifest = readJson(args.manifest);
	const labelmapDoc = readJson<LabelmapDocument>(args.labelmap);
	const truth = readJson(args.truth);

	const report = inspectTruth({
		truthLabel: args.point,
		truth: truth as any,
		trace: trace as any,
		manifest: manifest as any,
		labelmapDoc,
	});

	console.log(formatReport(report));
}

main();
