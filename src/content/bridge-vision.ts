/**
 * ISOLATED world: carries the video track from the page to the offscreen frame classifier
 * over its own Port ('mr-vis') and results back. Keeps stream headers and recent video so a
 * restarted classifier can catch up. Connects only once the page sends video (blur enabled).
 */
import { MSG_NS } from '../shared/messages';
import { encodeToVision, isInitSegment, type FromVision, type ToVision, type ToVisionWire } from '../shared/vision-messages';

interface LogEntry {
  wire: ToVisionWire;
  bytes: number;
  pinned: boolean;
}
const log: LogEntry[] = [];
let logBytes = 0;
const LOG_MAX = 32 * 1024 * 1024;

function remember(msg: ToVision, wire: ToVisionWire): void {
  if (msg.type === 'sb-init') log.push({ wire, bytes: 0, pinned: true });
  else if (msg.type === 'append') {
    const pinned = isInitSegment(new Uint8Array(msg.data, 0, Math.min(8, msg.data.byteLength)));
    if (pinned) {
      // only the latest init segment per SourceBuffer matters
      for (let i = log.length - 1; i >= 0; i--) {
        const w = log[i].wire;
        if (log[i].pinned && w.type === 'append' && w.sb === msg.sb) log.splice(i, 1);
      }
    }
    log.push({ wire, bytes: msg.data.byteLength, pinned });
    logBytes += msg.data.byteLength;
    for (let i = 0; logBytes > LOG_MAX && i < log.length; ) {
      if (log[i].pinned) {
        i++;
        continue;
      }
      logBytes -= log[i].bytes;
      log.splice(i, 1);
    }
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
    for (const e of log) p.postMessage(e.wire);
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
