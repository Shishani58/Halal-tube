//! One-frame detection: NudeNet v3 (YOLOv8n, 320×320) for nudity and faces, then the gender
//! classifier (InsightFace genderage, 96×96) on every face. Input is a packed RGB24 frame.

use super::Rect;
use crate::model::Net;
use crate::Error;
use std::path::Path;

pub const INPUT: usize = 320;
const LABELS: usize = 18;

// class indices of NudeNet's 18 labels
const NUDE: [usize; 5] = [3, 4, 14, 2, 6]; // breast/genitalia exposed (F), genitalia exposed (M), buttocks, anus
const SKIN: [usize; 2] = [5, 13]; // male breast exposed, belly exposed
const FACES: [usize; 2] = [1, 12];

/// Faces the detector is less sure of than this are mostly cartoons, dolls and car fronts.
pub const FACE_MIN: f32 = 0.4;
/// Smallest face (side, in pixels of the analysed frame) the gender classifier is asked about.
pub const FACE_MIN_PX: f32 = 22.0;

#[derive(Clone, Debug)]
pub struct Face {
    pub rect: Rect,
    pub score: f32,
    /// Probability that this is a woman's face.
    pub female: f32,
}

#[derive(Clone, Debug, Default)]
pub struct Detection {
    /// Explicit nudity (≥ 0.3), with the detector's score.
    pub nude: Vec<(Rect, f32)>,
    /// Bare torso / belly (≥ 0.5): unreliable, judged more strictly.
    pub skin: Vec<(Rect, f32)>,
    pub faces: Vec<Face>,
    /// A hard cut lies between the previous analysed frame and this one.
    pub cut: bool,
}

pub struct Detector {
    nude: Net,
    gender: Net,
    pub backend: crate::model::Backend,
}

impl Detector {
    pub fn load(nudenet: &Path, gender: &Path, cache_dir: Option<&Path>) -> Result<Self, Error> {
        let nude = Net::load(nudenet, &[1, 3, INPUT, INPUT], true, cache_dir)?;
        let gender = Net::load(gender, &[1, 3, GENDER_INPUT, GENDER_INPUT], false, None)?;
        let backend = nude.backend;
        Ok(Detector { nude, gender, backend })
    }

    pub fn analyze(&mut self, rgb: &[u8], w: usize, h: usize) -> Result<Detection, Error> {
        let (input, scale) = letterbox_bgr(rgb, w, h);
        let out = self.nude.run(&[1, 3, INPUT, INPUT], &input)?;
        // box coordinates are in the 320 px input; `scale` maps them back to frame-relative units
        let to_rect = |b: &RawBox| Rect::new(b.x / scale.0, b.y / scale.1, b.w / scale.0, b.h / scale.1).clamped();
        let mut det = Detection::default();
        det.nude = decode(&out, &NUDE, 0.3, 12).iter().map(|b| (to_rect(b), b.score)).collect();
        det.skin = decode(&out, &SKIN, 0.5, 8).iter().map(|b| (to_rect(b), b.score)).collect();
        for b in decode(&out, &FACES, FACE_MIN, 6) {
            let rect = to_rect(&b);
            if rect.w * (w as f32) < FACE_MIN_PX && rect.h * (h as f32) < FACE_MIN_PX {
                continue;
            }
            let female = self.female_prob(rgb, w, h, &rect)?;
            det.faces.push(Face { rect, score: b.score, female });
        }
        Ok(det)
    }

