# -*- coding: utf-8 -*-
"""Trains a small face gender classifier from scratch on FairFace (CC BY 4.0) and exports ONNX.

Why: InsightFace's genderage weights are non-commercial. This model is trained only on FairFace,
from random initialisation (no pretrained weights, nothing distilled from another model), with the
same contract as genderage so the extension's pipeline takes it unchanged:
  input  [N, 3, 96, 96] float, RGB 0..255 (normalised inside the graph)
  output [N, 3]: [female logit, male logit, 0]  (the third column is genderage's age slot, unused)

    python train.py NPY_025_DIR OUT_DIR [epochs] [NPY_125_CENTER_DIR]
"""
import math, os, sys, time
import numpy as np
import torch
import torch.nn as nn
import torch.nn.functional as F
import torchvision

dev = torch.device("mps" if torch.backends.mps.is_available() else "cpu")


class GenderNet(nn.Module):
    def __init__(self):
        super().__init__()
        self.body = torchvision.models.mobilenet_v3_small(weights=None, num_classes=2)
        self.register_buffer("mean", torch.tensor([127.5, 127.5, 127.5]).view(1, 3, 1, 1))
        self.register_buffer("scale", torch.tensor(1 / 127.5))

    def forward(self, x):  # x: RGB 0..255
        z = self.body((x - self.mean) * self.scale)  # [N, 2]: female, male  (label 1 = female)
        return torch.cat([z[:, 0:1], z[:, 1:2], torch.zeros_like(z[:, 0:1])], dim=1)


def augment(x, loose):
    """x: [N,3,96,96] float 0..255. `loose` marks the pictures that come from the 1.25-padded set (about
    2.5x the face box of context, already cropped to the central part): they are cropped further to
    1.5x-2.5x; the 0.25 pictures (1.5x) are zoomed in a little (tighter crops) or left. So the model
    sees real context at the zooms the extension uses (1.4x-1.8x of NudeNet's face box), not
    mirrored borders. Then shift, tilt, flip, colour, blur, small-face (low resolution) and noise."""
    n = x.shape[0]
    # affine "scale" = share of the picture kept: < 1 zooms in
    keep = torch.where(loose, torch.empty(n, device=x.device).uniform_(0.6, 1.0), torch.empty(n, device=x.device).uniform_(0.75, 1.0))
    a = torch.empty(n, device=x.device).uniform_(-12, 12) * math.pi / 180
    tx, ty = [torch.empty(n, device=x.device).uniform_(-0.06, 0.06) for _ in range(2)]
    flip = (torch.rand(n, device=x.device) < 0.5).float() * 2 - 1
    cos, sin = torch.cos(a) * keep, torch.sin(a) * keep
    theta = torch.stack([torch.stack([cos * flip, -sin, tx], 1), torch.stack([sin * flip, cos, ty], 1)], 1)
    grid = F.affine_grid(theta, x.shape, align_corners=False)
    x = F.grid_sample(x, grid, mode="bilinear", padding_mode="reflection", align_corners=False)
    res = torch.randint(20, 97, (1,)).item() if torch.rand(1).item() < 0.45 else 96
    if res < 96:
        x = F.interpolate(F.interpolate(x, size=(res, res), mode="bilinear", antialias=True, align_corners=False), size=(96, 96), mode="bilinear", align_corners=False)
    if torch.rand(1).item() < 0.3:
        k = torch.tensor([1.0, 2.0, 1.0], device=x.device); k = (k[:, None] * k[None, :]); k = (k / k.sum()).view(1, 1, 3, 3).repeat(3, 1, 1, 1)
        x = F.conv2d(F.pad(x, (1, 1, 1, 1), mode="replicate"), k, groups=3)
    b = torch.empty(n, 1, 1, 1, device=x.device).uniform_(0.5, 1.4)
    c = torch.empty(n, 1, 1, 1, device=x.device).uniform_(0.7, 1.3)
    m = x.mean(dim=(1, 2, 3), keepdim=True)
    x = ((x - m) * c + m) * b
    g = x.mean(dim=1, keepdim=True)
    sat = torch.empty(n, 1, 1, 1, device=x.device).uniform_(0.5, 1.3)
    x = (x - g) * sat + g
    x = x + torch.randn_like(x) * torch.empty(n, 1, 1, 1, device=x.device).uniform_(0, 6)
    return x.clamp(0, 255)


