/** Messages page (MAIN world) → processor (iframe → worker). */
export type ToWorker =
  | { type: 'sb-init'; session: number; sb: number; mime: string }
  | { type: 'append'; session: number; sb: number; data: ArrayBuffer; tsOffset: number }
  | { type: 'abort'; session: number; sb: number }
  | {
      type: 'position';
      session: number;
      time: number;
      duration: number;
      enabled: boolean;
      /** The video is actually playing (not paused, seeking or stalled). Playing videos go first. */
      playing: boolean;
      /** Playback rate, to rank how soon each video needs its next tile. */
      rate: number;
      /** Tile indices the page currently holds around `time`. */
      have: number[];
      /** Debug: also return the original mix with each tile. */
      debug?: boolean;
      /** What to do to each tile (default: remove music, no profanity filter). */
      filter?: FilterConfig;
    }
  | {
      /**
       * Word timings from the video's captions for the profanity filter. 'pending': being fetched
       * (the worker waits a little before falling back to speech recognition); 'none': the video
       * has no usable captions.
       */
      type: 'captions';
      session: number;
      state: CaptionState;
      /** Media seconds, sorted by start. */
      words?: { text: string; start: number; end: number }[];
      lang?: string;
      /** Auto-generated (word-timed) or uploaded (line-timed) track. */
      kind?: 'asr' | 'uploaded';
    }
  | { type: 'drop-session'; session: number };

export type CaptionState = 'pending' | 'ready' | 'none';

/**
 * Whether a message means the page wants processing now. Until one arrives the bridge only keeps
 * the stream in its replay log and does not start the processor (extension off, or only blurring).
 */
export function needsProcessor(m: ToWorker): boolean {
  return (m.type === 'position' && m.enabled) || m.type === 'captions';
}

/** Messages processor → page. */
export type FromWorker =
  | { type: 'ready' }
  | {
      type: 'tile';
      session: number;
      k: number;
      start: number;
      /** Media time from which this tile is valid (> start for a partial tile after a seek). */
      validFrom: number;
      sampleRate: number;
      left: Float32Array;
      right: Float32Array;
      /** Debug only: original (unseparated) left channel for the same span. */
      mixLeft?: Float32Array;
      computeMs?: number;
      /** filterKey() of the config this tile was made with. */
      cfg?: string;
      /** Profanity filter result for this tile (when it ran). */
      profanity?: TileProfanityReport;
      /**
       * Pitch of the voice (Hz, 0: nobody speaks) every VOICE_STEP seconds from `start`, measured
       * on the separated vocals (only with music removal): a hint for blurring women.
       */
      voice?: number[];
    }
  /** Status of one media session (`session` set) or of the model only (no session yet). */
  | { type: 'status'; session?: number; status: WorkerStatus }
  | { type: 'tiling'; tileSeconds: number; sampleRate: number };

export interface WorkerStatus {
  model: 'idle' | 'loading' | 'ready' | 'error';
  backend: string;
  error?: string;
  /** Average processing time / audio time (lower is better, < 1 means faster than real time). */
  rtf: number;
  tilesDone: number;
  /** Seconds of clean audio prepared ahead of the playhead (contiguous). */
  ahead: number;
  /** Seconds of compressed audio buffered ahead of the playhead. */
  inputAhead: number;
  /**
   * Why the tile under the playhead isn't there yet: 'input' — the player hasn't loaded that
   * audio yet; 'compute' — it is queued or being separated; undefined — it's done.
   */
  waitFor?: 'input' | 'compute';
  /** Where the profanity filter gets this video's words: its captions, speech recognition, or still deciding. */
  words?: 'captions' | 'asr' | 'pending';
  /** Speech recognizer for the profanity filter. */
  asr?: 'idle' | 'loading' | 'ready' | 'error';
  asrError?: string;
  /** Average recognition time per tile (ms). */
  asrMs?: number;
  /** Result of the WebGPU self-test of the separation model (processor/model.ts). */
  selfTest?: string;
}

export type ProfanityMode = 'off' | 'mute' | 'beep';

/** Per-tile processing the page asks for. */
export interface FilterConfig {
  musicRemoval: boolean;
  profanity: ProfanityMode;
}

