/**
 * Build-time stand-in for 'onnxruntime-web/webgpu' and 'onnxruntime-common' inside the
 * transformers.js bundle (processor/asr-lib.js). It hands transformers.js the runtime that asr.ts
 * registered as globalThis.__musicRemoverOrt — the same one the separation model uses
 * (ort/ort.webgpu.min.mjs) — so there is one runtime, one set of WASM files and one WebGPU
 * device, and tensors created by transformers.js are accepted by its sessions.
 * (transformers.js's own Symbol.for('onnxruntime') hook is not used: with it, it refuses
 * device: 'webgpu'.)
 */
type OrtLike = { Tensor: unknown; InferenceSession: unknown; env: unknown };
const ort = (globalThis as unknown as { __musicRemoverOrt?: OrtLike }).__musicRemoverOrt;
if (!ort) throw new Error('ONNX Runtime must be registered before loading asr-lib.js');

export const Tensor = ort.Tensor;
export const InferenceSession = ort.InferenceSession;
export const env = ort.env;
export default ort;
