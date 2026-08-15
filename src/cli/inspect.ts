// The Phase 6 acceptance query: "select a known ground-truth object, see its actual
// white-mask support, exact connected component, checks that truly executed, first
// failed threshold, and downstream non-execution -- without rerunning the detector or
// reading source." This module is the query logic; src/cli/bin.ts is the thin argv/
// file-reading wrapper around it (kept separate so the logic itself is directly
// testable without spawning a process or touching the filesystem).
//
// Scope note (IMPLEMENTATION-DECISIONS.md / DESIGN.md Part 2 section 10): this performs
// the correspondence/lineage-walk analysis a real Toph deployment would eventually do
// generically. For this vertical slice it is intentionally narrow -- single-labelmap,
// single-entity-kind, one-hop "which checks executed for this entity" -- not a general
// graph-query engine. "What's deliberately absent (viewer-computed, not stored)" per
// DESIGN.md section 10 is exactly what this module computes on demand from the raw
// TraceRun + manifest, rather than something the runtime had to precompute.

import type { CheckManifestEntry, ManifestFragment, StageManifestEntry } from '../compiler/types.js';
import type { CheckRecord, EntityRecord, TraceRun } from '../runtime/index.js';
import { decodeLabelmap, labelAt, type LabelmapDocument } from './labelmap.js';

export interface TruthObject {
	label: string;
	point: { x: number; y: number };
	expect?: string;
}

export interface TruthDocument {
	objects: TruthObject[];
}

export interface WhiteMaskSupport {
	/** True iff the ground-truth pixel itself falls on a labeled (non-zero) pixel. */
	directHit: boolean;
	/** The label at the exact ground-truth pixel (0 if none). */
	labelAtPoint: number;
}

export interface Correspondence {
	method: 'direct-pixel-hit' | 'nearest-centroid' | 'none';
	distancePx: number | null;
	entityId: number | null;
}

export interface ExecutedCheck {
	code: string;
	operator: string;
	value: number;
	threshold: number;
	unit?: string;
	pass: boolean;
	source: { file: string; line: number };
}

export interface StageBreakdown {
	stageId: number;
	stageName: string;
	stageSource: { file: string; line: number };
	checksExecuted: ExecutedCheck[];
	firstFailingCheck: ExecutedCheck | null;
	checksNotEvaluated: string[];
	/** True iff every check defined for this stage executed and passed. */
	kept: boolean;
}

export interface InspectReport {
	truth: TruthObject;
	whiteMaskSupport: WhiteMaskSupport;
	correspondence: Correspondence;
	component: { entityId: number; kindId: number; attrs: Record<string, number | string | boolean> } | null;
	stages: StageBreakdown[];
	/** Human-readable note on whether any downstream (unistrumented) stage would have
	 * run -- this trace never records that directly (nothing to record: an
	 * un-instrumented stage emits no events at all), so this is a plain derived
	 * statement, not a stored fact. */
	downstreamNote: string;
}

function euclideanDistance(ax: number, ay: number, bx: number, by: number): number {
	return Math.hypot(ax - bx, ay - by);
}

function findEntityCentroid(entity: EntityRecord): { x: number; y: number } | null {
	const { centroidX, centroidY } = entity.attrs;
	if (typeof centroidX === 'number' && typeof centroidY === 'number') return { x: centroidX, y: centroidY };
	return null;
}

/**
 * Resolves ground-truth point -> component entity, via the two-step correspondence
 * DESIGN.md describes: (1) does the labelmap have a bright pixel exactly at the truth
 * point -- if so, that pixel's label IS the answer, distance 0, no guessing; (2)
 * otherwise, fall back to the nearest spawned entity by centroid distance, reporting the
 * method and distance explicitly rather than silently picking one -- so a reader can
 * judge whether "nearest" is actually close enough to mean anything.
 */
export function resolveCorrespondence(
	truth: TruthObject,
	labelmap: Uint32Array,
	widthPx: number,
	heightPx: number,
	entities: readonly EntityRecord[]
): { whiteMaskSupport: WhiteMaskSupport; correspondence: Correspondence } {
	const label = labelAt(labelmap, widthPx, heightPx, Math.round(truth.point.x), Math.round(truth.point.y));
	const whiteMaskSupport: WhiteMaskSupport = { directHit: label !== 0, labelAtPoint: label };

	if (label !== 0) {
		// Label N corresponds to the entity spawned at ordinal N-1 (collectComponents
		// assigns labels 1..N in the same order it pushes components -- see
		// IMPLEMENTATION-DECISIONS.md section 9's Phase 6 addendum).
		const entity = entities.find((e) => e.ordinal === label - 1);
		return {
			whiteMaskSupport,
			correspondence: { method: 'direct-pixel-hit', distancePx: 0, entityId: entity?.id ?? null },
		};
	}

	let best: { entity: EntityRecord; distance: number } | null = null;
	for (const entity of entities) {
		const centroid = findEntityCentroid(entity);
		if (!centroid) continue;
		const distance = euclideanDistance(truth.point.x, truth.point.y, centroid.x, centroid.y);
		if (best === null || distance < best.distance) best = { entity, distance };
	}
	if (best === null) {
		return { whiteMaskSupport, correspondence: { method: 'none', distancePx: null, entityId: null } };
	}
	return {
		whiteMaskSupport,
		correspondence: { method: 'nearest-centroid', distancePx: best.distance, entityId: best.entity.id },
	};
}

