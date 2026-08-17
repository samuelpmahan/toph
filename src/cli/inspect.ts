// Query semantics for Toph traces. The runtime records execution facts; this module is
// deliberately responsible for correspondence and verdict inference so those inferences
// can fail closed instead of masquerading as recorded facts.

import type { CheckManifestEntry, ManifestFragment, StageManifestEntry } from '../compiler/types.js';
import type { CheckRecord, EntityRecord, TraceRun } from '../runtime/index.js';
import { decodeLabelmap, labelAt, type LabelmapDocument } from './labelmap.js';

export interface TruthPoint { x: number; y: number; space?: string; }
export interface SpaceTransform {
	from: string;
	to: string;
	scaleX?: number;
	scaleY?: number;
	dx?: number;
	dy?: number;
}
export interface TruthObject {
	label: string;
	point: TruthPoint;
	/** Expected semantic verdict family, not a stage-name prefix or naming convention. */
	expect?: string;
	status?: 'confident' | 'ambiguous';
	reason?: string;
}
export interface TruthDocument {
	objects: TruthObject[];
	/** Explicit coordinate-frame transforms available to correspondence queries. */
	transforms?: SpaceTransform[];
}

export interface WhiteMaskSupport { directHit: boolean; labelAtPoint: number; }
export interface Correspondence {
	method: 'direct-pixel-hit' | 'nearest-pixel' | 'nearest-centroid' | 'unreconciled-space' | 'none';
	distancePx: number | null;
	entityId: number | null;
	reliable: boolean;
	reason?: string;
}
export interface ExecutedCheck {
	code: string;
	operator: string;
	value: number | boolean;
	threshold: number | boolean;
	unit?: string;
	pass: boolean;
	source: { file: string; line: number };
}
export interface StageBreakdown {
	stageId: number;
	stageName: string;
	family?: string;
	stageSource: { file: string; line: number };
	checksExecuted: ExecutedCheck[];
	firstFailingCheck: ExecutedCheck | null;
	checksNotEvaluated: string[];
	kept: boolean;
}

export type AggregatedStageOutcome = 'kept' | 'rejected' | 'mixed';
export interface AggregatedStageFate {
	stageId: number;
	stageName: string;
	family?: string;
	invocationCount: number;
	outcome: AggregatedStageOutcome;
	firstFailingCheck: ExecutedCheck | null;
}

export interface SelectFate {
	stageInvocationId: number;
	name?: string;
	outcome: 'kept' | 'rejected';
	basis?: Record<string, number | string | boolean | null>;
}

export interface InspectReportAmbiguous { truth: TruthObject; ambiguous: { reason: string }; }
export interface InspectReportResolved {
	truth: TruthObject;
	ambiguous?: undefined;
	whiteMaskSupport: WhiteMaskSupport;
	correspondence: Correspondence;
	component: { entityId: number; kindId: number; attrs: Record<string, number | string | boolean> } | null;
	stages: StageBreakdown[];
	selects?: SelectFate[];
	downstreamNote: string;
}
export type InspectReport = InspectReportAmbiguous | InspectReportResolved;

function euclideanDistance(ax: number, ay: number, bx: number, by: number): number { return Math.hypot(ax - bx, ay - by); }
function findEntityCentroid(entity: EntityRecord): { x: number; y: number } | null {
	const { centroidX, centroidY } = entity.attrs;
	return typeof centroidX === 'number' && typeof centroidY === 'number' ? { x: centroidX, y: centroidY } : null;
}