export const DEFAULT_FILTER: FilterConfig = { musicRemoval: true, profanity: 'off' };

/** Short key identifying a FilterConfig (tiles made with another config are stale). */
export function filterKey(f: FilterConfig): string {
  return `${f.musicRemoval ? 'v' : 'm'}:${f.profanity}`;
}

export interface TileProfanityReport {
  lang: string;
  langProb: number;
  passes: number;
  asrMs: number;
  /** Recognized words around the tile, media seconds. */
  words: { text: string; start: number; end: number }[];
  /** Profane words found. */
  hits: { text: string; start: number; end: number }[];
  /** Padded spans muted/beeped inside this tile. */
  spans: { start: number; end: number }[];
  /** Share of the left/right recognition context that had audio (debug). */
  context?: [number, number];
  /** Debug only: the recognizer's 16 kHz input (int16 values). */
  input?: number[];
}

export interface Settings {
  enabled: boolean;
  /** strict: silence while clean audio isn't ready; lenient: play original meanwhile. */
  mode: 'strict' | 'lenient';
  showBadge: boolean;
  /** Remove background music (off: the profanity filter alone works on the original sound). */
  musicRemoval: boolean;
  /**
   * How much of the music to take out, 0–100 %: the clean voice is mixed with the original in this
   * proportion (100: voice only). Ignored while the profanity filter is on (the original would let
   * the muted words through).
   */
  musicStrength: number;
  /** Profanity (мат) filter: off, silence the word, or beep over it. */
  profanity: ProfanityMode;
  /** Blur video frames with nudity (men and women). */
  blur: boolean;
  /** Also blur frames where a woman is visible. */
  blurWomen: boolean;
  /** Keep the video blurred until its frames have been checked. */
  blurStrict: boolean;
  /** Also check and blur video thumbnails (feed, recommendations, end screen). */
  blurThumbs: boolean;
  /** How readily video frames are blurred: soft (fewer false blurs) · normal · strict (blur when in doubt). */
  blurLevel: 'soft' | 'normal' | 'strict';
  /** Reveal a blurred thumbnail while the pointer rests on it. */
  blurHover: boolean;
  /** How hidden parts look: a blur, or a solid dark cover (nothing of the picture shows through). */
  blurStyle: 'blur' | 'solid';
  /** Keep what the frame classifier found in a video, so the next viewing needs no checking. */
  blurCache: boolean;
  /**
   * Keep the video paused while the sound without music (or the profanity filter) or the frame
   * check hasn't caught up with the playhead, and resume it once it has (instead of playing
   * silence / the original / a blurred frame meanwhile).
   */
  pauseUntilReady: boolean;
}

export const DEFAULT_SETTINGS: Settings = { enabled: true, mode: 'strict', showBadge: true, musicRemoval: true, musicStrength: 100, profanity: 'off', blur: true, blurWomen: true, blurStrict: true, blurThumbs: true, blurLevel: 'normal', blurHover: false, blurStyle: 'blur', blurCache: true, pauseUntilReady: false };

/**
 * Share of the clean (voice-only) sound in what is heard, 0–1; the rest is the original track.
 * Always 1 while the profanity filter is on, and out-of-range values are clamped.
 */
export function cleanShare(s: Pick<Settings, 'musicStrength' | 'profanity' | 'musicRemoval'>): number {
  if (s.profanity !== 'off' || !s.musicRemoval) return 1;
  const v = Number(s.musicStrength);
  return Number.isFinite(v) ? Math.min(1, Math.max(0, v / 100)) : 1;
}

/** What the page reports for the popup. */
export interface PageStatus {
  worker: WorkerStatus | null;
  /** offline: no link to the processor (e.g. the extension was updated) — the original plays. */
  state: 'disabled' | 'no-video' | 'waiting' | 'clean' | 'paused' | 'suspended' | 'offline';
  videoTime: number;
  sessions: number;
  /** Blurring (frame classifier) state. */
  vision?: import('./vision-messages').PageVision;
  /** What the video is kept paused for (pauseUntilReady); empty: not held. */
  hold?: ('audio' | 'blur')[];
}

export const MSG_NS = '__musicRemover';
export const PROC_IFRAME_ID = '__music_remover_processor';