    /// Mean of two head crops (the detector's face box sits low: brows to chin), through a sigmoid.
    fn female_prob(&mut self, rgb: &[u8], w: usize, h: usize, face: &Rect) -> Result<f32, Error> {
        let mut diff = 0.0;
        for (scale, dy) in GENDER_CROPS {
            let (fw, fh) = (face.w * w as f32, face.h * h as f32);
            let side = fw.max(fh) * scale;
            let cx = face.x * w as f32 + fw / 2.0;
            let cy = face.y * h as f32 + fh / 2.0 + dy * fh;
            let input = crop_rgb_planar(rgb, w, h, cx - side / 2.0, cy - side / 2.0, side, GENDER_INPUT);
            let o = self.gender.run(&[1, 3, GENDER_INPUT, GENDER_INPUT], &input)?;
            diff += o[0] - o[1];
        }
        Ok(1.0 / (1.0 + (-diff / GENDER_CROPS.len() as f32).exp()))
    }
}

const GENDER_INPUT: usize = 96;
const GENDER_CROPS: [(f32, f32); 2] = [(1.4, -0.1), (1.8, -0.2)];

struct RawBox {
    x: f32,
    y: f32,
    w: f32,
    h: f32,
    score: f32,
}

/// The frame scaled to fit 320×320 (long side 320) at the top-left of a black square, as planar **BGR** floats 0–1
/// (the order the model was exported with). Also returns the (x, y) factors from frame-relative units to input pixels.
pub fn letterbox_bgr(rgb: &[u8], w: usize, h: usize) -> (Vec<f32>, (f32, f32)) {
    let s = INPUT as f32 / w.max(h).max(1) as f32;
    let dw = ((w as f32 * s).round() as usize).clamp(1, INPUT);
    let dh = ((h as f32 * s).round() as usize).clamp(1, INPUT);
    let n = INPUT * INPUT;
    let mut out = vec![0f32; 3 * n];
    for y in 0..dh {
        let sy = ((y as f32 + 0.5) / dh as f32) * h as f32 - 0.5;
        for x in 0..dw {
            let sx = ((x as f32 + 0.5) / dw as f32) * w as f32 - 0.5;
            let p = sample(rgb, w, h, sx, sy);
            let i = y * INPUT + x;
            out[i] = p[2] / 255.0;
            out[n + i] = p[1] / 255.0;
            out[2 * n + i] = p[0] / 255.0;
        }
    }
    (out, (dw as f32, dh as f32))
}

/// Bilinear sample at (x, y) in pixels; coordinates are clamped to the image.
fn sample(rgb: &[u8], w: usize, h: usize, x: f32, y: f32) -> [f32; 3] {
    let x = x.clamp(0.0, w as f32 - 1.0);
    let y = y.clamp(0.0, h as f32 - 1.0);
    let (x0, y0) = (x.floor() as usize, y.floor() as usize);
    let (x1, y1) = ((x0 + 1).min(w - 1), (y0 + 1).min(h - 1));
    let (fx, fy) = (x - x0 as f32, y - y0 as f32);
    let px = |xx: usize, yy: usize, c: usize| rgb[(yy * w + xx) * 3 + c] as f32;
    let mut o = [0f32; 3];
    for (c, v) in o.iter_mut().enumerate() {
        let top = px(x0, y0, c) * (1.0 - fx) + px(x1, y0, c) * fx;
        let bot = px(x0, y1, c) * (1.0 - fx) + px(x1, y1, c) * fx;
        *v = top * (1.0 - fy) + bot * fy;
    }
    o
}

/// A square crop (top-left `x`,`y`, `side` px, may stick out of the frame: edge pixels repeat) resampled to
/// n×n, as planar **RGB** floats 0–255 (what genderage expects).
pub fn crop_rgb_planar(rgb: &[u8], w: usize, h: usize, x: f32, y: f32, side: f32, n: usize) -> Vec<f32> {
    let mut out = vec![0f32; 3 * n * n];
    for j in 0..n {
        let sy = y + (j as f32 + 0.5) / n as f32 * side - 0.5;
        for i in 0..n {
            let sx = x + (i as f32 + 0.5) / n as f32 * side - 0.5;
            let p = sample(rgb, w, h, sx, sy);
            for c in 0..3 {
                out[c * n * n + j * n + i] = p[c];
            }
        }
    }
    out
}