type PixelHit = { x: number; y: number; label: number; distance: number };
function nearestLabeledPixel(labelmap: Uint32Array, widthPx: number, heightPx: number, point: { x: number; y: number }, maxDistancePx: number): PixelHit | null {
	const roundedX = Math.round(point.x);
	const roundedY = Math.round(point.y);
	const consider = (x: number, y: number, best: PixelHit | null): PixelHit | null => {
		if (x < 0 || y < 0 || x >= widthPx || y >= heightPx) return best;
		const label = labelmap[y * widthPx + x];
		if (label === 0) return best;
		const distance = euclideanDistance(point.x, point.y, x, y);
		const rowMajorIndex = y * widthPx + x;
		const bestIndex = best === null ? -1 : best.y * widthPx + best.x;
		return best === null || distance < best.distance || (distance === best.distance && rowMajorIndex < bestIndex)
			? { x, y, label, distance }
			: best;
	};
	for (let radius = 0; radius <= maxDistancePx; radius++) {
		let best: PixelHit | null = null;
		if (radius === 0) best = consider(roundedX, roundedY, best);
		else {
			for (let dx = -radius; dx <= radius; dx++) {
				best = consider(roundedX + dx, roundedY - radius, best);
				best = consider(roundedX + dx, roundedY + radius, best);
			}
			for (let dy = -radius + 1; dy <= radius - 1; dy++) {
				best = consider(roundedX - radius, roundedY + dy, best);
				best = consider(roundedX + radius, roundedY + dy, best);
			}
		}
		if (best !== null) return best;
	}
	return null;
}

export const DEFAULT_MAX_CORRESPONDENCE_DISTANCE_PX = 20;

function entityForLabel(label: number, entities: readonly EntityRecord[], entityIds?: readonly number[]): EntityRecord | null {
	if (label <= 0) return null;
	if (entityIds !== undefined) {
		const id = entityIds[label - 1];
		return id === undefined ? null : entities.find((e) => e.id === id) ?? null;
	}
	// Legacy fixture compatibility: ordinal lookup remains safe only if the ordinal is
	// unique. Multiple spawn sites can each have ordinal 0; guessing among them is banned.
	const matches = entities.filter((e) => e.ordinal === label - 1);
	return matches.length === 1 ? matches[0] : null;
}

function scopedEntities(entities: readonly EntityRecord[], entityIds?: readonly number[]): readonly EntityRecord[] {
	if (entityIds === undefined) return entities;
	const allowed = new Set(entityIds);
	return entities.filter((e) => allowed.has(e.id));
}

export function resolveCorrespondence(
	truth: TruthObject,
	labelmap: Uint32Array,
	widthPx: number,
	heightPx: number,
	entities: readonly EntityRecord[],
	maxDistancePx: number = DEFAULT_MAX_CORRESPONDENCE_DISTANCE_PX,
	entityIds?: readonly number[]
): { whiteMaskSupport: WhiteMaskSupport; correspondence: Correspondence } {
	const label = labelAt(labelmap, widthPx, heightPx, Math.round(truth.point.x), Math.round(truth.point.y));
	const whiteMaskSupport = { directHit: label !== 0, labelAtPoint: label };
	if (label !== 0) {
		const entity = entityForLabel(label, entities, entityIds);
		return {
			whiteMaskSupport,
			correspondence: entity
				? { method: 'direct-pixel-hit', distancePx: 0, entityId: entity.id, reliable: true }
				: { method: 'direct-pixel-hit', distancePx: 0, entityId: null, reliable: false, reason: 'Label does not resolve uniquely within the labelmap entity set.' },
		};
	}
	const nearestPixel = nearestLabeledPixel(labelmap, widthPx, heightPx, truth.point, maxDistancePx);
	if (nearestPixel !== null) {
		const entity = entityForLabel(nearestPixel.label, entities, entityIds);
		return {
			whiteMaskSupport,
			correspondence: entity
				? { method: 'nearest-pixel', distancePx: nearestPixel.distance, entityId: entity.id, reliable: true }
				: { method: 'nearest-pixel', distancePx: nearestPixel.distance, entityId: null, reliable: false, reason: 'Nearby label does not resolve uniquely within the labelmap entity set.' },
		};
	}
	let best: { entity: EntityRecord; distance: number } | null = null;
	for (const entity of scopedEntities(entities, entityIds)) {
		const centroid = findEntityCentroid(entity);
		if (!centroid) continue;
		const distance = euclideanDistance(truth.point.x, truth.point.y, centroid.x, centroid.y);
		if (best === null || distance < best.distance) best = { entity, distance };
	}
	if (best === null) return { whiteMaskSupport, correspondence: { method: 'none', distancePx: null, entityId: null, reliable: false } };
	return { whiteMaskSupport, correspondence: { method: 'nearest-centroid', distancePx: best.distance, entityId: best.entity.id, reliable: best.distance <= maxDistancePx } };
}

