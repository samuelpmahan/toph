// Unit tests on the runtime's Phase 5 additions in isolation (no compiler involved) --
// snapshotRaster/getRasterBytes and spawnEntities/enterElement's new `ref` parameter.
// See test/compiler/entities-and-assets.test.ts for the end-to-end proof that these
// satisfy the real compiler's generated output; this file exercises edge cases that
// aren't reachable (or aren't worth reaching) through real generated code, the same way
// test/runtime/session.test.ts complements test/runtime/integration.test.ts for the
// Phase 1-4 primitives.

import { beforeEach, describe, expect, it } from 'vitest';
import * as toph from '../../src/runtime/index.js';

beforeEach(() => {
	try {
		toph.finishTrace();
	} catch {
		// No active session to clean up -- fine, that's the expected steady state.
	}
});

describe('calls with no active session fail loudly, same style as the Phase 1-4 primitives', () => {
	it('snapshotRaster() throws a clear, specific error', () => {
		expect(() => toph.snapshotRaster(1, 'a', 'mask', new Uint8Array([1]), 1, 1)).toThrow(
			/toph: snapshotRaster\(\).*no active trace session/i
		);
	});

	it('getRasterBytes() throws a clear, specific error', () => {
		expect(() => toph.getRasterBytes(1)).toThrow(/toph: getRasterBytes\(\).*no active trace session/i);
	});

	it('spawnEntities() throws a clear, specific error', () => {
		expect(() => toph.spawnEntities(1, [{}])).toThrow(/toph: spawnEntities\(\).*no active trace session/i);
	});
});

describe('snapshotRaster / getRasterBytes', () => {
	it('getRasterBytes returns undefined for an assetId never snapshotted this session', () => {
		toph.startTrace();
		expect(toph.getRasterBytes(999)).toBeUndefined();
		toph.finishTrace();
	});

	it('getRasterBytes returns a COPY, independent of later mutation of the original ref', () => {
		toph.startTrace();
		const ref = new Uint8Array([1, 2, 3]);
		toph.snapshotRaster(7, 'mask.a', 'mask', ref, 3, 1);

		ref[0] = 99; // mutate the original AFTER snapshotting
		const bytes = toph.getRasterBytes(7);
		expect(Array.from(bytes!)).toEqual([1, 2, 3]); // pristine, not [99, 2, 3]
		expect(bytes).not.toBe(ref); // genuinely a different array object

		toph.finishTrace();
	});

	it('preserves the exact typed-array subclass (Uint8ClampedArray in, Uint8ClampedArray out)', () => {
		toph.startTrace();
		const ref = new Uint8ClampedArray([10, 20]);
		toph.snapshotRaster(1, 'clamped', 'mask', ref, 2, 1);
		const bytes = toph.getRasterBytes(1);
		expect(bytes).toBeInstanceOf(Uint8ClampedArray);
		toph.finishTrace();
	});

	it('multiple distinct assetIds are tracked independently', () => {
		toph.startTrace();
		toph.snapshotRaster(1, 'a', 'mask', new Uint8Array([1]), 1, 1);
		toph.snapshotRaster(2, 'b', 'mask', new Uint8Array([2]), 1, 1);
		expect(Array.from(toph.getRasterBytes(1)!)).toEqual([1]);
		expect(Array.from(toph.getRasterBytes(2)!)).toEqual([2]);
		toph.finishTrace();
	});

	it('finishTrace populates `assets` with metadata only -- no pixel bytes -- and omits it entirely when never called', () => {
		toph.startTrace();
		const runEmpty = toph.finishTrace();
		expect('assets' in runEmpty).toBe(false);

		toph.startTrace();
		toph.snapshotRaster(5, 'bright.mask', 'mask', new Uint8Array([1, 2, 3, 4]), 2, 2);
		const run = toph.finishTrace();
		expect(run.assets).toEqual([{ id: 5, name: 'bright.mask', kind: 'mask', widthPx: 2, heightPx: 2 }]);
		// No raw bytes anywhere on the serialized run.
		expect(JSON.stringify(run)).not.toContain('"1,2,3,4"');
	});

	it('getRasterBytes is unusable after finishTrace() -- throws the same no-active-session error, not a stale lookup', () => {
		toph.startTrace();
		toph.snapshotRaster(1, 'a', 'mask', new Uint8Array([1]), 1, 1);
		toph.finishTrace();
		expect(() => toph.getRasterBytes(1)).toThrow(/no active trace session/i);
	});
});

