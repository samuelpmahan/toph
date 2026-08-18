import { afterEach, describe, expect, it } from 'vitest';
import { makeFakeAdapter } from '../replay/support/fakeAdapter.js';
import { json } from './support/json.js';
import { startTestServer, type TestServerContext } from './support/testServer.js';

let ctx: TestServerContext | null = null;
afterEach(async () => {
  if (ctx) await ctx.close();
  ctx = null;
});

describe('GET /api/session', () => {
  it('ensures a baseline run exists on startup so the viewer is always openable', async () => {
    ctx = await startTestServer(makeFakeAdapter());
    const res = await fetch(`${ctx.baseUrl}/api/session`);
    expect(res.status).toBe(200);
    const body = await json(res);
    expect(body.pipelineId).toBe('test.fixture');
    expect(body.runs).toHaveLength(1);
    expect(body.runs[0].parentRunId).toBeNull();
    expect(body.paramSchema).toHaveLength(3);
    expect(body.defaults).toBeDefined();
  });

  it('GET /api/run/:id returns the run record', async () => {
    ctx = await startTestServer(makeFakeAdapter());
    const session = await json(await fetch(`${ctx.baseUrl}/api/session`));
    const runId = session.runs[0].runId;
    const res = await fetch(`${ctx.baseUrl}/api/run/${runId}`);
    expect(res.status).toBe(200);
    const run = await json(res);
    expect(run.runId).toBe(runId);
  });

  it('GET /api/run/:id/trace and /manifest and /final and /labelmaps behave per availability', async () => {
    ctx = await startTestServer(makeFakeAdapter());
    const session = await json(await fetch(`${ctx.baseUrl}/api/session`));
    const runId = session.runs[0].runId;

    const trace = await fetch(`${ctx.baseUrl}/api/run/${runId}/trace`);
    expect(trace.status).toBe(200);
    expect((await json(trace)).version).toBe(1);

    // The fake adapter emits no manifest/final/labelmaps for this run.
    const manifest = await fetch(`${ctx.baseUrl}/api/run/${runId}/manifest`);
    expect(manifest.status).toBe(404);
    const final = await fetch(`${ctx.baseUrl}/api/run/${runId}/final`);
    expect(final.status).toBe(404);
    const labelmaps = await fetch(`${ctx.baseUrl}/api/run/${runId}/labelmaps`);
    expect(labelmaps.status).toBe(404);
  });
});

describe('GET /', () => {
  it('serves the static viewer page with html content-type and the app root element', async () => {
    ctx = await startTestServer(makeFakeAdapter());
    const res = await fetch(`${ctx.baseUrl}/`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toMatch(/text\/html/);
    const body = await res.text();
    expect(body).toContain('id="app"');
  });
});

describe('GET /api/source-image', () => {
  it('404s when no source image is configured', async () => {
    ctx = await startTestServer(makeFakeAdapter());
    const res = await fetch(`${ctx.baseUrl}/api/source-image`);
    expect(res.status).toBe(404);
    const body = await json(res);
    expect(body.error).toBeDefined();
  });
});

describe('error paths', () => {
  it('404s for an unknown run id', async () => {
    ctx = await startTestServer(makeFakeAdapter());
    const res = await fetch(`${ctx.baseUrl}/api/run/does-not-exist`);
    expect(res.status).toBe(404);
    const body = await json(res);
    expect(body.error).toMatch(/unknown run id/i);
  });

  it('404s for an unknown route', async () => {
    ctx = await startTestServer(makeFakeAdapter());
    const res = await fetch(`${ctx.baseUrl}/nope`);
    expect(res.status).toBe(404);
  });

  it('400s /api/diff without both run ids', async () => {
    ctx = await startTestServer(makeFakeAdapter());
    const res = await fetch(`${ctx.baseUrl}/api/diff?a=x`);
    expect(res.status).toBe(400);
  });

  it('400s POST /api/replay with a malformed body', async () => {
    ctx = await startTestServer(makeFakeAdapter());
    const res = await fetch(`${ctx.baseUrl}/api/replay`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ parentRunId: 123 }),
    });
    expect(res.status).toBe(400);
  });

  it('404s POST /api/replay against an unknown parent', async () => {
    ctx = await startTestServer(makeFakeAdapter());
    const res = await fetch(`${ctx.baseUrl}/api/replay`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ parentRunId: 'nope', patch: {} }),
    });
    expect(res.status).toBe(404);
  });
});