function transformPoint(point: TruthPoint, transform: SpaceTransform): TruthPoint {
	return {
		x: point.x * (transform.scaleX ?? 1) + (transform.dx ?? 0),
		y: point.y * (transform.scaleY ?? 1) + (transform.dy ?? 0),
		space: transform.to,
	};
}

function truthInLabelmapSpace(truth: TruthObject, truthDoc: TruthDocument, labelmapDoc: LabelmapDocument): TruthObject | null {
	const from = truth.point.space;
	const to = labelmapDoc.space;
	// Compatibility for pre-space fixtures: absence on either side means the legacy
	// coordinate contract is unchanged. New artifacts should name both spaces.
	if (from === undefined || to === undefined || from === to) return truth;
	const direct = truthDoc.transforms?.find((t) => t.from === from && t.to === to);
	if (!direct) return null;
	return { ...truth, point: transformPoint(truth.point, direct) };
}

export function buildStageBreakdowns(entityId: number, trace: TraceRun, manifest: Pick<ManifestFragment, 'stages' | 'checks'>): StageBreakdown[] {
	const stageById = new Map<number, StageManifestEntry>(manifest.stages.map((s) => [s.id, s]));
	const invocationToStageId = new Map<number, number>(trace.stages.map((inv) => [inv.invocationId, inv.stageId]));
	const checksByStageId = new Map<number, CheckManifestEntry[]>();
	for (const check of manifest.checks) {
		const list = checksByStageId.get(check.stageId) ?? [];
		list.push(check);
		checksByStageId.set(check.stageId, list);
	}
	const eventsByInvocation = new Map<number, CheckRecord[]>();
	for (const event of trace.checks) {
		if (event.elementId !== entityId) continue;
		const list = eventsByInvocation.get(event.stageInvocationId) ?? [];
		list.push(event);
		eventsByInvocation.set(event.stageInvocationId, list);
	}
	const breakdowns: StageBreakdown[] = [];
	for (const [stageInvocationId, events] of eventsByInvocation) {
		const stageId = invocationToStageId.get(stageInvocationId);
		if (stageId === undefined) continue;
		const stage = stageById.get(stageId);
		if (!stage) continue;
		const stageChecks = checksByStageId.get(stageId) ?? [];
		const checkById = new Map(stageChecks.map((c) => [c.id, c]));
		const checksExecuted: ExecutedCheck[] = events.map((event) => {
			const m = checkById.get(event.checkId);
			const out: ExecutedCheck = { code: m?.code ?? `#${event.checkId}`, operator: event.operator, value: event.value, threshold: event.threshold, pass: event.pass, source: m?.source ?? stage.source };
			if (m?.unit !== undefined) out.unit = m.unit;
			return out;
		});
		const executedCodes = new Set(checksExecuted.map((c) => c.code));
		const breakdown: StageBreakdown = {
			stageId,
			stageName: stage.name,
			stageSource: stage.source,
			checksExecuted,
			firstFailingCheck: checksExecuted.find((c) => !c.pass) ?? null,
			checksNotEvaluated: stageChecks.map((c) => c.code).filter((code) => !executedCodes.has(code)),
			kept: stageChecks.every((c) => executedCodes.has(c.code)) && checksExecuted.every((c) => c.pass),
		};
		if (stage.family !== undefined) breakdown.family = stage.family;
		breakdowns.push(breakdown);
	}
	return breakdowns;
}

export function aggregateStageFates(breakdowns: readonly StageBreakdown[]): AggregatedStageFate[] {
	const groups = new Map<string, StageBreakdown[]>();
	for (const breakdown of breakdowns) {
		const key = `${breakdown.stageId}`;
		const list = groups.get(key) ?? [];
		list.push(breakdown);
		groups.set(key, list);
	}
	return [...groups.values()].map((group) => {
		const anyKept = group.some((b) => b.kept);
		const anyRejected = group.some((b) => !b.kept);
		const first = group[0];
		const out: AggregatedStageFate = {
			stageId: first.stageId,
			stageName: first.stageName,
			invocationCount: group.length,
			outcome: anyKept && anyRejected ? 'mixed' : anyKept ? 'kept' : 'rejected',
			firstFailingCheck: group.find((b) => !b.kept)?.firstFailingCheck ?? null,
		};
		if (first.family !== undefined) out.family = first.family;
		return out;
	});
}

