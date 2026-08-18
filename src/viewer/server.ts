// Local diagnostic viewer server for Toph counterfactual replay sessions. Node HTTP only,
// no framework: serves one static HTML/JS/CSS page plus a small JSON API over an
// already-open ReplaySession. Stays application-generic -- the only "meaning" resolved
// here is stage NAME lookup from manifest data, kept out of the replay core itself.

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  diffConfig,
  diffSummaries,
  firstDivergentStage,
  openReplaySession,
  type ReplayAdapter,
  type ReplaySession,
  type RunRecord,
} from '../replay/index.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const STATIC_INDEX_PATH = join(__dirname, 'static', 'index.html');
const VIEWER_JS_PATH = join(__dirname, 'static', 'viewer.js');

export interface ReplayViewerSourceImage {
  path: string;
  contentType: string;
}

export interface StartReplayViewerOptions {
  sessionDir: string;
  adapter: ReplayAdapter;
  port?: number;
  sourceImage?: ReplayViewerSourceImage;
}

export interface ReplayViewerHandle {
  port: number;
  close(): Promise<void>;
}

interface ManifestStageEntry {
  id: number;
  name: string;
}

function isManifestWithStages(value: unknown): value is { stages: ManifestStageEntry[] } {
  if (value === null || typeof value !== 'object') return false;
  const stages = (value as { stages?: unknown }).stages;
  return Array.isArray(stages);
}

async function resolveStageName(session: ReplaySession, runId: string, stageId: number): Promise<string | undefined> {
  let manifest: unknown;
  try {
    manifest = await session.loadManifest(runId);
  } catch {
    return undefined;
  }
  if (!isManifestWithStages(manifest)) return undefined;
  return manifest.stages.find((stage) => stage.id === stageId)?.name;
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(payload) });
  res.end(payload);
}

function sendError(res: ServerResponse, status: number, message: string): void {
  sendJson(res, status, { error: message });
}

async function readRequestBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks).toString('utf8');
}

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const raw = await readRequestBody(req);
  if (raw.trim() === '') return {};
  return JSON.parse(raw);
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Starts the local replay viewer: a static diagnostic page plus a small JSON API served
 * over the given session directory and adapter. Ensures a baseline run exists so the
 * viewer is always openable with data.
 */
