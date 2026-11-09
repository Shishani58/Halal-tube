/**
 * Entry for processor/asr-lib.js: the parts of transformers.js the profanity filter needs.
 * Built as a separate bundle and imported at runtime (after ONNX Runtime is registered, see
 * ort-shim.ts), so the separation-only path never loads it.
 */
export { pipeline, env, Tensor } from '@huggingface/transformers';
