//! Hard-cut detection between two analysed frames, on 32×18 thumbnails (luma + a coarse colour histogram).
//! A person is only followed inside one shot: a face at the same spot after a cut is someone else.

pub const W: usize = 32;
pub const H: usize = 18;
const BINS: usize = 64;

/// Mean luma difference (0–255) above which two frames are a cut.
pub const CUT_PIXELS: f32 = 20.0;
/// Colour-histogram distance (half L1, 0–1) above which two frames are a cut.
pub const CUT_HIST: f32 = 0.3;

#[derive(Clone)]
pub struct Thumb {
    luma: [u8; W * H],
    hist: [f32; BINS],
}

/// Box-averaged thumbnail of a packed RGB24 frame.
pub fn thumb(rgb: &[u8], w: usize, h: usize) -> Thumb {
    let mut luma = [0u8; W * H];
    let mut hist = [0f32; BINS];
    for ty in 0..H {
        let (y0, y1) = (ty * h / H, ((ty + 1) * h / H).max(ty * h / H + 1).min(h));
        for tx in 0..W {
            let (x0, x1) = (tx * w / W, ((tx + 1) * w / W).max(tx * w / W + 1).min(w));
            let (mut r, mut g, mut b, mut n) = (0u32, 0u32, 0u32, 0u32);
            for y in y0..y1 {
                for x in x0..x1 {
                    let i = (y * w + x) * 3;
                    r += rgb[i] as u32;
                    g += rgb[i + 1] as u32;
                    b += rgb[i + 2] as u32;
                    n += 1;
                }
            }
            let (r, g, b) = ((r / n) as usize, (g / n) as usize, (b / n) as usize);
            luma[ty * W + tx] = ((r * 77 + g * 150 + b * 29) >> 8) as u8;
            hist[((r >> 6) << 4) | ((g >> 6) << 2) | (b >> 6)] += 1.0 / (W * H) as f32;
        }
    }
    Thumb { luma, hist }
}

pub fn is_cut(a: &Thumb, b: &Thumb) -> bool {
    let pix = a.luma.iter().zip(&b.luma).map(|(p, q)| (*p as i32 - *q as i32).unsigned_abs() as f32).sum::<f32>() / (W * H) as f32;
    let hist = a.hist.iter().zip(&b.hist).map(|(p, q)| (p - q).abs()).sum::<f32>() / 2.0;
    pix > CUT_PIXELS || hist > CUT_HIST
}

#[cfg(test)]
mod tests {
    use super::*;

    fn flat(w: usize, h: usize, c: [u8; 3]) -> Vec<u8> {
        (0..w * h).flat_map(|_| c).collect()
    }

    #[test]
    fn a_cut_is_seen_a_small_change_is_not() {
        let a = thumb(&flat(160, 90, [200, 40, 40]), 160, 90);
        let same = thumb(&flat(160, 90, [205, 42, 38]), 160, 90);
        let other = thumb(&flat(160, 90, [30, 60, 200]), 160, 90);
        assert!(!is_cut(&a, &same));
        assert!(is_cut(&a, &other));
    }
}
