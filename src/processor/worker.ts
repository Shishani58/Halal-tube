/// <reference lib="webworker" />
import { createDemuxer, type Demuxer } from '../core/demux';
import { KIM_VOCAL_2, MdxProcessor } from '../core/mdx';
import { resampleCubic } from '../core/resample';
import { Tiling, separateWindow } from '../core/tiles';
import type { FromWorker, ToWorker, WorkerStatus } from '../shared/messages';
import { decodePackets } from './decode';
import { loadModel, type LoadedModel } from './model';
import { PacketStore } from './packet-store';

declare const self: DedicatedWorkerGlobalScope;

const MODEL_FILE = 'Kim_Vocal_2.onnx';
const LOOKAHEAD_TILES = 16; // ≈ 92 s of clean audio prepared ahead
const KEEP_BEHIND_S = 45;
const MAX_SESSIONS = 4;
/** Free the model (GPU memory) after this long without an enabled, active player. */
const IDLE_RELEASE_MS = 3 * 60_000;
let lastEnabledAt = Date.now();

const base = new URL('../', self.location.href).href;
const mdx = new MdxProcessor(KIM_VOCAL_2);
const tiling = new Tiling(mdx);
const scratch = new Float32Array(4 * KIM_VOCAL_2.dimF * KIM_VOCAL_2.dimT);

interface Session {
  store: PacketStore;
  sbs: Map<number, { mime: string; demuxer: Demuxer | null }>;
  lastUsed: number;
}

const sessions = new Map<number, Session>();
let pos: Extract<ToWorker, { type: 'position' }> | null = null;
let have = new Set<number>();
const sentAt = new Map<string, number>(); // `${session}:${k}` → time sent
let model: LoadedModel | null = null;
let busy = false;
const status: WorkerStatus = { model: 'idle', backend: '-', rtf: 0, tilesDone: 0, ahead: 0, inputAhead: 0 };
let computeSec = 0;
let audioSec = 0;
const failedAt = new Map<string, number>();

function post(msg: FromWorker, transfer: Transferable[] = []): void {
  self.postMessage(msg, transfer);
}

function session(id: number): Session {
  let s = sessions.get(id);
  if (!s) {
    s = { store: new PacketStore(), sbs: new Map(), lastUsed: Date.now() };
    sessions.set(id, s);
    if (sessions.size > MAX_SESSIONS) {
      const oldest = [...sessions.entries()].sort((a, b) => a[1].lastUsed - b[1].lastUsed)[0];
      if (oldest && oldest[0] !== id) sessions.delete(oldest[0]);
    }
  }
  return s;
}

self.onmessage = (e: MessageEvent<ToWorker>) => {
  const m = e.data;
  switch (m.type) {
    case 'sb-init': {
      const s = session(m.session);
      const prev = s.sbs.get(m.sb);
      if (prev && prev.mime === m.mime) break;
      s.sbs.set(m.sb, { mime: m.mime, demuxer: createDemuxer(m.mime) });
      break;
    }
    case 'append': {
      const s = session(m.session);
      let sb = s.sbs.get(m.sb);
      if (!sb) {
        sb = { mime: '', demuxer: null };
        s.sbs.set(m.sb, sb);
      }
      if (!sb.demuxer) {
        // Late attach: sniff the container.
        const b = new Uint8Array(m.data, 0, Math.min(8, m.data.byteLength));
        const isWebm = b[0] === 0x1a && b[1] === 0x45 && b[2] === 0xdf && b[3] === 0xa3;
        const isMp4 = String.fromCharCode(b[4], b[5], b[6], b[7]) === 'ftyp';
        if (isWebm || isMp4) sb.demuxer = createDemuxer(isWebm ? 'audio/webm' : 'audio/mp4');
      }
      if (!sb.demuxer) break;
      try {
        for (const p of sb.demuxer.push(new Uint8Array(m.data), m.tsOffset)) s.store.add(p);
      } catch (err) {
        console.warn('[music-remover] demux error', err);
        sb.demuxer.resetParser();
      }
      if (pos?.enabled) schedule();
      break;
    }
    case 'abort': {
      sessions.get(m.session)?.sbs.get(m.sb)?.demuxer?.resetParser();
      break;
    }
    case 'drop-session':
      sessions.delete(m.session);
      break;
    case 'position': {
      pos = m;
      if (m.enabled) lastEnabledAt = Date.now();
      have = new Set(m.have);
      const s = sessions.get(m.session);
      if (s) {
        s.lastUsed = Date.now();
        s.store.evictBefore(m.time - KEEP_BEHIND_S);
      }
      if (m.enabled && status.model === 'idle') void initModel();
      schedule();
      updateStatus();
      break;
    }
  }
};

