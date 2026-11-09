// Speech-recognition models for the profanity filter (Whisper exports with cross-attentions,
// so transformers.js can compute word timestamps). Shared by fetch-asr-model.mjs and build.mjs.
// Only one of them ships in the extension (ASR_DEFAULT); the others are for `npm run bench`.
const META = ['config.json', 'generation_config.json', 'preprocessor_config.json', 'tokenizer.json', 'tokenizer_config.json'];
const onnx = (enc, dec) => [`onnx/encoder_model_${enc}.onnx`, `onnx/decoder_model_merged_${dec}.onnx`];

export const ASR_MODELS = {
  'whisper-tiny_timestamped': {
    repo: 'onnx-community/whisper-tiny_timestamped',
    revision: '517244293732ee2d58139af5814231b7e6830a0d',
    dtype: { encoder_model: 'fp16', decoder_model_merged: 'q4f16' },
    files: [...META, ...onnx('fp16', 'q4f16')],
  },
  'whisper-base_timestamped': {
    repo: 'onnx-community/whisper-base_timestamped',
    revision: '608c49e61301901684bc36cac8f74b95ff6b5a8e',
    dtype: { encoder_model: 'fp16', decoder_model_merged: 'q4f16' },
    files: [...META, ...onnx('fp16', 'q4f16')],
  },
  'whisper-small_timestamped': {
    repo: 'onnx-community/whisper-small_timestamped',
    revision: '65caa70f294b46e1c33ff820aae6b16d048ab818',
    dtype: { encoder_model: 'fp16', decoder_model_merged: 'q4f16' },
    files: [...META, ...onnx('fp16', 'q4f16')],
  },
};

export const ASR_DEFAULT = 'whisper-base_timestamped';