/** Builds the per-stage checks-executed / first-failure / not-evaluated breakdown for
 * one entity id, across every stage invocation that entity appears in. */
export function buildStageBreakdowns(
	entityId: number,
	trace: TraceRun,
	manifest: Pick<ManifestFragment, 'stages' | 'checks'>
): StageBreakdown[] {
	const stageById = new Map<number, StageManifestEntry>(manifest.stages.map((s) => [s.id, s]));
	const invocationToStageId = new Map<number, number>(trace.stages.map((inv) => [inv.invocationId, inv.stageId]));
	const checksByStageId = new Map<number, CheckManifestEntry[]>();
	for (const check of manifest.checks) {
		const list = checksByStageId.get(check.stageId) ?? [];
		list.push(check);
		checksByStageId.set(check.stageId, list);
	}

	const eventsByStageInvocation = new Map<number, CheckRecord[]>();
	for (const event of trace.checks) {
		if (event.elementId !== entityId) continue;
		const list = eventsByStageInvocation.get(event.stageInvocationId) ?? [];
		list.push(event);
		eventsByStageInvocation.set(event.stageInvocationId, list);
	}

	const breakdowns: StageBreakdown[] = [];
	for (const [stageInvocationId, events] of eventsByStageInvocation) {
		const stageId = invocationToStageId.get(stageInvocationId);
		if (stageId === undefined) continue;
		const stage = stageById.get(stageId);
		if (!stage) continue;
		const stageChecks = checksByStageId.get(stageId) ?? [];
		const checkById = new Map(stageChecks.map((c) => [c.id, c]));

		const checksExecuted: ExecutedCheck[] = events.map((event) => {
			const manifestCheck = checkById.get(event.checkId);
			return {
				code: manifestCheck?.code ?? `#${event.checkId}`,
				operator: event.operator,
				value: event.value,
				threshold: event.threshold,
				unit: manifestCheck?.unit,
				pass: event.pass,
				source: manifestCheck?.source ?? stage.source,
			};
		});
		const firstFailingCheck = checksExecuted.find((c) => !c.pass) ?? null;
		const executedCodes = new Set(checksExecuted.map((c) => c.code));
		const checksNotEvaluated = stageChecks.map((c) => c.code).filter((code) => !executedCodes.has(code));
		const kept = checksNotEvaluated.length === 0 && checksExecuted.every((c) => c.pass);

		breakdowns.push({
			stageId,
			stageName: stage.name,
			stageSource: stage.source,
			checksExecuted,
			firstFailingCheck,
			checksNotEvaluated,
			kept,
		});
	}
	return breakdowns;
}

export interface InspectOptions {
	truthLabel: string;
	truth: TruthDocument;
	trace: TraceRun;
	manifest: Pick<ManifestFragment, 'stages' | 'checks' | 'entityKinds'>;
	labelmapDoc: LabelmapDocument;
}

export function inspectTruth(opts: InspectOptions): InspectReport {
	const truth = opts.truth.objects.find((o) => o.label === opts.truthLabel);
	if (!truth) {
		throw new Error(`toph inspect: no ground-truth object labeled "${opts.truthLabel}" in the supplied truth document.`);
	}

	const labelmap = decodeLabelmap(opts.labelmapDoc);
	const entities = opts.trace.entities ?? [];
	const { whiteMaskSupport, correspondence } = resolveCorrespondence(
		truth,
		labelmap,
		opts.labelmapDoc.widthPx,
		opts.labelmapDoc.heightPx,
		entities
	);

	let component: InspectReport['component'] = null;
	let stages: StageBreakdown[] = [];
	let downstreamNote = 'No corresponding component entity was found for this ground-truth point.';

	if (correspondence.entityId !== null) {
		const entity = entities.find((e) => e.id === correspondence.entityId) ?? null;
		if (entity) {
			component = { entityId: entity.id, kindId: entity.kindId, attrs: entity.attrs };
		}
		stages = buildStageBreakdowns(correspondence.entityId, opts.trace, opts.manifest);

		if (stages.length === 0) {
			downstreamNote =
				'This component entity was spawned but never entered any instrumented filter stage -- no checks were recorded for it at all.';
		} else {
			const lastStage = stages[stages.length - 1];
			downstreamNote = lastStage.kept
				? 'This component survived every instrumented check in its stage(s); any further (un-instrumented) stage is not recorded here and would need its own @toph annotations to trace.'
				: `This component was rejected at "${lastStage.firstFailingCheck?.code}" in stage "${lastStage.stageName}" -- every check and stage after that point never ran, so nothing downstream (including any un-instrumented appearance/association stage) was evaluated.`;
		}
	}

	return { truth, whiteMaskSupport, correspondence, component, stages, downstreamNote };
}
