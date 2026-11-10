/// <reference lib="webworker" />
/**
 * Frame classifier for blurring. Receives the video track as the player buffers it (ahead of
 * playback) and decodes it GOP by GOP with WebCodecs. Every decoded frame is shrunk to a 32×18
 * thumbnail to find shot cuts; frames are classified at each cut (the first frame of a new shot),
 * when the picture has changed enough since the last look, and at least every 0.5 s:
 *   1. NudeNet (YOLOv8n, WebGPU) on a copy letterboxed to 320 px (320×192 for 16:9 video) →
 *      nudity scores, face and body boxes;
 *   2. InsightFace genderage (1.3 MB, WASM) on each face crop → is it a woman, and where she is;
 *   3. MobileCLIP-S0 (45 MB, WebGPU) on three squares of the frame → are there women in it at all
 *      (small or stylised figures the face pipeline can't see; the page blurs the whole frame).
 * Reports which time ranges were checked, where the cuts are and what was found where.
 *
 * Every frame has to be decoded (inter-frame coding). Each one gets a GPU-side copy (an
 * ImageBitmap, ≤ 960 px) and a thumbnail drawn into a strip; the strip of 16 thumbnails is read
 * back at once, and copies of the frames not picked for classification are closed. GPU readbacks
 * stall the worker, so they are batched everywhere: one per 16 thumbnails, one per 8 detector
 * inputs, one per batch of face crops. Decoding, detection and classification are pipelined, so
 * at most a few batches of frame copies exist at a time. Packets are dropped as soon as their GOP
 * is analysed.
 */
import { createDemuxer, type Demuxer, type Packet } from '../core/demux';
import { IntervalSet } from '../core/intervals';
import {
  BODY_CLASSES,
  GENDER_CROPS,
  GENDER_INPUT as GS,
  GROUPS,
  FEMALE_BODY_MIN,
  NUDENET_BATCH as B,
  NUDENET_INPUT as S,
  detectBoxes,
  detectFaces,
  detectorInput,
  faceCrop,
  femaleProb,
  femaleScore,
  letterbox,
  personFromBody,
  personFromFace,
  rgbaToChw,
  rgbaToGenderInput,
  scoreFrames,
  toFrame,
  type Rect,
} from '../core/nudenet';
import { CLIP_INPUT as CS, CLIP_VIEWS, clipViews, rgbaToClip } from '../core/clip';
import type { FromClip, ToClip } from './clip-worker';
import { ShotTracker, THUMB_H, THUMB_W, isEdgeCut, makeThumb, type Thumb } from '../core/shots';
import type { FromVision, ToVision, VisionFrame, VisionStatus } from '../shared/vision-messages';
import { PART, THRESHOLDS } from '../core/vision-timeline';
import { ClipBudget, clipMode } from '../core/clip-budget';
import { loadModel, type LoadedModel } from './model';

declare const self: DedicatedWorkerGlobalScope;

const DETECTOR_FILE = 'nudenet-320n.onnx';
const GENDER_FILE = 'genderage.onnx';
/** Longest wait for the scene model to load / to score a batch; past it, frames go without. */
const CLIP_LOAD_MS = 60_000;
const CLIP_RUN_MS = 10_000;
/** Faces per gender-classifier call at most (GENDER_CROPS.length crops each). */
const NC = GENDER_CROPS.length;
const G = 8 * NC;
/** Longest side of the frame copy kept for face crops. */
const HI = 960;
/**
 * Faces the gender classifier calls a woman at least this surely are reported; the page applies
 * the threshold, a lower one where a woman's voice is heard (vision-timeline FACE_FEMALE_*).
 */
