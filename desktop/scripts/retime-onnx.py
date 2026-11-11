#!/usr/bin/env python3
"""Re-exports the MDX-Net ONNX with another time axis: retime-onnx.py IN.onnx OUT.onnx FRAMES.

The net is convolutional along time, so the weights are the same; only the fixed input/output shape (and the
shape hints derived from it) change. Needs `pip install onnx`. The live mode uses 32 frames (core/src/mdx.rs LIVE_FRAMES)."""
import sys
import onnx

src, dst, frames = sys.argv[1], sys.argv[2], int(sys.argv[3])
model = onnx.load(src)
graph = model.graph
del graph.value_info[:]  # shapes of the inner tensors, computed for the old length
for io in list(graph.input) + list(graph.output):
    io.type.tensor_type.shape.dim[3].dim_value = frames
onnx.save(model, dst)
