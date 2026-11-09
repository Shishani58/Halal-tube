/**
 * Offscreen document (extension-owned, outside any web page): one processing Worker per
 * connected tab/frame. Pages talk to it through their bridge content script over a Port.
 */
import type { FromWorker } from '../shared/messages';
import { decodeToWorker, encodeFromWorker, type ToWorkerWire } from '../shared/wire';
import { decodeToVision, type FromVision, type ToVisionWire } from '../shared/vision-messages';

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== 'mr-proc') return;
  const worker = new Worker(new URL('./worker.js', location.href), { type: 'module' });
  let alive = true;
  worker.onmessage = (e: MessageEvent<FromWorker>) => {
    if (!alive) return;
    try {
      port.postMessage(encodeFromWorker(e.data));
    } catch {
      alive = false;
      worker.terminate();
    }
  };
  worker.onerror = (e) => {
    console.error('[music-remover] worker error', e.message);
    if (alive) {
      port.postMessage({
        type: 'status',
        status: { model: 'error', backend: '-', error: e.message, rtf: 0, tilesDone: 0, ahead: 0, inputAhead: 0 },
      });
    }
  };
  port.onMessage.addListener((m: ToWorkerWire) => {
    const msg = decodeToWorker(m);
    worker.postMessage(msg, msg.type === 'append' ? [msg.data] : []);
  });
  port.onDisconnect.addListener(() => {
    alive = false;
    worker.terminate();
  });
});

// ───────────── frame classifier (blurring), one Worker per connected tab/frame ─────────────
chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== 'mr-vis') return;
  const worker = new Worker(new URL('./vision-worker.js', location.href), { type: 'module' });
  let alive = true;
  worker.onmessage = (e: MessageEvent<FromVision>) => {
    if (!alive) return;
    try {
      port.postMessage(e.data);
    } catch {
      alive = false;
      worker.terminate();
    }
  };
  worker.onerror = (e) => {
    console.error('[music-remover] vision worker error', e.message);
    if (alive) port.postMessage({ type: 'status', status: { model: 'error', backend: '-', error: e.message, frames: 0, speed: 0, ahead: 0 } } satisfies FromVision);
  };
  port.onMessage.addListener((m: ToVisionWire) => {
    const msg = decodeToVision(m);
    worker.postMessage(msg, msg.type === 'append' ? [msg.data] : []);
  });
  port.onDisconnect.addListener(() => {
    alive = false;
    worker.terminate();
  });
});