export function selectFateOf(entityId: number, trace: TraceRun): SelectFate[] {
	const out: SelectFate[] = [];
	for (const event of trace.dataflow ?? []) {
		if (event.t !== 'select') continue;
		const kept = event.kept.includes(entityId);
		const rejected = event.rejected.includes(entityId);
		if (!kept && !rejected) continue;
		const fate: SelectFate = { stageInvocationId: event.stage, outcome: kept ? 'kept' : 'rejected' };
		if (event.name !== undefined) fate.name = event.name;
		const basis = (event as typeof event & { basis?: Record<string, number | string | boolean | null> }).basis;
		if (basis !== undefined) fate.basis = basis;
		out.push(fate);
	}
	return out;
}

export interface InspectOptions {
	truthLabel: string;
	truth: TruthDocument;
	trace: TraceRun;
	manifest: Pick<ManifestFragment, 'stages' | 'checks' | 'entityKinds'>;
	labelmapDoc: LabelmapDocument;
	maxCorrespondenceDistancePx?: number;
}

function legacyDownstreamNote(stages: readonly StageBreakdown[]): string {
	if (stages.length === 0) return 'This component entity was spawned but never entered any instrumented filter stage -- no checks were recorded for it at all.';
	const lastStage = stages[stages.length - 1];
	return lastStage.kept
		? 'This component survived every instrumented check in its stage(s); any further (un-instrumented) stage is not recorded here and would need its own @toph annotations to trace.'
		: `This component was rejected at "${lastStage.firstFailingCheck?.code}" in stage "${lastStage.stageName}" -- every check and stage after that point never ran, so nothing downstream (including any un-instrumented appearance/association stage) was evaluated.`;
}

function familyDownstreamNote(expect: string, stages: readonly StageBreakdown[]): string {
	const attributable = stages.filter((s) => s.family === expect);
	if (attributable.length === 0) return `No instrumented stage declares semantic family "${expect}" for this entity; refusing to infer a verdict from unrelated execution stages.`;
	const fates = aggregateStageFates(attributable);
	const mixed = fates.find((f) => f.outcome === 'mixed');
	if (mixed) return `Semantic family "${expect}" has mixed outcomes across ${mixed.invocationCount} invocations of stage "${mixed.stageName}"; refusing to collapse them into a confident verdict.`;
	const rejected = fates.find((f) => f.outcome === 'rejected');
	if (rejected) return `This component's first attributable rejection for semantic family "${expect}" was at "${rejected.firstFailingCheck?.code}" in stage "${rejected.stageName}".`;
	return `This component survived every instrumented stage that declares semantic family "${expect}"; rejections in unrelated families are not losses for this truth object.`;
}

export function inspectTruth(opts: InspectOptions): InspectReport {
	const truth = opts.truth.objects.find((o) => o.label === opts.truthLabel);
	if (!truth) throw new Error(`toph inspect: no ground-truth object labeled "${opts.truthLabel}" in the supplied truth document.`);
	if (truth.status === 'ambiguous') return { truth, ambiguous: { reason: truth.reason ?? '(no reason given in the ground-truth fixture)' } };

	const reconciledTruth = truthInLabelmapSpace(truth, opts.truth, opts.labelmapDoc);
	if (reconciledTruth === null) {
		return {
			truth,
			whiteMaskSupport: { directHit: false, labelAtPoint: 0 },
			correspondence: { method: 'unreconciled-space', distancePx: null, entityId: null, reliable: false, reason: `No transform from truth space "${truth.point.space}" to labelmap space "${opts.labelmapDoc.space}".` },
			component: null,
			stages: [],
			downstreamNote: 'Ground truth and labelmap are in unreconciled coordinate spaces; no correspondence lookup was attempted.',
		};
	}

	const labelmap = decodeLabelmap(opts.labelmapDoc);
	const entities = opts.trace.entities ?? [];
	const { whiteMaskSupport, correspondence } = resolveCorrespondence(reconciledTruth, labelmap, opts.labelmapDoc.widthPx, opts.labelmapDoc.heightPx, entities, opts.maxCorrespondenceDistancePx, opts.labelmapDoc.entityIds);
	let component: InspectReportResolved['component'] = null;
	let stages: StageBreakdown[] = [];
	let downstreamNote = correspondence.reason ?? 'No corresponding component entity was found for this ground-truth point.';
	let selects: SelectFate[] | undefined;

	if (correspondence.entityId !== null && correspondence.reliable) {
		const entity = entities.find((e) => e.id === correspondence.entityId) ?? null;
		if (entity) component = { entityId: entity.id, kindId: entity.kindId, attrs: entity.attrs };
		stages = buildStageBreakdowns(correspondence.entityId, opts.trace, opts.manifest);
		selects = selectFateOf(correspondence.entityId, opts.trace);
		downstreamNote = truth.expect === undefined ? legacyDownstreamNote(stages) : familyDownstreamNote(truth.expect, stages);
	} else if (correspondence.entityId !== null && !correspondence.reliable) {
		downstreamNote = `The nearest entity (id ${correspondence.entityId}) is ${correspondence.distancePx?.toFixed(2)}px away, beyond the reliable-match threshold -- not treated as a corresponding component, so no stage breakdown was computed.`;
	}
	const report: InspectReportResolved = { truth, whiteMaskSupport, correspondence, component, stages, downstreamNote };
	if (selects !== undefined && selects.length > 0) report.selects = selects;
	return report;
}

