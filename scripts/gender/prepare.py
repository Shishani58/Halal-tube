# -*- coding: utf-8 -*-
"""FairFace (CC BY 4.0, padding 0.25 version, from the Hugging Face dataset HuggingFaceM4/FairFace)
-> uint8 arrays of 96x96 faces and gender labels (1 = female), cached as .npy.

    python prepare.py DATA_DIR OUT_DIR [CENTER]
DATA_DIR holds the parquet files (train-*, validation-*). CENTER (default 1): keep only this central
share of each picture; for the 1.25-padded version use 0.72 (about 2.5x the face box of context),
which gives the loose crops; the 0.25 version is used whole.
"""
import glob, io, os, sys
from concurrent.futures import ProcessPoolExecutor
import numpy as np
import pyarrow.parquet as pq
from PIL import Image

SIZE = 96
CENTER = float(os.environ.get("CENTER", "1"))  # read at import: worker processes start fresh


def decode(b):
    im = Image.open(io.BytesIO(b)).convert("RGB")
    if CENTER < 1.0:
        w, h = im.size
        m = (1 - CENTER) / 2
        im = im.crop((round(w * m), round(h * m), round(w * (1 - m)), round(h * (1 - m))))
    im = im.resize((SIZE, SIZE), Image.BICUBIC, reducing_gap=2.0)
    return np.asarray(im, dtype=np.uint8)


def load(files):
    xs, ys = [], []
    for f in files:
        t = pq.read_table(f, columns=["image", "gender"]).to_pydict()
        with ProcessPoolExecutor() as ex:
            xs.extend(ex.map(decode, [d["bytes"] for d in t["image"]], chunksize=256))
        ys.extend(t["gender"])
        print(f, len(ys), flush=True)
    return np.stack(xs), np.array(ys, dtype=np.uint8)


if __name__ == "__main__":
    data, out = sys.argv[1], sys.argv[2]
    if len(sys.argv) > 3:
        os.environ["CENTER"] = sys.argv[3]
        CENTER = float(sys.argv[3])
    os.makedirs(out, exist_ok=True)
    for split in ("train", "validation"):
        x, y = load(sorted(glob.glob(os.path.join(data, f"{split}-*.parquet"))))
        np.save(os.path.join(out, f"{split}_x.npy"), x)
        np.save(os.path.join(out, f"{split}_y.npy"), y)
        print(split, x.shape, "female share", float(y.mean()))
