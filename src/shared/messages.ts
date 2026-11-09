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
      /** Tile indices the page currently holds around `time`. */
      have: number[];
      /** Debug: also return the original mix with each tile. */
      debug?: boolean;
      /** What to do to each tile (default: remove music, no profanity filter). */
      filter?: FilterConfig;
    }
  | { type: 'drop-session'; session: number };

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
    }
  | { type: 'status'; status: WorkerStatus }
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
  /** Speech recognizer for the profanity filter. */
  asr?: 'idle' | 'loading' | 'ready' | 'error';
  asrError?: string;
  /** Average recognition time per tile (ms). */
  asrMs?: number;
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
  /** Profanity (мат) filter: off, silence the word, or beep over it. */
  profanity: ProfanityMode;
}

export const DEFAULT_SETTINGS: Settings = { enabled: true, mode: 'strict', showBadge: true, musicRemoval: true, profanity: 'off' };

/** What the page reports for the popup. */
export interface PageStatus {
  worker: WorkerStatus | null;
  state: 'disabled' | 'no-video' | 'waiting' | 'clean' | 'paused' | 'suspended';
  videoTime: number;
  sessions: number;
}

export const MSG_NS = '__musicRemover';
export const PROC_IFRAME_ID = '__music_remover_processor';
