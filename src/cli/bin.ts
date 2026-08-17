#!/usr/bin/env node
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, relative, resolve } from 'node:path';
import type { ManifestFragment } from '../compiler/types.js';
import { buildSurvivalFunnel, inspectTruth, type FunnelReport, type InspectReport } from './inspect.js';
import type { LabelmapDocument } from './labelmap.js';

type Args = Record<string, string> & { _: string[] };

function parseArgs(argv: string[]): Args {
  const out = { _: [] as string[] } as Args;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg.startsWith('--')) {
      const key = arg.slice(2);
      const value = argv[i + 1];
      if (value === undefined || value.startsWith('--')) throw new Error(`toph: missing value for --${key}`);
      out[key] = value;
      i += 1;
    } else out._.push(arg);
  }
  return out;
}

function readJson<T>(path: string): T { return JSON.parse(readFileSync(path, 'utf8')) as T; }

function formatCheck(c: { code: string; operator: string; value: number | boolean; threshold: number | boolean; unit?: string; pass: boolean }): string {
  const unit = c.unit ? ` ${c.unit}` : '';
  const mark = c.pass ? 'PASS' : 'FAIL';
  return `    ${c.code.padEnd(16)} ${c.value}${unit} ${c.operator} ${c.threshold}${unit}  [${mark}]`;
}

export function formatReport(report: InspectReport): string {
  const lines: string[] = [];
  const space = report.truth.point.space ? ` [space: ${report.truth.point.space}]` : '';
  lines.push(`Ground truth: ${report.truth.label} at (${report.truth.point.x}, ${report.truth.point.y})${space}${report.truth.expect ? ` (expect: ${report.truth.expect})` : ''}`);
  lines.push('');

  if (report.ambiguous) {
    lines.push(`${report.truth.label}: marked ambiguous -- ${report.ambiguous.reason} -- not resolved.`);
    return lines.join('\n');
  }

  lines.push('White-mask support:');
  if (report.whiteMaskSupport.directHit) lines.push(`  Direct hit -- bright pixel at the truth point, label ${report.whiteMaskSupport.labelAtPoint}.`);
  else lines.push('  No bright pixel exactly at the truth point.');
  lines.push('');
  lines.push('Correspondence:');
  lines.push(`  method: ${report.correspondence.method}`);
  lines.push(`  distance: ${report.correspondence.distancePx === null ? 'n/a' : `${report.correspondence.distancePx.toFixed(2)}px`}`);
  lines.push(`  reliable: ${report.correspondence.reliable}`);
  if (report.correspondence.reason) lines.push(`  reason: ${report.correspondence.reason}`);
  if (report.component) {
    lines.push(`  component entity: ${report.component.entityId}`);
    lines.push('  attrs:');
    for (const [key, value] of Object.entries(report.component.attrs)) lines.push(`    ${key}: ${value}`);
  } else lines.push('  No corresponding component found.');
  lines.push('');

  for (const stage of report.stages) {
    lines.push(`Stage: ${stage.stageName}${stage.family ? `  [family=${stage.family}]` : ''}  (${stage.stageSource.file}:${stage.stageSource.line})`);
    lines.push('  Checks executed (in order):');
    for (const check of stage.checksExecuted) lines.push(formatCheck(check) + `  (${check.source.file}:${check.source.line})`);
    if (stage.firstFailingCheck) lines.push(`  First failing check: ${stage.firstFailingCheck.code}`);
    if (stage.checksNotEvaluated.length > 0) lines.push(`  Checks NOT evaluated: ${stage.checksNotEvaluated.join(', ')}`);
    lines.push(`  Kept: ${stage.kept}`);
    lines.push('');
  }

  if (report.selects && report.selects.length > 0) {
    lines.push('Population decisions:');
    for (const select of report.selects) {
      lines.push(`  ${select.name ?? '(unnamed select)'}: ${select.outcome}  [stage invocation ${select.stageInvocationId}]`);
      if (select.basis) lines.push(`    basis: ${JSON.stringify(select.basis)}`);
    }
    lines.push('');
  }
  lines.push(`Downstream: ${report.downstreamNote}`);
  return lines.join('\n');
}

export function formatFunnelReport(report: FunnelReport): string {
  const lines: string[] = [];
  lines.push(`Truth objects: ${report.totalTruthObjects} total (${report.confidentCount} confident, ${report.ambiguousCount} ambiguous)`);
  lines.push(`Corresponded: ${report.correspondedCount} / ${report.confidentCount} confident`);
  for (const stage of report.stages) {
    const mixed = stage.mixed === undefined ? '' : `, mixed ${stage.mixed}`;
    lines.push(`  ${stage.stageName}: reached ${stage.reached}, kept ${stage.kept}${mixed}`);
  }
  lines.push(`Materialized: ${report.materializedCount}`);
  return lines.join('\n');
}

const USAGE = [
  'Usage:',
  '  toph compile [--mode trace|production] --out-dir <dir> <source.ts ...>',
  '  toph inspect --trace <trace.json> --manifest <manifest.json> --labelmap <labelmap.json> --truth <truth.json> --point <label>',
  '  toph funnel --trace <trace.json> --manifest <manifest.json> --labelmap <labelmap.json> --truth <truth.json> --stages <name,name,...>',
].join('\n');

