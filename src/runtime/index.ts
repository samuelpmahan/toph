// Toph trace runtime. It records append-only execution evidence and deliberately does
// not compute semantic verdicts; those belong to the query layer.

export type CheckOperator = 'gte' | 'lte' | 'gt' | 'lt' | 'eq' | 'neq';
export interface StageInvocationRecord { invocationId: number; stageId: number; seq: number; }
export interface ElementRecord { id: number; stageInvocationId: number; ordinal: number; kept: boolean; }
export interface CheckRecord { stageInvocationId: number; elementId: number; checkId: number; operator: CheckOperator; value: number | boolean; threshold: number | boolean; pass: boolean; }
export type AssetKind = 'mask';
export interface AssetRecord { id: number; name: string; kind: AssetKind; widthPx: number; heightPx: number; }
export interface EntityRecord { id: number; kindId: number; ordinal: number; attrs: Record<string, number | string | boolean>; parentId?: number; }
export interface MeasureRecord { stageInvocationId: number; name: string; value: number | string | boolean | null; unit?: string; }

// -----------------------------------------------------------------------------------------
// Evidence (observational geometry). Optional, presentation-only annotations that preserve
// the actual source-space pixels/geometry an algorithm already looked at when it produced a
// measurement or decision. Recording evidence NEVER changes control flow or any verdict --
// it only lets a viewer draw the literal thing that was measured, registered to the source
// image. Shapes are in source-image pixel coordinates; a 'component' shape references pixels
// in a labelmap by its integer label. Trace-diff intentionally ignores evidence.
export type EvidenceRole = 'measured' | 'current' | 'proposed' | 'historical' | 'threshold' | 'context';
export type EvidenceShape =
	| { t: 'point'; x: number; y: number; label?: string }
	| { t: 'segment'; x1: number; y1: number; x2: number; y2: number; label?: string }
	| { t: 'polyline'; pts: Array<[number, number]>; closed?: boolean; label?: string }
	| { t: 'bbox'; x: number; y: number; w: number; h: number; label?: string }
	| { t: 'circle'; x: number; y: number; r: number; label?: string }
	| { t: 'angle'; x: number; y: number; fromDeg: number; toDeg: number; radius: number; label?: string }
	| { t: 'vector'; x: number; y: number; dx: number; dy: number; label?: string }
	| { t: 'component'; assetId: number; label: number };
export interface EvidenceRecord {
	stageInvocationId: number;
	entityId?: number;       // entity this evidence is about, if any
	label?: string;          // human name of the measurement/decision, e.g. "Forward gate angle"
	measure?: string;        // links to a MeasureRecord.name at this stage, if any
	checkId?: number;        // links to a CheckRecord.checkId at this stage, if any
	value?: number | string | boolean;
	unit?: string;
	operator?: CheckOperator;
	threshold?: number;
	decision?: string;       // resulting decision label, e.g. "SWAP" | "KEEP" | "PASS" | "FAIL"
	role?: EvidenceRole;
	shapes: EvidenceShape[];
}

export interface TraceRun { version: 1; pipeline?: string; stages: StageInvocationRecord[]; elements: ElementRecord[]; checks: CheckRecord[]; assets?: AssetRecord[]; entities?: EntityRecord[]; dataflow?: DataflowEvent[]; measures?: MeasureRecord[]; evidence?: EvidenceRecord[]; }
export interface StartTraceOptions { pipeline?: string; }

interface Session {
	pipeline?: string;
	stages: StageInvocationRecord[];
	elements: ElementRecord[];
	checks: CheckRecord[];
	assets: AssetRecord[];
	entities: EntityRecord[];
	dataflow: DataflowEvent[];
	measures: MeasureRecord[];
	evidence: EvidenceRecord[];
	nextStageInvocationId: number;
	nextElementId: number;
	nextEntityId: number;
	seqByStageId: Map<number, number>;
	nextOrdinalByStageInvocation: Map<number, number>;
	elementsById: Map<number, ElementRecord>;
	rasterBytesById: Map<number, Uint8Array | Uint8ClampedArray>;
	entityIdByRef: WeakMap<object, number>;
}

