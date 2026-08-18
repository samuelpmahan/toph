// Shared harness for viewer server tests: spins up a real HTTP server on an ephemeral
// port against a temp session dir, and tears both down afterward.

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startReplayViewer, type ReplayViewerHandle, type StartReplayViewerOptions } from '../../../src/viewer/server.js';
import type { ReplayAdapter } from '../../../src/replay/index.js';

export interface TestServerContext {
  handle: ReplayViewerHandle;
  baseUrl: string;
  sessionDir: string;
  close(): Promise<void>;
}

export async function startTestServer(
  adapter: ReplayAdapter,
  extra: Partial<StartReplayViewerOptions> = {}
): Promise<TestServerContext> {
  const sessionDir = await mkdtemp(join(tmpdir(), 'toph-viewer-test-'));
  const handle = await startReplayViewer({ sessionDir, adapter, port: 0, ...extra });
  return {
    handle,
    baseUrl: `http://127.0.0.1:${handle.port}`,
    sessionDir,
    async close(): Promise<void> {
      await handle.close();
      await rm(sessionDir, { recursive: true, force: true });
    },
  };
}
