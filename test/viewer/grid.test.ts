import { afterEach, describe, expect, it } from 'vitest';
import { makeFakeAdapter } from '../replay/support/fakeAdapter.js';
import { json } from './support/json.js';
import { startTestServer, type TestServerContext } from './support/testServer.js';

let ctx: TestServerContext | null = null;
afterEach(async () => {
  if (ctx) await ctx.close();
  ctx = null;
});

describe('POST /api/grid', () => {
  it('a 2x1 axis set produces 2 children with the same semantics as two manual /api/replay calls', async () => {
    ctx = await startTestServer(makeFakeAdapter());
    const session = await json(await fetch(`${ctx.baseUrl}/api/session`));
    const baselineId = session.runs[0].runId;

    const gridRes = await fetch(`${ctx.baseUrl}/api/grid`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ parentRunId: baselineId, axes: { 'p6.swap.enabled': [true, false] } }),
    });
    expect(gridRes.status).toBe(200);
    const gridRuns = await json(gridRes);
    expect(gridRuns).toHaveLength(2);
    expect(gridRuns.map((r: { patch: unknown }) => r.patch)).toEqual([
      { 'p6.swap.enabled': true },
      { 'p6.swap.enabled': false },
    ]);
    for (const run of gridRuns) expect(run.parentRunId).toBe(baselineId);

    // Reconstruct the same patches via manual replay against an independent server and
    // compare non-volatile fields for equivalence.
    ctx2 = await startTestServer(makeFakeAdapter());
    const session2 = await json(await fetch(`${ctx2.baseUrl}/api/session`));
    const baselineId2 = session2.runs[0].runId;
    const manualRuns = [];
    for (const patch of [{ 'p6.swap.enabled': true }, { 'p6.swap.enabled': false }]) {
      const res = await fetch(`${ctx2.baseUrl}/api/replay`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ parentRunId: baselineId2, patch }),
      });
      manualRuns.push(await json(res));
    }

    const strip = (run: Record<string, unknown>) => {
      const { runId, createdAt, parentRunId, ...rest } = run;
      return rest;
    };
    expect(gridRuns.map(strip)).toEqual(manualRuns.map(strip));
  });

  it('400s when an axis value is not an array', async () => {
    ctx = await startTestServer(makeFakeAdapter());
    const session = await json(await fetch(`${ctx.baseUrl}/api/session`));
    const baselineId = session.runs[0].runId;
    const res = await fetch(`${ctx.baseUrl}/api/grid`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ parentRunId: baselineId, axes: { 'p6.swap.enabled': true } }),
    });
    expect(res.status).toBe(400);
  });
});

let ctx2: TestServerContext | null = null;
afterEach(async () => {
  if (ctx2) await ctx2.close();
  ctx2 = null;
});