const WOMAN_REPORT = 0.05;
/** Analysed GOP edges remembered per session (cuts across GOP boundaries). */
const MAX_EDGES = 256;
/** Faces smaller than this (longer box edge, px in the HI copy) are too small to classify. */
const MIN_FACE = 17;
/** A still-growing GOP under the playhead is re-analysed once this many new seconds arrived. */
const PARTIAL_MIN = 1;
/** …or, on its first pass, once it holds this much. */
const PARTIAL_FIRST = 0.25;
/** Analyse up to this far ahead of the playhead. */
const LOOKAHEAD = 180;
const KEEP_BEHIND = 5;
/** Cap on compressed video held while waiting for analysis. */
const MAX_BYTES = 256 * 1024 * 1024;
const MAX_SESSIONS = 4;
/** Free the models after this long without analysing anything (paused, everything checked, off). */
const IDLE_RELEASE_MS = 3 * 60_000;
/** Drop the buffered video of a session not reported for this long (navigated away, blur off). */
const STALE_SESSION_MS = 60_000;
/** Consecutive analysis failures (lost GPU device, broken decoder) before reporting an error. */
const MAX_FAILURES = 3;
/** After a model error, try loading again after this long. */
const RETRY_MS = 30_000;
/** Thumbnails waiting to be classified (more are asked for again by the page later). */
const MAX_IMAGES = 200;
const IMAGE_TIMEOUT_MS = 10_000;

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

/** First and last frame thumbnails of an analysed GOP: cuts across GOP boundaries. */
interface Edge {
  start: number;
  /** Time just past the last frame. */
  end: number;
  first: Thumb;
  last: Thumb;
  /** Frame-to-frame motion at the start / end (NaN: unknown). */
  startRecent: number;
  endRecent: number;
}

interface Session {
  sbs: Map<number, Sb>;
  gops: Gop[];
  checked: IntervalSet;
  edges: Edge[];
  lastUsed: number;
}

const base = new URL('../', self.location.href).href;
const sessions = new Map<number, Session>();
let pos: Extract<ToVision, { type: 'position' }> | null = null;
let model: LoadedModel | null = null;
let gender: LoadedModel | null = null;
/**
 * The scene model, in a worker of its own (clip-worker.ts). Optional: without it (no WebGPU, file
 * missing, too slow to answer) frames get no `scene` score.
 */
let clip: Worker | null = null;
let clipCalls = 0;

function clipAsk(m: ToClip, ms: number, transfer: Transferable[] = []): Promise<FromClip | null> {
  const w = clip;
  if (!w) return Promise.resolve(null);
  const id = m.type === 'run' ? m.id : -1;
  return new Promise((resolve) => {
    const done = (r: FromClip | null) => {
      clearTimeout(timer);
      w.removeEventListener('message', on);
      resolve(r);
    };
    const on = (e: MessageEvent<FromClip>) => {
      const r = e.data;
      if ((m.type === 'load' && r.type === 'loaded') || (r.type === 'result' && r.id === id)) done(r);
    };
    const timer = setTimeout(() => done(null), ms);
    w.addEventListener('message', on);
    w.postMessage(m, transfer);
  });
}

async function loadClip(): Promise<void> {
  clip = new Worker(new URL('./clip-worker.js', self.location.href), { type: 'module' });
  const r = await clipAsk({ type: 'load' }, CLIP_LOAD_MS);
  if (r?.type === 'loaded' && r.ok) return;
  console.warn('[music-remover] scene model unavailable', r?.type === 'loaded' ? r.error : 'timeout');
  clip.terminate();
  clip = null;
}
let busy = false;
/** Last time a GOP was analysed or the models became ready (idle release). */
let lastWorkAt = Date.now();
let failures = 0;
let everLoaded = false;
let errorAt = 0;
let workSec = 0;
let mediaSec = 0;
const status: VisionStatus = { model: 'idle', backend: '-', frames: 0, speed: 0, ahead: 0 };
/** Thumbnail URLs to classify, oldest first. */
const images = new Set<string>();

const post = (m: FromVision) => self.postMessage(m);

