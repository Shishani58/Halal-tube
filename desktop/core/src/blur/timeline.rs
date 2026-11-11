//! From per-frame detections to the regions that get blurred. Pure logic, no models.
//!
//! - **Nudity.** A frame with explicit nudity at ≥ 0.5 is hidden at once; a weaker score (0.3–0.5) needs
//!   three such frames within 1.5 s (a single burst on a shiny bald head is not nudity). A bare torso / belly
//!   is judged more strictly (≥ 0.65, or ≥ 0.5 on three frames).
//! - **Women.** Faces are chained into people by position; a person is a woman when the mean probability over
//!   all their frames is ≥ 0.4 with at least two frames ≥ 0.3 (a lone frame: ≥ 0.5). Then head and body
//!   are hidden on all her frames, a little before and after, and across short gaps where the face was lost.

use super::detect::Detection;
use super::Rect;

pub const NUDE_STRONG: f32 = 0.5;
pub const NUDE_WEAK: f32 = 0.3;
pub const SKIN_STRONG: f32 = 0.65;
pub const SKIN_WEAK: f32 = 0.5;
/// Weak scores count when this many frames agree within [`CONFIRM_WINDOW`] seconds.
pub const CONFIRM_FRAMES: usize = 3;
pub const CONFIRM_WINDOW: f32 = 1.5;
pub const WOMAN_MEAN: f32 = 0.4;
pub const WOMAN_FRAME: f32 = 0.3;
pub const WOMAN_ALONE: f32 = 0.5;
/// A person is followed across this long a gap without a face (seconds).
pub const TRACK_GAP: f32 = 1.0;
/// A woman stays hidden this long (seconds) before her first and after her last found frame.
pub const PAD: f32 = 0.5;

#[derive(Clone, Debug, Default)]
pub struct Timeline {
    /// Seconds between samples; sample `i` is the frame at `i * step`.
    pub step: f32,
    /// The regions to blur on each sample.
    pub rects: Vec<Vec<Rect>>,
}

impl Timeline {
    pub fn is_empty(&self) -> bool {
        self.rects.iter().all(|r| r.is_empty())
    }

    /// Regions to blur at time `t`: those of the two samples around it (a region present at either end
    /// of the interval is blurred through it, so a moving person never slips out).
    pub fn rects_at(&self, t: f64) -> Vec<Rect> {
        if self.rects.is_empty() || self.step <= 0.0 {
            return Vec::new();
        }
        let pos = (t / self.step as f64).max(0.0);
        let lo = (pos.floor() as usize).min(self.rects.len() - 1);
        let hi = (pos.ceil() as usize).min(self.rects.len() - 1);
        let mut out = self.rects[lo].clone();
        if hi != lo {
            out.extend(self.rects[hi].iter().copied());
        }
        out
    }

    /// Share of samples that have something blurred.
    pub fn hidden_share(&self) -> f32 {
        if self.rects.is_empty() {
            return 0.0;
        }
        self.rects.iter().filter(|r| !r.is_empty()).count() as f32 / self.rects.len() as f32
    }
}

/// The head and the body of a woman whose face is `face`: two rects, as the extension draws them
/// (`personFromFace` without detected body parts).
pub fn person_from_face(face: &Rect) -> [Rect; 2] {
    let cx = face.x + face.w / 2.0;
    let head = Rect::new(cx - 0.7 * face.w, face.y - 0.65 * face.h, 1.4 * face.w, 1.55 * face.h);
    let body = Rect::new(cx - 1.3 * face.w, face.y + 0.85 * face.h, 2.6 * face.w, 8.15 * face.h);
    [head.clamped(), body.clamped()]
}

/// Which samples of a score series are confirmed: `strong` at once, `weak` when [`CONFIRM_FRAMES`] samples
/// with at least that score lie within [`CONFIRM_WINDOW`] seconds.
fn confirmed(scores: &[f32], step: f32, strong: f32, weak: f32) -> Vec<bool> {
    let reach = (CONFIRM_WINDOW / step).floor() as usize;
    (0..scores.len())
        .map(|i| {
            if scores[i] >= strong {
                return true;
            }
            if scores[i] < weak {
                return false;
            }
            let lo = i.saturating_sub(reach);
            let hi = (i + reach).min(scores.len() - 1);
            // some window of CONFIRM_FRAMES consecutive-in-time samples around i that contains i
            (lo..=hi).filter(|&j| scores[j] >= weak && (i as isize - j as isize).unsigned_abs() <= reach).count() >= CONFIRM_FRAMES
        })
        .collect()
}

