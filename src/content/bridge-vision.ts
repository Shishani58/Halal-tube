/**
 * ISOLATED world: carries the video track from the page to the offscreen frame classifier
 * over its own Port ('mr-vis') and results back. Keeps stream headers and recent video so a
 * restarted classifier can catch up. Connects only once the page sends video (blur enabled).
 */
import { MSG_NS } from '../shared/messages';
import { encodeToVision, isInitSegment, type FromVision, type ToVision, type ToVisionWire } from '../shared/vision-messages';
import { ReplayLog } from './replay-log';

const log = new ReplayLog<ToVisionWire>(32 * 1024 * 1024);

function remember(msg: ToVision, wire: ToVisionWire): void {
  if (msg.type === 'position' && !msg.enabled) {
    log.clearMedia(); // blurring turned off: the recent video won't be needed again
  } else if (msg.type === 'sb-init') {
    log.add({ wire, session: msg.session, sb: msg.sb, bytes: 0, pinned: true });
  } else if (msg.type === 'append' && wire.type === 'append') {
    const init = isInitSegment(new Uint8Array(msg.data, 0, Math.min(8, msg.data.byteLength)));
    log.add({ wire, session: msg.session, sb: msg.sb, bytes: wire.data.length, pinned: init, init });
  }
}

let port: chrome.runtime.Port | null = null;
let connecting = false;

function contextAlive(): boolean {
  try {
    return !!chrome.runtime?.id;
  } catch {
    return false;
  }
}

async function connect(): Promise<void> {
  if (port || connecting || !contextAlive()) return;
  connecting = true;
  try {
    await chrome.runtime.sendMessage({ type: 'ensure-offscreen' });
    const p = chrome.runtime.connect({ name: 'mr-vis' });
    p.onMessage.addListener((msg: FromVision) => {
      window.postMessage({ ns: MSG_NS, from: 'vision', msg }, '*');
    });
    p.onDisconnect.addListener(() => {
      port = null;
      if (contextAlive()) setTimeout(() => void connect(), 1000);
    });
    port = p;
    for (const e of log.all) p.postMessage(e.wire);
  } catch (e) {
    console.warn('[music-remover] vision connect failed', e);
    if (contextAlive()) setTimeout(() => void connect(), 2000);
  } finally {
    connecting = false;
  }
}

window.addEventListener('message', (e: MessageEvent) => {
  if (e.source !== window) return;
  const d = e.data as { ns?: string; from?: string; kind?: string; msg?: ToVision };
  if (!d || d.ns !== MSG_NS || d.from !== 'main' || d.kind !== 'to-vision' || !d.msg) return;
  const wire = encodeToVision(d.msg);
  remember(d.msg, wire);
  if (port) {
    try {
      port.postMessage(wire);
    } catch {
      port = null;
    }
  }
  if (!port) void connect();
});
