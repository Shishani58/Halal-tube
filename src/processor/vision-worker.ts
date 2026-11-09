/// <reference lib="webworker" />
/**
 * Frame classifier for blurring. Receives the video track as the player buffers it (ahead of
 * playback), decodes it GOP by GOP with WebCodecs and classifies ~4 frames per second:
 *   1. NudeNet (YOLOv8n, WebGPU) on a 320×320 copy → nudity scores + face boxes;
 *   2. InsightFace genderage (1.3 MB, WASM) on each face crop → is it a woman.
 * Reports which time ranges were checked and what was found.
 *
 * Every frame has to be decoded (inter-frame coding), but only sampled frames are copied (on the
 * GPU, into an ImageBitmap) and only 320×320 + 96×96 face crops are read back; everything else is
 * closed right away. Decoding, detection and classification are pipelined in batches of 8, so at
 * most a couple of batches of frame copies exist at a time. Packets are dropped as soon as their
 * GOP is analysed.
 */
import { createDemuxer, type Demuxer, type Packet } from '../core/demux';
import { IntervalSet } from '../core/intervals';
import {
  GENDER_INPUT as GS,
  NUDENET_BATCH as B,
  NUDENET_INPUT as S,
  detectFaces,
  faceCrop,
  femaleProb,
  femaleScore,
  letterbox,
  rgbaToChw,
  rgbaToGenderInput,
  scoreFrames,
} from '../core/nudenet';
import type { FromVision, ToVision, VisionStatus } from '../shared/vision-messages';
import { loadModel, type LoadedModel } from './model';

declare const self: DedicatedWorkerGlobalScope;

const DETECTOR_FILE = 'nudenet-320n.onnx';
const GENDER_FILE = 'genderage.onnx';
/** Faces per gender-classifier call. */
const G = 8;
/** Longest side of the frame copy kept for face crops. */
const HI = 960;
/** Faces smaller than this (px in the HI copy) are too small to classify. */
const MIN_FACE = 20;
/** Seconds between classified frames. */
const STEP = 0.25;
/** A still-growing GOP under the playhead is re-analysed once this many new seconds arrived. */
const PARTIAL_MIN = 1;
/** Analyse up to this far ahead of the playhead. */
const LOOKAHEAD = 180;
const KEEP_BEHIND = 5;
/** Cap on compressed video held while waiting for analysis. */
const MAX_BYTES = 256 * 1024 * 1024;
const MAX_SESSIONS = 4;
const IDLE_RELEASE_MS = 3 * 60_000;

interface Gop {
  start: number;
  end: number;
  lastDts: number;
  configKey: string;
  packets: Packet[];
  bytes: number;
  /** The stream moved past this GOP: it won't grow any more. */
  closed: boolean;
  /** Presentation time of the last classified frame (partial analysis of a still-growing GOP). */
  analyzedTo: number;
  analyzedCount: number;
  lastAppend: number;
  done: boolean;
}

interface Sb {
  mime: string;
  demuxer: Demuxer | null;
  cur: Gop | null;
}

interface Session {
  sbs: Map<number, Sb>;
  gops: Gop[];
  checked: IntervalSet;
  lastUsed: number;
}

const base = new URL('../', self.location.href).href;
const sessions = new Map<number, Session>();
let pos: Extract<ToVision, { type: 'position' }> | null = null;
let model: LoadedModel | null = null;
let gender: LoadedModel | null = null;
let busy = false;
let lastEnabledAt = Date.now();
let workSec = 0;
let mediaSec = 0;
const status: VisionStatus = { model: 'idle', backend: '-', frames: 0, speed: 0, ahead: 0 };

const post = (m: FromVision) => self.postMessage(m);

function session(id: number): Session {
  let s = sessions.get(id);
  if (!s) {
    s = { sbs: new Map(), gops: [], checked: new IntervalSet(), lastUsed: Date.now() };
    sessions.set(id, s);
    if (sessions.size > MAX_SESSIONS) {
      const oldest = [...sessions.entries()].sort((a, b) => a[1].lastUsed - b[1].lastUsed)[0];
      if (oldest && oldest[0] !== id) sessions.delete(oldest[0]);
    }
  }
  return s;
}

function free(g: Gop): void {
  g.done = true;
  g.packets = [];
  g.bytes = 0;
}

function close(g: Gop, nextKey: number | null): void {
  g.closed = true;
  // the GOP lasts until the next keyframe when the stream continues seamlessly
  if (nextKey !== null && nextKey >= g.end - 0.25 && nextKey - g.end < 0.5) g.end = nextKey;
}

