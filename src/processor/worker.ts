/// <reference lib="webworker" />
/**
 * One processing Worker for the whole browser (owned by the offscreen document): one model in
 * GPU memory shared by every tab. Session ids arrive already made unique by the offscreen
 * document. Each session reports its playhead; the worker always separates the tile that is
 * needed soonest, playing videos first.
 */
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
const MAX_SESSIONS = 8;
/** Free the model (GPU memory) after this long without any video playing. */
const IDLE_RELEASE_MS = 3 * 60_000;
/** A session that stopped reporting its position (tab frozen / closed) is not worked on. */
const POSITION_STALE_MS = 10_000;

const base = new URL('../', self.location.href).href;
const mdx = new MdxProcessor(KIM_VOCAL_2);
const tiling = new Tiling(mdx);
const scratch = new Float32Array(4 * KIM_VOCAL_2.dimF * KIM_VOCAL_2.dimT);

type Position = Extract<ToWorker, { type: 'position' }>;

interface Session {
  store: PacketStore;
  sbs: Map<number, { mime: string; demuxer: Demuxer | null }>;
  lastUsed: number;
  pos: Position | null;
  posAt: number;
  have: Set<number>;
}

const sessions = new Map<number, Session>();
const sentAt = new Map<string, number>(); // `${session}:${k}` → time sent
const failedAt = new Map<string, number>();
let model: LoadedModel | null = null;
let modelEverLoaded = false;
let busy = false;
let lastPlayingAt = Date.now();
const model$: Pick<WorkerStatus, 'model' | 'backend' | 'error' | 'rtf' | 'tilesDone'> = {
  model: 'idle',
  backend: '-',
  rtf: 0,
  tilesDone: 0,
};
let computeSec = 0;
let audioSec = 0;

function post(msg: FromWorker, transfer: Transferable[] = []): void {
  self.postMessage(msg, transfer);
}

function session(id: number): Session {
  let s = sessions.get(id);
  if (!s) {
    s = { store: new PacketStore(), sbs: new Map(), lastUsed: Date.now(), pos: null, posAt: 0, have: new Set() };
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
      if (s.pos?.enabled) schedule();
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
      const s = session(m.session);
      s.pos = m;
      s.posAt = Date.now();
      s.lastUsed = Date.now();
      s.have = new Set(m.have);
      s.store.evictBefore(m.time - KEEP_BEHIND_S);
      if (m.enabled && m.playing) lastPlayingAt = Date.now();
      // Load the model as soon as a page has a video; after an idle release, only once one plays.
      if (m.enabled && model$.model === 'idle' && (m.playing || !modelEverLoaded)) void initModel();
      schedule();
      updateStatus();
      break;
    }
  }
};

