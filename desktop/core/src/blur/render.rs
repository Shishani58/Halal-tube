//! Blurring regions of a packed RGB24 frame.

use super::Rect;

/// Blurs every region of `rects` (frame-relative) in place. Each region gets three passes of a box blur whose
/// radius grows with its size, so the contents are unrecognisable at any resolution.
pub fn blur_regions(rgb: &mut [u8], w: usize, h: usize, rects: &[Rect]) {
    for r in rects {
        let r = r.clamped();
        let x0 = (r.x * w as f32).floor() as usize;
        let y0 = (r.y * h as f32).floor() as usize;
        let x1 = (((r.x + r.w) * w as f32).ceil() as usize).min(w);
        let y1 = (((r.y + r.h) * h as f32).ceil() as usize).min(h);
        if x1 <= x0 + 1 || y1 <= y0 + 1 {
            continue;
        }
        let radius = ((x1 - x0).min(y1 - y0) / 6).clamp(4, 80);
        blur_box(rgb, w, x0, y0, x1 - x0, y1 - y0, radius);
    }
}

/// Three-pass separable box blur of the `bw`×`bh` block at (`x0`,`y0`); pixels outside the block are not read.
fn blur_box(rgb: &mut [u8], stride: usize, x0: usize, y0: usize, bw: usize, bh: usize, radius: usize) {
    let mut buf = vec![0u8; bw * bh * 3];
    for y in 0..bh {
        let src = ((y0 + y) * stride + x0) * 3;
        buf[y * bw * 3..(y + 1) * bw * 3].copy_from_slice(&rgb[src..src + bw * 3]);
    }
    let mut tmp = vec![0u8; buf.len()];
    for _ in 0..3 {
        pass(&buf, &mut tmp, bw, bh, radius, true);
        pass(&tmp, &mut buf, bw, bh, radius, false);
    }
    for y in 0..bh {
        let dst = ((y0 + y) * stride + x0) * 3;
        rgb[dst..dst + bw * 3].copy_from_slice(&buf[y * bw * 3..(y + 1) * bw * 3]);
    }
}

/// One box-blur pass along rows (`horizontal`) or columns, edges clamped.
fn pass(src: &[u8], dst: &mut [u8], w: usize, h: usize, r: usize, horizontal: bool) {
    let (len, lines, step_in, step_line) = if horizontal { (w, h, 3, w * 3) } else { (h, w, w * 3, 3) };
    let win = (2 * r + 1) as u32;
    for line in 0..lines {
        let base = line * step_line;
        for c in 0..3 {
            let at = |i: isize| -> u32 {
                let i = i.clamp(0, len as isize - 1) as usize;
                src[base + i * step_in + c] as u32
            };
            let mut sum: u32 = (-(r as isize)..=r as isize).map(at).sum();
            for i in 0..len {
                dst[base + i * step_in + c] = ((sum + win / 2) / win) as u8;
                sum = sum + at(i as isize + r as isize + 1) - at(i as isize - r as isize);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn checker(w: usize, h: usize) -> Vec<u8> {
        let mut v = vec![0u8; w * h * 3];
        for y in 0..h {
            for x in 0..w {
                let on = (x / 2 + y / 2) % 2 == 0;
                let i = (y * w + x) * 3;
                v[i..i + 3].copy_from_slice(&if on { [250, 250, 250] } else { [5, 5, 5] });
            }
        }
        v
    }

    fn spread(v: &[u8], w: usize, x0: usize, y0: usize, x1: usize, y1: usize) -> i32 {
        let (mut lo, mut hi) = (255i32, 0i32);
        for y in y0..y1 {
            for x in x0..x1 {
                let p = v[(y * w + x) * 3] as i32;
                lo = lo.min(p);
                hi = hi.max(p);
            }
        }
        hi - lo
    }

    #[test]
    fn only_the_region_changes_and_it_goes_flat() {
        let (w, h) = (64, 48);
        let orig = checker(w, h);
        let mut f = orig.clone();
        blur_regions(&mut f, w, h, &[Rect::new(0.25, 0.25, 0.5, 0.5)]);
        // inside (away from the border, where clamping at the block edge matters): flat grey
        assert!(spread(&f, w, 24, 18, 40, 30) < 20, "blurred area still has detail");
        // outside: untouched, byte for byte
        for y in 0..h {
            for x in 0..w {
                let inside = x >= 16 && x < 48 && y >= 12 && y < 36;
                if !inside {
                    let i = (y * w + x) * 3;
                    assert_eq!(f[i..i + 3], orig[i..i + 3], "pixel {x},{y} changed");
                }
            }
        }
    }

    #[test]
    fn empty_and_out_of_frame_regions_are_ignored() {
        let mut f = checker(32, 32);
        let orig = f.clone();
        blur_regions(&mut f, 32, 32, &[Rect::new(1.2, 1.2, 0.3, 0.3), Rect::new(0.5, 0.5, 0.0, 0.0)]);
        assert_eq!(f, orig);
    }
}
