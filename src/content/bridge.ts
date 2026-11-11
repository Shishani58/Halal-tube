/**
 * ISOLATED-world content script.
 *  - Relays settings from chrome.storage to the MAIN-world script.
 *  - Carries audio from the page to the extension's offscreen processor over a Port and the
 *    separated audio back. Nothing is inserted into the page DOM.
 *  - Keeps the stream headers and recent audio so a restarted processor can catch up.
 *  - Answers popup status queries.
 */
import { DEFAULT_SETTINGS, MSG_NS, needsProcessor, type PageStatus, type Settings, type ToWorker } from '../shared/messages';
import { isInitSegment } from '../shared/vision-messages';
import { decodeFromWorker, encodeToWorker, type FromWorkerWire, type ToWorkerWire } from '../shared/wire';
import { connectProcessor, type PortLike } from '../shared/port';
import { ReplayLog } from './replay-log';
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
const log = new ReplayLog<ToWorkerWire>(24 * 1024 * 1024);

function remember(msg: ToWorker, wire: ToWorkerWire): void {
  if (msg.type === 'sb-init') {
    log.add({ wire, session: msg.session, sb: msg.sb, bytes: 0, pinned: true });
  } else if (msg.type === 'captions') {
    // only the latest caption state per session matters
    log.remove((e) => e.wire.type === 'captions' && e.session === msg.session);
    log.add({ wire, session: msg.session, bytes: 0, pinned: true });
  } else if (msg.type === 'append' && wire.type === 'append') {
    const init = isInitSegment(new Uint8Array(msg.data, 0, Math.min(8, msg.data.byteLength)));
    log.add({ wire, session: msg.session, sb: msg.sb, bytes: wire.data.length, pinned: init, init });
  }
}

// ───────────── connection to the offscreen processor ─────────────
let port: PortLike | null = null;
let connecting = false;
let wanted = false;

/**
 * Tell the page whether the processor is reachable. `orphaned`: this content script lost its
 * extension (the extension was updated or reloaded while the tab stayed open) — only a page
 * reload brings it back.
 */
function reportLink(): void {
  const orphaned = !contextAlive();
  window.postMessage({ ns: MSG_NS, from: 'bridge', kind: 'link', up: !!port && !orphaned, orphaned }, '*');
}

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
    const p = await connectProcessor('mr-proc');
    p.onMessage.addListener((m) => {
      const msg = decodeFromWorker(m as FromWorkerWire);
      const transfer: Transferable[] = [];
      if (msg.type === 'tile') {
        transfer.push(msg.left.buffer, msg.right.buffer);
        if (msg.mixLeft) transfer.push(msg.mixLeft.buffer);
      }
      window.postMessage({ ns: MSG_NS, from: 'processor', msg }, '*', transfer);
    });
    p.onDisconnect.addListener(() => {
      port = null;
      reportLink();
      if (wanted && contextAlive()) setTimeout(() => void connect(), 300);
    });
    port = p;
    for (const e of log.all) p.postMessage(e.wire); // catch the (new) processor up
    reportLink();
  } catch (e) {
    // The service worker may still be starting (fresh install / browser start): retry soon.
    console.warn('[music-remover] processor connect failed', e);
    reportLink();
    if (contextAlive()) setTimeout(() => void connect(), 500);
  } finally {
    connecting = false;
  }
}

window.addEventListener('message', (e: MessageEvent) => {
  if (e.source !== window) return;
  const d = e.data as { ns?: string; from?: string; kind?: string; status?: PageStatus; msg?: ToWorker };
  if (!d || d.ns !== MSG_NS || d.from !== 'main') return;
  if (d.kind === 'get-settings') {
    pushSettings();
    reportLink();
  }
  else if (d.kind === 'status' && d.status) lastStatus = d.status;
  else if (d.kind === 'to-worker' && d.msg) {
    if (!contextAlive()) {
      reportLink();
      return;
    }
    const wire = encodeToWorker(d.msg);
    remember(d.msg, wire);
    if (needsProcessor(d.msg)) wanted = true;
    if (!wanted) return; // kept in the log, replayed once the page needs the processor
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
