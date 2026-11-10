import type { MdxProcessor } from './mdx';

/**
 * Timeline tiling. Output tile k covers model-rate samples [k·G, (k+1)·G) of the media timeline
 * (t = 0 at media time 0). Its model input window starts `trim` samples earlier and is
 * `chunkSize` samples long, so neighbouring tiles butt together without seams to stitch.
 */
export class Tiling {
  readonly rate: number;
  readonly genSize: number;
  readonly chunkSize: number;
  readonly trim: number;

  constructor(mdx: MdxProcessor) {
    this.rate = mdx.cfg.sampleRate;
    this.genSize = mdx.genSize;
    this.chunkSize = mdx.chunkSize;
    this.trim = mdx.trim;
  }

  get tileSeconds(): number {
    return this.genSize / this.rate;
  }

  tileAt(time: number): number {
    return Math.floor((time * this.rate) / this.genSize);
  }

  tileStart(k: number): number {
    return (k * this.genSize) / this.rate;
  }

  /** Media-time range [start, end) of the model input window for tile k. */
  inputRange(k: number): [number, number] {
    const s = (k * this.genSize - this.trim) / this.rate;
    return [s, s + this.chunkSize / this.rate];
  }
}

/** Run a model on `input` (of `shape`, or the shape it was loaded with). */
export type RunModel = (input: Float32Array, shape?: [number, number, number, number]) => Promise<Float32Array>;

/** Run one model window: stereo input (chunkSize) → separated stereo output (genSize). */
export async function separateWindow(
  mdx: MdxProcessor,
  run: RunModel,
  left: Float32Array,
  right: Float32Array,
  scratch?: Float32Array,
): Promise<[Float32Array, Float32Array]> {
  const spec = mdx.stft(left, right, scratch);
  const pred = await run(spec);
  return mdx.istftTrimmed(pred);
}
