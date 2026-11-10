/// <reference lib="webworker" />
/**
 * One processing Worker for the whole browser (owned by the offscreen document): one model in
 * GPU memory shared by every tab. Session ids arrive already made unique by the offscreen
 * document. Each session reports its playhead; the worker always separates the tile that is
 * needed soonest, playing videos first.
 */
import { createDemuxer, type Demuxer } from '../core/demux';
import { KIM_VOCAL_2, MdxProcessor } from '../core/mdx';
import { wordsIn } from '../core/captions';
import type { Word } from '../core/profanity';
import { keepOriginalWhereClean } from '../core/passthrough';
import { testAudio } from '../core/selftest';
import { resampleCubic } from '../core/resample';
import { voicePitch } from '../core/voice';
import { Tiling } from '../core/tiles';
import { DEFAULT_FILTER, filterKey, type CaptionState, type FilterConfig, type FromWorker, type ToWorker, type WorkerStatus } from '../shared/messages';
import { decodePackets, type DecodedAudio } from './decode';
import { describeSelfTest, loadModel, type LoadedModel } from './model';
import { PacketStore } from './packet-store';
import { CONTEXT_S, ProfanityStage } from './profanity-stage';

declare const self: DedicatedWorkerGlobalScope;

const MODEL_FILE = 'Kim_Vocal_2.onnx';
const MODEL_FP16_FILE = 'Kim_Vocal_2.fp16.onnx';
const LOOKAHEAD_TILES = 16; // ≈ 92 s of clean audio prepared ahead
const KEEP_BEHIND_S = 45;
const MAX_SESSIONS = 8;
/** Free the model (GPU memory) after this long without any video playing. */
const IDLE_RELEASE_MS = 3 * 60_000;
/** A session that stopped reporting its position (tab frozen / closed) is not worked on. */
const POSITION_STALE_MS = 10_000;
/** How long the profanity filter waits for a video's captions before using speech recognition. */
const CAPTIONS_WAIT_MS = 10_000;

const base = new URL('../', self.location.href).href;
const mdx = new MdxProcessor(KIM_VOCAL_2);
const tiling = new Tiling(mdx);
const SPEC_SIZE = 4 * KIM_VOCAL_2.dimF * KIM_VOCAL_2.dimT;
/** Model loads run one at a time (concurrent first session creation hangs ONNX Runtime). */
let loadChain: Promise<unknown> = Promise.resolve();
function serial<T>(load: () => Promise<T>): Promise<T> {
  const p = loadChain.then(load);
  loadChain = p.catch(() => undefined);
  return p;
}
const profanity = new ProfanityStage(base, serial, (sid, from, to) => {
  const c = sessions.get(sid)?.captions;
  return c?.state === 'ready' ? wordsIn(c.words, from, to) : null;
});
let cfgKey = filterKey(DEFAULT_FILTER);

type Position = Extract<ToWorker, { type: 'position' }>;

interface Session {
  store: PacketStore;
  sbs: Map<number, { mime: string; demuxer: Demuxer | null }>;
  lastUsed: number;
  pos: Position | null;
  posAt: number;
  have: Set<number>;
  /** Caption words for the profanity filter (see ToWorker 'captions'). */
  captions: { state: CaptionState; words: Word[] } | null;
  /** When this session first asked for the profanity filter (start of the captions wait). */
  filterSince: number;
}

