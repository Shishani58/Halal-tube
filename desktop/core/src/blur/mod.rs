//! Hiding people in video: finds nudity and women on sampled frames and blurs those regions in a
//! re-encoded copy. A smaller port of the browser extension's `vision-timeline` (see the desktop README
//! for what is and isn't carried over).
//!
//! - [`detect`]: NudeNet (nudity and faces) and the face gender classifier on one RGB frame.
//! - [`timeline`]: per-frame detections → the regions to blur over time (pure logic).
//! - [`shots`]: hard cuts, so a person is followed inside one shot only.
//! - [`render`]: box-blur of a region of an RGB frame.
//! - [`job`]: the file pipeline: scan sampled frames, then decode → blur → hardware-encode, keeping audio.

pub mod detect;
pub mod job;
pub mod render;
pub mod shots;
pub mod timeline;

/// A rectangle in frame-relative units (0–1 on both axes).
#[derive(Clone, Copy, Debug, PartialEq, serde::Serialize)]
pub struct Rect {
    pub x: f32,
    pub y: f32,
    pub w: f32,
    pub h: f32,
}

impl Rect {
    pub fn new(x: f32, y: f32, w: f32, h: f32) -> Self {
        Rect { x, y, w, h }
    }

    pub fn centre(&self) -> (f32, f32) {
        (self.x + self.w / 2.0, self.y + self.h / 2.0)
    }

    pub fn union(&self, o: &Rect) -> Rect {
        let x0 = self.x.min(o.x);
        let y0 = self.y.min(o.y);
        let x1 = (self.x + self.w).max(o.x + o.w);
        let y1 = (self.y + self.h).max(o.y + o.h);
        Rect { x: x0, y: y0, w: x1 - x0, h: y1 - y0 }
    }

    /// Inside the frame (0–1).
    pub fn clamped(&self) -> Rect {
        let x0 = self.x.max(0.0);
        let y0 = self.y.max(0.0);
        let x1 = (self.x + self.w).min(1.0);
        let y1 = (self.y + self.h).min(1.0);
        Rect { x: x0, y: y0, w: (x1 - x0).max(0.0), h: (y1 - y0).max(0.0) }
    }

    /// Grown by `frac` of its size on every side.
    pub fn grown(&self, frac: f32) -> Rect {
        Rect { x: self.x - self.w * frac, y: self.y - self.h * frac, w: self.w * (1.0 + 2.0 * frac), h: self.h * (1.0 + 2.0 * frac) }
    }

    pub fn iou(&self, o: &Rect) -> f32 {
        let x0 = self.x.max(o.x);
        let y0 = self.y.max(o.y);
        let x1 = (self.x + self.w).min(o.x + o.w);
        let y1 = (self.y + self.h).min(o.y + o.h);
        let inter = (x1 - x0).max(0.0) * (y1 - y0).max(0.0);
        inter / (self.w * self.h + o.w * o.h - inter + 1e-9)
    }
}
