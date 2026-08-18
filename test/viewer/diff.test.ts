import { afterEach, describe, expect, it } from 'vitest';
import { makeConfigSensitiveAdapter } from './support/configSensitiveAdapter.js';
import { json } from './support/json.js';
import { startTestServer, type TestServerContext } from './support/testServer.js';

let ctx: TestServerContext | null = null;
afterEach(async () => {
  if (ctx) await ctx.close();
  ctx = null;
});

describe('GET /api/diff', () => {
  it('reports the patched config path and a real, name-resolved first divergent stage', async () => {
    ctx = await startTestServer(makeConfigSensitiveAdapter());
    const session = await json(await fetch(`${ctx.baseUrl}/api/session`));
    const baselineId = session.runs[0].runId;

    const replayRes = await fetch(`${ctx.baseUrl}/api/replay`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ parentRunId: baselineId, patch: { 'p6.forwardGateAngleDeg': 100 } }),
    });
    const patched = await json(replayRes);

    const diffRes = await fetch(`${ctx.baseUrl}/api/diff?a=${baselineId}&b=${patched.runId}`);
    expect(diffRes.status).toBe(200);
    const diff = await json(diffRes);

    expect(diff.configDiff).toEqual(
      expect.arrayContaining([{ path: 'p6.forwardGateAngleDeg', a: 80, b: 100 }])
    );
    expect(diff.summaryDiff).toEqual(
      expect.arrayContaining([{ key: 'gatePass', a: false, b: true }])
    );
    expect(diff.firstDivergentStage).not.toBeNull();
    expect(diff.firstDivergentStage.stageId).toBe(1);
    expect(diff.firstDivergentStage.seq).toBe(0);
    expect(diff.firstDivergentStage.stageName).toBe('p6.gate');
    expect(diff.firstDivergentStage.reason).toMatch(/kept flag differs/i);
  });

  it('returns a null firstDivergentStage for two identical runs', async () => {
    ctx = await startTestServer(makeConfigSensitiveAdapter());
    const session = await json(await fetch(`${ctx.baseUrl}/api/session`));
    const baselineId = session.runs[0].runId;

    const replayRes = await fetch(`${ctx.baseUrl}/api/replay`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ parentRunId: baselineId, patch: {} }),
    });
    const clone = await json(replayRes);

    const diffRes = await fetch(`${ctx.baseUrl}/api/diff?a=${baselineId}&b=${clone.runId}`);
    const diff = await json(diffRes);
    expect(diff.firstDivergentStage).toBeNull();
    expect(diff.configDiff).toEqual([]);
  });

  it('404s when either run id is unknown', async () => {
    ctx = await startTestServer(makeConfigSensitiveAdapter());
    const session = await json(await fetch(`${ctx.baseUrl}/api/session`));
    const baselineId = session.runs[0].runId;
    const res = await fetch(`${ctx.baseUrl}/api/diff?a=${baselineId}&b=nope`);
    expect(res.status).toBe(404);
  });
});
