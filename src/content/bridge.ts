/**
 * ISOLATED-world content script.
 *  - Relays settings from chrome.storage to the MAIN-world script.
 *  - Carries audio from the page to the extension's offscreen processor over a Port and the
 *    separated audio back. Nothing is inserted into the page DOM.
 *  - Keeps the stream headers and recent audio so a restarted processor can catch up.
 *  - Answers popup status queries.
 */
import { DEFAULT_SETTINGS, MSG_NS, type PageStatus, type Settings, type ToWorker } from '../shared/messages';
import { decodeFromWorker, encodeToWorker, type FromWorkerWire, type ToWorkerWire } from '../shared/wire';
import './bridge-vision';

let settings: Settings = { ...DEFAULT_SETTINGS };
let lastStatus: PageStatus | null = null;

function pushSettings(): void {
  window.postMessage({ ns: MSG_NS, from: 'bridge', kind: 'settings', settings }, '*');
}

chrome.storage.sync.get(DEFAULT_SETTINGS as unknown as Record<string, unknown>, (s) => {
  settings = { ...DEFAULT_SETTINGS, ...(s as unknown as Settings) };
  pushSettings();
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'sync') return;
  let changed = false;
  for (const [k, v] of Object.entries(changes)) {
    if (k in settings) {
      (settings as unknown as Record<string, unknown>)[k] = v.newValue;
      changed = true;
    }
  }
  if (changed) pushSettings();
});

// ───────────── replay log: stream setup + recent audio, re-sent after a reconnect ─────────────
interface LogEntry {
  wire: ToWorkerWire;
  bytes: number;
  pinned: boolean; // sb-init and init segments are never dropped
}
const log: LogEntry[] = [];
let logBytes = 0;
const LOG_MAX = 24 * 1024 * 1024;

function isInitSegment(data: ArrayBuffer): boolean {
  const b = new Uint8Array(data, 0, Math.min(8, data.byteLength));
  if (b[0] === 0x1a && b[1] === 0x45 && b[2] === 0xdf && b[3] === 0xa3) return true; // EBML header
  const t = String.fromCharCode(b[4], b[5], b[6], b[7]);
  return t === 'ftyp' || t === 'moov';
}

function remember(msg: ToWorker, wire: ToWorkerWire): void {
  if (msg.type === 'sb-init') {
    log.push({ wire, bytes: 0, pinned: true });
  } else if (msg.type === 'append') {
    const pinned = isInitSegment(msg.data);
    const bytes = msg.data.byteLength;
    log.push({ wire, bytes, pinned });
    logBytes += bytes;
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

// ───────────── connection to the offscreen processor ─────────────
let port: chrome.runtime.Port | null = null;
let connecting = false;
let wanted = false;

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
    const p = chrome.runtime.connect({ name: 'mr-proc' });
    p.onMessage.addListener((m: FromWorkerWire) => {
      const msg = decodeFromWorker(m);
      const transfer: Transferable[] = [];
      if (msg.type === 'tile') {
        transfer.push(msg.left.buffer, msg.right.buffer);
        if (msg.mixLeft) transfer.push(msg.mixLeft.buffer);
      }
      window.postMessage({ ns: MSG_NS, from: 'processor', msg }, '*', transfer);
    });
    p.onDisconnect.addListener(() => {
      port = null;
      if (wanted && contextAlive()) setTimeout(() => void connect(), 1000);
    });
    port = p;
    for (const e of log) p.postMessage(e.wire); // catch the (new) processor up
  } catch (e) {
    console.warn('[music-remover] processor connect failed', e);
    if (contextAlive()) setTimeout(() => void connect(), 2000);
  } finally {
    connecting = false;
  }
}

window.addEventListener('message', (e: MessageEvent) => {
  if (e.source !== window) return;
  const d = e.data as { ns?: string; from?: string; kind?: string; status?: PageStatus; msg?: ToWorker };
  if (!d || d.ns !== MSG_NS || d.from !== 'main') return;
  if (d.kind === 'get-settings') pushSettings();
  else if (d.kind === 'status' && d.status) lastStatus = d.status;
  else if (d.kind === 'to-worker' && d.msg) {
    const wire = encodeToWorker(d.msg);
    remember(d.msg, wire);
    wanted = true;
    if (port) {
      try {
        port.postMessage(wire);
      } catch {
        port = null;
      }
    }
    if (!port) void connect();
  }
});

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type !== 'get-status') return false;
  const hasVideo = lastStatus && lastStatus.state !== 'no-video';
  if (hasVideo) {
    sendResponse(lastStatus);
    return false;
  }
  if (window === window.top) {
    // let frames that actually play a video answer first
    setTimeout(() => sendResponse(lastStatus), 150);
    return true;
  }
  return false;
});
