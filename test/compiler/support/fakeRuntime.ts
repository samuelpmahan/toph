// Test-only fake Toph runtime used to actually execute compiler-generated
// trace-mode code end-to-end.
//
// This is NOT src/runtime (owned by a later phase; Subagent A must never touch it)
// -- it exists purely so this phase's tests can prove the *compiler's* output is
// correct by running it, not just by inspecting its text.
//
// Implements the exact function signatures the generated code in
// IMPLEMENTATION-DECISIONS.md section 6 calls:
//   enterStage(stageId): number
//   enterElement(stageInvocationId): number
//   gte/lte/gt/lt/eq/neq(elementId, checkId, value, threshold): boolean
//   keep(elementId): void
//
// Every call is recorded into an ordered `events` array, in the exact order the
// generated code invokes them -- this is what the behavioral tests assert against to
// prove short-circuiting (no event for a check that never ran) and evaluation order.
//
// The generated code is executed in a real, separate Node subprocess (see
// execTraceModule.ts) so that its `import * as __toph from "toph"` bare specifier
// resolves through completely ordinary node_modules resolution, independent of
// vitest/Vite's module loader semantics for arbitrary temp-directory files.
// FAKE_RUNTIME_SOURCE is therefore plain, dependency-free ESM JavaScript text --
// written out as node_modules/toph/index.mjs by the test harness, not imported from
// this compiled .ts file directly. Keep the two in sync if you change one.

export type FakeCheckOp = 'gte' | 'lte' | 'gt' | 'lt' | 'eq' | 'neq';

export type FakeEvent =
	| { type: 'enterStage'; stageId: number; invocationId: number }
	| { type: 'enterElement'; stageInvocationId: number; elementId: number }
	| {
			type: 'check';
			op: FakeCheckOp;
			elementId: number;
			checkId: number;
			value: number;
			threshold: number;
			pass: boolean;
	  }
	| { type: 'keep'; elementId: number };

export const FAKE_RUNTIME_SOURCE = `
export const events = [];

let nextInvocationId = 1;
let nextElementId = 1;

function record(event) {
	events.push(event);
}

export function enterStage(stageId) {
	const invocationId = nextInvocationId++;
	record({ type: 'enterStage', stageId, invocationId });
	return invocationId;
}

export function enterElement(stageInvocationId) {
	const elementId = nextElementId++;
	record({ type: 'enterElement', stageInvocationId, elementId });
	return elementId;
}

function makeCheck(op, compare) {
	return (elementId, checkId, value, threshold) => {
		const pass = compare(value, threshold);
		record({ type: 'check', op, elementId, checkId, value, threshold, pass });
		return pass;
	};
}

export const gte = makeCheck('gte', (a, b) => a >= b);
export const lte = makeCheck('lte', (a, b) => a <= b);
export const gt = makeCheck('gt', (a, b) => a > b);
export const lt = makeCheck('lt', (a, b) => a < b);
export const eq = makeCheck('eq', (a, b) => a === b);
export const neq = makeCheck('neq', (a, b) => a !== b);

export function keep(elementId) {
	record({ type: 'keep', elementId });
}
`;
