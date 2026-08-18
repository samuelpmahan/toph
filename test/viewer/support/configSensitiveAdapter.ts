// A ReplayAdapter whose trace really is sensitive to config, so that /api/diff exercises
// a genuine divergence rather than an artifact of two empty traces happening to match.
// Kept separate from test/replay/support/fakeAdapter.ts (that one is shared across the
// core replay suite and intentionally produces empty traces).

import type { AdapterRunOutput, ReplayAdapter, SourceIdentity } from '../../../src/replay/index.js';
import type { TraceRun } from '../../../src/runtime/index.js';

export interface ConfigSensitiveAdapter extends ReplayAdapter {
  calls: object[];
}

function getAtPath(root: object, path: string): unknown {
  return path.split('.').reduce<unknown>((cursor, key) => {
    if (cursor === null || typeof cursor !== 'object') return undefined;
    return (cursor as Record<string, unknown>)[key];
  }, root);
}

export function makeConfigSensitiveAdapter(): ConfigSensitiveAdapter {
  const defaults = { p6: { swap: { enabled: true, minRibbonImprovementPx: 20 }, forwardGateAngleDeg: 80 } };
  const source: SourceIdentity = { name: 'fixture.png', sha256: 'deadbeef', widthPx: 40, heightPx: 30 };
  const calls: object[] = [];

  const manifest = {
    stages: [{ id: 1, name: 'p6.gate', kind: 'filter', source: { file: 'fixture.ts', line: 1 } }],
    checks: [{ id: 1, stageId: 1, code: 'angle.gate', operator: 'gte', source: { file: 'fixture.ts', line: 2 } }],
    assets: [],
    entityKinds: [{ id: 1, name: 'hole', source: { file: 'fixture.ts', line: 1 } }],
  };

  function buildTrace(effectiveConfig: object): TraceRun {
    const angle = Number(getAtPath(effectiveConfig, 'p6.forwardGateAngleDeg'));
    const pass = angle >= 90;
    return {
      version: 1,
      stages: [{ invocationId: 1, stageId: 1, seq: 0 }],
      elements: [{ id: 1, stageInvocationId: 1, ordinal: 0, kept: pass }],
      checks: [{ stageInvocationId: 1, elementId: 1, checkId: 1, operator: 'gte', value: angle, threshold: 90, pass }],
      entities: [{ id: 1, kindId: 1, ordinal: 0, attrs: { x: 10, y: 12, holeNumber: 1 } }],
    };
  }

  const adapter: ConfigSensitiveAdapter = {
    pipelineId: 'test.viewer-fixture',
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
      calls.push(structuredClone(effectiveConfig));
      const angle = Number(getAtPath(effectiveConfig, 'p6.forwardGateAngleDeg'));
      return {
        trace: buildTrace(effectiveConfig),
        manifest,
        summary: { wallMs: 5, holes: 1, gatePass: angle >= 90 },
      };
    },
  };
  return adapter;
}
