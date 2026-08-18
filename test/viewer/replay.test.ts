import { afterEach, describe, expect, it } from 'vitest';
import { makeFakeAdapter } from '../replay/support/fakeAdapter.js';
import { json } from './support/json.js';
import { startTestServer, type TestServerContext } from './support/testServer.js';

let ctx: TestServerContext | null = null;
afterEach(async () => {
  if (ctx) await ctx.close();
  ctx = null;
});

describe('POST /api/replay', () => {
  it('creates a child run recording parent/patch, visible in a subsequent /api/session', async () => {
    ctx = await startTestServer(makeFakeAdapter());
    const session = await json(await fetch(`${ctx.baseUrl}/api/session`));
    const baselineId = session.runs[0].runId;

    const res = await fetch(`${ctx.baseUrl}/api/replay`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ parentRunId: baselineId, patch: { 'p6.swap.enabled': false }, label: 'no-swap' }),
    });
    expect(res.status).toBe(200);
    const run = await json(res);
    expect(run.parentRunId).toBe(baselineId);
    expect(run.patch).toEqual({ 'p6.swap.enabled': false });
    expect(run.label).toBe('no-swap');
    expect(run.effectiveConfig.p6.swap.enabled).toBe(false);

    const session2 = await json(await fetch(`${ctx.baseUrl}/api/session`));
    expect(session2.runs).toHaveLength(2);
    expect(session2.runs.map((r: { runId: string }) => r.runId)).toContain(run.runId);
  });
});
