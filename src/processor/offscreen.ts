/**
 * Offscreen document (extension-owned, outside any web page). Owns ONE processing Worker for
 * all tabs, so the model is loaded once and stays warm between videos, reloads and tabs.
 * Pages talk to it through their bridge content script over a Port; each Port's session ids
 * are mapped to ids that are unique across ports.
 */
import type { FromWorker, ToWorker, WorkerStatus } from '../shared/messages';
import { decodeToWorker, encodeFromWorker, type FromWorkerWire, type ToWorkerWire } from '../shared/wire';

const SPAN = 1_000_000; // local session ids of one page stay far below this

interface Link {
  id: number;
  port: chrome.runtime.Port;
  sessions: Set<number>;
}

const links = new Map<number, Link>();
let nextLinkId = 1;
let worker: Worker | null = null;
let lastModelStatus: WorkerStatus | null = null;
const greeting: FromWorker[] = []; // 'tiling' + 'ready', replayed to every new port

function send(link: Link, msg: FromWorker): void {
  try {
    link.port.postMessage(encodeFromWorker(msg) as FromWorkerWire);
  } catch {
    drop(link);
  }
}

function broadcast(msg: FromWorker): void {
  for (const l of [...links.values()]) send(l, msg);
}

function startWorker(): Worker {
  const w = new Worker(new URL('./worker.js', location.href), { type: 'module' });
  w.onmessage = (e: MessageEvent<FromWorker>) => {
    const msg = e.data;
    if (msg.type === 'tiling' || msg.type === 'ready') {
      greeting.push(msg);
      broadcast(msg);
      return;
    }
    if (msg.type === 'status') lastModelStatus = msg.status;
    if ((msg.type === 'tile' || msg.type === 'status') && msg.session !== undefined) {
      const link = links.get(Math.floor(msg.session / SPAN));
      if (link) send(link, { ...msg, session: msg.session % SPAN });
      return;
    }
    broadcast(msg);
  };
  w.onerror = (e) => {
    console.error('[music-remover] worker error', e.message);
    broadcast({
      type: 'status',
      status: { model: 'error', backend: '-', error: e.message, rtf: 0, tilesDone: 0, ahead: 0, inputAhead: 0 },
    });
    // Start over: drop every page link; their bridges reconnect and replay the stream headers
    // and recent audio into a fresh worker.
    w.terminate();
    if (worker === w) {
      worker = null;
      greeting.length = 0;
      lastModelStatus = null;
      for (const l of [...links.values()]) {
        links.delete(l.id);
        l.port.disconnect();
      }
    }
  };
  return w;
}

function ensureWorker(): Worker {
  if (!worker) worker = startWorker();
  return worker;
}

function drop(link: Link): void {
  if (!links.delete(link.id)) return;
  for (const s of link.sessions) worker?.postMessage({ type: 'drop-session', session: s } satisfies ToWorker);
}

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== 'mr-proc') return;
  const link: Link = { id: nextLinkId++, port, sessions: new Set() };
  links.set(link.id, link);
  ensureWorker();
  for (const g of greeting) send(link, g);
  if (lastModelStatus) send(link, { type: 'status', status: { ...lastModelStatus, ahead: 0, inputAhead: 0, waitFor: undefined } });

  port.onMessage.addListener((m: ToWorkerWire) => {
    const msg = decodeToWorker(m);
    const global = link.id * SPAN + msg.session;
    link.sessions.add(global);
    const out = { ...msg, session: global } as ToWorker;
    ensureWorker().postMessage(out, out.type === 'append' ? [out.data] : []);
  });
  port.onDisconnect.addListener(() => drop(link));
});
