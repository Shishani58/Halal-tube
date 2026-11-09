/**
 * Encoding for chrome.runtime Port messages, which are JSON-serialized (no ArrayBuffers):
 * binary payloads travel as base64; separated audio as 16-bit PCM.
 */
import type { FromWorker, ToWorker } from './messages';

export function b64encode(u: Uint8Array): string {
  let s = '';
  const CH = 0x8000;
  for (let i = 0; i < u.length; i += CH) s += String.fromCharCode.apply(null, u.subarray(i, i + CH) as unknown as number[]);
  return btoa(s);
}

export function b64decode(s: string): Uint8Array {
  const bin = atob(s);
  const u = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
  return u;
}

function f32ToPcm16(a: Float32Array): string {
  const out = new Int16Array(a.length);
  for (let i = 0; i < a.length; i++) {
    const x = a[i];
    out[i] = x >= 1 ? 32767 : x <= -1 ? -32767 : Math.round(x * 32767);
  }
  return b64encode(new Uint8Array(out.buffer));
}

function pcm16ToF32(s: string): Float32Array {
  const u = b64decode(s);
  const i16 = new Int16Array(u.buffer, u.byteOffset, u.byteLength >> 1);
  const out = new Float32Array(i16.length);
  for (let i = 0; i < i16.length; i++) out[i] = i16[i] / 32767;
  return out;
}

/** Wire form of ToWorker (append.data as base64). */
export type ToWorkerWire = Exclude<ToWorker, { type: 'append' }> | (Omit<Extract<ToWorker, { type: 'append' }>, 'data'> & { data: string });

export function encodeToWorker(m: ToWorker): ToWorkerWire {
  if (m.type === 'append') return { ...m, data: b64encode(new Uint8Array(m.data)) };
  return m;
}

export function decodeToWorker(m: ToWorkerWire): ToWorker {
  if (m.type === 'append') {
    const u = b64decode(m.data);
    return { ...m, data: u.buffer as ArrayBuffer };
  }
  return m;
}

type Tile = Extract<FromWorker, { type: 'tile' }>;
export type FromWorkerWire =
  | Exclude<FromWorker, Tile>
  | (Omit<Tile, 'left' | 'right' | 'mixLeft'> & { left: string; right: string; mixLeft?: string });

export function encodeFromWorker(m: FromWorker): FromWorkerWire {
  if (m.type !== 'tile') return m;
  return { ...m, left: f32ToPcm16(m.left), right: f32ToPcm16(m.right), mixLeft: m.mixLeft ? f32ToPcm16(m.mixLeft) : undefined };
}

export function decodeFromWorker(m: FromWorkerWire): FromWorker {
  if (m.type !== 'tile') return m;
  return { ...m, left: pcm16ToF32(m.left), right: pcm16ToF32(m.right), mixLeft: m.mixLeft ? pcm16ToF32(m.mixLeft) : undefined };
}
