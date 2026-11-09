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
}

export interface Settings {
  enabled: boolean;
  /** strict: silence while clean audio isn't ready; lenient: play original meanwhile. */
  mode: 'strict' | 'lenient';
  showBadge: boolean;
}

export const DEFAULT_SETTINGS: Settings = { enabled: true, mode: 'strict', showBadge: true };

/** What the page reports for the popup. */
export interface PageStatus {
  worker: WorkerStatus | null;
  state: 'disabled' | 'no-video' | 'waiting' | 'clean' | 'paused' | 'suspended';
  videoTime: number;
  sessions: number;
}

export const MSG_NS = '__musicRemover';
export const PROC_IFRAME_ID = '__music_remover_processor';