function addPacket(s: Session, sb: Sb, p: Packet): void {
  const dts = p.dts ?? p.ts;
  const cur = sb.cur;
  const now = Date.now();
  if (p.key) {
    if (cur) close(cur, p.ts);
    const g: Gop = {
      start: p.ts, end: p.ts + p.dur, lastDts: dts, configKey: p.config.key, packets: [p], bytes: p.data.byteLength,
      closed: false, analyzedTo: -Infinity, analyzedCount: 0, lastAppend: now, done: false,
    };
    // same GOP appended again (seek back, quality switch): the newest copy wins
    const gs = s.gops;
    for (let i = gs.length - 1; i >= 0; i--) if (Math.abs(gs[i].start - p.ts) < 0.01 && gs[i] !== cur) gs.splice(i, 1);
    let i = gs.length;
    while (i > 0 && gs[i - 1].start > g.start) i--;
    gs.splice(i, 0, g);
    sb.cur = g;
    return;
  }
  if (!cur || cur.closed) return; // no keyframe to start decoding from
  if (p.config.key !== cur.configKey || dts <= cur.lastDts - 1e-6 || dts > cur.lastDts + 1) {
    // discontinuity without a keyframe: nothing after this point is decodable
    close(cur, null);
    sb.cur = null;
    return;
  }
  cur.packets.push(p);
  cur.bytes += p.data.byteLength;
  cur.lastDts = dts;
  cur.end = Math.max(cur.end, p.ts + p.dur);
  cur.lastAppend = now;
}

self.onmessage = (e: MessageEvent<ToVision>) => {
  const m = e.data;
  switch (m.type) {
    case 'sb-init': {
      const s = session(m.session);
      const prev = s.sbs.get(m.sb);
      if (prev && prev.mime === m.mime) break;
      if (prev?.cur) close(prev.cur, null);
      s.sbs.set(m.sb, { mime: m.mime, demuxer: createDemuxer(m.mime, 'video'), cur: null });
      break;
    }
    case 'append': {
      const s = session(m.session);
      const sb = s.sbs.get(m.sb);
      if (!sb?.demuxer) break;
      try {
        for (const p of sb.demuxer.push(new Uint8Array(m.data), m.tsOffset)) addPacket(s, sb, p);
      } catch (err) {
        console.warn('[music-remover] video demux error', err);
        sb.demuxer.resetParser();
        if (sb.cur) close(sb.cur, null);
        sb.cur = null;
      }
      if (pos?.enabled) schedule();
      break;
    }
    case 'abort': {
      const sb = sessions.get(m.session)?.sbs.get(m.sb);
      if (sb) {
        sb.demuxer?.resetParser();
        if (sb.cur) close(sb.cur, null);
        sb.cur = null;
      }
      break;
    }
    case 'position': {
      pos = m;
      if (m.enabled) lastEnabledAt = Date.now();
      const s = sessions.get(m.session);
      if (s) {
        s.lastUsed = Date.now();
        evict(s, m.time);
      }
      if (m.enabled && status.model === 'idle') void initModel();
      schedule();
      updateStatus();
      break;
    }
  }
};

function evict(s: Session, t: number): void {
  s.gops = s.gops.filter((g) => {
    if (g.end >= t - KEEP_BEHIND || g.start > t) return true;
    free(g);
    return false;
  });
  let total = s.gops.reduce((a, g) => a + g.bytes, 0);
  for (let i = s.gops.length - 1; i >= 0 && total > MAX_BYTES; i--) {
    const g = s.gops[i];
    if (g.start <= t) break;
    total -= g.bytes;
    free(g);
    s.gops.splice(i, 1);
  }
}