function session(id: number): Session {
  let s = sessions.get(id);
  if (!s) {
    s = { sbs: new Map(), gops: [], checked: new IntervalSet(), edges: [], lastUsed: Date.now() };
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
  if (!cur || cur.closed || cur.done) {
    // no keyframe to start decoding from, or the GOP was dropped (memory cap)
    if (cur?.done) sb.cur = null;
    return;
  }
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
      const s = sessions.get(m.session);
      if (s) {
        s.lastUsed = Date.now();
        evict(s, m.time);
        // the last GOP of the video has no next keyframe to close it
        if (Number.isFinite(m.duration) && m.duration > 0)
          for (const sb of s.sbs.values()) if (sb.cur && sb.cur.end >= m.duration - 0.1) close(sb.cur, null);
      }
      if (status.model === 'error' && Date.now() - errorAt > RETRY_MS) status.model = 'idle';
      // Load as soon as a page has a video; after an idle release, once there is something to analyse
      // (not for a paused video whose frames ahead are all checked).
      if (m.enabled && status.model === 'idle' && (!everLoaded || (s && pickGop(s, m.time)))) void initModel();
      schedule();
      updateStatus();
      break;
    }
    case 'image': {
      images.delete(m.url);
      images.add(m.url);
      if (images.size > MAX_IMAGES) images.delete(images.values().next().value!);
      if (status.model === 'error' && Date.now() - errorAt > RETRY_MS) status.model = 'idle';
      if (status.model === 'idle') void initModel();
      schedule();
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
    // also compile the shaders for wide (16:9) video frames, the usual input
    const wide = detectorInput([letterbox(16, 9)]);
    await model.run(new Float32Array(B * 3 * wide.w * wide.h), [B, 3, wide.h, wide.w]);
    // tiny model, tiny inputs: CPU avoids GPU round trips and leaves the GPU to the detector
    gender = await loadModel({ base, modelFile: GENDER_FILE, shape: [1, 3, GS, GS], backend: 'wasm' });
    await loadClip();
    status.model = 'ready';
    status.backend = model.backend;
    status.error = undefined;
    lastWorkAt = Date.now();
    everLoaded = true;
  } catch (e) {
    void releaseModels();
    setError(e);
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
      if (now - g.lastAppend > 300 || fresh >= PARTIAL_MIN || (g.analyzedCount === 0 && fresh >= PARTIAL_FIRST)) return g;
    }
  }
  return null;
}

interface Shot {
  t: number;
  bmp: ImageBitmap;
  /** Thumbnail, and whether the frame starts a new shot (clip-budget); absent for stills. */
  th?: Thumb;
  cut?: boolean;
}

function ctx(w: number, h: number): OffscreenCanvasRenderingContext2D {
  return new OffscreenCanvas(w, h).getContext('2d', { alpha: false })!;
}
let hiCtx: OffscreenCanvasRenderingContext2D | null = null;
let detCtx: OffscreenCanvasRenderingContext2D | null = null;
let faceCtx: OffscreenCanvasRenderingContext2D | null = null;
const detIn = new Float32Array(B * 3 * S * S);
const genIn = new Float32Array(G * 3 * GS * GS);
let clipCtx: OffscreenCanvasRenderingContext2D | null = null;

/** MobileCLIP women score of each frame (null without the model): views stacked, one readback. */
async function sceneWomen(bmps: ImageBitmap[]): Promise<number[] | null> {
  if (!clip || !bmps.length) return null;
  const m = bmps.length * CLIP_VIEWS;
  clipCtx ??= ctx(CS, CS * B * CLIP_VIEWS);
  const c = clipCtx;
  let i = 0;
  for (const bmp of bmps)
    for (const [x, y, side] of clipViews(bmp.width, bmp.height)) c.drawImage(bmp, x, y, side, side, 0, CS * i++, CS, CS);
  const px = c.getImageData(0, 0, CS, CS * m).data;
  const plane = CS * CS;
  const input = new Float32Array(m * 3 * plane);
  for (let k = 0; k < m; k++) rgbaToClip(px.subarray(k * plane * 4, (k + 1) * plane * 4), CS, input, k * 3 * plane);
  const r = await clipAsk({ type: 'run', id: ++clipCalls, input, frames: bmps.length }, CLIP_RUN_MS, [input.buffer]);
  return r?.type === 'result' && r.scores ? r.scores : null;
}