const sessions = new Map<number, Session>();
const sentAt = new Map<string, number>(); // `${session}:${k}` → time sent
const failedAt = new Map<string, number>();
let model: LoadedModel | null = null;
let modelEverLoaded = false;
let busy = false;
let lastPlayingAt = Date.now();
const model$: Pick<WorkerStatus, 'model' | 'backend' | 'error' | 'rtf' | 'tilesDone' | 'selfTest'> = {
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
    s = { store: new PacketStore(), sbs: new Map(), lastUsed: Date.now(), pos: null, posAt: 0, have: new Set(), captions: null, filterSince: 0 };
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
      s.sbs.set(m.sb, { mime: m.mime, demuxer: createDemuxer(m.mime, 'audio') });
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
    case 'captions': {
      const s = session(m.session);
      s.captions = { state: m.state, words: m.words ?? [] };
      schedule();
      updateStatus(true);
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
      const f = m.filter ?? DEFAULT_FILTER;
      if (filterKey(f) !== cfgKey) {
        // settings changed (they are global): tiles the pages hold are stale (they stop reporting them in `have`)
        cfgKey = filterKey(f);
        sentAt.clear();
        failedAt.clear();
      }
      // Load the model as soon as a page has a video; after an idle release, only once one plays.
      if (m.enabled && f.musicRemoval && model$.model === 'idle' && (m.playing || !modelEverLoaded)) void initModel();
      if (f.profanity === 'off') s.filterSince = 0;
      else if (!s.filterSince) s.filterSince = Date.now();
      // speech recognition only for videos without captions
      if (m.enabled && f.profanity !== 'off' && wordsFrom(s) === 'asr' && (m.playing || profanity.state !== 'idle'))
        profanity.ensure(() => (updateStatus(true), schedule()));
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
    model = await serial(() => loadModel({ base, modelFile: MODEL_FILE, fp16File: MODEL_FP16_FILE, shape: mdx.tensorShape, selfTestInput: (r) => mdx.stft(...testAudio(mdx.chunkSize, 44100, r.seed)) }));
    modelEverLoaded = true;
    model$.model = 'ready';
    model$.backend = model.backend;
    model$.selfTest = describeSelfTest(model);
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
  return [...sessions.entries()].filter(([, s]) => s.pos?.enabled && now - s.posAt < POSITION_STALE_MS && canProcess(s));
}

/** Where the profanity filter takes this session's words from. */
function wordsFrom(s: Session): 'captions' | 'asr' | 'pending' {
  const st = s.captions?.state;
  if (st === 'ready') return 'captions';
  if (st === 'none') return 'asr';
  return s.filterSince && Date.now() - s.filterSince < CAPTIONS_WAIT_MS ? 'pending' : 'asr';
}

/**
 * What this session's config needs is there: the separation model; for the profanity filter the
 * captions, or else the recognizer (a failed recognizer lets tiles go out unfiltered — the page
 * shows why).
 */
function canProcess(s: Session): boolean {
  const f = s.pos?.filter ?? DEFAULT_FILTER;
  if (f.musicRemoval && !model) return false;
  if (f.profanity !== 'off') {
    const src = wordsFrom(s);
    if (src === 'pending') return false;
    if (src === 'asr' && (profanity.state === 'idle' || profanity.state === 'loading')) return false;
  }
  return true;
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
    if (inflight.has(key)) continue;
    const sent = sentAt.get(key);
    if (sent && now - sent < 3000) continue; // page hasn't acknowledged yet
    const failed = failedAt.get(key);
    if (failed && now - failed < 5000) continue;
    const due = Math.max(0, tiling.tileStart(k) - t) / rate + (pos.playing ? 0 : 1000);
    const [a, b] = tiling.inputRange(k);
    // with the profanity filter, tiles ahead of the playhead also wait for the recognition context
    const after = k > kNow && pos.filter && pos.filter.profanity !== 'off' && wordsFrom(s) === 'asr' ? CONTEXT_S : 0;
    if (s.store.covers(a, b + after, pos.duration)) return { sessionId: id, k, validFrom: tiling.tileStart(k), due };
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

/** A tile on its way through the pipeline: decoded and transformed, waiting for the model. */
interface Job {
  pick: TilePick;
  key: string;
  f: FilterConfig;
  debug: boolean;
  decoded: DecodedAudio;
  /** Resampled model input window. */
  L: Float32Array;
  R: Float32Array;
  /** Model input (spectrogram); only with music removal. */
  spec?: Float32Array;
  t0: number;
}

/** Tiles being computed right now (not picked again). */
const inflight = new Set<string>();
/** Spectrogram buffers (one per tile in the pipeline: at most two). */
const specPool: Float32Array[] = [];
/** When the last tile left the pipeline (throughput, `rtf`). */
let lastDoneAt = 0;

/** The tile is still worth computing (the viewer may have seeked meanwhile). */
function stillWanted(pick: TilePick): boolean {
  const s = sessions.get(pick.sessionId);
  if (!s?.pos) return false;
  const t = playhead(s);
  return pick.k >= tiling.tileAt(t) && tiling.tileStart(pick.k) <= t + (LOOKAHEAD_TILES + 1) * tiling.tileSeconds;
}

/** Seconds of wall time until tile k of session `id` is heard. */
function dueOf(pick: TilePick): number {
  const s = sessions.get(pick.sessionId);
  if (!s?.pos) return Infinity;
  const rate = s.pos.rate > 0 ? s.pos.rate : 1;
  return Math.max(0, tiling.tileStart(pick.k) - playhead(s)) / rate + (s.pos.playing ? 0 : 1000);
}

/** The tile's words come from speech recognition (which runs on the GPU too). */
function usesAsr(job: Job): boolean {
  const s = sessions.get(job.pick.sessionId);
  return job.f.profanity !== 'off' && !!s && wordsFrom(s) === 'asr';
}

/** CPU part before the model: decode, resample, STFT. Null when the tile is no longer wanted. */
async function prepare(pick: TilePick): Promise<Job | null> {
  const s = sessions.get(pick.sessionId)!;
  const key = `${pick.sessionId}:${pick.k}`;
  const f = s.pos?.filter ?? DEFAULT_FILTER;
  const t0 = performance.now();
  const [a, b] = tiling.inputRange(pick.k);
  const ctxS = f.profanity !== 'off' ? CONTEXT_S : 0; // speech recognition also hears around the tile
  const decoded = await decodePackets(s.store.range(a - 0.12 - ctxS, b + 0.05 + ctxS));
  if (!decoded) throw new Error('nothing decoded');
  // The viewer may have seeked while this was being decoded: don't spend the model on a tile
  // that is no longer ahead of the playhead.
  if (!stillWanted(pick)) return null;
  const L = resampleCubic(decoded.left, decoded.sampleRate, decoded.start, tiling.rate, a, tiling.chunkSize);
  const R = resampleCubic(decoded.right, decoded.sampleRate, decoded.start, tiling.rate, a, tiling.chunkSize);
  const spec = f.musicRemoval ? mdx.stft(L, R, specPool.pop() ?? new Float32Array(SPEC_SIZE)) : undefined;
  return { pick, key, f, debug: !!s.pos?.debug, decoded, L, R, spec, t0 };
}

/** Pick and prepare the next tile (skipping ones that fail or are no longer wanted). */
async function prepareNext(): Promise<Job | null> {
  for (let tries = 0; tries < 4; tries++) {
    const pick = pickTile();
    if (!pick) return null;
    const key = `${pick.sessionId}:${pick.k}`;
    inflight.add(key);
    try {
      const job = await prepare(pick);
      if (job) return job;
      inflight.delete(key);
    } catch (e) {
      console.warn('[music-remover] tile failed', pick.k, e);
      failedAt.set(key, Date.now());
      inflight.delete(key);
    }
  }
  return null;
}

function drop(job: Job): void {
  inflight.delete(job.key);
  if (job.spec) specPool.push(job.spec);
  job.spec = undefined;
}

/** The model on a prepared tile (GPU). The spectrogram buffer goes back to the pool. */
function infer(job: Job): Promise<Float32Array> {
  const spec = job.spec!;
  job.spec = undefined;
  return model!.run(spec).finally(() => specPool.push(spec));
}

/** CPU part after the model: iSTFT, profanity filter, send. */
async function finish(job: Job, pred: Float32Array | undefined): Promise<void> {
  const { pick, key, f, debug, decoded, L, R } = job;
  const { sessionId, k, validFrom } = pick;
  const G = tiling.genSize, trim = tiling.trim;
  const mixLeft = debug ? L.slice(trim, trim + G) : undefined;
  const [left, right] = pred ? mdx.istftTrimmed(pred) : [L.slice(trim, trim + G), R.slice(trim, trim + G)];
  // the voice's pitch on the vocals (before the profanity filter beeps over them)
  const voice = f.musicRemoval ? voicePitch(left, right, tiling.rate) : undefined;
  // plain speech (nothing taken out) is better left as it was: swap in the original there
  if (pred) keepOriginalWhereClean(left, right, L.subarray(trim, trim + G), R.subarray(trim, trim + G), tiling.rate);
  const { report, patch } =
    f.profanity !== 'off'
      ? await profanity.filterTile({ session: sessionId, k, start: tiling.tileStart(k), validFrom, rate: tiling.rate, left, right, decoded, separated: f.musicRemoval, mode: f.profanity, debug })
      : {};
  // throughput: tiles overlap in the pipeline, so count wall time since the previous one left
  const now = performance.now();
  const dt = (now - Math.max(job.t0, lastDoneAt)) / 1000;
  lastDoneAt = now;
  computeSec += dt;
  audioSec += tiling.tileSeconds;
  model$.tilesDone++;
  model$.rtf = computeSec / audioSec;
  sentAt.set(key, Date.now());
  inflight.delete(key);
  const transfer: Transferable[] = [left.buffer, right.buffer];
  if (mixLeft) transfer.push(mixLeft.buffer);
  post(
    { type: 'tile', session: sessionId, k, start: tiling.tileStart(k), validFrom, sampleRate: tiling.rate, left, right, mixLeft, computeMs: (now - job.t0), cfg: filterKey(f), profanity: report, voice },
    transfer,
  );
  if (patch) post({ ...patch, type: 'tile', session: sessionId, sampleRate: tiling.rate, cfg: filterKey(f) }, [patch.left.buffer, patch.right.buffer]);
  updateStatus();
}

/**
 * Two-stage pipeline: while the GPU runs the model on one tile, the CPU decodes and transforms
 * the next one, and the next tile's model run starts before this tile's iSTFT. (Not with speech
 * recognition, which needs the GPU after the separation: runs on the GPU never overlap.)
 */
async function pump(): Promise<void> {
  if (busy) return;
  busy = true;
  let job: Job | null = null;
  let next: Job | null = null;
  try {
    job = await prepareNext();
    let running = job?.spec ? infer(job) : null;
    while (job) {
      next = await prepareNext(); // CPU work while the GPU computes `job`
      let pred: Float32Array | undefined;
      try {
        pred = running ? await running : undefined;
      } catch (e) {
        console.warn('[music-remover] tile failed', job.pick.k, e);
        failedAt.set(job.key, Date.now());
        drop(job);
        job = null;
      }
      // a seek since `next` was picked: what is due now goes first
      const better = next && pickTile();
      if (next && (!stillWanted(next.pick) || (better && better.due < dueOf(next.pick) - tiling.tileSeconds))) {
        drop(next);
        next = await prepareNext();
      }
      let nextRunning: Promise<Float32Array> | null = null;
      if (next?.spec && job && !usesAsr(job)) nextRunning = infer(next);
      if (job) {
        try {
          await finish(job, pred);
        } catch (e) {
          console.warn('[music-remover] tile failed', job.pick.k, e);
          failedAt.set(job.key, Date.now());
          drop(job);
        }
      }
      if (next?.spec && !nextRunning) nextRunning = infer(next);
      job = next;
      next = null;
      running = nextRunning;
    }
  } finally {
    for (const j of [job, next]) if (j) drop(j);
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
    words: (pos.filter ?? DEFAULT_FILTER).profanity !== 'off' ? wordsFrom(s) : undefined,
    asr: profanity.state,
    asrError: profanity.error,
    asrMs: profanity.avgMs,
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
  if (!any) post({ type: 'status', status: { ...model$, asr: profanity.state, asrError: profanity.error, ahead: 0, inputAhead: 0 } });
}

setInterval(() => {
  if (!busy && Date.now() - lastPlayingAt > IDLE_RELEASE_MS && profanity.state === 'ready') {
    void profanity.release();
    updateStatus(true);
  }
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
