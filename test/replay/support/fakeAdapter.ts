// Test-only fake ReplayAdapter used across the replay test suite. Records exactly the
// configs it was called with (as JSON snapshots) so tests can assert on call history
// without risking aliasing with what the session module stored.

import type { AdapterRunOutput, ReplayAdapter, SourceIdentity } from '../../../src/replay/index.js';
import type { TraceRun } from '../../../src/runtime/index.js';

export interface FakeAdapterOptions {
  defaults?: object;
  buildTrace?: (effectiveConfig: object, callIndex: number) => TraceRun;
  buildSummary?: (effectiveConfig: object, callIndex: number) => Record<string, number | string | boolean | null>;
}

export interface FakeAdapter extends ReplayAdapter {
  calls: object[];
}

function emptyTrace(): TraceRun {
  return { version: 1, stages: [], elements: [], checks: [] };
}

export function makeFakeAdapter(options: FakeAdapterOptions = {}): FakeAdapter {
  const defaults = options.defaults ?? { p6: { swap: { enabled: true, minRibbonImprovementPx: 20 }, forwardGateAngleDeg: 80 } };
  const source: SourceIdentity = { name: 'fixture.png', sha256: 'deadbeef', widthPx: 100, heightPx: 100 };
  const calls: object[] = [];

  const adapter: FakeAdapter = {
    pipelineId: 'test.fixture',
    codeVersion: { app: 'test-sha-1', toph: 'test-sha-2' },
    source,
    defaults,
    paramSchema: [
      { path: 'p6.swap.enabled', label: 'Swap enabled', type: 'boolean', default: true },
      { path: 'p6.swap.minRibbonImprovementPx', label: 'Min ribbon improvement (px)', type: 'number', default: 20, min: 0, max: 200, step: 5 },
      { path: 'p6.forwardGateAngleDeg', label: 'Forward gate angle (deg)', type: 'number', default: 80, min: 0, max: 180, step: 5 },
    ],
    calls,
    async execute(effectiveConfig: object): Promise<AdapterRunOutput> {
      const snapshot = structuredClone(effectiveConfig);
      calls.push(snapshot);
      const callIndex = calls.length - 1;
      const trace = options.buildTrace ? options.buildTrace(effectiveConfig, callIndex) : emptyTrace();
      const summary = options.buildSummary
        ? options.buildSummary(effectiveConfig, callIndex)
        : { wallMs: 10 + callIndex, holes: 18 };
      return { trace, summary };
    },
  };
  return adapter;
}