def to_tensor(xb):  # uint8 NHWC -> float NCHW
    return torch.from_numpy(xb).to(dev).permute(0, 3, 1, 2).float()


def evaluate(model, x, y, bs=512, transform=None):
    model.eval(); correct = 0; probs = []
    with torch.no_grad():
        for i in range(0, len(x), bs):
            xb = to_tensor(x[i:i + bs])
            if transform: xb = transform(xb)
            z = model(xb); p = torch.softmax(z[:, :2], 1)[:, 0]
            probs.append(p.cpu()); correct += ((p > 0.5).long().cpu() == torch.from_numpy(y[i:i + bs]).long()).sum().item()
    return correct / len(x), torch.cat(probs).numpy()


if __name__ == "__main__":
    data, out = sys.argv[1], sys.argv[2]
    epochs = int(sys.argv[3]) if len(sys.argv) > 3 else 12
    os.makedirs(out, exist_ok=True)
    d125 = sys.argv[4] if len(sys.argv) > 4 else None
    x1, y1 = np.load(f"{data}/train_x.npy", mmap_mode="r"), np.load(f"{data}/train_y.npy")
    xva, yva = np.load(f"{data}/validation_x.npy"), np.load(f"{data}/validation_y.npy")
    if d125:  # the loose version: same people, more context
        x2, y2 = np.load(f"{d125}/train_x.npy", mmap_mode="r"), np.load(f"{d125}/train_y.npy")
        xtr = [x1, x2]; ytr = np.concatenate([y1, y2]); sizes = [len(x1), len(x2)]
    else:
        xtr = [x1]; ytr = y1; sizes = [len(x1)]
    total = sum(sizes)
    print("train", total, "val", xva.shape, "device", dev, flush=True)
    def batch(idx):  # idx sorted global indices -> (uint8 NHWC, loose mask)
        parts, loose = [], []
        for i in idx:
            k = 0 if i < sizes[0] else 1
            parts.append(xtr[k][i - (sizes[0] if k else 0)]); loose.append(k == 1)
        return np.stack(parts), torch.tensor(loose, device=dev)
    torch.manual_seed(0); np.random.seed(0)
    model = GenderNet().to(dev)
    print("parameters", sum(p.numel() for p in model.parameters()) / 1e6, "M", flush=True)
    bs = 256; steps = epochs * (total // bs)
    opt = torch.optim.AdamW(model.parameters(), lr=2e-3, weight_decay=0.02)
    sched = torch.optim.lr_scheduler.OneCycleLR(opt, max_lr=3e-3, total_steps=steps, pct_start=0.2)
    t0 = time.time(); step = 0
    for ep in range(epochs):
        model.train(); perm = np.random.permutation(total); loss_sum = 0
        for i in range(0, len(perm) - bs + 1, bs):
            idx = np.sort(perm[i:i + bs])
            xs, lo = batch(idx)
            xb = augment(to_tensor(xs), lo); yb = torch.from_numpy(ytr[idx]).to(dev).long()
            z = model(xb)[:, :2]   # column 0 = female: label 1 (female) -> class 0
            target = 1 - yb
            loss = F.cross_entropy(z, target, label_smoothing=0.05)
            opt.zero_grad(set_to_none=True); loss.backward(); opt.step(); sched.step(); step += 1
            loss_sum += loss.item()
        acc, _ = evaluate(model, xva, yva)
        print(f"epoch {ep + 1}/{epochs} loss {loss_sum / (len(perm) // bs):.4f} val acc {acc:.4f}  {time.time() - t0:.0f}s", flush=True)
    torch.save(model.state_dict(), f"{out}/gender.pt")
    model.eval().cpu()
    torch.onnx.export(model, torch.zeros(1, 3, 96, 96) * 127.0, f"{out}/gender.onnx", input_names=["input"], output_names=["output"], dynamic_axes={"input": {0: "batch"}, "output": {0: "batch"}}, opset_version=17, dynamo=False)
    print("exported", os.path.getsize(f"{out}/gender.onnx") / 1e6, "MB")