/// Boxes of the given classes above `min`, best first, after non-maximum suppression (IoU 0.45).
/// `out` is [1, 4 + 18, anchors]: cx, cy, w, h, then the class confidences.
fn decode(out: &[f32], classes: &[usize], min: f32, max: usize) -> Vec<RawBox> {
    let rows = 4 + LABELS;
    let anchors = out.len() / rows;
    let at = |r: usize, a: usize| out[r * anchors + a];
    let mut cand: Vec<RawBox> = Vec::new();
    for a in 0..anchors {
        let s = classes.iter().fold(0f32, |m, &c| m.max(at(4 + c, a)));
        if s < min {
            continue;
        }
        let (w, h) = (at(2, a), at(3, a));
        cand.push(RawBox { x: at(0, a) - w / 2.0, y: at(1, a) - h / 2.0, w, h, score: s });
    }
    cand.sort_by(|p, q| q.score.partial_cmp(&p.score).unwrap_or(std::cmp::Ordering::Equal));
    let mut keep: Vec<RawBox> = Vec::new();
    for c in cand {
        let cr = Rect::new(c.x, c.y, c.w, c.h);
        if keep.iter().all(|k| Rect::new(k.x, k.y, k.w, k.h).iou(&cr) < 0.45) {
            keep.push(c);
        }
        if keep.len() >= max {
            break;
        }
    }
    keep
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn letterbox_puts_the_frame_top_left() {
        // 4×2 frame, left half red, right half blue → scaled to 320×160, rest black; BGR order
        let mut rgb = vec![0u8; 4 * 2 * 3];
        for y in 0..2 {
            for x in 0..4 {
                let i = (y * 4 + x) * 3;
                if x < 2 { rgb[i] = 255 } else { rgb[i + 2] = 255 }
            }
        }
        let (t, (dw, dh)) = letterbox_bgr(&rgb, 4, 2);
        assert_eq!((dw, dh), (320.0, 160.0));
        let n = INPUT * INPUT;
        assert!(t[2 * n + 10] > 0.99 && t[10] < 0.01); // left: red → R plane (index 2 in BGR) is 1
        assert!(t[10 * INPUT + 300] > 0.99 && t[2 * n + 10 * INPUT + 300] < 0.01); // right: blue → B plane
        assert_eq!(t[200 * INPUT + 10], 0.0); // padding below the picture
    }

    #[test]
    fn decode_merges_overlaps_and_respects_the_threshold() {
        // three anchors: two overlapping boxes of class 1 (0.9, 0.8), one weak (0.2)
        let anchors = 3;
        let mut out = vec![0f32; (4 + LABELS) * anchors];
        let set = |out: &mut Vec<f32>, a: usize, cx: f32, cy: f32, w: f32, h: f32, c: usize, s: f32| {
            out[a] = cx; out[anchors + a] = cy; out[2 * anchors + a] = w; out[3 * anchors + a] = h; out[(4 + c) * anchors + a] = s;
        };
        set(&mut out, 0, 100.0, 100.0, 50.0, 50.0, 1, 0.9);
        set(&mut out, 1, 102.0, 101.0, 50.0, 50.0, 1, 0.8);
        set(&mut out, 2, 200.0, 200.0, 40.0, 40.0, 12, 0.2);
        let faces = decode(&out, &FACES, 0.4, 6);
        assert_eq!(faces.len(), 1);
        assert!((faces[0].score - 0.9).abs() < 1e-6);
        assert_eq!(decode(&out, &FACES, 0.1, 6).len(), 2);
    }

    #[test]
    fn crop_repeats_edge_pixels_outside_the_frame() {
        let rgb = vec![200u8; 8 * 8 * 3];
        let c = crop_rgb_planar(&rgb, 8, 8, -20.0, -20.0, 10.0, 4);
        assert!(c.iter().all(|&v| (v - 200.0).abs() < 1e-3));
    }
}
