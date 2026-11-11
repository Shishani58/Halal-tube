//! The "hide on screen" decision: from the detections of the last couple of seconds to the regions to blur now.
//! The same rules as the file timeline (`timeline::build`), run on a sliding window, so only what can be known
//! without looking ahead: a woman is hidden from the frame her face is first found and half a second after she
//! leaves; weak nudity needs three frames. Pure logic.

use super::detect::{Detection, Face};
use super::timeline;
use super::Rect;
use std::collections::VecDeque;

/// How much history the decision looks at, seconds.
const WINDOW_S: f32 = 2.5;

pub struct LiveBlur {
    step: f32,
    history: VecDeque<Detection>,
}

impl LiveBlur {
    /// `step`: seconds between the detections that are pushed.
    pub fn new(step: f32) -> Self {
        LiveBlur { step, history: VecDeque::new() }
    }

    /// Adds the newest detection; returns the regions (fractions of the frame) to hide right now.
    pub fn push(&mut self, det: Detection) -> Vec<Rect> {
        self.history.push_back(det);
        let keep = (WINDOW_S / self.step).ceil() as usize + 1;
        while self.history.len() > keep {
            self.history.pop_front();
        }
        let frames: Vec<Detection> = self.history.iter().cloned().collect();
        let t = timeline::build(&frames, self.step);
        // the last two samples: what moved between them stays covered
        let n = t.rects.len();
        let mut out = t.rects[n - 1].clone();
        if n >= 2 {
            out.extend(t.rects[n - 2].iter().copied());
        }
        merge_overlapping(out)
    }

    pub fn reset(&mut self) {
        self.history.clear();
    }
}

/// Rects that overlap a lot become one (fewer patches on the screen).
fn merge_overlapping(mut rects: Vec<Rect>) -> Vec<Rect> {
    let mut i = 0;
    while i < rects.len() {
        let mut j = i + 1;
        let mut merged = false;
        while j < rects.len() {
            if rects[i].iou(&rects[j]) > 0.3 || contains(&rects[i], &rects[j]) || contains(&rects[j], &rects[i]) {
                rects[i] = rects[i].union(&rects[j]);
                rects.swap_remove(j);
                merged = true;
            } else {
                j += 1;
            }
        }
        if !merged {
            i += 1;
        }
    }
    rects
}

fn contains(a: &Rect, b: &Rect) -> bool {
    b.x >= a.x - 0.002 && b.y >= a.y - 0.002 && b.x + b.w <= a.x + a.w + 0.002 && b.y + b.h <= a.y + a.h + 0.002
}

/// One detection from several looks at the same frame: `parts` are detections made on regions of it, each with the
/// region (fractions of the whole frame). Boxes are mapped back to the whole frame; the same thing found twice
/// (in the whole frame and in a tile) is kept once, with the better score.
pub fn merge(parts: Vec<(Detection, Rect)>) -> Detection {
    let place = |r: &Rect, reg: &Rect| Rect::new(reg.x + r.x * reg.w, reg.y + r.y * reg.h, r.w * reg.w, r.h * reg.h);
    let mut out = Detection::default();
    for (det, reg) in &parts {
        out.nude.extend(det.nude.iter().map(|(r, s)| (place(r, reg), *s)));
        out.skin.extend(det.skin.iter().map(|(r, s)| (place(r, reg), *s)));
        out.faces.extend(det.faces.iter().map(|f| Face { rect: place(&f.rect, reg), score: f.score, female: f.female }));
    }
    out.nude = dedupe(out.nude, |x| x.0, |x| x.1);
    out.skin = dedupe(out.skin, |x| x.0, |x| x.1);
    out.faces = dedupe(out.faces, |f| f.rect, |f| f.score);
    out
}

fn dedupe<T>(mut items: Vec<T>, rect: impl Fn(&T) -> Rect, score: impl Fn(&T) -> f32) -> Vec<T> {
    items.sort_by(|a, b| score(b).partial_cmp(&score(a)).unwrap());
    let mut kept: Vec<T> = Vec::new();
    for it in items {
        if kept.iter().all(|k| rect(k).iou(&rect(&it)) < 0.4) {
            kept.push(it);
        }
    }
    kept
}

#[cfg(test)]
mod tests {
    use super::*;

    fn woman(x: f32) -> Detection {
        Detection { faces: vec![Face { rect: Rect::new(x, 0.2, 0.05, 0.08), score: 0.8, female: 0.9 }], ..Default::default() }
    }

    #[test]
    fn a_woman_is_covered_at_once_and_a_bit_after_she_leaves() {
        let mut lb = LiveBlur::new(0.2);
        assert!(lb.push(Detection::default()).is_empty());
        assert!(!lb.push(woman(0.4)).is_empty(), "covered on the first frame she is found");
        for _ in 0..4 {
            lb.push(woman(0.4));
        }
        // she leaves: still covered for ~0.5 s, then free
        assert!(!lb.push(Detection::default()).is_empty());
        let mut left = 0;
        for _ in 0..8 {
            if !lb.push(Detection::default()).is_empty() {
                left += 1;
            }
        }
        assert!((1..=4).contains(&left), "still covered for {left} frames after she left");
        assert!(lb.push(Detection::default()).is_empty());
    }

    #[test]
    fn a_man_is_never_covered() {
        let mut lb = LiveBlur::new(0.2);
        for _ in 0..20 {
            let mut d = woman(0.4);
            d.faces[0].female = 0.05;
            assert!(lb.push(d).is_empty());
        }
    }

    #[test]
    fn the_same_face_found_twice_is_one_patch() {
        let a = (woman(0.4), Rect::new(0.0, 0.0, 1.0, 1.0));
        // the same face seen in a tile: tile covers the left 55 %, the face sits at 0.4/0.55 of it
        let mut t = woman(0.4 / 0.55);
        t.faces[0].rect = Rect::new(0.4 / 0.55, 0.2, 0.05 / 0.55, 0.08);
        let m = merge(vec![a, (t, Rect::new(0.0, 0.0, 0.55, 1.0))]);
        assert_eq!(m.faces.len(), 1);
    }

    #[test]
    fn overlapping_patches_merge() {
        let r = merge_overlapping(vec![Rect::new(0.1, 0.1, 0.2, 0.2), Rect::new(0.12, 0.1, 0.2, 0.2), Rect::new(0.8, 0.8, 0.1, 0.1)]);
        assert_eq!(r.len(), 2);
    }
}