struct Track {
    /// (sample index, face rect, female probability)
    seen: Vec<(usize, Rect, f32)>,
}

impl Track {
    fn last(&self) -> &(usize, Rect, f32) {
        self.seen.last().unwrap()
    }

    fn is_woman(&self) -> bool {
        let n = self.seen.len();
        let mean = self.seen.iter().map(|s| s.2).sum::<f32>() / n as f32;
        let likely = self.seen.iter().filter(|s| s.2 >= WOMAN_FRAME).count();
        if n == 1 { mean >= WOMAN_ALONE } else { mean >= WOMAN_MEAN && likely >= 2 }
    }
}

/// `frames[i]` is the detection on the frame at `i * step` seconds.
pub fn build(frames: &[Detection], step: f32) -> Timeline {
    let n = frames.len();
    let mut rects: Vec<Vec<Rect>> = vec![Vec::new(); n];

    // nudity
    let top = |v: &[(Rect, f32)]| v.iter().fold(0f32, |m, b| m.max(b.1));
    let nude: Vec<f32> = frames.iter().map(|f| top(&f.nude)).collect();
    let skin: Vec<f32> = frames.iter().map(|f| top(&f.skin)).collect();
    let nude_ok = confirmed(&nude, step, NUDE_STRONG, NUDE_WEAK);
    let skin_ok = confirmed(&skin, step, SKIN_STRONG, SKIN_WEAK);
    for i in 0..n {
        if nude_ok[i] {
            rects[i].extend(frames[i].nude.iter().map(|b| b.0.grown(0.25).clamped()));
        }
        if skin_ok[i] {
            rects[i].extend(frames[i].skin.iter().map(|b| b.0.grown(0.15).clamped()));
        }
    }

    // women: chain faces into people, inside one shot
    let mut scene = vec![0usize; n];
    for i in 1..n {
        scene[i] = scene[i - 1] + frames[i].cut as usize;
    }
    let max_gap = (TRACK_GAP / step).ceil() as usize + 1;
    let mut tracks: Vec<Track> = Vec::new();
    for (i, f) in frames.iter().enumerate() {
        let mut taken = vec![false; tracks.len()];
        for face in &f.faces {
            let (cx, cy) = face.rect.centre();
            let reach = face.rect.w.max(face.rect.h) * 1.6;
            let best = tracks
                .iter()
                .enumerate()
                .filter(|(t, tr)| !taken[*t] && i - tr.last().0 <= max_gap && scene[tr.last().0] == scene[i])
                .map(|(t, tr)| {
                    let (tx, ty) = tr.last().1.centre();
                    (t, ((tx - cx).powi(2) + (ty - cy).powi(2)).sqrt())
                })
                .filter(|(_, d)| *d <= reach)
                .min_by(|a, b| a.1.partial_cmp(&b.1).unwrap());
            match best {
                Some((t, _)) => {
                    taken[t] = true;
                    tracks[t].seen.push((i, face.rect, face.female));
                }
                None => {
                    tracks.push(Track { seen: vec![(i, face.rect, face.female)] });
                    taken.push(true);
                }
            }
        }
    }
    let pad = (PAD / step).ceil() as usize;
    for tr in tracks.iter().filter(|t| t.is_woman()) {
        let first = tr.seen.first().unwrap().0;
        let last = tr.last().0;
        let mut cur = tr.seen[0].1;
        let mut next = 0;
        for i in first.saturating_sub(pad)..=(last + pad).min(n - 1) {
            if scene[i] != scene[first] {
                continue; // the pad stops at the cut
            }
            while next < tr.seen.len() && tr.seen[next].0 <= i {
                cur = tr.seen[next].1;
                next += 1;
            }
            rects[i].extend(person_from_face(&cur));
        }
    }
    Timeline { step, rects }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::blur::detect::Face;

    fn nude_frame(score: f32) -> Detection {
        Detection { nude: vec![(Rect::new(0.4, 0.4, 0.2, 0.2), score)], ..Default::default() }
    }
    fn face_frame(female: f32, x: f32) -> Detection {
        Detection { faces: vec![Face { rect: Rect::new(x, 0.2, 0.1, 0.15), score: 0.8, female }], ..Default::default() }
    }

    #[test]
    fn strong_nudity_is_hidden_at_once_weak_needs_company() {
        let mut f = vec![Detection::default(); 12];
        f[2] = nude_frame(0.6);
        f[8] = nude_frame(0.4); // alone
        let t = build(&f, 0.25);
        assert!(!t.rects[2].is_empty());
        assert!(t.rects[8].is_empty(), "a single weak frame must not blur");
        // three weak frames within 1.5 s do
        let mut g = vec![Detection::default(); 12];
        for i in [5, 6, 8] {
            g[i] = nude_frame(0.4);
        }
        let t = build(&g, 0.25);
        assert!([5, 6, 8].iter().all(|&i| !t.rects[i].is_empty()));
        // weak frames far apart (> 1.5 s) do not add up
        let mut h = vec![Detection::default(); 20];
        for i in [1, 9, 17] {
            h[i] = nude_frame(0.4);
        }
        assert!(build(&h, 0.25).is_empty());
    }

    #[test]
    fn a_woman_is_hidden_across_all_her_frames_a_man_is_not() {
        let mut f = vec![Detection::default(); 20];
        for i in 4..12 {
            f[i] = face_frame(0.7, 0.4);
        }
        f[7] = Detection::default(); // face lost for a frame: still hidden (gap bridged)
        let t = build(&f, 0.25);
        assert!((4..12).all(|i| !t.rects[i].is_empty()), "her frames");
        assert!(!t.rects[3].is_empty() && !t.rects[2].is_empty(), "padded before");
        assert!(!t.rects[13].is_empty(), "padded after");
        assert!(t.rects[0].is_empty() && t.rects[19].is_empty());

        let mut m = vec![Detection::default(); 20];
        for i in 4..12 {
            m[i] = face_frame(0.05, 0.4);
        }
        assert!(build(&m, 0.25).is_empty());
    }

    #[test]
    fn one_wrong_frame_does_not_turn_a_man_into_a_woman() {
        let mut m = vec![Detection::default(); 20];
        for i in 4..12 {
            m[i] = face_frame(0.05, 0.4);
        }
        m[6] = face_frame(0.6, 0.4); // a single wrong spike: mean stays low
        assert!(build(&m, 0.25).is_empty());
    }

    #[test]
    fn a_cut_ends_the_person() {
        // woman for 8 samples, then a cut to a man at the same spot: the man is not hidden
        let mut f = vec![Detection::default(); 20];
        for i in 2..10 {
            f[i] = face_frame(0.95, 0.4);
        }
        for i in 10..18 {
            f[i] = face_frame(0.02, 0.4);
        }
        f[10].cut = true;
        let t = build(&f, 0.25);
        assert!((2..10).all(|i| !t.rects[i].is_empty()));
        assert!((10..18).all(|i| t.rects[i].is_empty()), "the man after the cut is hidden: {:?}", (10..18).map(|i| t.rects[i].len()).collect::<Vec<_>>());
    }

    #[test]
    fn two_people_are_followed_separately() {
        let mut f = vec![Detection::default(); 12];
        for i in 0..12 {
            f[i] = Detection {
                faces: vec![
                    Face { rect: Rect::new(0.1, 0.2, 0.1, 0.15), score: 0.9, female: 0.9 },
                    Face { rect: Rect::new(0.7, 0.2, 0.1, 0.15), score: 0.9, female: 0.05 },
                ],
                ..Default::default()
            };
        }
        let t = build(&f, 0.25);
        // only the woman on the left is covered
        assert!(t.rects[5].iter().all(|r| r.x < 0.5), "{:?}", t.rects[5]);
        assert!(!t.rects[5].is_empty());
    }

    #[test]
    fn rects_at_uses_both_neighbouring_samples() {
        let t = Timeline { step: 0.25, rects: vec![vec![], vec![Rect::new(0.1, 0.1, 0.2, 0.2)], vec![]] };
        assert!(t.rects_at(0.0).is_empty());
        assert_eq!(t.rects_at(0.1).len(), 1); // between samples 0 and 1
        assert_eq!(t.rects_at(0.25).len(), 1);
        assert_eq!(t.rects_at(0.4).len(), 1); // between 1 and 2
        assert!(t.rects_at(0.5).is_empty());
        assert!(t.rects_at(99.0).is_empty()); // past the end: the last sample
    }
}
