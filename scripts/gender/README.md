# A face gender classifier without InsightFace's licence

InsightFace's `genderage` weights (what the extension uses by default) are **non-commercial**. This
folder trains a replacement on [FairFace](https://github.com/joojs/fairface) only (CC BY 4.0; its
pictures come from YFCC100M, whose per-photo licences are mixed: check that before a commercial
release), from random initialisation (no pretrained weights, nothing distilled from another model).
Same contract as genderage (input `[N,3,96,96]` RGB 0..255, output `[N,3]` with the female and male
logits first), so nothing else in the pipeline changes.

```bash
python3 -m venv venv && . venv/bin/activate && pip install torch torchvision pyarrow pillow numpy onnx onnxruntime onnxscript
# the Hugging Face dataset HuggingFaceM4/FairFace: 0.25/*.parquet and 1.25/*.parquet into data/ and data125/
python prepare.py data npy                 # padding 0.25: 96x96 arrays
python prepare.py data125 npy125 0.72      # padding 1.25, central part: more context
python train.py npy out 6 npy125           # ~20 min on an M1 Pro (MPS) → out/gender.onnx (6 MB, 1.5 M parameters)
python eval.py npy npy125 3000 genderage.onnx out/gender.onnx
```

Use it in a build with `GENDER_MODEL=fairface` (copies `models/gender-fairface.onnx` to the build as
`gender.onnx`).

## Result (6 epochs, 1.5 M parameters, FairFace validation, 3000 faces per set, accuracy % (AUC))

| crop | genderage | this model |
|---|---|---|
| tight (1.5× the face) | 74.6 (0.827) | **80.9** (0.896) |
| tight, zoomed in 1.2× | 68.6 (0.750) | **76.3** (0.863) |
| loose 2.5× | **80.4** (0.901) | 80.0 (0.884) |
| loose 2.0× | **80.7** (0.893) | 80.4 (0.894) |
| loose 1.5× | 74.1 (0.828) | **80.9** (0.899) |
| loose 2.0×, a face of 40 / 24 px | 79.1 / 76.6 | **80.2 / 79.1** |
| loose 2.0×, blurred / dark | 80.4 / 76.8 | 80.4 / **80.8** |

On this data it is as good as genderage at genderage's best crop and better elsewhere.

## But it is not a replacement yet

The extension's own blur test (`npm run test:blur`, portraits of women and men on a test video) says
otherwise: with `GENDER_MODEL=fairface` **151 of 205** checks pass, with genderage 208 of 208. The
model scores a woman at 0.35 (below the 0.4 mean the timeline needs: she is not blurred) and a man
at 0.24, where genderage gives 0.99 and 0. FairFace is a hard, mixed-quality set, and ~80 % on it is a
long way from a classifier that is sure about clear portraits; the timeline's thresholds were also
tuned to genderage's confident outputs. What it would take: more and cleaner labelled faces than
FairFace's 87 k (with licences that allow commercial use), a larger input or network, a longer
training, then re-tuning the thresholds on real video. Until then genderage stays the default and
this model is the starting point, not the answer. The trained weights are not committed (the run is
reproducible with the commands above).