let active: Session | null = null;
function requireSession(fnName: string): Session {
	if (active === null) throw new Error(`toph: ${fnName}() was called with no active trace session. Call startTrace() before running instrumented code (and finishTrace() when done).`);
	return active;
}

export function startTrace(opts: StartTraceOptions = {}): void {
	if (active !== null) throw new Error('toph: startTrace() was called while a trace session is already active. Call finishTrace() to end the current session before starting a new one.');
	active = { pipeline: opts.pipeline, stages: [], elements: [], checks: [], assets: [], entities: [], dataflow: [], measures: [], evidence: [], nextStageInvocationId: 1, nextElementId: 1, nextEntityId: 1, seqByStageId: new Map(), nextOrdinalByStageInvocation: new Map(), elementsById: new Map(), rasterBytesById: new Map(), entityIdByRef: new WeakMap() };
}

export function finishTrace(): TraceRun {
	const session = requireSession('finishTrace');
	const run: TraceRun = { version: 1, stages: session.stages, elements: session.elements, checks: session.checks };
	if (session.pipeline !== undefined) run.pipeline = session.pipeline;
	if (session.assets.length > 0) run.assets = session.assets;
	if (session.entities.length > 0) run.entities = session.entities;
	if (session.dataflow.length > 0) run.dataflow = session.dataflow;
	if (session.measures.length > 0) run.measures = session.measures;
	if (session.evidence.length > 0) run.evidence = session.evidence;
	active = null;
	return run;
}

export interface FinishedTraceWithAssets { trace: TraceRun; assetBytes: Array<{ asset: AssetRecord; bytes: Uint8Array | Uint8ClampedArray }>; }
export function finishTraceWithAssets(): FinishedTraceWithAssets {
	const session = requireSession('finishTrace');
	const assetBytes = session.assets.flatMap((asset) => { const bytes = session.rasterBytesById.get(asset.id); return bytes === undefined ? [] : [{ asset, bytes }]; });
	return { trace: finishTrace(), assetBytes };
}

export function enterStage(stageId: number): number {
	const session = requireSession('enterStage');
	const invocationId = session.nextStageInvocationId++;
	const seq = session.seqByStageId.get(stageId) ?? 0;
	session.seqByStageId.set(stageId, seq + 1);
	session.stages.push({ invocationId, stageId, seq });
	session.nextOrdinalByStageInvocation.set(invocationId, 0);
	return invocationId;
}

export function enterElement(stageInvocationId: number, ref?: object): number {
	const session = requireSession('enterElement');
	const ordinal = session.nextOrdinalByStageInvocation.get(stageInvocationId);
	if (ordinal === undefined) throw new Error(`toph: enterElement() was called with stage invocation id ${stageInvocationId}, which was not produced by enterStage() in the current trace session.`);
	if (ref !== undefined && ref !== null && typeof ref === 'object') {
		const entityId = session.entityIdByRef.get(ref);
		if (entityId !== undefined) { session.elementsById.set(entityId, { id: entityId, stageInvocationId, ordinal, kept: false }); return entityId; }
	}
	session.nextOrdinalByStageInvocation.set(stageInvocationId, ordinal + 1);
	const id = session.nextElementId++;
	const record: ElementRecord = { id, stageInvocationId, ordinal, kept: false };
	session.elements.push(record);
	session.elementsById.set(id, record);
	return id;
}