describe('spawnEntities', () => {
	it('allocates one fresh id per element, in order, and returns them in the same order', () => {
		toph.startTrace();
		const ids = toph.spawnEntities(1, [{ a: 1 }, { a: 2 }, { a: 3 }]);
		expect(new Set(ids).size).toBe(3);
		const run = toph.finishTrace();
		expect(run.entities!.map((e) => e.id)).toEqual(ids);
		expect(run.entities!.map((e) => e.ordinal)).toEqual([0, 1, 2]);
		expect(run.entities!.every((e) => e.kindId === 1)).toBe(true);
	});

	it('copies own enumerable primitive-valued properties into attrs, silently skipping nested objects/arrays/functions', () => {
		toph.startTrace();
		toph.spawnEntities(1, [
			{
				area: 12,
				label: 'x',
				bright: true,
				nested: { a: 1 },
				list: [1, 2, 3],
				fn: () => 1,
				undef: undefined,
				nil: null,
			},
		]);
		const run = toph.finishTrace();
		expect(run.entities![0].attrs).toEqual({ area: 12, label: 'x', bright: true });
	});

	it('is valid to call with zero later consumption -- no enterElement ever looks a spawned entity up', () => {
		toph.startTrace();
		expect(() => toph.spawnEntities(1, [{ a: 1 }, { a: 2 }])).not.toThrow();
		const run = toph.finishTrace();
		expect(run.entities).toHaveLength(2);
	});

	it('non-object elements (e.g. primitives) still get an id and an empty attrs record, without crashing', () => {
		toph.startTrace();
		const ids = toph.spawnEntities(1, [42, 'hello', null, true]);
		expect(ids).toHaveLength(4);
		const run = toph.finishTrace();
		expect(run.entities!.every((e) => Object.keys(e.attrs).length === 0)).toBe(true);
	});

	it('spawning zero elements records nothing and returns an empty array', () => {
		toph.startTrace();
		const ids = toph.spawnEntities(1, []);
		expect(ids).toEqual([]);
		const run = toph.finishTrace();
		expect('entities' in run).toBe(false);
	});

	it('two different kindIds produce independent entity records, correctly tagged', () => {
		toph.startTrace();
		toph.spawnEntities(10, [{ a: 1 }]);
		toph.spawnEntities(20, [{ b: 2 }, { b: 3 }]);
		const run = toph.finishTrace();
		expect(run.entities!.filter((e) => e.kindId === 10)).toHaveLength(1);
		expect(run.entities!.filter((e) => e.kindId === 20)).toHaveLength(2);
	});
});