async function pump(): Promise<void> {
  if (busy || !model || !gender) return;
  const sid = pos?.enabled ? pos.session : 0;
  const s = sid ? sessions.get(sid) : undefined;
  const g = s && pos ? pickGop(s, pos.time) : null;
  // thumbnails are quick and on screen: first, unless the playing video needs its next frames checked
  if (images.size && !(g && s && pos && !s.checked.covers(pos.time, pos.time + 3))) {
    busy = true;
    try {
      await analyseImages();
      lastWorkAt = Date.now();
    } catch (e) {
      console.warn('[music-remover] thumbnail analysis failed', e);
    } finally {
      busy = false;
    }
    schedule();
    return;
  }
  if (!s || !g) return;
  busy = true;
  try {
    await analyse(sid, s, g);
    failures = 0;
    lastWorkAt = Date.now();
  } catch (e) {
    console.warn('[music-remover] GOP analysis failed', g.start, e);
    if (g.closed) free(g);
    else g.analyzedCount = g.packets.length; // retry once more data arrives
    // a persistent failure (lost GPU device…) must show, not silently stop checking frames
    if (++failures >= MAX_FAILURES) {
      failures = 0;
      await releaseModels();
      setError(e);
      updateStatus(true);
    }
  } finally {
    busy = false;
  }
  updateStatus();
  schedule();
}

/**
 * Classify frames: nudity scores, face and body boxes, then the gender of each face.
 * GPU readbacks stall the worker until the GPU catches up, so there are two per call, not one per
 * frame and per face: all detector inputs are drawn stacked into one canvas, all face crops into
 * another, and each is read back once.
 */
/** Cumulative milliseconds per stage (profiling; reported in the status). */
const T: Record<string, number> = {};
const lap = (k: string, since: number): number => {
  const now = performance.now();
  T[k] = (T[k] ?? 0) + now - since;
  return now;
};