function lookupElement(session: Session, fnName: string, elementId: number): ElementRecord {
	const record = session.elementsById.get(elementId);
	if (record === undefined) throw new Error(`toph: ${fnName}() was called with element id ${elementId}, which was not produced by enterElement() in the current trace session.`);
	return record;
}
function makeCheck<T extends number | boolean>(operator: CheckOperator, compare: (value: T, threshold: T) => boolean) {
	return (elementId: number, checkId: number, value: T, threshold: T): boolean => { const session = requireSession(operator); const element = lookupElement(session, operator, elementId); const pass = compare(value, threshold); session.checks.push({ stageInvocationId: element.stageInvocationId, elementId, checkId, operator, value, threshold, pass }); return pass; };
}
export const gte = makeCheck<number>('gte', (v, t) => v >= t);
export const lte = makeCheck<number>('lte', (v, t) => v <= t);
export const gt = makeCheck<number>('gt', (v, t) => v > t);
export const lt = makeCheck<number>('lt', (v, t) => v < t);
export const eq = makeCheck<number | boolean>('eq', (v, t) => v === t);
export const neq = makeCheck<number | boolean>('neq', (v, t) => v !== t);
export function keep(elementId: number): void { const session = requireSession('keep'); lookupElement(session, 'keep', elementId).kept = true; }

function copyPrimitiveAttrs(value: unknown): Record<string, number | string | boolean> {
	const attrs: Record<string, number | string | boolean> = {};
	if (value === null || typeof value !== 'object') return attrs;
	for (const [key, propValue] of Object.entries(value as Record<string, unknown>)) if (typeof propValue === 'number' || typeof propValue === 'string' || typeof propValue === 'boolean') attrs[key] = propValue;
	return attrs;
}
function spawnOneEntity(session: Session, kindId: number, el: unknown, ordinal: number, parentId?: number): EntityRecord {
	const id = session.nextEntityId++;
	if (el !== null && typeof el === 'object') session.entityIdByRef.set(el, id);
	const record: EntityRecord = { id, kindId, ordinal, attrs: copyPrimitiveAttrs(el) };
	if (parentId !== undefined) record.parentId = parentId;
	session.entities.push(record);
	return record;
}
export function spawnEntities(kindId: number, elements: readonly unknown[]): number[] { const session = requireSession('spawnEntities'); return elements.map((el, ordinal) => spawnOneEntity(session, kindId, el, ordinal).id); }
export function spawnDerivedEntities(kindId: number, elements: readonly unknown[], parents: readonly unknown[]): number[] { const session = requireSession('spawnDerivedEntities'); return elements.map((el, ordinal) => { const parent = parents[ordinal]; const parentId = parent !== null && typeof parent === 'object' ? session.entityIdByRef.get(parent) : undefined; return spawnOneEntity(session, kindId, el, ordinal, parentId).id; }); }

export function snapshotRaster(assetId: number, name: string, kind: AssetKind, ref: Uint8Array | Uint8ClampedArray, widthPx: number, heightPx: number): void { const session = requireSession('snapshotRaster'); session.rasterBytesById.set(assetId, ref.slice()); session.assets.push({ id: assetId, name, kind, widthPx, heightPx }); }
export function getRasterBytes(assetId: number): Uint8Array | Uint8ClampedArray | undefined { return requireSession('getRasterBytes').rasterBytesById.get(assetId); }

export type EntityRef = number | object;
export type DataflowBasis = Record<string, number | string | boolean | null>;
export interface DataflowMapEvent { t: 'map'; stage: number; parents: number[]; children: number[]; }
export interface DataflowSplitEvent { t: 'split'; stage: number; parent: number; children: number[]; }
export interface DataflowMergeEvent { t: 'merge'; stage: number; parents: number[]; child: number; rep?: number; }
export interface DataflowReduceEvent { t: 'reduce'; stage: number; inputs: number[]; result: number | string | boolean | null; output?: number; }
export interface DataflowRankEvent { t: 'rank'; stage: number; entity: number; rank: number; cutoff?: number; }
export interface DataflowSelectEvent { t: 'select'; stage: number; kept: number[]; rejected: number[]; name?: string; basis?: DataflowBasis; }
export interface DataflowSuppressEvent { t: 'suppress'; stage: number; entity: number; by?: number; }
export interface DataflowRelateEvent { t: 'relate'; stage: number; left: number; right: number; join?: number; relation?: string; }
export type DataflowEvent = DataflowMapEvent | DataflowSplitEvent | DataflowMergeEvent | DataflowReduceEvent | DataflowRankEvent | DataflowSelectEvent | DataflowSuppressEvent | DataflowRelateEvent;

