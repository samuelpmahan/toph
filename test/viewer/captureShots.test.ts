// Acceptance capture: launches the REAL replay viewer against the ChainSpot pancake fixture and
// screenshots the six views the task requires, driving a headless Chromium over the DevTools
// Protocol with Node's built-in WebSocket (no npm browser dependency). Gated behind TOPH_SHOOT=1
// so the normal test run stays fast and hermetic:  TOPH_SHOOT=1 npx vitest run test/viewer/captureShots
import { describe, it, expect } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtemp, writeFile, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startReplayViewer } from '../../src/viewer/server.js';
import { makeChainspotPancakeAdapter } from './support/chainspot/adapter.js';
import { renderCourseImage } from './support/chainspot/sourceImage.js';
import { SCENE } from './support/chainspot/scene.js';

const CHROME = '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
const OUT_DIR = join(process.cwd(), 'artifacts');
const RUN = process.env.TOPH_SHOOT === '1';

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// Minimal CDP client over one page target's WebSocket.
class Cdp {
  private ws: WebSocket;
  private id = 0;
  private pending = new Map<number, { resolve: (v: any) => void; reject: (e: any) => void }>();
  private constructor(ws: WebSocket) {
    this.ws = ws;
    ws.onmessage = (ev: MessageEvent) => {
      const msg = JSON.parse(typeof ev.data === 'string' ? ev.data : '');
      if (msg.id && this.pending.has(msg.id)) {
        const p = this.pending.get(msg.id)!;
        this.pending.delete(msg.id);
        if (msg.error) p.reject(new Error(JSON.stringify(msg.error)));
        else p.resolve(msg.result);
      }
    };
  }
  static async connect(wsUrl: string): Promise<Cdp> {
    const ws = new WebSocket(wsUrl);
    await new Promise<void>((resolve, reject) => {
      ws.onopen = () => resolve();
      ws.onerror = () => reject(new Error('ws error connecting to ' + wsUrl));
    });
    return new Cdp(ws);
  }
  send(method: string, params: Record<string, unknown> = {}): Promise<any> {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
      setTimeout(() => { if (this.pending.has(id)) { this.pending.delete(id); reject(new Error('CDP timeout: ' + method)); } }, 15000);
    });
  }
  async evaluate(expression: string): Promise<any> {
    const r = await this.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    return r.result?.value;
  }
  close(): void { this.ws.close(); }
}

describe.skipIf(!RUN)('chainspot viewer acceptance screenshots', () => {
  it('captures the six required views from the real viewer', async () => {
    await mkdir(OUT_DIR, { recursive: true });
    const sessionDir = await mkdtemp(join(tmpdir(), 'toph-shoot-'));
    const pngPath = join(sessionDir, 'TheRec-stitched.png');
    await writeFile(pngPath, renderCourseImage(SCENE));

    const handle = await startReplayViewer({
      sessionDir,
      adapter: makeChainspotPancakeAdapter(SCENE),
      port: 0,
      sourceImage: { path: pngPath, contentType: 'image/png' },
    });
    const base = `http://127.0.0.1:${handle.port}/`;

    const chrome: ChildProcess = spawn(CHROME, [
      '--headless=new', '--disable-gpu', '--no-sandbox', '--hide-scrollbars',
      '--remote-debugging-port=9333', '--window-size=1600,1000', 'about:blank',
    ], { stdio: 'ignore' });

    let cdp: Cdp | null = null;
    try {
      // Wait for CDP, then open a fresh page target.
      let version: any = null;
      for (let i = 0; i < 40 && !version; i++) {
        version = await fetch('http://127.0.0.1:9333/json/version').then((r) => r.json()).catch(() => null);
        if (!version) await sleep(250);
      }
      expect(version, 'chrome CDP did not come up').toBeTruthy();
      const target = (await fetch('http://127.0.0.1:9333/json/new?about:blank', { method: 'PUT' }).then((r) => r.json())) as { webSocketDebuggerUrl: string };
      cdp = await Cdp.connect(target.webSocketDebuggerUrl);
      await cdp.send('Page.enable');
      await cdp.send('Runtime.enable');
      await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1600, height: 1000, deviceScaleFactor: 1, mobile: false });

      await cdp.send('Page.navigate', { url: base });
      // Wait for the viewer to load its session + trace.
      let ready = false;
      for (let i = 0; i < 40 && !ready; i++) {
        await sleep(250);
        ready = await cdp.evaluate('!!(window.__tophViewer && window.__tophViewer.ready())').catch(() => false);
      }
      expect(ready, 'viewer never became ready').toBe(true);
      await cdp.evaluate('window.__tophViewer.fit()');
      await sleep(500); // source image fetch + first paint

      const shoot = async (name: string, setup: string): Promise<void> => {
        await cdp!.evaluate(setup);
        await sleep(450);
        const shot = await cdp!.send('Page.captureScreenshot', { format: 'png' });
        await writeFile(join(OUT_DIR, name), Buffer.from(shot.data, 'base64'));
      };

      const stages = await cdp.evaluate('JSON.stringify(Array.from({length: window.__tophViewer.stageCount()}, (_,i)=>{window.__tophViewer.setStageIndex(i); return window.__tophViewer.currentStage();}))');
      // eslint-disable-next-line no-console
      console.log('STAGES', stages);

      // 1. mask / component measurement
      await shoot('01-mask-component.png',
        "window.__tophViewer.setStageByName('p1.rawObjectMask'); window.__tophViewer.setMaskMode('component'); window.__tophViewer.selectEvidenceByLabel('Basket mask component');");
      // 2. geometric measurement with overlay + value + threshold (basket area: circle+bbox, area >= min)
      await shoot('02-basket-area.png',
        "window.__tophViewer.setMaskMode('source'); window.__tophViewer.fit(); window.__tophViewer.setStageByName('p4.basketDetect'); window.__tophViewer.selectEvidenceByLabel('Basket area');");
      // 3. Rec P6.1 low-par assignment (the initial, wrong assignment + forward gate)
      await shoot('03-p61-lowpar.png',
        "window.__tophViewer.setStageByName('p6.lowParAssignment'); window.__tophViewer.selectEvidenceByLabel('Forward gate angle');");
      // 4. P6.2 swap adjudication: the actual evidence behind the 7/8 swap
      await shoot('04-p62-swap.png',
        "window.__tophViewer.setStageByName('p6.swapAdjudication'); window.__tophViewer.selectEvidenceByLabel('Ribbon improvement');");
      // 5. P6.2 with one involved entity/evidence selected (focus dims the rest)
      await shoot('05-p62-selected.png',
        "window.__tophViewer.setStageByName('p6.swapAdjudication'); window.__tophViewer.selectEntityBySemantic('Basket → Hole 7'); window.__tophViewer.selectEvidenceByLabel('Ribbon offset — proposed (hole 7)');");
      // 6. parameter editing after the layout correction (wide drawer, numeric entry + sliders)
      await shoot('06-params.png',
        "window.__tophViewer.setStageByName('p6.swapAdjudication'); window.__tophViewer.openDrawer();");

      expect(stages).toContain('p6.swapAdjudication');
    } finally {
      if (cdp) cdp.close();
      chrome.kill('SIGKILL');
      await handle.close();
      await rm(sessionDir, { recursive: true, force: true });
    }
  }, 120000);
});
