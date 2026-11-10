# -*- coding: utf-8 -*-
"""Compares gender classifiers (ONNX, input RGB 0..255 planar 96x96, output [N,3] with columns
[female, male, ...]) on the FairFace validation faces, clean and degraded the way video degrades faces.

    python eval.py NPY_025_DIR NPY_125_CENTER_DIR N model_a.onnx [model_b.onnx ...]

The pictures: "tight" = FairFace padding 0.25 (about 1.5x the face box of context); "loose" = padding
1.25 cut to its central part (about 2.5x), then cropped to 2.0x / 1.5x. The extension's crops are
1.4x-1.8x of NudeNet's face box.
"""
import sys
import numpy as np
import onnxruntime as ort
import torch
import torch.nn.functional as F


def zoom(x, s):  # x: [N,3,96,96] float; s < 1 zooms out (the face gets smaller), reflection fills
    n = x.shape[0]
    theta = torch.tensor([[1 / s, 0, 0], [0, 1 / s, 0]], dtype=torch.float32).unsqueeze(0).repeat(n, 1, 1)
    return F.grid_sample(x, F.affine_grid(theta, x.shape, align_corners=False), mode="bilinear", padding_mode="reflection", align_corners=False)


def small(x, px):  # a face of px pixels blown up to 96
    return F.interpolate(F.interpolate(x, size=(px, px), mode="bilinear", antialias=True, align_corners=False), size=(96, 96), mode="bilinear", align_corners=False)


def blur(x):
    k = torch.tensor([1.0, 2.0, 1.0]); k = (k[:, None] * k[None, :]); k = (k / k.sum()).view(1, 1, 3, 3).repeat(3, 1, 1, 1)
    return F.conv2d(F.pad(x, (1, 1, 1, 1), mode="replicate"), k, groups=3)


def crop(x, keep):  # keep the central share `keep` (zoom in)
    return zoom(x, 1 / keep)


def deg(fn, base):
    return lambda x: fn(base(x))


# (name, which pictures, transform)
CASES = [
    ("tight 1.5x", "t", lambda x: x),
    ("tight, zoom in 1.2", "t", lambda x: zoom(x, 1.2)),
    ("tight, zoom out 0.75", "t", lambda x: zoom(x, 0.75)),
    ("loose 2.5x", "l", lambda x: x),
    ("loose 2.0x", "l", lambda x: crop(x, 0.8)),
    ("loose 1.5x", "l", lambda x: crop(x, 0.6)),
    ("loose 2.0x, small 40 px", "l", lambda x: small(crop(x, 0.8), 40)),
    ("loose 2.0x, small 24 px", "l", lambda x: small(crop(x, 0.8), 24)),
    ("loose 2.0x, blurred", "l", lambda x: blur(crop(x, 0.8))),
    ("loose 2.0x, dark", "l", lambda x: crop(x, 0.8) * 0.45),
]


def auc(p, y):  # y = 1 female
    o = np.argsort(p); r = np.empty(len(p)); r[o] = np.arange(1, len(p) + 1)
    pos = y == 1
    return (r[pos].sum() - pos.sum() * (pos.sum() + 1) / 2) / (pos.sum() * (~pos).sum())


if __name__ == "__main__":
    d1, d2 = sys.argv[1], sys.argv[2]
    n = int(sys.argv[3])
    models = [m for m in sys.argv[4:] if m.endswith(".onnx")]
    sessions = {m: ort.InferenceSession(m, providers=["CPUExecutionProvider"]) for m in models}
    sets = {}
    for key, d in (("t", d1), ("l", d2)):
        x = np.load(f"{d}/validation_x.npy"); y = np.load(f"{d}/validation_y.npy").astype(int)
        idx = np.random.RandomState(0).permutation(len(x))[:n]
        sets[key] = (torch.from_numpy(x[idx]).permute(0, 3, 1, 2).float(), y[idx])
    print(f"{n} validation faces per set; accuracy % (AUC)")
    print("case".ljust(26) + "".join(m.split('/')[-1][:22].ljust(24) for m in models))
    for name, which, fn in CASES:
        xt, yt = sets[which]
        row = name.ljust(26)
        for m in models:
            s_ = sessions[m]; probs = []
            for i in range(0, n, 256):
                xb = fn(xt[i:i + 256]).clamp(0, 255).numpy().astype(np.float32)
                o = s_.run(None, {s_.get_inputs()[0].name: xb})[0]
                probs.append(1 / (1 + np.exp(-(o[:, 0] - o[:, 1]))))
            p = np.concatenate(probs)
            row += f"{((p > 0.5) == (yt == 1)).mean() * 100:5.1f} ({auc(p, yt):.3f})".ljust(24)
        print(row)