export function idOf(ref: object): number { return requireSession('idOf').entityIdByRef.get(ref) ?? 0; }
function requireDataflowEntity(session: Session, id: number): void { if (!Number.isInteger(id) || id <= 0 || !session.entities.some((entity) => entity.id === id)) throw new Error('toph: recordDataflow() referenced unknown entity id ' + String(id) + '.'); }
function requireDataflowStage(session: Session, stage: number): void { if (!Number.isInteger(stage) || !session.stages.some((invocation) => invocation.invocationId === stage)) throw new Error('toph: recordDataflow() referenced unknown stage invocation id ' + String(stage) + '.'); }

export function recordMeasure(stageInvocationId: number, name: string, value: number | string | boolean | null, unit?: string): void {
	const session = requireSession('recordMeasure');
	requireDataflowStage(session, stageInvocationId);
	const record: MeasureRecord = { stageInvocationId, name, value };
	if (unit !== undefined) record.unit = unit;
	session.measures.push(record);
}

function copyEvidenceShape(shape: EvidenceShape): EvidenceShape {
	return shape.t === 'polyline' ? { ...shape, pts: shape.pts.map(([x, y]) => [x, y] as [number, number]) } : { ...shape };
}
/**
 * Records observational evidence for a stage/entity: the actual source-space geometry that a
 * measurement or decision was computed from, plus its value/threshold/decision. Purely
 * additive -- it does not touch elements, checks, kept flags, or dataflow, so it can never
 * change what the pipeline decided. Validates that the referenced stage (and entity, if given)
 * exist in the current trace so evidence can always be resolved by a viewer.
 */
export function recordEvidence(record: EvidenceRecord): void {
	const session = requireSession('recordEvidence');
	requireDataflowStage(session, record.stageInvocationId);
	if (record.entityId !== undefined) requireDataflowEntity(session, record.entityId);
	session.evidence.push({ ...record, shapes: record.shapes.map(copyEvidenceShape) });
}

function copyDataflowEvent(event: DataflowEvent): DataflowEvent {
	switch (event.t) {
		case 'map': return { ...event, parents: [...event.parents], children: [...event.children] };
		case 'split': return { ...event, children: [...event.children] };
		case 'merge': return { ...event, parents: [...event.parents] };
		case 'reduce': return { ...event, inputs: [...event.inputs] };
		case 'select': return { ...event, kept: [...event.kept], rejected: [...event.rejected], ...(event.basis === undefined ? {} : { basis: { ...event.basis } }) };
		default: return { ...event };
	}
}
export function recordDataflow(event: DataflowEvent): void {
	const session = requireSession('recordDataflow');
	requireDataflowStage(session, event.stage);
	const ids: number[] = [];
	switch (event.t) {
		case 'map': ids.push(...event.parents, ...event.children); break;
		case 'split': ids.push(event.parent, ...event.children); break;
		case 'merge': ids.push(...event.parents, event.child); if (event.rep !== undefined) ids.push(event.rep); break;
		case 'reduce': ids.push(...event.inputs); if (event.output !== undefined) ids.push(event.output); break;
		case 'rank': ids.push(event.entity); break;
		case 'select': ids.push(...event.kept, ...event.rejected); break;
		case 'suppress': ids.push(event.entity); if (event.by !== undefined) ids.push(event.by); break;
		case 'relate': ids.push(event.left, event.right); if (event.join !== undefined) ids.push(event.join); break;
	}
	for (const id of ids) requireDataflowEntity(session, id);
	session.dataflow.push(copyDataflowEvent(event));
}