async function classify(shots: Shot[], scene: ClipBudget | null = null): Promise<VisionFrame[]> {
  const tc0 = performance.now();
  let tl = tc0;
  T.classifyCalls = (T.classifyCalls ?? 0) + 1;
  T.classifyFrames = (T.classifyFrames ?? 0) + shots.length;
  const n = shots.length;
  const boxes = shots.map((x) => letterbox(x.bmp.width, x.bmp.height));
  const { w: iw, h: ih } = detectorInput(boxes);
  detCtx ??= ctx(S, S * B);
  const det = detCtx;
  if (det.canvas.width !== iw || det.canvas.height !== ih * B) {
    det.canvas.width = iw;
    det.canvas.height = ih * B;
  }
  det.fillStyle = '#000';
  det.fillRect(0, 0, iw, ih * n);
  for (let j = 0; j < n; j++) det.drawImage(shots[j].bmp, 0, j * ih, boxes[j].dw, boxes[j].dh);
  const px = det.getImageData(0, 0, iw, ih * n).data;
  const plane = iw * ih;
  for (let j = 0; j < n; j++) rgbaToChw(px.subarray(j * plane * 4, (j + 1) * plane * 4), iw, detIn, j * 3 * plane, ih);
  tl = lap('detPrep', tl);
  // unused batch slots: whatever they held (the model's output for them is never read)
  const out = await model!.run(detIn, [B, 3, ih, iw]);
  tl = lap('detRun', tl);
  const scores = scoreFrames(out, B, n);

  // face crops from the higher-resolution copies (NC per face, consecutive), stacked, one readback
  const queued: { j: number; face: Rect }[] = [];
  const crops: { bmp: ImageBitmap; sx: number; sy: number; side: number }[] = [];
  for (let j = 0; j < n; j++) {
    const { bmp } = shots[j];
    const k = Math.max(bmp.width, bmp.height) / S;
    for (const box of detectFaces(out, B, j)) {
      if (Math.max(box.w, box.h) * k < MIN_FACE) continue;
      for (const crop of GENDER_CROPS) {
        const c = faceCrop(box, crop);
        crops.push({ bmp, sx: c.x * k, sy: c.y * k, side: c.side * k });
      }
      queued.push({ j, face: toFrame(box, boxes[j].dw, boxes[j].dh) });
    }
  }
  const faces: { face: Rect; p: number }[][] = shots.map(() => []);
  for (let i0 = 0; i0 < crops.length; i0 += G) {
    const m = Math.min(G, crops.length - i0);
    faceCtx ??= ctx(GS, GS * G);
    const fc = faceCtx;
    fc.fillStyle = '#000';
    fc.fillRect(0, 0, GS, GS * m);
    for (let i = 0; i < m; i++) {
      const c = crops[i0 + i];
      fc.drawImage(c.bmp, c.sx, c.sy, c.side, c.side, 0, i * GS, GS, GS);
    }
    const fpx = fc.getImageData(0, 0, GS, GS * m).data;
    for (let i = 0; i < m; i++) rgbaToGenderInput(fpx.subarray(i * GS * GS * 4, (i + 1) * GS * GS * 4), GS, genIn, i * 3 * GS * GS);
    tl = lap('facePrep', tl);
    // exactly as many crops as there are (CPU: the cost is per crop, unlike the GPU detector)
    const g = await gender!.run(genIn, [m, 3, GS, GS]);
    tl = lap('gender', tl);
    T.genderCrops = (T.genderCrops ?? 0) + m;
    for (let i = 0; i < m; i += NC) {
      const q = queued[(i0 + i) / NC];
      faces[q.j].push({ face: q.face, p: femaleProb(g, i, NC) });
    }
  }

  const r = (x: number) => Math.round(x * 1000) / 1000;
  const frames: VisionFrame[] = [];
  for (let j = 0; j < n; j++) {
    const sc = scores[j];
    const { dw, dh } = boxes[j];
    const parts = detectBoxes(out, B, j, BODY_CLASSES, 0.3, 12).map((x) => toFrame(x, dw, dh));
    const women: number[] = [];
    const kinds: number[] = [];
    /** Each person's rects (head and body, or body alone) and their entries in `women`. */
    const people: { rects: Rect[]; at: number[] }[] = [];
    const add = (rects: Rect[], p: number, part: number[]) => {
      const at: number[] = [];
      rects.forEach((q, i) => {
        at.push(women.length / 5);
        women.push(r(q.x), r(q.y), r(q.w), r(q.h), r(p));
        kinds.push(part[i]);
      });
      people.push({ rects, at });
    };
    for (const f of faces[j]) if (f.p >= WOMAN_REPORT) add(personFromFace(f.face, parts), f.p, [PART.head, PART.body]);
    // a woman's body: makes the person it belongs to a woman; or one without a face found
    // (turned away, face cut off)
    for (const x of detectBoxes(out, B, j, GROUPS.femaleBody, FEMALE_BODY_MIN, 4)) {
      const part = toFrame(x, dw, dh);
      const cx = part.x + part.w / 2, cy = part.y + part.h / 2;
      const who = people.find((o) => o.rects.some((q) => cx >= q.x && cx <= q.x + q.w && cy >= q.y && cy <= q.y + q.h));
      if (who) for (const i of who.at) women[i * 5 + 4] = Math.max(women[i * 5 + 4], r(x.score));
      else add([personFromBody(part)], x.score, [PART.whole]);
    }
    frames.push({
      t: shots[j].t,
      nude: r(sc.nude),
      skin: r(sc.skin),
      female: r(femaleScore(faces[j].map((f) => f.p), sc.femaleBody)),
      women,
      ...(kinds.some((k) => k !== PART.whole) ? { parts: kinds } : {}),
    });
  }
  tl = lap('post', tl);
  // The scene model looks only where the budget says (clip-budget): not at frames already decided
  // by nudity or a located woman, and a few times per shot.
  if (scene && clip) {
    const asked: number[] = [];
    for (let j = 0; j < n; j++) {
      const f = frames[j];
      let located = false;
      for (let i = 4; i < f.women.length; i += 5) located ||= f.women[i] >= THRESHOLDS.female;
      if (scene.want(f.t, shots[j].th ?? null, !!shots[j].cut, f.nude >= THRESHOLDS.nude || located)) asked.push(j);
    }
    T.clipLooks = (T.clipLooks ?? 0) + asked.length;
    T.clipSkipped = (T.clipSkipped ?? 0) + n - asked.length;
    if (asked.length) {
      const sc = await sceneWomen(asked.map((j) => shots[j].bmp));
      if (sc)
        asked.forEach((j, i) => {
          frames[j].scene = r(sc[i]);
          scene.result(sc[i]);
        });
    }
    tl = lap('clip', tl);
  }
  lap('classify', tc0);
  return frames;
}