describe('spawnDerivedEntities', () => {
	it('links a derived entity to its parent via parentId when the parent was previously spawned', () => {
		toph.startTrace();
		const parentObj = { area: 5 };
		const [parentId] = toph.spawnEntities(1, [parentObj]);
		const derivedObj = { x: 1 }; // a BRAND NEW object, not the same reference as parentObj
		const [derivedId] = toph.spawnDerivedEntities(2, [derivedObj], [parentObj]);
		const run = toph.finishTrace();

		expect(derivedId).not.toBe(parentId);
		const derivedRecord = run.entities!.find((e) => e.id === derivedId)!;
		expect(derivedRecord.parentId).toBe(parentId);
		expect(derivedRecord.kindId).toBe(2);
		expect(derivedRecord.attrs).toEqual({ x: 1 });
	});

	it('omits parentId (not 0, not null) when the parent was never spawned -- a legitimate, non-error case', () => {
		toph.startTrace();
		const neverSpawnedParent = { area: 5 };
		const derivedObj = { x: 1 };
		const [derivedId] = toph.spawnDerivedEntities(2, [derivedObj], [neverSpawnedParent]);
		const run = toph.finishTrace();

		const derivedRecord = run.entities!.find((e) => e.id === derivedId)!;
		expect('parentId' in derivedRecord).toBe(false);
		expect(JSON.stringify(derivedRecord)).not.toContain('parentId');
	});

	it('spawnEntities-produced entities NEVER carry a parentId field at all', () => {
		toph.startTrace();
		toph.spawnEntities(1, [{ a: 1 }]);
		const run = toph.finishTrace();
		expect('parentId' in run.entities![0]).toBe(false);
	});

	it('one call links each element to ITS OWN corresponding parent by index, not a shared/first one', () => {
		toph.startTrace();
		const parentA = { n: 'a' };
		const parentB = { n: 'b' };
		const [parentIdA, parentIdB] = toph.spawnEntities(1, [parentA, parentB]);
		const derivedA = { m: 'a' };
		const derivedB = { m: 'b' };
		const [derivedIdA, derivedIdB] = toph.spawnDerivedEntities(2, [derivedA, derivedB], [parentA, parentB]);
		const run = toph.finishTrace();

		expect(run.entities!.find((e) => e.id === derivedIdA)!.parentId).toBe(parentIdA);
		expect(run.entities!.find((e) => e.id === derivedIdB)!.parentId).toBe(parentIdB);
	});

	it('a derived entity is ITSELF registered in the identity map -- a later stage consuming its exact reference resolves to the SAME id (transitive identity)', () => {
		toph.startTrace();
		const parentObj = { area: 5 };
		toph.spawnEntities(1, [parentObj]);
		const derivedObj = { x: 1 };
		const [derivedId] = toph.spawnDerivedEntities(2, [derivedObj], [parentObj]);

		const s = toph.enterStage(1);
		const resolvedId = toph.enterElement(s, derivedObj);
		expect(resolvedId).toBe(derivedId);

		const run = toph.finishTrace();
		// The entity-identity path was used (not a fresh ordinal) -- no new record in the
		// public `elements` array.
		expect(run.elements).toEqual([]);
	});

	it('reuses the exact same session-global identity WeakMap spawnEntities/enterElement use -- a parent re-spawned as a DIFFERENT entity later resolves to the LATER spawn, not the first', () => {
		toph.startTrace();
		const obj = { area: 5 };
		const [firstId] = toph.spawnEntities(1, [obj]);
		const [secondId] = toph.spawnEntities(1, [obj]); // same object, re-spawned -- overwrites the WeakMap entry
		expect(secondId).not.toBe(firstId);

		const derivedObj = { x: 1 };
		const [derivedId] = toph.spawnDerivedEntities(2, [derivedObj], [obj]);
		const run = toph.finishTrace();
		expect(run.entities!.find((e) => e.id === derivedId)!.parentId).toBe(secondId);
	});

	it('elements and parents of length zero: returns an empty array and records nothing', () => {
		toph.startTrace();
		const ids = toph.spawnDerivedEntities(1, [], []);
		expect(ids).toEqual([]);
		const run = toph.finishTrace();
		expect('entities' in run).toBe(false);
	});

	it('throws the same no-active-session error style as spawnEntities when called with no active session', () => {
		expect(() => toph.spawnDerivedEntities(1, [{ x: 1 }], [{ area: 1 }])).toThrow(
			/toph: spawnDerivedEntities\(\).*no active trace session/i
		);
	});

	it('non-object parents (primitives, null) are treated as "no known parent" without throwing', () => {
		toph.startTrace();
		const ids = toph.spawnDerivedEntities(1, [{ x: 1 }, { x: 2 }, { x: 3 }], [42, null, 'hello']);
		const run = toph.finishTrace();
		for (const id of ids) {
			expect('parentId' in run.entities!.find((e) => e.id === id)!).toBe(false);
		}
	});
});

