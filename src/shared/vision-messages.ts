/**
 * Page ↔ vision worker protocol (frame classifier for blurring). Travels over its own Port
 * ('mr-vis'), separate from the audio processor.
 */
import { b64decode, b64encode } from './wire';

/** Page (MAIN world) → vision worker. */
export type ToVision =
  | { type: 'sb-init'; session: number; sb: number; mime: string }
  | { type: 'append'; session: number; sb: number; data: ArrayBuffer; tsOffset: number }
  | { type: 'abort'; session: number; sb: number }
  | { type: 'position'; session: number; time: number; duration: number; enabled: boolean }
  /** Classify a still image (a video thumbnail), fetched by the worker. */
  | { type: 'image'; url: string };

/** Vision worker → page. */
export type FromVision =
  | { type: 'ready' }
  /**
   * Frames in [from, to] were analysed. `cuts`: shot cuts found strictly inside `cutRange` (the list
   * replaces what was known there); `edges`: cut or not at GOP boundaries ([time, 1 | 0]).
   */
  | { type: 'result'; session: number; from: number; to: number; frames: VisionFrame[]; cuts: number[]; cutRange: [number, number]; edges: [number, number][] }
  | { type: 'status'; status: VisionStatus }
  /** A classified image (`frame`), or why it couldn't be (`error`). */
  | { type: 'image'; url: string; frame?: VisionFrame; error?: string };

/** One classified frame. */
export interface VisionFrame {
  t: number;
  nude: number;
  skin: number;
  /** Most confident woman in the frame (0 when none). */
  female: number;
  /** Women in the frame: flat [x, y, w, h, score, …], frame-relative (0–1), one rect each (a person: head and body). */
  women: number[];
  /** MobileCLIP: how surely the frame shows women at all, wherever they are (video frames only). */
  scene?: number;
}

export interface VisionStatus {
  model: 'idle' | 'loading' | 'ready' | 'error';
  backend: string;
  error?: string;
  /** Frames classified so far. */
  frames: number;
  /** Seconds of video checked per second of work (> 1: faster than real time). */
  speed: number;
  /** Seconds of video checked ahead of the playhead (contiguous). */
  ahead: number;
}

/** What the page reports about blurring (popup, badge). */
export interface PageVision {
  status: VisionStatus | null;
  /** off: feature disabled · checking: frame not analysed yet (blurred in strict mode) · hidden: blurred by a detection · clear */
  state: 'off' | 'checking' | 'hidden' | 'clear' | 'no-video';
  /** Women's boxes blurred on the active video (0: none, or the whole frame is blurred). */
  regions?: number;
}

export type ToVisionWire = Exclude<ToVision, { type: 'append' }> | (Omit<Extract<ToVision, { type: 'append' }>, 'data'> & { data: string });

export function encodeToVision(m: ToVision): ToVisionWire {
  if (m.type === 'append') return { ...m, data: b64encode(new Uint8Array(m.data)) };
  return m;
}

export function decodeToVision(m: ToVisionWire): ToVision {
  if (m.type === 'append') return { ...m, data: b64decode(m.data).buffer as ArrayBuffer };
  return m;
}

/** Initialization segment (WebM EBML header / MP4 ftyp|moov) by its first bytes. */
export function isInitSegment(b: Uint8Array): boolean {
  if (b.length < 8) return false;
  if (b[0] === 0x1a && b[1] === 0x45 && b[2] === 0xdf && b[3] === 0xa3) return true;
  const t = String.fromCharCode(b[4], b[5], b[6], b[7]);
  return t === 'ftyp' || t === 'moov';
}
