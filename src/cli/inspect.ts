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
	/** Absent/undefined means 'confident' -- this keeps every pre-existing truth.json
	 * (e.g. examples/heritage-first-loss/truth.json, which has no `status` field at all)
	 * parsing and behaving exactly as before. 'ambiguous' means the ground-truth author
	 * could not reliably pin this point down (e.g. a visually-merged glyph) and
	 * inspectTruth must not attempt any correspondence guess for it -- see `reason`. */
	status?: 'confident' | 'ambiguous';
	/** Human-readable explanation, present when status === 'ambiguous'. */
	reason?: string;
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

/** DEFAULT_MAX_CORRESPONDENCE_DISTANCE_PX's rationale lives on that constant, just below --
 * `reliable` mirrors the same judgment as a boolean so callers don't have to re-derive it
 * from `distancePx`/`method` themselves. Direct pixel hits are always reliable (distance 0,
 * unambiguous by construction -- the truth point landed exactly on a labeled pixel, there is
 * no "nearest" guess involved). A nearest-pixel match is also always reliable, for the same
 * reason: it's a labeled pixel actually found near the truth point, not an aggregate guess --
 * see `nearestLabeledPixel`'s doc comment. A nearest-centroid match is reliable only when its
 * distance is within the caller's threshold; beyond that it is still reported honestly
 * (method, distance, and entityId are never hidden or nulled out) but callers should treat it
 * as "no dependable correspondence," the same as `method: 'none'`. */