describe('enterElement(stageInvocationId, ref): entity-identity reuse', () => {
	it('a ref that was spawned returns the SAME id every time it is passed again, within the session', () => {
		toph.startTrace();
		const obj = { area: 5 };
		const [entityId] = toph.spawnEntities(1, [obj]);
		const s = toph.enterStage(1);
		const first = toph.enterElement(s, obj);
		const second = toph.enterElement(s, obj);
		expect(first).toBe(entityId);
		expect(second).toBe(entityId);
		toph.finishTrace();
	});

	it('a ref that was never spawned falls back to the normal fresh-ordinal path, unaffected by unrelated spawns', () => {
		toph.startTrace();
		toph.spawnEntities(1, [{ area: 1 }]); // unrelated spawn -- different object
		const s = toph.enterStage(1);
		const neverSpawned = { area: 99 };
		const id = toph.enterElement(s, neverSpawned);
		const run = toph.finishTrace();
		// Ordinary ordinal-scoped element, exactly like calling enterElement(s) with no ref.
		expect(run.elements).toEqual([{ id, stageInvocationId: s, ordinal: 0, kept: false }]);
	});

	it('calling with no ref at all behaves EXACTLY as before (existing Phase 1-4 call shape, unmodified)', () => {
		toph.startTrace();
		const s = toph.enterStage(1);
		const e0 = toph.enterElement(s);
		const e1 = toph.enterElement(s);
		const run = toph.finishTrace();
		expect(run.elements.map((e) => e.ordinal)).toEqual([0, 1]);
		expect(new Set([e0, e1]).size).toBe(2);
	});

	it('an entity-identity call does NOT push a new record into the public `elements` array', () => {
		toph.startTrace();
		const obj = { area: 5 };
		toph.spawnEntities(1, [obj]);
		const s = toph.enterStage(1);
		toph.enterElement(s, obj);
		const run = toph.finishTrace();
		expect(run.elements).toEqual([]);
	});

	it('an entity-identity call does NOT consume/advance the stage invocation\'s ordinal counter for OTHER elements', () => {
		toph.startTrace();
		const spawned = { area: 5 };
		toph.spawnEntities(1, [spawned]);
		const s = toph.enterStage(1);
		toph.enterElement(s, spawned); // entity-identity path -- no ordinal consumed
		const freshId = toph.enterElement(s); // ordinary path -- must still be ordinal 0
		const run = toph.finishTrace();
		expect(run.elements).toEqual([{ id: freshId, stageInvocationId: s, ordinal: 0, kept: false }]);
	});

	it('gte()/keep() both work against a reused entity id without throwing, and record the correct stageInvocationId', () => {
		toph.startTrace();
		const obj = { area: 200 };
		const [entityId] = toph.spawnEntities(1, [obj]);
		const s = toph.enterStage(1);
		const id = toph.enterElement(s, obj);
		expect(id).toBe(entityId);
		expect(() => toph.gte(id, 42, 200, 100)).not.toThrow();
		expect(() => toph.keep(id)).not.toThrow();
		const run = toph.finishTrace();
		expect(run.checks).toEqual([
			{ stageInvocationId: s, elementId: entityId, checkId: 42, operator: 'gte', value: 200, threshold: 100, pass: true },
		]);
	});

	it('the SAME entity flowing through TWO different stage invocations records checks against the correct stageInvocationId each time', () => {
		toph.startTrace();
		const obj = { area: 200 };
		const [entityId] = toph.spawnEntities(1, [obj]);

		const s1 = toph.enterStage(10);
		const id1 = toph.enterElement(s1, obj);
		toph.gte(id1, 1, 200, 50);

		const s2 = toph.enterStage(20);
		const id2 = toph.enterElement(s2, obj);
		toph.gte(id2, 2, 200, 999);

		expect(id1).toBe(entityId);
		expect(id2).toBe(entityId);

		const run = toph.finishTrace();
		expect(run.checks).toEqual([
			{ stageInvocationId: s1, elementId: entityId, checkId: 1, operator: 'gte', value: 200, threshold: 50, pass: true },
			{ stageInvocationId: s2, elementId: entityId, checkId: 2, operator: 'gte', value: 200, threshold: 999, pass: false },
		]);
	});

	it('still throws for an invalid stageInvocationId even when a valid ref is passed', () => {
		toph.startTrace();
		const obj = { area: 5 };
		toph.spawnEntities(1, [obj]);
		expect(() => toph.enterElement(999, obj)).toThrow(/not produced by enterStage/i);
		toph.finishTrace();
	});

	it('a spawned entity from a PREVIOUS (finished) session is not recognized by a new session\'s enterElement', () => {
		toph.startTrace();
		const obj = { area: 5 };
		toph.spawnEntities(1, [obj]);
		toph.finishTrace();

		toph.startTrace();
		const s = toph.enterStage(1);
		const id = toph.enterElement(s, obj); // obj's WeakMap entry lived in the OLD session
		const run = toph.finishTrace();
		// Falls back to the ordinary fresh-ordinal path -- the WeakMap that held the old
		// session's registration was discarded along with the rest of that Session object.
		expect(run.elements).toEqual([{ id, stageInvocationId: s, ordinal: 0, kept: false }]);
	});
});