export interface FunnelStageCounts {
	stageName: string;
	reached: number;
	kept: number;
	/** Number of distinct truth/entity pairs with both kept and rejected invocations. */
	mixed?: number;
}
export interface FunnelReport {
	totalTruthObjects: number;
	confidentCount: number;
	ambiguousCount: number;
	correspondedCount: number;
	stages: FunnelStageCounts[];
	materializedCount: number;
}

export function buildSurvivalFunnel(opts: {
	truth: TruthDocument;
	trace: TraceRun;
	manifest: Pick<ManifestFragment, 'stages' | 'checks' | 'entityKinds'>;
	labelmapDoc: LabelmapDocument;
	stageOrder: string[];
	maxCorrespondenceDistancePx?: number;
}): FunnelReport {
	const labelmap = decodeLabelmap(opts.labelmapDoc);
	const entities = opts.trace.entities ?? [];
	let confidentCount = 0;
	let ambiguousCount = 0;
	let correspondedCount = 0;
	const correspondedEntityIds: number[] = [];

	for (const truth of opts.truth.objects) {
		if (truth.status === 'ambiguous') { ambiguousCount++; continue; }
		confidentCount++;
		const reconciled = truthInLabelmapSpace(truth, opts.truth, opts.labelmapDoc);
		if (reconciled === null) continue;
		const { correspondence } = resolveCorrespondence(reconciled, labelmap, opts.labelmapDoc.widthPx, opts.labelmapDoc.heightPx, entities, opts.maxCorrespondenceDistancePx, opts.labelmapDoc.entityIds);
		if (correspondence.entityId === null || !correspondence.reliable) continue;
		correspondedCount++;
		correspondedEntityIds.push(correspondence.entityId);
	}

	const stageIndexByName = new Map(opts.stageOrder.map((name, index) => [name, index]));
	const stages: FunnelStageCounts[] = opts.stageOrder.map((stageName) => ({ stageName, reached: 0, kept: 0 }));
	let materializedCount = 0;
	for (const entityId of correspondedEntityIds) {
		const breakdowns = buildStageBreakdowns(entityId, opts.trace, opts.manifest);
		const byStageName = new Map<string, StageBreakdown[]>();
		for (const breakdown of breakdowns) {
			if (!stageIndexByName.has(breakdown.stageName)) continue;
			const list = byStageName.get(breakdown.stageName) ?? [];
			list.push(breakdown);
			byStageName.set(breakdown.stageName, list);
		}
		for (const [stageName, group] of byStageName) {
			const index = stageIndexByName.get(stageName)!;
			stages[index].reached += 1;
			const anyKept = group.some((b) => b.kept);
			const anyRejected = group.some((b) => !b.kept);
			if (anyKept && anyRejected) stages[index].mixed = (stages[index].mixed ?? 0) + 1;
			else if (anyKept) stages[index].kept += 1;
		}
		if (entities.some((e) => e.parentId === entityId)) materializedCount++;
	}
	return { totalTruthObjects: opts.truth.objects.length, confidentCount, ambiguousCount, correspondedCount, stages, materializedCount };
}