export interface Correspondence {
	method: 'direct-pixel-hit' | 'nearest-pixel' | 'nearest-centroid' | 'none';
	distancePx: number | null;
	entityId: number | null;
	reliable: boolean;
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

/**
 * A ground-truth point marked `status: 'ambiguous'` in its TruthDocument. Deliberately
 * carries NOTHING else -- no `whiteMaskSupport`, `correspondence`, `component`, `stages`,
 * or `downstreamNote` -- because an ambiguous point is never resolved at all (see
 * `inspectTruth`'s short-circuit). This is a genuinely different shape from "resolved but
 * found nothing" (InspectReportResolved with `component: null`/`stages: []`), not the
 * same shape with empty-looking values, so "never looked" can't be mistaken for "looked,
 * found nothing."
 */
export interface InspectReportAmbiguous {
	truth: TruthObject;
	ambiguous: { reason: string };
}

/** A confident ground-truth point that was actually resolved (whether or not that
 * resolution found a reliable corresponding component). `component: null`/`stages: []`
 * covers both "no correspondence at all" and "a nearest-centroid match that exceeded the
 * reliability threshold" -- see `correspondence.reliable` and `inspectTruth`'s doc
 * comment for why an unreliable match doesn't get a component/stage report. */
export interface InspectReportResolved {
	truth: TruthObject;
	ambiguous?: undefined;
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

export type InspectReport = InspectReportAmbiguous | InspectReportResolved;

function euclideanDistance(ax: number, ay: number, bx: number, by: number): number {
	return Math.hypot(ax - bx, ay - by);
}

function findEntityCentroid(entity: EntityRecord): { x: number; y: number } | null {
	const { centroidX, centroidY } = entity.attrs;
	if (typeof centroidX === 'number' && typeof centroidY === 'number') return { x: centroidX, y: centroidY };
	return null;
}

type PixelHit = { x: number; y: number; label: number; distance: number };

/**
 * The direct fix for the failure DEFAULT_MAX_CORRESPONDENCE_DISTANCE_PX's doc comment
 * describes: a large/irregular component's aggregate centroid can sit far from a truth point
 * that nonetheless lands right on that component's own pixels (the tee glyph merged with
 * unrelated bright pixels during detection). Rather than trusting the centroid, this walks an
 * expanding square ring -- Chebyshev distance 0, 1, 2, ... -- outward from the rounded truth
 * pixel, directly against the decoded labelmap, and stops at the first ring containing any
 * labeled (non-zero) pixel: real, non-aggregate evidence that the truth point sits right next
 * to this exact component, not a guess about which component is "closest" in some aggregate
 * sense. Bounded by `maxDistancePx` so it can't wander arbitrarily far across a sparse
 * labelmap. A ring is Chebyshev-uniform but not Euclidean-uniform (corner pixels are farther
 * from the truth point than edge-midpoint pixels at the same radius), so among the winning
 * ring's hits, ties are broken by true Euclidean distance to the exact (unrounded) truth
 * point first, then -- if still tied -- by lowest row-major pixel index, so the result is the
 * same on every run. Returns null if no labeled pixel is found within `maxDistancePx`.
 */
function nearestLabeledPixel(
	labelmap: Uint32Array,
	widthPx: number,
	heightPx: number,
	point: { x: number; y: number },
	maxDistancePx: number
): PixelHit | null {
	const roundedX = Math.round(point.x);
	const roundedY = Math.round(point.y);

	// Ties within a ring are broken by true Euclidean distance to the exact (unrounded)
	// truth point first (a ring is Chebyshev-uniform, not Euclidean-uniform -- its corners
	// are farther from the truth point than its edge midpoints), then -- if still tied --
	// by lowest row-major pixel index, so the winner is the same on every run.
	const consider = (x: number, y: number, best: PixelHit | null): PixelHit | null => {
		if (x < 0 || y < 0 || x >= widthPx || y >= heightPx) return best;
		const label = labelmap[y * widthPx + x];
		if (label === 0) return best;
		const distance = euclideanDistance(point.x, point.y, x, y);
		const rowMajorIndex = y * widthPx + x;
		const bestRowMajorIndex = best === null ? -1 : best.y * widthPx + best.x;
		if (best === null || distance < best.distance || (distance === best.distance && rowMajorIndex < bestRowMajorIndex)) {
			return { x, y, label, distance };
		}
		return best;
	};

	for (let radius = 0; radius <= maxDistancePx; radius++) {
		let best: PixelHit | null = null;
		if (radius === 0) {
			best = consider(roundedX, roundedY, best);
		} else {
			// Visit only the ring's perimeter -- O(radius) cells -- rather than scanning the
			// full (2*radius+1)^2 filled square and discarding the interior. That distinction
			// matters because callers can pass a `maxDistancePx` much larger than the 20px
			// default (buildSurvivalFunnel's tests do), and a filled-square scan would make
			// the search cost cubic in `maxDistancePx` instead of quadratic.
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

/**
 * Default ceiling for a nearest-centroid correspondence to count as `reliable`. Chosen on
 * the order of the smallest realistic glyph in the imagery this tool was built against: a
 * real Heritage nearest-centroid fallback once "matched" a ~15px-wide tee glyph to an
 * unrelated entity 30px away -- clearly not a dependable correspondence, just the
 * least-bad option among unrelated candidates. 20px sits between "close enough to
 * plausibly be the same glyph" and "clearly a different object," for glyphs at roughly
 * that scale. This is a default, not a hard-coded assumption: callers whose imagery is at
 * a different resolution/scale should pass their own `maxDistancePx`.
 */
export const DEFAULT_MAX_CORRESPONDENCE_DISTANCE_PX = 20;

/**
 * Resolves ground-truth point -> component entity, via the correspondence DESIGN.md
 * describes, in three steps: (1) does the labelmap have a bright pixel exactly at the
 * truth point -- if so, that pixel's label IS the answer, distance 0, no guessing; (2)
 * otherwise, search an expanding ring of actual labeled pixels outward from that same
 * rounded point (see `nearestLabeledPixel`'s doc comment) -- still real pixel evidence,
 * just not exactly under the point; (3) only if that bounded search finds nothing, fall
 * back to the nearest spawned entity by centroid distance, reporting the method and
 * distance explicitly rather than silently picking one -- so a reader can judge whether
 * "nearest" is actually close enough to mean anything. A nearest-centroid match beyond
 * `maxDistancePx` is still reported honestly (method/distance/entityId are never hidden)
 * but flagged `reliable: false` -- see Correspondence's doc comment.
 */
export function resolveCorrespondence(
	truth: TruthObject,
	labelmap: Uint32Array,
	widthPx: number,
	heightPx: number,
	entities: readonly EntityRecord[],
	maxDistancePx: number = DEFAULT_MAX_CORRESPONDENCE_DISTANCE_PX
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
			correspondence: { method: 'direct-pixel-hit', distancePx: 0, entityId: entity?.id ?? null, reliable: true },
		};
	}

	const nearestPixel = nearestLabeledPixel(labelmap, widthPx, heightPx, truth.point, maxDistancePx);
	if (nearestPixel !== null) {
		// Label N corresponds to the entity spawned at ordinal N-1 -- same mapping
		// direct-pixel-hit uses just above, because this is the same kind of evidence (an
		// actual labeled pixel), just not exactly under the truth point.
		const entity = entities.find((e) => e.ordinal === nearestPixel.label - 1);
		return {
			whiteMaskSupport,
			correspondence: {
				method: 'nearest-pixel',
				distancePx: nearestPixel.distance,
				entityId: entity?.id ?? null,
				reliable: true,
			},
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
		return { whiteMaskSupport, correspondence: { method: 'none', distancePx: null, entityId: null, reliable: false } };
	}
	return {
		whiteMaskSupport,
		correspondence: {
			method: 'nearest-centroid',
			distancePx: best.distance,
			entityId: best.entity.id,
			reliable: best.distance <= maxDistancePx,
		},
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
	/** Passed through to resolveCorrespondence's nearest-centroid reliability check.
	 * Defaults to DEFAULT_MAX_CORRESPONDENCE_DISTANCE_PX. */
	maxCorrespondenceDistancePx?: number;
}

export function inspectTruth(opts: InspectOptions): InspectReport {
	const truth = opts.truth.objects.find((o) => o.label === opts.truthLabel);
	if (!truth) {
		throw new Error(`toph inspect: no ground-truth object labeled "${opts.truthLabel}" in the supplied truth document.`);
	}

	// An ambiguous truth object is never resolved at all -- no direct-pixel-hit lookup,
	// no nearest-centroid search, nothing that could produce a number. Short-circuit
	// before touching the labelmap or trace.entities, per IMPLEMENTATION-DECISIONS.md's
	// "never approximate silently" stance: a point the ground-truth author explicitly
	// couldn't pin down must not come back looking like a confident (or confidently
	// empty) answer.
	if (truth.status === 'ambiguous') {
		return {
			truth,
			ambiguous: { reason: truth.reason ?? '(no reason given in the ground-truth fixture)' },
		};
	}

	const labelmap = decodeLabelmap(opts.labelmapDoc);
	const entities = opts.trace.entities ?? [];
	const { whiteMaskSupport, correspondence } = resolveCorrespondence(
		truth,
		labelmap,
		opts.labelmapDoc.widthPx,
		opts.labelmapDoc.heightPx,
		entities,
		opts.maxCorrespondenceDistancePx
	);

	let component: InspectReportResolved['component'] = null;
	let stages: StageBreakdown[] = [];
	let downstreamNote = 'No corresponding component entity was found for this ground-truth point.';

	// An unreliable nearest-centroid match is reported honestly above (method, distance,
	// entityId), but is NOT trusted enough to proceed to component/stage reporting --
	// same spirit as the ambiguous short-circuit: we looked, but "closest of the
	// unrelated candidates" is not a dependable correspondence worth building a stage
	// breakdown on top of.
	if (correspondence.entityId !== null && correspondence.reliable) {
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
	} else if (correspondence.entityId !== null && !correspondence.reliable) {
		downstreamNote = `The nearest entity (id ${correspondence.entityId}) is ${correspondence.distancePx?.toFixed(2)}px away, beyond the reliable-match threshold -- not treated as a corresponding component, so no stage breakdown was computed.`;
	}

	return { truth, whiteMaskSupport, correspondence, component, stages, downstreamNote };
}

/** Per-stage counts for buildSurvivalFunnel, in the caller-supplied `stageOrder`. */
export interface FunnelStageCounts {
	stageName: string;
	/** Truth objects whose resolved (reliable) entity had at least one check event in this
	 * stage. */
	reached: number;
	/** Of `reached`, how many passed every check recorded for that stage -- the same
	 * "kept" definition StageBreakdown.kept already computes (via buildStageBreakdowns),
	 * not a second pass/fail derivation. */
	kept: number;
}

export interface FunnelReport {
	totalTruthObjects: number;
	confidentCount: number;
	ambiguousCount: number;
	/** Of the confident ones: how many resolved to a reliable corresponding component at
	 * all (direct-pixel-hit, or nearest-centroid within the reliability threshold). An
	 * unreliable nearest-centroid match does not count here, same as no match. */
	correspondedCount: number;
	stages: FunnelStageCounts[];
	/** Of the corresponded entities: how many have their id appear as some OTHER entity's
	 * `parentId` anywhere in `trace.entities` (i.e. a later `.map()`-derived spawn site
	 * recognized them as its source object). */
	materializedCount: number;
}

/**
 * Runs `inspectTruth`'s correspondence + stage-breakdown logic across an ENTIRE truth
 * fixture at once, instead of one point at a time, and tallies a simple survival funnel:
 * how many ground-truth objects are confident vs. ambiguous, how many of the confident
 * ones reliably corresponded to a component at all, how many of those reached and
 * survived each stage in `stageOrder` (in order), and how many ultimately materialized
 * into a later derived entity. Ambiguous truth objects and unreliable correspondences are
 * excluded from every count past `ambiguousCount`/`correspondedCount` -- exactly the same
 * "don't guess" stance `inspectTruth` takes for a single point, applied fixture-wide.
 */
export function buildSurvivalFunnel(opts: {
	truth: TruthDocument;
	trace: TraceRun;
	manifest: Pick<ManifestFragment, 'stages' | 'checks' | 'entityKinds'>;
	labelmapDoc: LabelmapDocument;
	/** Stage NAMES in pipeline order, e.g. ['p1.tee.geometry', 'p1.tee.appearance'].
	 * Never hardcoded by this function -- whatever the caller's trace/manifest actually
	 * has. A name with no matching manifest stage simply reports reached=0, kept=0. */
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
		if (truth.status === 'ambiguous') {
			ambiguousCount += 1;
			continue;
		}
		confidentCount += 1;

		const { correspondence } = resolveCorrespondence(
			truth,
			labelmap,
			opts.labelmapDoc.widthPx,
			opts.labelmapDoc.heightPx,
			entities,
			opts.maxCorrespondenceDistancePx
		);
		if (correspondence.entityId === null || !correspondence.reliable) continue;

		correspondedCount += 1;
		correspondedEntityIds.push(correspondence.entityId);
	}

	const stageIndexByName = new Map(opts.stageOrder.map((name, index) => [name, index]));
	const stages: FunnelStageCounts[] = opts.stageOrder.map((stageName) => ({ stageName, reached: 0, kept: 0 }));

	let materializedCount = 0;
	for (const entityId of correspondedEntityIds) {
		// Reuse buildStageBreakdowns (the exact same function/logic inspectTruth's
		// single-point query calls) rather than re-deriving "which stage did this entity
		// reach, did it pass every check there" a second way that could drift.
		const breakdowns = buildStageBreakdowns(entityId, opts.trace, opts.manifest);
		for (const breakdown of breakdowns) {
			const index = stageIndexByName.get(breakdown.stageName);
			if (index === undefined) continue;
			stages[index].reached += 1;
			if (breakdown.kept) stages[index].kept += 1;
		}

		if (entities.some((e) => e.parentId === entityId)) materializedCount += 1;
	}

	return {
		totalTruthObjects: opts.truth.objects.length,
		confidentCount,
		ambiguousCount,
		correspondedCount,
		stages,
		materializedCount,
	};
}