async function compileCommand(args: Args): Promise<number> {
  const { compileProduction, compileTrace, createIdAllocator, writeManifest } = await import('../compiler/index.js');
  const ts = await import('typescript');
  const inputs = [...args._].sort();
  const outDir = args['out-dir'] ?? args.out;
  if (!outDir || inputs.length === 0) {
    console.error('toph compile: provide --out-dir <dir> and at least one source file.\n\n' + USAGE);
    return 1;
  }
  const mode = args.mode ?? 'trace';
  if (mode !== 'trace' && mode !== 'production') {
    console.error(`toph compile: --mode must be trace or production, got "${mode}"`);
    return 1;
  }

  mkdirSync(outDir, { recursive: true });
  const ids = createIdAllocator();
  const fragments: ManifestFragment[] = [];
  const generatedFiles: string[] = [];
  let diagnostics = 0;
  for (const input of inputs) {
    const absolute = resolve(input);
    const source = readFileSync(absolute, 'utf8');
    const fileName = relative(process.cwd(), absolute) || basename(absolute);
    let code: string;
    if (mode === 'trace') {
      const compiled = compileTrace(fileName, source, ids);
      code = compiled.code;
      fragments.push(compiled.manifest);
      diagnostics += compiled.diagnostics.length;
      for (const diagnostic of compiled.diagnostics) console.error(`${diagnostic.file}:${diagnostic.line}:${diagnostic.column}: ${diagnostic.code} ${diagnostic.message}`);
    } else {
      const compiled = compileProduction(fileName, source);
      code = compiled.code;
      diagnostics += compiled.diagnostics.length;
      for (const diagnostic of compiled.diagnostics) console.error(`${diagnostic.file}:${diagnostic.line}:${diagnostic.column}: ${diagnostic.code} ${diagnostic.message}`);
    }

    const outputName = basename(input).replace(/\.(tsx?|mts|cts)$/, '.js');
    const outputPath = resolve(outDir, outputName);
    const transpiled = ts.transpileModule(code, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext, sourceMap: true }, fileName: outputName });
    writeFileSync(outputPath, transpiled.outputText, 'utf8');
    generatedFiles.push(outputPath);
  }

  const merged = mode === 'trace' ? writeManifest(fragments) : { manifest: { stages: [], checks: [], assets: [], entityKinds: [] }, sourceMap: [] };
  writeFileSync(resolve(outDir, 'manifest.json'), JSON.stringify(merged.manifest, null, 2) + '\n', 'utf8');
  writeFileSync(resolve(outDir, 'source-map.json'), JSON.stringify(merged.sourceMap, null, 2) + '\n', 'utf8');
  console.log(`Compiled ${generatedFiles.length} file(s) in ${mode} mode to ${resolve(outDir)}`);
  return diagnostics === 0 ? 0 : 2;
}

function inspectCommand(command: string, args: Args): number {
  for (const required of ['trace', 'manifest', 'labelmap', 'truth']) {
    if (!args[required]) { console.error(`toph ${command}: missing required --${required}`); return 1; }
  }
  if (!args.point && !args.stages) { console.error(`toph ${command}: supply either --point <label> or --stages <name,name,...>.\n\n` + USAGE); return 1; }
  if (args.point && args.stages) { console.error(`toph ${command}: --point and --stages are mutually exclusive.`); return 1; }

  let maxCorrespondenceDistancePx: number | undefined;
  if (args['max-distance'] !== undefined) {
    maxCorrespondenceDistancePx = Number(args['max-distance']);
    if (Number.isNaN(maxCorrespondenceDistancePx)) { console.error(`toph ${command}: --max-distance must be a number`); return 1; }
  }

  const trace = readJson(args.trace);
  const manifest = readJson(args.manifest);
  const labelmapDoc = readJson<LabelmapDocument>(args.labelmap);
  const truth = readJson(args.truth);
  if (args.point) {
    console.log(formatReport(inspectTruth({ truthLabel: args.point, truth: truth as any, trace: trace as any, manifest: manifest as any, labelmapDoc, maxCorrespondenceDistancePx })));
  } else {
    const stageOrder = args.stages!.split(',').map((s) => s.trim()).filter(Boolean);
    console.log(formatFunnelReport(buildSurvivalFunnel({ truth: truth as any, trace: trace as any, manifest: manifest as any, labelmapDoc, stageOrder, maxCorrespondenceDistancePx })));
  }
  return 0;
}

export async function main(argv = process.argv.slice(2)): Promise<number> {
  const command = argv[0];
  if (command === 'compile') return compileCommand(parseArgs(argv.slice(1)));
  if (command === 'inspect' || command === 'funnel') return inspectCommand(command, parseArgs(argv.slice(1)));
  if (command === undefined || command === '--help' || command === '-h') { console.log(USAGE); return 0; }
  console.error(USAGE);
  return 1;
}

if (import.meta.url === `file://${process.argv[1]}`) process.exitCode = await main();