/**
 * Parts of a thumbnail looked at besides the whole picture: on a wide one, its left and right
 * halves (with some overlap), so small faces in a collage are seen at almost twice the size.
 */
function imageCrops(w: number, h: number): [number, number, number, number][] {
  if (w < h * 1.2) return [];
  const half = Math.round(w * 0.55);
  return [
    [0, 0, half, h],
    [w - half, 0, half, h],
  ];
}

/** Fetch and classify the next thumbnails: nudity and female scores, the most of the whole and its parts. */
async function analyseImages(): Promise<void> {
  const urls = [...images].slice(-B).reverse(); // newest first: what the page shows now
  for (const u of urls) images.delete(u);
  const loaded = await Promise.all(
    urls.map(async (url) => {
      const ctl = new AbortController();
      const timer = setTimeout(() => ctl.abort(), IMAGE_TIMEOUT_MS);
      try {
        const res = await fetch(url, { credentials: 'omit', signal: ctl.signal });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const whole = await createImageBitmap(await res.blob());
        const parts = await Promise.all(imageCrops(whole.width, whole.height).map(([x, y, w, h]) => createImageBitmap(whole, x, y, w, h)));
        return { url, bmps: [whole, ...parts] };
      } catch (e) {
        post({ type: 'image', url, error: e instanceof Error ? e.message : String(e) });
        return null;
      } finally {
        clearTimeout(timer);
      }
    }),
  );
  const ok = loaded.filter((x): x is { url: string; bmps: ImageBitmap[] } => !!x);
  try {
    // as many whole images per detector call as fit
    for (let i = 0; i < ok.length; ) {
      const group: typeof ok = [];
      let n = 0;
      while (i < ok.length && (n === 0 || n + ok[i].bmps.length <= B)) {
        n += ok[i].bmps.length;
        group.push(ok[i++]);
      }
      try {
        const frames = await classify(group.flatMap((x) => x.bmps.map((bmp) => ({ t: 0, bmp }))));
        let k = 0;
        for (const x of group) {
          const fs = frames.slice(k, (k += x.bmps.length));
          const max = (f: (v: VisionFrame) => number) => Math.max(...fs.map(f));
          post({ type: 'image', url: x.url, frame: { t: 0, nude: max((v) => v.nude), skin: max((v) => v.skin), female: max((v) => v.female), women: fs[0].women } });
        }
        status.frames += n;
      } catch (e) {
        for (const x of group) post({ type: 'image', url: x.url, error: e instanceof Error ? e.message : String(e) });
        throw e;
      }
    }
  } finally {
    for (const x of ok) for (const b of x.bmps) b.close();
  }
}

/**
 * Thumbnails of this many decoded frames are drawn into one strip and read back at once: a
 * readback waits for the GPU, and one per frame took 60–80% of the analysis time.
 */
const THUMB_BATCH = 16;
let thumbCtx: OffscreenCanvasRenderingContext2D | null = null;

const ms = (t: number) => Math.round(t * 1000) / 1000;

