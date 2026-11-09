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
  | { type: 'position'; session: number; time: number; duration: number; enabled: boolean };

/** Vision worker → page. */
export type FromVision =
  | { type: 'ready' }
  /** Frames in [from, to] were analysed; samples = flat [t, nude, skin, female, …]. */
  | { type: 'result'; session: number; from: number; to: number; samples: number[] }
  | { type: 'status'; status: VisionStatus };

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