async function initModel(): Promise<void> {
  status.model = 'loading';
  updateStatus(true);
  try {
    model = await loadModel({ base, modelFile: DETECTOR_FILE, shape: [B, 3, S, S] });
    // tiny model, tiny inputs: CPU avoids GPU round trips and leaves the GPU to the detector
    gender = await loadModel({ base, modelFile: GENDER_FILE, shape: [G, 3, GS, GS], backend: 'wasm' });
    status.model = 'ready';
    status.backend = model.backend;
  } catch (e) {
    status.model = 'error';
    status.error = e instanceof Error ? e.message : String(e);
    console.error('[music-remover] vision model load failed', e);
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

/** Next GOP to analyse: the earliest one at or after the playhead that is ready. */
function pickGop(s: Session, t: number): Gop | null {
  const now = Date.now();
  for (const g of s.gops) {
    if (g.done || !g.packets.length || g.end < t - 0.5) continue;
    if (g.start > t + LOOKAHEAD) break;
    if (g.closed) {
      if (s.checked.covers(g.start, g.end)) {
        free(g);
        continue;
      }
      return g;
    }
    // Still growing (the player is mid-segment). Worth a partial pass when it's what is on
    // screen now (long GOPs would otherwise leave the playhead unchecked for seconds): once
    // appends pause, or once enough new frames came in. Each pass re-decodes from the keyframe.
    if (g.start <= t + 3 && g.packets.length > g.analyzedCount) {
      const fresh = g.end - Math.max(g.start, g.analyzedTo);
      if (now - g.lastAppend > 300 || fresh >= PARTIAL_MIN || (g.analyzedCount === 0 && fresh >= STEP)) return g;
    }
  }
  return null;
}

interface Shot {
  t: number;
  bmp: ImageBitmap;
}

function ctx(w: number, h: number): OffscreenCanvasRenderingContext2D {
  return new OffscreenCanvas(w, h).getContext('2d', { alpha: false })!;
}
let hiCtx: OffscreenCanvasRenderingContext2D | null = null;
let loCtx: OffscreenCanvasRenderingContext2D | null = null;
let faceCtx: OffscreenCanvasRenderingContext2D | null = null;
const detIn = new Float32Array(B * 3 * S * S);
const genIn = new Float32Array(G * 3 * GS * GS);

async function pump(): Promise<void> {
  if (busy || !model || !gender || !pos?.enabled) return;
  const sid = pos.session;
  const s = sessions.get(sid);
  if (!s) return;
  const g = pickGop(s, pos.time);
  if (!g) return;
  busy = true;
  try {
    await analyse(sid, s, g);
  } catch (e) {
    console.warn('[music-remover] GOP analysis failed', g.start, e);
    if (g.closed) free(g);
    else g.analyzedCount = g.packets.length; // retry once more data arrives
  } finally {
    busy = false;
  }
  updateStatus();
  schedule();
}

/** Classify shots: nudity scores and face boxes, then the gender of each face. → flat samples */
async function classify(shots: Shot[]): Promise<number[]> {
  loCtx ??= ctx(S, S);
  faceCtx ??= ctx(GS, GS);
  const lo = loCtx, fc = faceCtx;
  const n = shots.length;
  for (let j = 0; j < n; j++) {
    const { bmp } = shots[j];
    const { dw, dh } = letterbox(bmp.width, bmp.height);
    lo.fillStyle = '#000';
    lo.fillRect(0, 0, S, S);
    lo.drawImage(bmp, 0, 0, dw, dh);
    rgbaToChw(lo.getImageData(0, 0, S, S).data, S, detIn, j * 3 * S * S);
  }
  const out = await model!.run(detIn);
  const scores = scoreFrames(out, B, n);

  // face crops from the higher-resolution copies
  const owners: number[] = [];
  const probs: number[][] = shots.map(() => []);
  const flush = async () => {
    if (!owners.length) return;
    const g = await gender!.run(genIn);
    owners.forEach((j, i) => probs[j].push(femaleProb(g, i)));
    owners.length = 0;
  };
  for (let j = 0; j < n; j++) {
    const { bmp } = shots[j];
    const k = Math.max(bmp.width, bmp.height) / S;
    for (const box of detectFaces(out, B, j)) {
      const c = faceCrop(box);
      if (c.side * k < MIN_FACE) continue;
      fc.fillStyle = '#000';
      fc.fillRect(0, 0, GS, GS);
      fc.drawImage(bmp, c.x * k, c.y * k, c.side * k, c.side * k, 0, 0, GS, GS);
      rgbaToGenderInput(fc.getImageData(0, 0, GS, GS).data, GS, genIn, owners.length * 3 * GS * GS);
      owners.push(j);
      if (owners.length === G) await flush();
    }
  }
  await flush();

  const r = (x: number) => Math.round(x * 1000) / 1000;
  const samples: number[] = [];
  for (let j = 0; j < n; j++) {
    const sc = scores[j];
    samples.push(+shots[j].t.toFixed(3), r(sc.nude), r(sc.skin), r(femaleScore(probs[j], sc.femaleBody)));
  }
  return samples;
}

async function analyse(sid: number, s: Session, g: Gop): Promise<void> {
  const t0 = performance.now();
  const packets = g.packets.slice();
  const wasClosed = g.closed;
  const cfg = packets[0].config;
  const from = g.analyzedTo;
  hiCtx ??= ctx(16, 16);
  const hc = hiCtx;
  const pending: Shot[] = [];
  const samples: number[] = [];
  let next = from + STEP;
  let lastT = -Infinity;
  let lastShot = -Infinity;
  let lastDur = 0;
  let shots = 0;
  let failure: unknown = null;

  const decoder = new VideoDecoder({
    output: (f) => {
      try {
        const t = f.timestamp / 1e6;
        lastT = Math.max(lastT, t);
        lastDur = (f.duration ?? 0) / 1e6 || lastDur;
        if (t > from + 1e-3 && t >= next - 0.02) {
          next = t + STEP;
          // GPU-side copy at ≤ HI px; the VideoFrame can be released immediately
          const k = Math.min(1, HI / Math.max(f.displayWidth, f.displayHeight));
          const w = Math.max(1, Math.round(f.displayWidth * k)), h = Math.max(1, Math.round(f.displayHeight * k));
          if (hc.canvas.width !== w || hc.canvas.height !== h) {
            hc.canvas.width = w;
            hc.canvas.height = h;
          }
          hc.drawImage(f, 0, 0, w, h);
          pending.push({ t, bmp: (hc.canvas as OffscreenCanvas).transferToImageBitmap() });
          lastShot = Math.max(lastShot, t);
        }
      } finally {
        f.close();
      }
    },
    error: (e) => {
      failure = e;
    },
  });
  const runBatch = async () => {
    const batch = pending.splice(0, B);
    try {
      samples.push(...(await classify(batch)));
      shots += batch.length;
    } finally {
      for (const x of batch) x.bmp.close();
    }
  };
  try {
    decoder.configure({
      codec: cfg.codec,
      description: cfg.description,
      codedWidth: cfg.width || undefined,
      codedHeight: cfg.height || undefined,
      optimizeForLatency: true,
    });
    for (const p of packets) {
      // keep the decoder fed but bounded; classify as soon as a batch is ready
      while (!failure && decoder.state === 'configured' && (pending.length >= B || decoder.decodeQueueSize > 8)) {
        if (pending.length >= B) await runBatch();
        else await new Promise((r) => decoder.addEventListener('dequeue', r, { once: true }));
      }
      if (failure || decoder.state !== 'configured') break;
      decoder.decode(
        new EncodedVideoChunk({ type: p.key ? 'key' : 'delta', timestamp: Math.round(p.ts * 1e6), duration: Math.round(p.dur * 1e6), data: p.data }),
      );
    }
    if (!failure && decoder.state === 'configured') await decoder.flush();
    if (failure) throw failure;
    while (pending.length) await runBatch();
  } finally {
    for (const x of pending) x.bmp.close();
    if (decoder.state !== 'closed') decoder.close();
  }

  const spanFrom = Number.isFinite(from) ? from : g.start;
  const spanTo = wasClosed ? g.end : lastT + (lastDur || 1 / 30);
  if (Number.isFinite(lastShot)) g.analyzedTo = lastShot;
  g.analyzedCount = packets.length;
  if (spanTo > spanFrom) s.checked.add(spanFrom, spanTo);
  if (wasClosed) free(g);
  if (spanTo > spanFrom) post({ type: 'result', session: sid, from: spanFrom, to: spanTo, samples });

  status.frames += shots;
  workSec += (performance.now() - t0) / 1000;
  mediaSec += Math.max(0, spanTo - spanFrom);
  status.speed = workSec > 0 ? mediaSec / workSec : 0;
}

let lastStatus = 0;
function updateStatus(force = false): void {
  const now = Date.now();
  if (!force && now - lastStatus < 500) return;
  lastStatus = now;
  if (pos) {
    const s = sessions.get(pos.session);
    status.ahead = s ? Math.max(0, s.checked.endFrom(pos.time) - pos.time) : 0;
  }
  post({ type: 'status', status: { ...status } });
}

setInterval(() => {
  if (model && !busy && Date.now() - lastEnabledAt > IDLE_RELEASE_MS) {
    const m = model;
    const gm = gender;
    model = null;
    gender = null;
    status.model = 'idle';
    status.backend = '-';
    void m.release().catch(() => undefined);
    void gm?.release().catch(() => undefined);
    updateStatus(true);
  }
}, 30_000);

post({ type: 'ready' });