/** Remember a GOP's edge frames; decide the cuts at its boundaries with the GOPs around it. */
function edgeCuts(s: Session, e: Edge, closed: boolean): [number, number][] {
  const out: [number, number][] = [];
  const list = s.edges.filter((x) => Math.abs(x.start - e.start) > 0.01);
  for (const x of list) {
    if (Math.abs(x.end - e.start) < 0.1) out.push([e.start, isEdgeCut(x.last, x.endRecent, e.first, e.startRecent) ? 1 : 0]);
    if (closed && Math.abs(e.end - x.start) < 0.1) out.push([x.start, isEdgeCut(e.last, e.endRecent, x.first, x.startRecent) ? 1 : 0]);
  }
  list.push(e);
  list.sort((p, q) => p.start - q.start);
  s.edges = list.length > MAX_EDGES ? list.slice(-MAX_EDGES) : list;
  return out;
}

/** How often the scene model may look, per session (clip-budget). */
const clipBudgets = new WeakMap<Session, ClipBudget>();

/** Seconds checked beyond the playhead of session `sid` (Infinity: it isn't the one being watched). */
function aheadOf(sid: number, s: Session): number {
  if (!pos || pos.session !== sid) return Infinity;
  return Math.max(0, s.checked.endFrom(pos.time) - pos.time);
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
  const frames: VisionFrame[] = [];
  const shotsOf = new ShotTracker();
  let budget = clipBudgets.get(s);
  if (!budget) clipBudgets.set(s, (budget = new ClipBudget()));
  let lastT = -Infinity;
  let lastShot = -Infinity;
  let lastDur = 0;
  let shots = 0;
  let failure: unknown = null;

  if (!thumbCtx) {
    thumbCtx = new OffscreenCanvas(THUMB_W, THUMB_H * THUMB_BATCH).getContext('2d', { alpha: false })!;
    thumbCtx.imageSmoothingQuality = 'high';
  }
  const tc = thumbCtx;
  // Frames whose thumbnail is drawn but not read yet. Whether a frame is classified is only known
  // from its thumbnail, so each one (that could be) keeps a GPU-side copy until then.
  const slots: { t: number; bmp: ImageBitmap | null }[] = [];
  const TB = THUMB_W * THUMB_H * 4;
  const drain = () => {
    if (!slots.length) return;
    const td = performance.now();
    const px = tc.getImageData(0, 0, THUMB_W, THUMB_H * slots.length).data;
    T.drainFrames = (T.drainFrames ?? 0) + slots.length;
    lap('thumbReadback', td);
    const tt = performance.now();
    slots.forEach((x, i) => {
      const th = makeThumb(px.subarray(i * TB, (i + 1) * TB));
      const { cut, sample } = shotsOf.push(x.t, th);
      if (sample && x.bmp) {
        pending.push({ t: x.t, bmp: x.bmp, th, cut });
        lastShot = Math.max(lastShot, x.t);
      } else x.bmp?.close();
    });
    slots.length = 0;
    lap('shotTrack', tt);
  };

  const decoder = new VideoDecoder({
    output: (f) => {
      const to = performance.now();
      T.decodedFrames = (T.decodedFrames ?? 0) + 1;
      try {
        const t = ms(f.timestamp / 1e6);
        lastT = Math.max(lastT, t);
        lastDur = (f.duration ?? 0) / 1e6 || lastDur;
        tc.drawImage(f, 0, slots.length * THUMB_H, THUMB_W, THUMB_H);
        let bmp: ImageBitmap | null = null;
        if (t > from + 1e-3) {
          // GPU-side copy at ≤ HI px (no readback); the VideoFrame can be released immediately
          const k = Math.min(1, HI / Math.max(f.displayWidth, f.displayHeight));
          const w = Math.max(1, Math.round(f.displayWidth * k)), h = Math.max(1, Math.round(f.displayHeight * k));
          if (hc.canvas.width !== w || hc.canvas.height !== h) {
            hc.canvas.width = w;
            hc.canvas.height = h;
          }
          hc.drawImage(f, 0, 0, w, h);
          bmp = (hc.canvas as OffscreenCanvas).transferToImageBitmap();
        }
        slots.push({ t, bmp });
      } finally {
        f.close();
        lap('frameCb', to);
      }
      if (slots.length === THUMB_BATCH) drain();
    },
    error: (e) => {
      failure = e;
    },
  });
  const runBatch = async () => {
    const batch = pending.splice(0, B);
    try {
      budget.mode = clipMode(budget.mode, aheadOf(sid, s), status.speed);
      frames.push(...(await classify(batch, budget)));
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
    drain();
    while (pending.length) await runBatch();
  } finally {
    for (const x of pending) x.bmp.close();
    for (const x of slots) x.bmp?.close();
    if (decoder.state !== 'closed') decoder.close();
  }

  const spanFrom = Number.isFinite(from) ? from : g.start;
  const frameEnd = lastT + (lastDur || 1 / 30);
  const spanTo = wasClosed ? g.end : frameEnd;
  if (Number.isFinite(lastShot)) g.analyzedTo = lastShot;
  g.analyzedCount = packets.length;
  const edges =
    shotsOf.first && shotsOf.last ? edgeCuts(s, { start: ms(shotsOf.firstT), end: wasClosed ? g.end : frameEnd, first: shotsOf.first, last: shotsOf.last, startRecent: shotsOf.startRecent, endRecent: shotsOf.endRecent }, wasClosed) : [];
  if (spanTo > spanFrom) s.checked.add(spanFrom, spanTo);
  if (wasClosed) free(g);
  if (spanTo > spanFrom)
    post({ type: 'result', session: sid, from: spanFrom, to: spanTo, frames, cuts: shotsOf.cuts, cutRange: [g.start, spanTo], edges });

  status.frames += shots;
  lap('analyse', t0);
  workSec += (performance.now() - t0) / 1000;
  mediaSec += Math.max(0, spanTo - spanFrom);
  status.speed = workSec > 0 ? mediaSec / workSec : 0;
}

let lastStatus = 0;
let trailing: ReturnType<typeof setTimeout> | null = null;
function updateStatus(force = false): void {
  const now = Date.now();
  if (!force && now - lastStatus < 500) {
    // the last update of a burst must not be dropped (the status would stay stale until the next work)
    trailing ??= setTimeout(() => {
      trailing = null;
      updateStatus(true);
    }, 500);
    return;
  }
  if (trailing) {
    clearTimeout(trailing);
    trailing = null;
  }
  lastStatus = now;
  if (pos) {
    const s = sessions.get(pos.session);
    status.ahead = s ? Math.max(0, s.checked.endFrom(pos.time) - pos.time) : 0;
  }
  post({ type: 'status', status: { ...status, timings: { ...T } } });
}

function setError(e: unknown): void {
  status.model = 'error';
  status.error = e instanceof Error ? e.message : String(e);
  errorAt = Date.now();
}

async function releaseModels(): Promise<void> {
  const m = model;
  const gm = gender;
  if (clip) {
    clip.postMessage({ type: 'release' } satisfies ToClip);
    const w = clip;
    setTimeout(() => w.terminate(), 2000);
  }
  clip = null;
  model = null;
  gender = null;
  status.model = 'idle';
  status.backend = '-';
  await Promise.all([m?.release(), gm?.release()]).catch(() => undefined);
}

setInterval(() => {
  const now = Date.now();
  if (model && !busy && now - lastWorkAt > IDLE_RELEASE_MS) {
    void releaseModels();
    updateStatus(true);
  }
  // Buffered video nobody asks about any more (the page plays another video, or blurring was
  // turned off and positions stopped): free it, keep `checked`.
  for (const s of sessions.values()) {
    if (now - s.lastUsed < STALE_SESSION_MS || !s.gops.length) continue;
    for (const g of s.gops) free(g);
    s.gops = [];
    for (const sb of s.sbs.values()) sb.cur = null;
  }
}, 30_000);

post({ type: 'ready' });