export async function startReplayViewer(options: StartReplayViewerOptions): Promise<ReplayViewerHandle> {
  const session = await openReplaySession(options.sessionDir, options.adapter);
  await session.baseline();

  function findRun(runId: string): RunRecord | undefined {
    return session.list().find((run) => run.runId === runId);
  }

  const server = createServer((req, res) => {
    void handleRequest(req, res).catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      if (!res.headersSent) sendError(res, 500, message);
      else res.end();
    });
  });

  async function handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const method = req.method ?? 'GET';
    const url = new URL(req.url ?? '/', 'http://localhost');
    const path = url.pathname;

    if (method === 'GET' && path === '/') {
      const html = await readFile(STATIC_INDEX_PATH, 'utf8');
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Content-Length': Buffer.byteLength(html) });
      res.end(html);
      return;
    }

    if (method === 'GET' && path === '/viewer.js') {
      const js = await readFile(VIEWER_JS_PATH, 'utf8');
      res.writeHead(200, { 'Content-Type': 'text/javascript; charset=utf-8', 'Content-Length': Buffer.byteLength(js) });
      res.end(js);
      return;
    }

    if (method === 'GET' && path === '/api/session') {
      sendJson(res, 200, {
        pipelineId: options.adapter.pipelineId,
        source: options.adapter.source,
        codeVersion: options.adapter.codeVersion,
        defaults: options.adapter.defaults,
        paramSchema: options.adapter.paramSchema,
        runs: session.list(),
      });
      return;
    }

    if (method === 'GET' && path === '/api/source-image') {
      if (options.sourceImage === undefined) {
        sendError(res, 404, 'No source image configured for this viewer.');
        return;
      }
      const bytes = await readFile(options.sourceImage.path);
      res.writeHead(200, { 'Content-Type': options.sourceImage.contentType, 'Content-Length': bytes.length });
      res.end(bytes);
      return;
    }

    if (method === 'GET' && path === '/api/diff') {
      const runIdA = url.searchParams.get('a');
      const runIdB = url.searchParams.get('b');
      if (runIdA === null || runIdB === null) {
        sendError(res, 400, 'Query parameters "a" and "b" (run ids) are required.');
        return;
      }
      const runA = findRun(runIdA);
      const runB = findRun(runIdB);
      if (runA === undefined || runB === undefined) {
        sendError(res, 404, `Unknown run id: ${runA === undefined ? runIdA : runIdB}`);
        return;
      }
      const [traceA, traceB] = await Promise.all([session.loadTrace(runIdA), session.loadTrace(runIdB)]);
      const configDiff = diffConfig(runA.effectiveConfig, runB.effectiveConfig);
      const summaryDiff = diffSummaries(runA.summary, runB.summary);
      const divergence = firstDivergentStage(traceA, traceB);
      let firstDivergentStagePayload: unknown = null;
      if (divergence !== null) {
        const stageName =
          (await resolveStageName(session, runIdA, divergence.stageId)) ??
          (await resolveStageName(session, runIdB, divergence.stageId));
        firstDivergentStagePayload = { ...divergence, ...(stageName !== undefined ? { stageName } : {}) };
      }
      sendJson(res, 200, { configDiff, summaryDiff, firstDivergentStage: firstDivergentStagePayload });
      return;
    }

    const runMatch = path.match(/^\/api\/run\/([^/]+)(\/(trace|final|manifest|labelmaps))?$/);
    if (method === 'GET' && runMatch) {
      const runId = decodeURIComponent(runMatch[1]);
      const sub = runMatch[3];
      const run = findRun(runId);
      if (run === undefined) {
        sendError(res, 404, `Unknown run id: ${runId}`);
        return;
      }
      try {
        if (sub === undefined) {
          sendJson(res, 200, run);
        } else if (sub === 'trace') {
          sendJson(res, 200, await session.loadTrace(runId));
        } else if (sub === 'final') {
          sendJson(res, 200, await session.loadFinal(runId));
        } else if (sub === 'manifest') {
          sendJson(res, 200, await session.loadManifest(runId));
        } else if (sub === 'labelmaps') {
          const labelmaps = await session.loadLabelmaps(runId);
          if (labelmaps === undefined) {
            sendError(res, 404, `Run "${runId}" has no labelmaps.`);
            return;
          }
          sendJson(res, 200, labelmaps);
        }
      } catch {
        sendError(res, 404, `Run "${runId}" has no ${sub ?? 'record'}.`);
      }
      return;
    }

    if (method === 'POST' && path === '/api/replay') {
      const body = await readJsonBody(req);
      if (!isPlainRecord(body) || typeof body.parentRunId !== 'string' || !isPlainRecord(body.patch)) {
        sendError(res, 400, 'Body must be { parentRunId: string, patch: object, label?: string }.');
        return;
      }
      const parent = findRun(body.parentRunId);
      if (parent === undefined) {
        sendError(res, 404, `Unknown parent run id: ${body.parentRunId}`);
        return;
      }
      const label = typeof body.label === 'string' ? body.label : undefined;
      try {
        const run = await session.replay(body.parentRunId, body.patch, label);
        sendJson(res, 200, run);
      } catch (error) {
        sendError(res, 500, error instanceof Error ? error.message : String(error));
      }
      return;
    }

    if (method === 'POST' && path === '/api/grid') {
      const body = await readJsonBody(req);
      if (!isPlainRecord(body) || typeof body.parentRunId !== 'string' || !isPlainRecord(body.axes)) {
        sendError(res, 400, 'Body must be { parentRunId: string, axes: Record<string, unknown[]> }.');
        return;
      }
      const parent = findRun(body.parentRunId);
      if (parent === undefined) {
        sendError(res, 404, `Unknown parent run id: ${body.parentRunId}`);
        return;
      }
      const axes = body.axes as Record<string, unknown>;
      for (const value of Object.values(axes)) {
        if (!Array.isArray(value)) {
          sendError(res, 400, 'Each axis value must be an array of values to sweep.');
          return;
        }
      }
      try {
        const runs = await session.grid(body.parentRunId, axes as Record<string, unknown[]>);
        sendJson(res, 200, runs);
      } catch (error) {
        sendError(res, 500, error instanceof Error ? error.message : String(error));
      }
      return;
    }

    sendError(res, 404, `No route for ${method} ${path}`);
  }

  await new Promise<void>((resolve) => {
    server.listen(options.port ?? 4173, resolve);
  });
  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : (options.port ?? 4173);

  return {
    port,
    close(): Promise<void> {
      return new Promise((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    },
  };
}