async function initModel(): Promise<void> {
  status.model = 'loading';
  updateStatus(true);
  try {
    model = await loadModel({ base, modelFile: MODEL_FILE, shape: mdx.tensorShape });
    status.model = 'ready';
    status.backend = model.backend;
  } catch (e) {
    status.model = 'error';
    status.error = e instanceof Error ? e.message : String(e);
    console.error('[music-remover] model load failed', e);
  }
  updateStatus(true);
  schedule();
}

let scheduled = false;
function schedule(): void {
  if (scheduled) return;
  scheduled = true;
  setTimeout(() => {
    scheduled = false;
    void pump();
  }, 0);
}

function pickTile(): { k: number; validFrom: number } | null {
  if (!pos || !pos.enabled) return null;
  const s = sessions.get(pos.session);
  if (!s) return null;
  const kNow = Math.max(0, tiling.tileAt(pos.time));
  const now = Date.now();
  for (let k = kNow; k <= kNow + LOOKAHEAD_TILES; k++) {
    if (Number.isFinite(pos.duration) && pos.duration > 0 && tiling.tileStart(k) >= pos.duration) break;
    if (have.has(k)) continue;
    const key = `${pos.session}:${k}`;
    const sent = sentAt.get(key);
    if (sent && now - sent < 3000) continue; // page hasn't acknowledged yet
    const failed = failedAt.get(key);
    if (failed && now - failed < 5000) continue;
    const [a, b] = tiling.inputRange(k);
    if (s.store.covers(a, b, pos.duration)) return { k, validFrom: tiling.tileStart(k) };
    // Right after a seek the player has no audio before the new position. For the tile under
    // the playhead, separate what exists (the unheard part before it is treated as silence)
    // instead of waiting for the next tile boundary.
    if (k === kNow) {
      const from = Math.max(a, pos.time - 0.3);
      if (from > a && s.store.covers(from, b, pos.duration)) return { k, validFrom: Math.max(tiling.tileStart(k), from + 0.1) };
    }
  }
  return null;
}

async function pump(): Promise<void> {
  if (busy || !model || !pos) return;
  const pick = pickTile();
  if (pick === null) return;
  const { k, validFrom } = pick;
  const sessionId = pos.session;
  const s = sessions.get(sessionId)!;
  busy = true;
  const key = `${sessionId}:${k}`;
  try {
    const t0 = performance.now();
    const [a, b] = tiling.inputRange(k);
    const decoded = await decodePackets(s.store.range(a - 0.12, b + 0.05));
    if (!decoded) throw new Error('nothing decoded');
    const L = resampleCubic(decoded.left, decoded.sampleRate, decoded.start, tiling.rate, a, tiling.chunkSize);
    const R = resampleCubic(decoded.right, decoded.sampleRate, decoded.start, tiling.rate, a, tiling.chunkSize);
    const mixLeft = pos.debug ? L.slice(tiling.trim, tiling.trim + tiling.genSize) : undefined;
    const [left, right] = await separateWindow(mdx, model.run, L, R, scratch);
    const dt = (performance.now() - t0) / 1000;
    computeSec += dt;
    audioSec += tiling.tileSeconds;
    status.tilesDone++;
    status.rtf = computeSec / audioSec;
    sentAt.set(key, Date.now());
    const transfer: Transferable[] = [left.buffer, right.buffer];
    if (mixLeft) transfer.push(mixLeft.buffer);
    post(
      { type: 'tile', session: sessionId, k, start: tiling.tileStart(k), validFrom, sampleRate: tiling.rate, left, right, mixLeft, computeMs: dt * 1000 },
      transfer,
    );
  } catch (e) {
    console.warn('[music-remover] tile failed', k, e);
    failedAt.set(key, Date.now());
  } finally {
    busy = false;
  }
  updateStatus();
  schedule();
}

let lastStatus = 0;
function updateStatus(force = false): void {
  const now = Date.now();
  if (!force && now - lastStatus < 500) return;
  lastStatus = now;
  if (pos) {
    const kNow = Math.max(0, tiling.tileAt(pos.time));
    let k = kNow;
    while (have.has(k) || sentAt.has(`${pos.session}:${k}`)) k++;
    status.ahead = Math.max(0, tiling.tileStart(k) - pos.time);
    const s = sessions.get(pos.session);
    status.inputAhead = s ? Math.max(0, s.store.contiguousEnd(pos.time) - pos.time) : 0;
    // forget acknowledgements far behind
    for (const key of sentAt.keys()) {
      const [sid, kk] = key.split(':').map(Number);
      if (sid !== pos.session || kk < kNow - 4) sentAt.delete(key);
    }
  }
  post({ type: 'status', status: { ...status } });
}

setInterval(() => {
  if (model && !busy && Date.now() - lastEnabledAt > IDLE_RELEASE_MS) {
    const m = model;
    model = null;
    status.model = 'idle';
    status.backend = '-';
    void m.release().catch(() => undefined);
    updateStatus(true);
  }
}, 30_000);

post({ type: 'tiling', tileSeconds: tiling.tileSeconds, sampleRate: tiling.rate });
post({ type: 'ready' });