async function initModel(): Promise<void> {
  model$.model = 'loading';
  model$.error = undefined;
  updateStatus(true);
  try {
    model = await loadModel({ base, modelFile: MODEL_FILE, shape: mdx.tensorShape });
    modelEverLoaded = true;
    model$.model = 'ready';
    model$.backend = model.backend;
  } catch (e) {
    model$.model = 'error';
    model$.error = e instanceof Error ? e.message : String(e);
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

interface TilePick {
  sessionId: number;
  k: number;
  validFrom: number;
  /** Seconds of wall time until this tile is heard (lower = more urgent). */
  due: number;
}

function activeSessions(): [number, Session][] {
  const now = Date.now();
  return [...sessions.entries()].filter(([, s]) => s.pos?.enabled && now - s.posAt < POSITION_STALE_MS);
}

/** Where the playhead is now: the last reported time, advanced by the time since the report. */
function playhead(s: Session): number {
  const pos = s.pos!;
  if (!pos.playing) return pos.time;
  return pos.time + (Math.min(Date.now() - s.posAt, 2000) / 1000) * (pos.rate > 0 ? pos.rate : 1);
}

/** Expected wall time to separate one tile, seconds. */
function tileComputeEstimate(): number {
  return (model$.rtf > 0 ? model$.rtf : 0.3) * tiling.tileSeconds + 0.25;
}

/** Tile under the playhead and whether it is still missing (neither held by the page nor sent). */
function nowTile(id: number, s: Session): { kNow: number; missing: boolean } {
  const kNow = Math.max(0, tiling.tileAt(playhead(s)));
  const sent = sentAt.get(`${id}:${kNow}`);
  return { kNow, missing: !s.have.has(kNow) && !(sent && Date.now() - sent < 3000) };
}

function pickFor(id: number, s: Session): TilePick | null {
  const pos = s.pos!;
  const { kNow } = nowTile(id, s);
  const now = Date.now();
  const rate = pos.rate > 0 ? pos.rate : 1;
  const t = playhead(s);
  for (let k = kNow; k <= kNow + LOOKAHEAD_TILES; k++) {
    // A tile that will already be over when it's ready is wasted work: go for the next one
    // (e.g. after a seek close to the end of a tile).
    if (pos.playing && k === kNow && (tiling.tileStart(k + 1) - t) / rate < tileComputeEstimate()) continue;
    if (Number.isFinite(pos.duration) && pos.duration > 0 && tiling.tileStart(k) >= pos.duration) break;
    if (s.have.has(k)) continue;
    const key = `${id}:${k}`;
    const sent = sentAt.get(key);
    if (sent && now - sent < 3000) continue; // page hasn't acknowledged yet
    const failed = failedAt.get(key);
    if (failed && now - failed < 5000) continue;
    const due = Math.max(0, tiling.tileStart(k) - t) / rate + (pos.playing ? 0 : 1000);
    const [a, b] = tiling.inputRange(k);
    if (s.store.covers(a, b, pos.duration)) return { sessionId: id, k, validFrom: tiling.tileStart(k), due };
    // Right after a seek the player has no audio before the new position. For the tile under
    // the playhead, separate what exists (the unheard part before it is treated as silence)
    // instead of waiting for the next tile boundary.
    if (k === kNow) {
      const from = Math.max(a, t - 0.3);
      if (from > a && s.store.covers(from, b, pos.duration)) {
        return { sessionId: id, k, validFrom: Math.max(tiling.tileStart(k), from + 0.1), due };
      }
    }
  }
  return null;
}

function pickTile(): TilePick | null {
  let best: TilePick | null = null;
  for (const [id, s] of activeSessions()) {
    const p = pickFor(id, s);
    if (p && (!best || p.due < best.due)) best = p;
  }
  return best;
}

async function pump(): Promise<void> {
  if (busy || !model) return;
  const pick = pickTile();
  if (pick === null) return;
  const { sessionId, k, validFrom } = pick;
  const s = sessions.get(sessionId)!;
  const debug = !!s.pos?.debug;
  busy = true;
  const key = `${sessionId}:${k}`;
  try {
    const t0 = performance.now();
    const [a, b] = tiling.inputRange(k);
    const decoded = await decodePackets(s.store.range(a - 0.12, b + 0.05));
    if (!decoded) throw new Error('nothing decoded');
    // The viewer may have seeked while this was being decoded: don't spend the model on a tile
    // that is no longer ahead of the playhead.
    if (s.pos && (k < tiling.tileAt(playhead(s)) || tiling.tileStart(k) > playhead(s) + (LOOKAHEAD_TILES + 1) * tiling.tileSeconds)) return;
    const L = resampleCubic(decoded.left, decoded.sampleRate, decoded.start, tiling.rate, a, tiling.chunkSize);
    const R = resampleCubic(decoded.right, decoded.sampleRate, decoded.start, tiling.rate, a, tiling.chunkSize);
    const mixLeft = debug ? L.slice(tiling.trim, tiling.trim + tiling.genSize) : undefined;
    const [left, right] = await separateWindow(mdx, model.run, L, R, scratch);
    const dt = (performance.now() - t0) / 1000;
    computeSec += dt;
    audioSec += tiling.tileSeconds;
    model$.tilesDone++;
    model$.rtf = computeSec / audioSec;
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
    schedule();
  }
  updateStatus();
}

function sessionStatus(id: number, s: Session): WorkerStatus {
  const pos = s.pos!;
  const { kNow, missing } = nowTile(id, s);
  let k = kNow;
  while (s.have.has(k) || sentAt.has(`${id}:${k}`)) k++;
  let waitFor: WorkerStatus['waitFor'];
  if (missing) {
    const [a, b] = tiling.inputRange(kNow);
    const from = Math.max(a, pos.time - 0.3);
    const coverable = s.store.covers(a, b, pos.duration) || (from > a && s.store.covers(from, b, pos.duration));
    waitFor = coverable ? 'compute' : 'input';
  }
  return {
    ...model$,
    ahead: Math.max(0, tiling.tileStart(k) - pos.time),
    inputAhead: Math.max(0, s.store.contiguousEnd(pos.time) - pos.time),
    waitFor,
  };
}

let lastStatus = 0;
function updateStatus(force = false): void {
  const now = Date.now();
  if (!force && now - lastStatus < 400) return;
  lastStatus = now;
  // forget acknowledgements far behind each playhead
  for (const key of sentAt.keys()) {
    const [sid, kk] = key.split(':').map(Number);
    const s = sessions.get(sid);
    if (!s?.pos || kk < tiling.tileAt(s.pos.time) - 4) sentAt.delete(key);
  }
  let any = false;
  for (const [id, s] of sessions) {
    if (!s.pos) continue;
    any = true;
    post({ type: 'status', session: id, status: sessionStatus(id, s) });
  }
  if (!any) post({ type: 'status', status: { ...model$, ahead: 0, inputAhead: 0 } });
}

setInterval(() => {
  if (model && !busy && Date.now() - lastPlayingAt > IDLE_RELEASE_MS) {
    const m = model;
    model = null;
    model$.model = 'idle';
    model$.backend = '-';
    void m.release().catch(() => undefined);
    updateStatus(true);
  }
}, 30_000);

post({ type: 'tiling', tileSeconds: tiling.tileSeconds, sampleRate: tiling.rate });
post({ type: 'ready' });
