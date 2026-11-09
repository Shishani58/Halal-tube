import { FFT } from './fft';

/**
 * Pre/post-processing for UVR MDX-Net (ConvTDFNet) ONNX models.
 * Mirrors the reference PyTorch code: torch.stft(center=True, reflect pad, periodic Hann),
 * channel layout [L_re, L_im, R_re, R_im], first `dimF` bins, `dimT` frames.
 */
export interface MdxConfig {
  nFft: number; // 7680
  hop: number; // 1024
  dimF: number; // 3072
  dimT: number; // 256
  compensate: number; // 1.009 for Kim_Vocal_2
  sampleRate: number; // 44100
}

export const KIM_VOCAL_2: MdxConfig = {
  nFft: 7680,
  hop: 1024,
  dimF: 3072,
  dimT: 256,
  compensate: 1.009,
  sampleRate: 44100,
};

export class MdxProcessor {
  readonly cfg: MdxConfig;
  /** Samples fed to the model per call. */
  readonly chunkSize: number;
  /** Context trimmed from each side of the model output. */
  readonly trim: number;
  /** Useful output samples per call (tile length). */
  readonly genSize: number;
  private readonly fft: FFT;
  private readonly window: Float64Array;
  private readonly re: Float64Array;
  private readonly im: Float64Array;

  constructor(cfg: MdxConfig) {
    this.cfg = cfg;
    this.chunkSize = cfg.hop * (cfg.dimT - 1);
    this.trim = cfg.nFft / 2;
    this.genSize = this.chunkSize - 2 * this.trim;
    this.fft = new FFT(cfg.nFft);
    this.window = new Float64Array(cfg.nFft);
    for (let i = 0; i < cfg.nFft; i++) this.window[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / cfg.nFft);
    this.re = new Float64Array(cfg.nFft);
    this.im = new Float64Array(cfg.nFft);
  }

  get tensorShape(): [number, number, number, number] {
    return [1, 4, this.cfg.dimF, this.cfg.dimT];
  }

  /** Stereo waveform (chunkSize samples each) → model input tensor data. */
  stft(left: Float32Array, right: Float32Array, out?: Float32Array): Float32Array {
    const { nFft: N, hop, dimF, dimT } = this.cfg;
    const L = this.chunkSize;
    if (left.length !== L || right.length !== L) throw new Error('stft: bad input length');
    const plane = dimF * dimT;
    const spec = out ?? new Float32Array(4 * plane);
    const pad = N / 2;
    const { re, im, window: w, fft } = this;
    for (let t = 0; t < dimT; t++) {
      const base = t * hop - pad;
      if (base >= 0 && base + N <= L) {
        for (let n = 0; n < N; n++) {
          re[n] = left[base + n] * w[n];
          im[n] = right[base + n] * w[n];
        }
      } else {
        // edge frames: torch.stft(center=True) reflect padding
        for (let n = 0; n < N; n++) {
          const idx = reflect(base + n, L);
          re[n] = left[idx] * w[n];
          im[n] = right[idx] * w[n];
        }
      }
      fft.forward(re, im);
      for (let k = 0; k < dimF; k++) {
        const o = k * dimT + t;
        if (k < 3) {
          // UVR zeroes the three lowest bins before inference
          spec[o] = 0; spec[plane + o] = 0; spec[2 * plane + o] = 0; spec[3 * plane + o] = 0;
          continue;
        }
        const nk = (N - k) % N;
        const zr = re[k], zi = im[k], cr = re[nk], ci = -im[nk];
        // L = (Z_k + conj(Z_{N-k})) / 2 ; R = (Z_k - conj(Z_{N-k})) / 2i
        spec[o] = 0.5 * (zr + cr);
        spec[plane + o] = 0.5 * (zi + ci);
        spec[2 * plane + o] = 0.5 * (zi - ci);
        spec[3 * plane + o] = -0.5 * (zr - cr);
      }
    }
    return spec;
  }

  /**
   * Model output tensor → stereo waveform of length genSize (the trimmed, valid region).
   */
  istftTrimmed(spec: Float32Array): [Float32Array, Float32Array] {
    const { nFft: N, hop, dimF, dimT } = this.cfg;
    const plane = dimF * dimT;
    const olaLen = (dimT - 1) * hop + N;
    const olaL = new Float64Array(olaLen);
    const olaR = new Float64Array(olaLen);
    const { re, im, window: w, fft } = this;
    for (let t = 0; t < dimT; t++) {
      // bins [dimF, N − dimF] are never written below: only they need clearing
      re.fill(0, dimF, N - dimF + 1);
      im.fill(0, dimF, N - dimF + 1);
      for (let k = 0; k < dimF; k++) {
        const o = k * dimT + t;
        let lr = spec[o], li = spec[plane + o], rr = spec[2 * plane + o], ri = spec[3 * plane + o];
        if (k === 0) { li = 0; ri = 0; }
        // Z[k] = L[k] + i·R[k]
        re[k] = lr - ri;
        im[k] = li + rr;
        if (k > 0) {
          // Z[N-k] = conj(L[k]) + i·conj(R[k])
          re[N - k] = lr + ri;
          im[N - k] = -li + rr;
        }
      }
      fft.inverseUnscaled(re, im); // the 1/N is in `outGain`
      const off = t * hop;
      for (let n = 0; n < N; n++) {
        olaL[off + n] += re[n] * w[n];
        olaR[off + n] += im[n] * w[n];
      }
    }
    const G = this.genSize;
    const gain = this.outGain();
    const outL = new Float32Array(G);
    const outR = new Float32Array(G);
    // istft output index j ↔ ola index j + pad; we keep j ∈ [trim, trim + G)
    const start = N / 2 + this.trim;
    for (let j = 0; j < G; j++) {
      outL[j] = olaL[start + j] * gain[j];
      outR[j] = olaR[start + j] * gain[j];
    }
    return [outL, outR];
  }

  private gain: Float64Array | null = null;
  /**
   * Per-sample output gain of the trimmed region: compensate / (N · Σ window²). The window
   * envelope depends only on the config, so it is computed once.
   */
  private outGain(): Float64Array {
    if (this.gain) return this.gain;
    const { nFft: N, hop, dimT, compensate } = this.cfg;
    const w = this.window;
    const env = new Float64Array((dimT - 1) * hop + N);
    for (let t = 0; t < dimT; t++) for (let n = 0; n < N; n++) env[t * hop + n] += w[n] * w[n];
    const start = N / 2 + this.trim;
    this.gain = new Float64Array(this.genSize);
    for (let j = 0; j < this.genSize; j++) {
      const e = env[start + j];
      this.gain[j] = e > 1e-11 ? compensate / (N * e) : 0;
    }
    return this.gain;
  }
}

function reflect(i: number, len: number): number {
  if (i < 0) return -i;
  if (i >= len) return 2 * (len - 1) - i;
  return i;
}
